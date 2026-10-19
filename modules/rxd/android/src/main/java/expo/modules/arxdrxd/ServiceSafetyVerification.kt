package expo.modules.arxdrxd

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Fixed Android verification scenarios at the actual native control seam. */
internal object ServiceSafetyVerification {
  fun httpPolicyCommitFailure(context: Context): Map<String, Any> {
    val files = File(context.filesDir, "http-policy-verification-${UUID.randomUUID()}").also { check(it.mkdir()) }
    val isolated = object : ContextWrapper(context) { override fun getFilesDir() = files }
    val base = File(files, "http-mcp-policy.json")
    val retained = File(files, "retained-policy")
    val marker = File(base, "owned-marker")
    val staging = File(files, "http-mcp-policy.json.new")
    val backup = File(files, "http-mcp-policy.json.bak")
    val results = mutableListOf<Map<String, Any>>()
    try {
      val owner = PlainHttpMcpPolicy(isolated)
      for (requested in listOf(true, false)) {
        owner.set(!requested)
        val before = base.readBytes() // Test-owned canonical policy, below 256 bytes.
        check(before.size <= 256 && base.renameTo(retained))
        check(base.mkdir()); marker.writeText("owned-commit-fault")
        var rawFinishReturned = false
        // Independently reproduce the platform's silent finishWrite failure.
        val atomic = android.util.AtomicFile(base)
        var output: java.io.FileOutputStream? = null
        try {
          output = atomic.startWrite(); output.write(before); output.fd.sync()
          atomic.finishWrite(output); rawFinishReturned = true
        } catch (_: Exception) { /* Older platforms may reject at startWrite. */ }
        finally { output?.let { runCatching { it.close() } } }
        check(base.isDirectory && marker.readText() == "owned-commit-fault")
        if (staging.exists()) check(staging.isFile && staging.delete())
        var rejected = false
        try { owner.set(requested) } catch (_: IllegalStateException) { rejected = true }
        val state = owner.view()
        check(rejected && !owner.allowed && state.getString("source") == "invalid" && !state.isNull("error")) { "Failed policy replacement was reported saved or permitted HTTP" }
        check(base.isDirectory && marker.readText() == "owned-commit-fault" && !staging.exists())
        check(marker.delete() && base.delete() && retained.renameTo(base))
        check(base.readBytes().contentEquals(before)) { "Commit-failure test changed its retained previous preference" }
        check(PlainHttpMcpPolicy(isolated).allowed == !requested) { "Failed replacement changed the durable previous preference" }
        results.add(mapOf("requested" to requested, "rejected" to rejected, "gateClosed" to true, "rawFinishReturnedNormally" to rawFinishReturned, "previousPreferencePreserved" to true))
      }
      return mapOf("passed" to true, "fault" to "nonempty directory at owned atomic policy base", "cases" to results)
    } finally {
      // Only exact paths in this fresh test-owned directory; never the App preference.
      if (marker.exists()) check(marker.delete())
      if (base.isDirectory) check(base.delete()) else if (base.exists()) check(base.delete())
      if (retained.exists()) check(retained.delete())
      if (staging.exists()) check(staging.isFile && staging.delete())
      if (backup.exists()) check(backup.isFile && backup.delete())
      check(files.delete()) { "Owned HTTP policy verification directory was not empty" }
    }
  }
  fun launchPersistenceFailure(context: Context): Map<String, Any> {
    val files = File(context.filesDir, "service-storage-verification-${UUID.randomUUID()}").also { check(it.mkdir()) }
    val isolated = object : ContextWrapper(context) { override fun getFilesDir() = files }
    try {
      val owner = ManagedProcesses(isolated)
      val id = owner.admit("storage-verification", """{"name":"Trusted pre-spawn failure","script":"exit 93","identity":"app"}""")
      // Admission is already durable. Fail the service's next atomic staging
      // write with EISDIR, covering the same containment path as ENOSPC/fsync.
      check(File(files, "managed-processes/index.staging").mkdir())
      owner.launch(id)
      val record = owner.inspect(id)
      check(record["state"] == "failed" && record["processMaySurvive"] == false && record["persistenceError"] != null) { "Launch persistence failure escaped or could spawn work" }
      check(owner.activeCount() == 0) { "An unspawned failure retained an active slot" }
      return mapOf("passed" to true, "failure" to "EISDIR before spawn", "state" to "failed")
    } finally { files.deleteRecursively() }
  }
  fun interruptedStop(context: Context, id: String): Map<String, Any> {
    val owner = ManagedProcesses.get(context)
    val before = owner.inspect(id)
    check(before["state"] == "running" && before["identity"] == "app") { "Use a running ordinary trusted fixture" }
    val failed = AtomicReference<Throwable?>()
    val worker = Thread {
      try { owner.stop(id) } catch (error: Throwable) { failed.set(error) }
    }.also { it.start() }
    Thread.sleep(250)
    worker.interrupt(); worker.join(3000)
    check(!worker.isAlive && failed.get() != null) { "Stop was not interrupted within its bounded fixture interval" }
    val record = owner.inspect(id)
    check(record["state"] == "lost" && record["processMaySurvive"] == true) { "Interrupted Stop did not retain uncertainty" }
    check(owner.activeCount() > 0) { "Interrupted Stop dropped foreground ownership/admission quota" }
    return mapOf("passed" to true, "state" to "lost", "potentiallyActive" to owner.activeCount())
  }
}
