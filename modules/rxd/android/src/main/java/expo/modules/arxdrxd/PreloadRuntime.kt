package expo.modules.arxdrxd

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.system.Os
import android.util.Log
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.attribute.BasicFileAttributes
import org.json.JSONObject

/** Experimental host for unchanged, officially signed Termux packages. No external App. */
class PreloadRuntime(private val context: Context) {
  private class Active(val requestId: String?, val process: Process, val pidFile: File) {
    @Volatile var stdoutTail = ""
    @Volatile var stderrTail = ""
  }
  @Volatile private var active: Active? = null
  private val requests = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicBoolean>()
  companion object { private val runtimeLock = Any() }
  private val appRoot = File(context.filesDir, "termux-preload")
  private val root = File(appRoot, "files")
  private val prefix = File(root, "usr")
  private val shim = File(context.applicationInfo.nativeLibraryDir, "libarxdpreload.so")
  private fun hash(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    input.use { stream ->
      val buffer = ByteArray(65536)
      while (true) { val n = stream.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
  private fun manifest() = JSONObject(context.assets.open("termux-bootstrap.json").bufferedReader().use { it.readText() })

  /** Only the generated experimental runtime, never the Pi database or other App files. */
  fun reset() = synchronized(runtimeLock) {
    if (appRoot.exists()) Files.walkFileTree(appRoot.toPath(), object : SimpleFileVisitor<Path>() {
      override fun visitFile(path: Path, attributes: BasicFileAttributes): FileVisitResult {
        Files.delete(path)
        return FileVisitResult.CONTINUE
      }
      override fun postVisitDirectory(path: Path, error: java.io.IOException?): FileVisitResult {
        if (error != null) throw error
        Files.delete(path)
        return FileVisitResult.CONTINUE
      }
    })
    Unit
  }

  fun prepare(): Map<String, Any> = synchronized(runtimeLock) { prepareLocked() }

  private fun prepareLocked(): Map<String, Any> {
    check(Build.VERSION.SDK_INT >= 29) { "The preload runtime requires Android 10+" }
    val pin = manifest()
    check(hash(shim.inputStream()) == pin.getString("shimSha256")) { "Installed preload shim identity mismatch" }
    val bundle = RuntimeBundle(context).prepare(pin)
    val skillsAliasError = SharedSkillCatalog(context).alias()
    return mapOf("skillsAlias" to "~/skills", "skillsAliasError" to (skillsAliasError ?: ""), "bootstrapSha256" to pin.getString("sha256"), "shimSha256" to pin.getString("shimSha256"),
      "release" to pin.getString("release"), "root" to root.path, "packageName" to context.packageName,
      "targetSdk" to context.applicationInfo.targetSdkVersion, "uid" to android.os.Process.myUid(),
      "pid" to android.os.Process.myPid(), "debuggable" to ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)) + bundle
  }

  fun register(requestId: String) {
    require(requestId.length in 1..128) { "Invalid shell request ID" }
    check(requests.putIfAbsent(requestId, java.util.concurrent.atomic.AtomicBoolean(false)) == null) { "Duplicate shell request" }
  }

  fun cancel(requestId: String) {
    requests[requestId]?.set(true)
    active?.takeIf { it.requestId == requestId }?.let { kill(it) }
  }

  /** Bounded in-memory previews; never wait for the execution lock or touch files on the JS thread. */
  fun progress(requestId: String): Map<String, String>? {
    val job = active?.takeIf { it.requestId == requestId } ?: return null
    return mapOf("stdoutTail" to job.stdoutTail, "stderrTail" to job.stderrTail)
  }

  private fun kill(job: Active) {
    val pid = if (job.pidFile.isFile) job.pidFile.readText().trim().toIntOrNull() else null
    if (pid != null && pid > 1) try { Os.kill(-pid, 9) } catch (_: Exception) { }
    job.process.destroyForcibly()
  }

  fun execute(script: String, timeoutMs: Int, requestId: String? = null): Map<String, Any> {
    val cancelled = requestId?.let { requests[it] ?: error("Shell request is not registered") }
    try {
      return synchronized(runtimeLock) {
        check(cancelled?.get() != true) { "Shell task cancelled" }
        executeLocked(script, timeoutMs, requestId, cancelled)
      }
    } finally { if (requestId != null) requests.remove(requestId, cancelled) }
  }

  private fun executeLocked(script: String, timeoutMs: Int, requestId: String?, cancelled: java.util.concurrent.atomic.AtomicBoolean?): Map<String, Any> {
    require(script.toByteArray().size <= 65536) { "Script exceeds the 64 KiB limit" }
    require(timeoutMs in 1..600000) { "Invalid timeout" }
    val identity = prepare()
    val job = File(context.filesDir, "preload-runs/${UUID.randomUUID()}").also { it.mkdirs() }
    val stdout = File(job, "stdout.txt")
    val stderr = File(job, "stderr.txt")
    val scriptFile = File(job, "command.sh").also { it.writeText(script) }
    val pidFile = File(job, "pid")
    val builder = RuntimeLaunch.builder(context, root, scriptFile, pidFile)
    val started = SystemClock.elapsedRealtime()
    val child = builder.start()
    val activeJob = Active(requestId, child, pidFile)
    active = activeJob
    child.outputStream.close()
    val readers = Executors.newFixedThreadPool(2)
    fun collect(input: InputStream, file: File, update: (String) -> Unit) {
      input.use { stream -> file.outputStream().use { output ->
        val buffer = ByteArray(16384)
        var bytes = 0
        var tail = ""
        var pending = ByteArray(0)
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE)
        while (true) {
          val n = stream.read(buffer); if (n < 0) break
          bytes += n
          check(bytes <= 8 * 1024 * 1024) { "Runtime output exceeds 8 MiB" }
          output.write(buffer, 0, n)
          val encoded = ByteBuffer.wrap(pending + buffer.copyOf(n))
          val decoded = CharBuffer.allocate(encoded.remaining())
          decoder.decode(encoded, decoded, false)
          pending = ByteArray(encoded.remaining()).also { encoded.get(it) }
          decoded.flip()
          tail = (tail + decoded.toString()).takeLast(8192)
          if (tail.isNotEmpty() && Character.isLowSurrogate(tail[0])) tail = tail.drop(1)
          update(tail)
        }
      } }
    }
    val out = readers.submit { collect(child.inputStream, stdout) { activeJob.stdoutTail = it } }
    val err = readers.submit { collect(child.errorStream, stderr) { activeJob.stderrTail = it } }
    try {
      check(cancelled?.get() != true) { "Shell task cancelled" }
      check(child.waitFor(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) { "Runtime command timed out: ${job.name}" }
      out.get(5, TimeUnit.SECONDS)
      err.get(5, TimeUnit.SECONDS)
      val result = mapOf("exitCode" to child.exitValue(), "stdout" to stdout.readText().takeLast(24000),
        "stderr" to stderr.readText().takeLast(12000), "stdoutBytes" to stdout.length(), "stderrBytes" to stderr.length(),
        "stdoutSha256" to hash(stdout.inputStream()), "stderrSha256" to hash(stderr.inputStream()),
        "durationMs" to (SystemClock.elapsedRealtime() - started), "job" to job.name, "identity" to identity)
      File(job, "result.json").writeText(JSONObject(result).toString(2))
      Log.i("ArxdPreload", JSONObject(mapOf("event" to "command", "job" to job.name, "exitCode" to child.exitValue())).toString())
      return result
    } finally {
      kill(activeJob)
      active = null
      readers.shutdownNow()
    }
  }
}
