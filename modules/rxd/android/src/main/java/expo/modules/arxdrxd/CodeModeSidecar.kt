package expo.modules.arxdrxd

import android.content.Context
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the Termux Node process that runs Pi's CodeMode QuickJS sandbox.
 *
 * The app's Agent stays in Hermes. This class only extracts the bundled sidecar,
 * starts Node inside the verified Termux runtime and exchanges JSON lines. The
 * sidecar never receives MCP credentials or tool implementations; tool calls go
 * back to the remote-sandbox host in JS.
 */
internal class CodeModeSidecar(
  private val context: Context,
  private val onMessage: (String) -> Unit,
  private val onExit: (code: Int, stderr: String) -> Unit,
) {
  companion object {
    private const val TAG = "ArxdCodeMode"
    private const val ASSET_DIR = "codemode"
    private const val MAX_LINE_BYTES = 4 * 1024 * 1024
    private const val MAX_STDERR_BYTES = 16 * 1024
    private const val READY_TIMEOUT_SECONDS = 60L
    private const val EXIT_TIMEOUT_MS = 1500L
    private val lock = Any()
  }

  data class Info(
    val protocol: Int,
    val hostSha256: String,
    val wasmSha256: String,
    val hostBytes: Long,
    val wasmBytes: Long,
  )

  private var process: Process? = null
  private var stderrTail = ""
  private var info: Info? = null
  private var stopping = false

  fun start(termuxRoot: File): Info = synchronized(lock) {
    process?.let { if (it.isAlive) return info ?: error("CodeMode sidecar has no identity") }
    stopping = false
    stderrTail = ""
    val files = prepareAssets()
    val node = File(termuxRoot, "usr/bin/node")
    check(node.isFile && node.canExecute()) { "Termux Node is not prepared; run the runtime check first" }
    info = files.info
    val run = File(files.directory, "run.sh").also {
      it.writeText("exec \"\$PREFIX/bin/node\" ${shellQuote(files.host.path)} ${shellQuote(files.wasm.path)}\n")
    }
    val pid = File(files.directory, "pid")
    val ready = CountDownLatch(1)
    val failure = AtomicReference<String?>(null)
    val readyProtocol = AtomicReference<Int?>(null)
    val builder = RuntimeLaunch.builder(context, termuxRoot, run, pid)
    val child = try { builder.start() } catch (error: Throwable) { failure.set(error.message); throw error }
    process = child
    Thread({
      try {
        child.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
          for (line in lines) {
            if (line.toByteArray(Charsets.UTF_8).size > MAX_LINE_BYTES) {
              failure.compareAndSet(null, "CodeMode sidecar sent a line over its budget")
              break
            }
            if (line.isNotEmpty()) {
              runCatching { JSONObject(line) }.getOrNull()?.let { message ->
                if (message.optString("type") == "ready") {
                  if (message.has("error")) failure.compareAndSet(null, message.optString("error"))
                  else readyProtocol.set(message.optInt("protocol", 0))
                  ready.countDown()
                }
              }
              runCatching { onMessage(line) }.onFailure { Log.w(TAG, "CodeMode event delivery failed", it) }
            }
          }
        }
      } catch (error: Throwable) {
        failure.compareAndSet(null, error.message ?: error.javaClass.simpleName)
      } finally {
        ready.countDown()
      }
    }, "arxd-codemode-stdout").apply { isDaemon = true }.start()
    Thread({
      val tail = StringBuilder()
      try {
        child.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
          for (line in lines) {
            tail.append(line).append('\n')
            if (tail.length > MAX_STDERR_BYTES) tail.delete(0, tail.length - MAX_STDERR_BYTES)
            Log.w(TAG, line.take(2000))
          }
        }
      } catch (_: Throwable) {
      } finally {
        synchronized(lock) { stderrTail = tail.toString().take(MAX_STDERR_BYTES) }
      }
    }, "arxd-codemode-stderr").apply { isDaemon = true }.start()
    Thread({
      val code = try { child.waitFor() } catch (_: InterruptedException) { 1 }
      synchronized(lock) {
        if (process === child) process = null
        val tail = stderrTail.ifEmpty { "CodeMode sidecar exited with code $code" }
        if (!stopping) runCatching { onExit(code, tail) }
      }
    }, "arxd-codemode-wait").apply { isDaemon = true }.start()

    if (!ready.await(READY_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      stopLocked()
      error("CodeMode sidecar did not become ready within ${READY_TIMEOUT_SECONDS}s" + if (stderrTail.isBlank()) "" else ": ${stderrTail.take(2000)}")
    }
    failure.get()?.let { stopLocked(); error("CodeMode sidecar failed: $it") }
    val protocol = readyProtocol.get() ?: run { stopLocked(); error("CodeMode sidecar returned no protocol identity") }
    check(protocol == files.info.protocol) { "Unsupported CodeMode sidecar protocol $protocol" }
    files.info
  }

  fun write(line: String) = synchronized(lock) {
    val child = process ?: error("CodeMode sidecar is not running")
    check(child.isAlive) { "CodeMode sidecar is not running" }
    require(line.toByteArray(Charsets.UTF_8).size <= MAX_LINE_BYTES) { "CodeMode message exceeds its budget" }
    try {
      child.outputStream.write(line.toByteArray(Charsets.UTF_8))
      child.outputStream.write('\n'.code)
      child.outputStream.flush()
    } catch (error: Throwable) {
      throw IllegalStateException("CodeMode sidecar input failed: ${error.message}", error)
    }
  }

  fun stop() = synchronized(lock) { stopLocked() }

  private fun stopLocked() {
    stopping = true
    val child = process ?: return
    process = null
    runCatching {
      child.outputStream.write("{\"type\":\"stop\"}\n".toByteArray(Charsets.UTF_8))
      child.outputStream.flush()
    }
    runCatching { child.destroy() }
    if (!runCatching { child.waitFor(EXIT_TIMEOUT_MS, TimeUnit.MILLISECONDS) }.getOrDefault(false)) {
      runCatching { child.destroyForcibly() }
    }
  }

  private data class Assets(val directory: File, val host: File, val wasm: File, val info: Info)

  private fun prepareAssets(): Assets {
    val manifest = JSONObject(context.assets.open("$ASSET_DIR/manifest.json").bufferedReader().use { it.readText() })
    check(manifest.optInt("schema", 0) == 1) { "Unsupported CodeMode sidecar asset schema" }
    val hostSha = manifest.getString("hostSha256")
    val wasmSha = manifest.getString("wasmSha256")
    val hostBytes = manifest.getLong("hostBytes")
    val wasmBytes = manifest.getLong("wasmBytes")
    val protocol = manifest.optInt("protocol", 0)
    check(protocol == 1) { "Unsupported CodeMode sidecar protocol" }
    val directory = File(context.filesDir, "codemode/$hostSha").also { it.mkdirs() }
    val host = copyAsset("$ASSET_DIR/host.mjs", File(directory, "host.mjs"), hostSha, hostBytes)
    val wasm = copyAsset("$ASSET_DIR/quickjs.wasm", File(directory, "quickjs.wasm"), wasmSha, wasmBytes)
    return Assets(directory, host, wasm, Info(protocol, hostSha, wasmSha, hostBytes, wasmBytes))
  }

  private fun copyAsset(name: String, target: File, expectedSha: String, expectedBytes: Long): File {
    if (target.isFile && target.length() == expectedBytes && sha256(target) == expectedSha) return target
    val staging = File(target.parentFile, target.name + ".staging").also { it.delete() }
    var size = 0L
    val digest = MessageDigest.getInstance("SHA-256")
    context.assets.open(name).use { input ->
      FileOutputStream(staging).use { output ->
        val buffer = ByteArray(65536)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          size += count
          require(size <= expectedBytes) { "CodeMode asset $name exceeds its manifest size" }
          digest.update(buffer, 0, count)
          output.write(buffer, 0, count)
        }
        output.fd.sync()
      }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    check(size == expectedBytes && actual == expectedSha) { "CodeMode asset $name identity mismatch" }
    Os.rename(staging.path, target.path)
    return target
  }

  private fun sha256(file: File): String = file.inputStream().use { input: InputStream ->
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(65536)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
    digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
}
