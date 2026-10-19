package expo.modules.arxdrxd

import android.content.Context
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** App-owned instances outlive screens and Pi turns. Nothing here automatically respawns. */
internal class ManagedProcesses internal constructor(private val context: Context) {
  companion object {
    @Volatile private var instance: ManagedProcesses? = null
    fun get(context: Context): ManagedProcesses = instance ?: synchronized(this) {
      instance ?: ManagedProcesses(context.applicationContext).also { instance = it }
    }
    val capabilities = mapOf("schemaVersion" to 1, "definitionSchemaVersion" to 1, "maxDefinitions" to 256, "maxRegistryBytes" to 33554432, "maxActive" to 8, "maxRecords" to 256,
      "maxCommandBytes" to 65536, "maxEnvironmentBytes" to 16384, "maxWriteBytes" to 16384,
      "maxLogPageBytes" to 49152, "retainedBytesPerStream" to 1048576, "startupTimeoutMs" to 15000,
      "stdinTimeoutMs" to 5000, "maxServiceStopOperations" to 2, "automaticRestart" to false, "supportsDetachedDescendants" to false)
    private val activeStates = setOf("queued", "starting", "running", "stopping")
    internal fun quote(value: String) = "'" + value.replace("'", "'\\''") + "'"
    internal fun procIdentity(stat: String): Pair<String, String> {
      val fields = stat.substringAfterLast(") ").trim().split(Regex("\\s+"))
      require(fields.size > 19) { "Cannot verify process identity" }
      return fields[19] to fields[2]
    }
  }
  private class Active(val process: Process, val stdin: java.util.concurrent.ExecutorService) {
    @Volatile var closing = false
    @Volatile var ioFailure: String? = null
  }
  private val lock = Any()
  private val root = File(context.filesDir, "managed-processes").also { it.mkdirs() }
  private val records = linkedMapOf<String, JSONObject>()
  private val definitions = linkedMapOf<String, JSONObject>()
  private val active = ConcurrentHashMap<String, Active>()
  private val serviceOwners = mutableMapOf<String, String>()
  private val output = ConcurrentHashMap<String, ManagedLog>()
  private val workers = Executors.newFixedThreadPool(8)
  private val readers = Executors.newFixedThreadPool(16)
  @Volatile var changed: (() -> Unit)? = null

  init {
    val index = File(root, "index.json")
    if (index.isFile) {
      check(index.length() <= 33554432) { "Process registry exceeds storage budget" }
      val text = index.readText(); boundedJson(text, 33554432)
      val saved = JSONObject(text)
      check(saved.getInt("schemaVersion") in 1..2) { "Unsupported process registry schema" }
      val storedDefinitions = saved.optJSONArray("definitions") ?: JSONArray()
      check(storedDefinitions.length() <= 256) { "Service definition budget exceeded" }
      for (i in 0 until storedDefinitions.length()) {
        val definition = storedDefinitions.getJSONObject(i)
        val id = definition.getString("id"); ServiceDefinitions.valid(id)
        check(definition.getInt("schemaVersion") == 1 && ServiceDefinitions.id(definition.getJSONObject("configuration")) == id && !definitions.containsKey(id)) { "Invalid retained service definition" }
        definitions[id] = definition
      }
      val items = saved.getJSONArray("items")
      check(items.length() <= 256) { "Process registry exceeds record budget" }
      for (i in 0 until items.length()) {
        val record = items.getJSONObject(i)
        val id = record.getString("id"); validId(id)
        val configuration = ServiceDefinitions.configuration(record)
        val definitionId = ServiceDefinitions.id(configuration)
        check(!record.has("definitionId") || record.getString("definitionId") == definitionId) { "Execution definition snapshot changed" }
        record.put("definitionId", definitionId)
        if (!definitions.containsKey(definitionId)) {
          check(saved.getInt("schemaVersion") == 1 && definitions.size < 256) { "Execution references a missing service definition" }
          definitions[definitionId] = JSONObject().put("id", definitionId).put("schemaVersion", 1).put("createdAt", record.getLong("createdAt")).put("configuration", configuration)
        }
        if (record.getString("state") in activeStates) record.put("state", "lost")
          .put("reason", "Host ownership was lost; no automatic restart was attempted")
          .put("processMaySurvive", true)
        records[id] = record
      }
      save()
    }
  }
  private fun validId(id: String) { require(id.matches(Regex("[a-f0-9-]{36}"))) { "Invalid process instance" } }
  private fun directory(id: String): File { validId(id); return File(root, id) }
  private fun log(id: String, stream: String): ManagedLog {
    require(stream == "stdout" || stream == "stderr") { "Unknown process stream" }
    return output.getOrPut("$id/$stream") { ManagedLog(File(directory(id), "$stream.ring")) }
  }
  private fun save() {
    val staged = File(root, "index.staging")
    val data = JSONObject().put("schemaVersion", 2).put("definitions", JSONArray(definitions.values.toList())).put("items", JSONArray(records.values.toList())).toString().toByteArray()
    require(data.size <= 33554432) { "Process/definition registry exceeds 32 MiB" }
    FileOutputStream(staged).use { it.write(data); it.fd.sync() }
    Os.rename(staged.path, File(root, "index.json").path)
  }
  private fun update(id: String, change: (JSONObject) -> Unit) {
    synchronized(lock) {
      val record = records[id] ?: error("Unknown process instance")
      change(record)
      try { save() } catch (error: Exception) {
        // Ownership and stream draining must survive a failed registry fsync.
        record.put("persistenceError", (error.message ?: error.javaClass.simpleName).take(500))
      }
    }
    runCatching { changed?.invoke() }
  }
  fun list(): List<Map<String, Any?>> = synchronized(lock) { records.values.toList().asReversed().map { publicRecord(it, false) } }
  fun inspectOptional(id: String): Map<String, Any?>? = synchronized(lock) { validId(id); records[id]?.let { publicRecord(it) } }
  fun inspect(id: String): Map<String, Any?> = synchronized(lock) { publicRecord(records[id] ?: error("Unknown process instance")) }
  private fun publicRecord(record: JSONObject, detail: Boolean = true): Map<String, Any?> = record.keys().asSequence()
    .filter { it != "environment" && (detail || it !in setOf("script", "argv", "runtimeIdentity", "startTicks")) }
    .associateWith { key -> record.opt(key).takeUnless { it == JSONObject.NULL } }
  fun admit(admissionId: String, json: String): String = synchronized(lock) {
    require(admissionId.length in 1..160 && json.toByteArray().size <= 98304) { "Process request exceeds budget" }
    boundedJson(json, 98304)
    val digest = MessageDigest.getInstance("SHA-256").digest(json.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    records.values.find { it.optString("admissionId") == admissionId }?.let {
      check(it.optString("requestSha256") == digest) { "Admission identity was already used for a different request" }
      return it.getString("id")
    }
    check(records.size < 256) { "Process record budget reached; remove exited records before starting another" }
    check(potentiallyLiveLocked() < 8) { "Eight process instances are already active" }
    val input = JSONObject(json)
    val request = if (input.has("definitionId")) {
      require(input.keys().asSequence().all { it in setOf("definitionId", "origin", "protocolOwner") }) { "A saved service reference cannot override its immutable configuration" }
      val definitionId = input.getString("definitionId"); ServiceDefinitions.valid(definitionId)
      val saved = definitions[definitionId] ?: error("Unknown service definition")
      JSONObject(saved.getJSONObject("configuration").toString()).put("origin", input.optString("origin")).put("protocolOwner", input.optString("protocolOwner"))
    } else input
    require(request.optString("name").length in 1..80) { "A process name is required (80 characters maximum)" }
    val script = request.optString("script")
    val argv = request.optJSONArray("argv")
    require((script.isNotEmpty()) != (argv != null)) { "Specify a script or argv" }
    require(script.toByteArray().size <= 65536 && !script.contains('\u0000')) { "Invalid script" }
    if (argv != null) {
      require(argv.length() in 1..128) { "Invalid argument count" }
      for (i in 0 until argv.length()) require(argv.getString(i).length <= 4096 && !argv.getString(i).contains('\u0000')) { "Invalid argument" }
      // argv has no shell separators: count only the actual UTF-8 argument bytes.
      require((0 until argv.length()).sumOf { argv.getString(it).toByteArray(Charsets.UTF_8).size } <= 65536) { "Command arguments exceed 64 KiB" }
    }
    val identity = request.optString("identity", "app")
    require(identity in setOf("app", "root")) { "Unknown execution identity" }
    val cwd = request.optString("cwd")
    require(cwd.length <= 4096 && !cwd.contains('\u0000') && (cwd.isEmpty() || cwd.startsWith('/'))) { "Working directory must be an absolute path" }
    val env = request.optJSONObject("environment") ?: JSONObject()
    require(env.length() <= 64 && env.toString().toByteArray().size <= 16384) { "Environment exceeds budget" }
    for (key in env.keys()) require(key.matches(Regex("[A-Za-z_][A-Za-z0-9_]*")) && !env.getString(key).contains('\u0000')) { "Invalid environment entry" }
    val endpoints = request.optJSONArray("endpoints") ?: JSONArray()
    require(endpoints.length() <= 8) { "At most eight configured endpoints are allowed" }
    for (i in 0 until endpoints.length()) {
      val raw = endpoints.getString(i)
      val endpoint = java.net.URI(raw)
      require(raw.length <= 4096 && endpoint.scheme in setOf("http", "https") && !endpoint.host.isNullOrEmpty() && endpoint.userInfo == null && endpoint.fragment == null) { "Invalid configured HTTP(S) endpoint" }
    }
    val owner = request.optString("protocolOwner")
    require(owner.isEmpty() || owner.matches(Regex("[a-f0-9-]{36}"))) { "Invalid protocol owner" }
    val configuration = ServiceDefinitions.configuration(request)
    val definitionId = ServiceDefinitions.id(configuration)
    val newDefinition = !definitions.containsKey(definitionId)
    check(!newDefinition || definitions.size < 256) { "Service definition budget reached; explicitly remove unused definitions" }
    val id = UUID.randomUUID().toString()
    val record = JSONObject().put("id", id).put("definitionId", definitionId).put("admissionId", admissionId).put("requestSha256", digest).put("name", request.getString("name"))
      .put("script", script).put("argv", argv ?: JSONObject.NULL).put("identity", identity).put("cwd", cwd)
      .put("environment", env).put("endpoints", endpoints).put("protocolOwner", owner).put("state", "queued").put("createdAt", System.currentTimeMillis())
      .put("origin", request.optString("origin").take(256)).put("automaticRestart", false)
      .put("startupGateVersion", 1).put("payloadAdmitted", false)
    val location = directory(id)
    check(location.mkdir()) { "Cannot create process instance directory" }
    records[id] = record
    if (newDefinition) definitions[definitionId] = JSONObject().put("id", definitionId).put("schemaVersion", 1).put("createdAt", record.getLong("createdAt")).put("configuration", JSONObject(configuration.toString()))
    try {
      save()
    } catch (error: Exception) {
      records.remove(id); if (newDefinition) definitions.remove(definitionId); location.deleteRecursively()
      throw error
    }
    id
  }
  fun claimService(id: String, generation: String): Boolean = synchronized(lock) {
    val record = records[id] ?: return false
    if (record.optString("state") !in activeStates && !record.optBoolean("processMaySurvive")) return false
    val previous = serviceOwners[id]
    if (previous != null && previous != generation && record.optString("state") != "queued") return false
    serviceOwners[id] = generation
    true
  }
  fun launch(id: String, generation: String? = null) {
    try {
      synchronized(lock) {
        if (records[id]?.optString("state") != "queued" || generation != null && serviceOwners[id] != generation) return
        records[id]!!.put("state", "starting"); save()
      }
      workers.execute { run(id) }
    } catch (error: Exception) {
      // This entry is called on Android's service main thread. Persistence failure
      // before spawn must never tear down unrelated owned processes.
      synchronized(lock) {
        records[id]?.put("state", "failed")?.put("processMaySurvive", false)
          ?.put("reason", "Process was not spawned: " + (error.message ?: error.javaClass.simpleName).take(500))
          ?.put("persistenceError", "Registry write failed before spawn")
        runCatching { save() }
      }
      runCatching { changed?.invoke() }
    }
  }
  private fun run(id: String) {
    var child: Process? = null
    var stdout: Future<*>? = null
    var stderr: Future<*>? = null
    var payloadAdmitted = false
    var approval: File? = null
    try {
      val record = synchronized(lock) { JSONObject(records.getValue(id).toString()) }
      val runtime = PreloadRuntime(context)
      val identity = runtime.prepare()
      val runtimeRoot = File(identity.getValue("root") as String)
      val dir = directory(id)
      val pidFile = File(dir, "pid").also { it.writeText("") }
      val statFile = File(dir, "initial-stat").also { it.writeText("") }
      val uidFile = File(dir, "uid").also { it.writeText("") }
      val gateNonce = UUID.randomUUID().toString()
      val ready = File(dir, "startup.ready").also { it.writeText("") }
      val allow = File(dir, "startup.approval").also { it.writeText("") }
      approval = allow
      val argv = record.optJSONArray("argv")
      val payload = if (argv == null) record.getString("script") else "exec " + (0 until argv.length()).joinToString(" ") { quote(argv.getString(it)) }
      val requestedCwd = record.optString("cwd")
      val payloadPid = File(dir, "payload.pid").also { it.writeText("") }
      val payloadExit = File(dir, "payload.exit")
      // Root may have a restrictive umask. Keep the atomic exit-status marker
      // App-owned, as are the other startup identity sidecars.
      File(dir, "payload.exit.staging").writeText("")
      val payloadScript = File(dir, "payload.sh").also { file ->
        file.writeText((if (requestedCwd.isNotEmpty()) "cd -- ${quote(requestedCwd)} || exit 125\n" else "") + payload)
      }
      // Keep a verified group leader until the native owner terminates the whole
      // group. Payload `exit`/`exec` cannot erase the identity used for cleanup.
      val script = File(dir, "command.sh").also { file -> file.writeText(
        "unset ARXD_JOB_FILE\n" +
        "/system/bin/id -u > ${quote(uidFile.path)} || exit 124\n/system/bin/cat /proc/\$\$/stat > ${quote(statFile.path)} || exit 124\n" +
        "printf '%s' ${quote(gateNonce)} > ${quote(ready.path)} || exit 124\n" +
        "interrupted=0\ntrap 'interrupted=1' TERM\ngate_attempt=0\n" +
        "while :; do gate_value=; IFS= read -r gate_value < ${quote(allow.path)}; [ \"\$gate_value\" = ${quote(gateNonce)} ] && break; " +
        "[ \"\$interrupted\" -eq 0 ] || exit 125; ((gate_attempt++)); [ \"\$gate_attempt\" -lt 300 ] || exit 124; /system/bin/sleep 0.05; done\n" +
        "${quote(File(runtimeRoot, "usr/bin/bash").path)} --noprofile --norc ${quote(payloadScript.path)} <&0 &\n" +
        "payload=\$!\nprintf '%s' \"\$payload\" > ${quote(payloadPid.path)}\nwhile :; do interrupted=0; wait \"\$payload\"; status=\$?; [ \"\$interrupted\" -eq 0 ] && break; done\n" +
        "printf '%s' \"\$status\" > ${quote(payloadExit.path + ".staging")}\n" +
        "/system/bin/mv -- ${quote(payloadExit.path + ".staging")} ${quote(payloadExit.path)}\n" +
        "while :; do /system/bin/sleep 1; done\n") }
      val overrides = record.getJSONObject("environment").let { env -> env.keys().asSequence().associateWith { env.getString(it) } }
      val builder = RuntimeLaunch.builder(context, runtimeRoot, script, pidFile, null, overrides)
      if (record.getString("identity") == "root") {
        val command = "/system/bin/env -i " + builder.environment().entries.joinToString(" ") { quote(it.key + "=" + it.value) } +
          " " + builder.command().joinToString(" ", transform = ::quote)
        builder.command(suPath(), "-c", "exec $command")
        builder.environment().clear()
      }
      val running = synchronized(lock) {
        if (records.getValue(id).optBoolean("stopRequested")) {
          records.getValue(id).put("state", "exited").put("processMaySurvive", false)
            .put("endedAt", System.currentTimeMillis()).put("reason", "Canceled before spawn")
          save(); return
        }
        val process = builder.start(); child = process
        Active(process, ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(4))).also { active[id] = it }
      }
      val process = running.process
      fun collect(stream: java.io.InputStream, name: String) = readers.submit {
        try {
          stream.use { input ->
            val bytes = ByteArray(8192)
            while (true) {
              val n = input.read(bytes); if (n < 0) break
              if (name == "stdout" && record.optString("protocolOwner").isNotEmpty()) NativeMcp.get(context).accept(id, bytes.copyOf(n))
              else log(id, name).append(bytes, n)
            }
          }
        } catch (error: Exception) {
          if (!running.closing) {
            val reason = error.javaClass.simpleName + ": " + (error.message ?: "").take(300)
            running.ioFailure = reason
            // A failed fsync must not skip cleanup or kill the verified leader
            // prematurely. The supervisor loop observes this flag independently.
            runCatching { update(id) { it.put("ioError", reason) } }
          }
        }
      }
      stdout = collect(process.inputStream, "stdout"); stderr = collect(process.errorStream, "stderr")
      val deadline = SystemClock.elapsedRealtime() + 15000
      fun identityReady() = pidFile.length() > 0 && statFile.length() > 0 && uidFile.length() > 0 &&
        ready.length() == gateNonce.length.toLong() && ready.readText() == gateNonce
      while (process.isAlive && !identityReady() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
      if (identityReady()) {
        val pid = pidFile.readText().trim().toInt()
        val uid = uidFile.readText().trim().toInt()
        val stat = statFile.readText()
        val (start, group) = procIdentity(stat)
        require(pid > 1 && stat.substringBefore(' ').toInt() == pid && group == pid.toString()) { "The process is not in its own managed group" }
        require(uid == if (record.getString("identity") == "root") 0 else android.os.Process.myUid()) { "Requested execution identity was not granted; no identity downgrade" }
        update(id) { it.put("pid", pid).put("startTicks", start).put("observedUid", uid).put("runtimeIdentity", JSONObject(identity))
          .put("ownershipScope", "verified-process-group; detached sessions are unsupported").put("startupGateVersion", 1) }
        synchronized(lock) {
          check(process.isAlive) { "Launcher exited before native payload admission" }
          check(!records.getValue(id).optBoolean("stopRequested")) { "Canceled before payload admission" }
          // This is the only path authorizing execution of the requested body.
          // Missing/partial startup markers can never admit it, even if a root
          // manager leaves a delayed launcher after its proxy has returned.
          val staged = File(dir, "startup.approval.staging")
          FileOutputStream(staged).use { it.write(gateNonce.toByteArray()); it.fd.sync() }
          Os.rename(staged.path, allow.path)
          payloadAdmitted = true
          records.getValue(id).put("payloadAdmitted", true)
          try { save() } catch (error: Exception) { records.getValue(id).put("persistenceError", (error.message ?: "Registry update failed").take(500)) }
        }
        while (process.isAlive && payloadPid.length() == 0L && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        check(payloadPid.length() > 0) { "Approved payload did not report its PID within startup deadline" }
        update(id) { it.put("payloadPid", payloadPid.readText().trim().toInt())
          .put("startedAt", System.currentTimeMillis()); if (it.optString("state") != "stopping") it.put("state", "running") }
      } else if (process.isAlive) error("Process startup identity did not settle within 15 seconds")
      else if (record.getString("identity") == "root" && !payloadAdmitted && process.exitValue() != 0 &&
        listOf(pidFile, statFile, uidFile, payloadPid, ready, allow).all { it.length() == 0L }) {
        val drained = runCatching { stdout.get(3, TimeUnit.SECONDS); stderr.get(3, TimeUnit.SECONDS) }.isSuccess
        val diagnostic = log(id, "stderr").read(-1, 4096)["text"] as? String
        if (drained && diagnostic?.contains("permission denied", ignoreCase = true) == true) {
          running.closing = true
          update(id) { it.put("state", "failed").put("processMaySurvive", false).put("payloadAdmitted", false)
            .put("startupGateVersion", 1).put("rootStartupDenied", true).put("exitCode", process.exitValue())
            .put("endedAt", System.currentTimeMillis()).put("reason", "Root startup was denied before native payload admission: Permission denied") }
          return
        }
      }
      while (process.isAlive && !payloadExit.isFile) {
        running.ioFailure?.let { error("Process output failed: $it") }
        process.waitFor(100, TimeUnit.MILLISECONDS)
      }
      running.ioFailure?.let { error("Process output failed: $it") }
      val payloadCode = if (payloadExit.isFile) payloadExit.readText().trim().toInt().also {
        check(it in 0..255) { "Invalid payload exit status" }
      } else null
      val owned = synchronized(lock) { JSONObject(records.getValue(id).toString()) }
      if (process.isAlive && payloadCode != null) {
        if (signal(owned, 15)) Thread.sleep(150)
        if (signal(owned, 0)) signal(owned, 9)
      }
      check(process.waitFor(3, TimeUnit.SECONDS)) { "Managed supervisor did not exit after group cleanup" }
      val groupGone = owned.has("pid") && awaitGroupGone(owned)
      running.closing = true
      val drained = runCatching { stdout.get(3, TimeUnit.SECONDS); stderr.get(3, TimeUnit.SECONDS) }.isSuccess
      if (!drained) { process.inputStream.close(); process.errorStream.close() }
      update(id) { it.put("state", if (!groupGone || !drained) "lost" else if (it.has("ioError")) "failed" else "exited")
        .put("exitCode", payloadCode ?: process.exitValue()).put("supervisorExitCode", process.exitValue()).put("processMaySurvive", !groupGone || !drained)
        .put("endedAt", System.currentTimeMillis()).put("reason", if (!groupGone) "Process group cleanup could not be proved" else if (it.optBoolean("stopRequested")) "Stopped explicitly" else "Payload exited and its owned group was terminated; no restart attempted") }
    } catch (error: Exception) {
      val cleaned = runCatching {
        val record = synchronized(lock) { JSONObject(records.getValue(id).toString()) }
        if (record.has("pid")) {
          if (signal(record, 0)) signal(record, 9)
          child?.waitFor(2, TimeUnit.SECONDS)
          awaitGroupGone(record)
        } else child == null
      }.getOrDefault(false)
      child?.destroyForcibly()
      runCatching { update(id) { it.put("state", if (cleaned) "failed" else "lost").put("processMaySurvive", !cleaned).put("endedAt", System.currentTimeMillis())
        .put("reason", (error.message ?: error.javaClass.simpleName).take(1000)) } }
    } finally {
      if (!payloadAdmitted) runCatching { approval?.writeText("closed") }
      active.remove(id)?.let { it.closing = true; it.stdin.shutdownNow() }
      runCatching { child?.inputStream?.close() }; runCatching { child?.errorStream?.close() }; runCatching { child?.outputStream?.close() }
      NativeMcp.get(context).processEnded(id)
      changed?.invoke()
    }
  }
  private fun suPath(): String = listOf("/system_ext/bin/su", "/system/bin/su", "/system/xbin/su", "/sbin/su")
    .firstOrNull { File(it).canExecute() } ?: error("Root executable is unavailable")
  fun startFailed(id: String, error: Exception) { update(id) { it.put("state", "failed").put("reason", "Foreground service start failed: " + error.javaClass.simpleName) } }
  fun logs(id: String, stream: String, cursor: Long, maxBytes: Int): Map<String, Any> {
    synchronized(lock) { check(records.containsKey(id)) { "Unknown process instance" } }
    return log(id, stream).read(cursor, maxBytes) + mapOf("instanceId" to id, "stream" to stream)
  }
  fun write(id: String, data: ByteArray, close: Boolean = false, protocolOwner: String? = null) {
    require(data.size <= 16384) { "Stdin write exceeds 16 KiB" }
    synchronized(lock) {
      val owner = records[id]?.optString("protocolOwner") ?: error("Unknown process instance")
      require(owner.isEmpty() || owner == protocolOwner) { "MCP owns this process's stdin" }
    }
    val job = active[id] ?: error("Process input is unavailable")
    check(!job.closing && job.process.isAlive) { "Process input has closed" }
    val pending = job.stdin.submit { job.process.outputStream.apply { write(data); flush(); if (close) this.close() } }
    try { pending.get(5, TimeUnit.SECONDS) }
    catch (error: Exception) { pending.cancel(true); throw IllegalStateException("Stdin delivery failed or is uncertain; do not retry automatically", error) }
  }
  private fun signal(record: JSONObject, number: Int): Boolean {
    val pid = record.optInt("pid")
    val ticks = record.optString("startTicks")
    require(pid > 1 && ticks.matches(Regex("[0-9]+"))) { "No verified process identity; outcome is unknown" }
    if (record.getString("identity") == "root") {
      val recordedRoot = record.optJSONObject("runtimeIdentity")?.optString("root")?.takeIf { it.isNotEmpty() }
      val runtimeRoot = File(recordedRoot ?: File(context.filesDir, "termux-preload/files").path)
      val python = File(runtimeRoot, "usr/bin/python")
      val env = RuntimeLaunch.builder(context, runtimeRoot, File("/dev/null"), File("/dev/null")).environment()
      env.remove("ARXD_JOB_FILE"); env["ARXD_EXECUTABLE"] = python.path
      // Python supplies errno rather than guessing from a shell's translated
      // error text. A missing leader permits only a harmless group-existence
      // probe; real signals still require its captured start-time identity.
      val program = """
        import errno, os, sys
        pid, ticks, number = $pid, '$ticks', $number
        try:
            try:
                stat = open('/proc/%d/stat' % pid).read().rsplit(') ', 1)[1].split()
            except FileNotFoundError:
                os.kill(-pid, 0)
                sys.exit(0 if number == 0 else 43)
            if stat[19] != ticks or stat[2] != str(pid):
                os.kill(-pid, 0)
                sys.exit(0 if number == 0 else 43)
            os.kill(-pid, number)
        except ProcessLookupError:
            sys.exit(42)
        except Exception:
            sys.exit(44)
      """.trimIndent()
      val command = "/system/bin/env -i " + env.entries.joinToString(" ") { quote(it.key + "=" + it.value) } +
        " /system/bin/linker64 " + quote(python.path) + " -c " + quote(program)
      val control = ProcessBuilder(suPath(), "-c", command).redirectErrorStream(true).start()
      if (!control.waitFor(3, TimeUnit.SECONDS)) { control.destroyForcibly(); error("Root process control timed out") }
      return when (control.exitValue()) { 0 -> true; 42 -> false; 43 -> error("Process leader identity is absent or changed; refusing to signal a possibly reused group"); else -> error("Root process control was denied or failed") }
    }
    val file = File("/proc/$pid/stat")
    if (!file.exists()) {
      val exists = try { Os.kill(-pid, 0); true } catch (error: ErrnoException) {
        if (error.errno == OsConstants.ESRCH) false else throw error
      }
      check(number == 0 || !exists) { "Group leader identity is gone; refusing to signal a possibly reused group" }
      return exists
    }
    val current = procIdentity(file.readText())
    if (current.first != ticks || current.second != pid.toString()) {
      val exists = try { Os.kill(-pid, 0); true } catch (error: ErrnoException) {
        if (error.errno == OsConstants.ESRCH) false else throw error
      }
      check(number == 0 || !exists) { "Process identity changed; refusing to signal a possibly reused group" }
      return exists
    }
    return try { Os.kill(-pid, number); true } catch (error: ErrnoException) { if (error.errno == OsConstants.ESRCH) false else throw error }
  }
  private fun awaitGroupGone(record: JSONObject): Boolean {
    val deadline = SystemClock.elapsedRealtime() + 2000
    do {
      if (!signal(record, 0)) return true
      Thread.sleep(50)
    } while (SystemClock.elapsedRealtime() < deadline)
    return false
  }
  private fun recoverCapturedIdentity(record: JSONObject): Boolean {
    if (record.has("pid")) return true
    val dir = directory(record.getString("id"))
    fun captured(name: String): String {
      val file = File(dir, name)
      check(!java.nio.file.Files.isSymbolicLink(file.toPath()) && file.isFile && file.length() in 1..8192 &&
        file.canonicalPath.startsWith(dir.canonicalPath + File.separator)) { "Missing or invalid captured $name" }
      return file.readText().trim()
    }
    return try {
      val pid = captured("pid").toInt()
      val stat = captured("initial-stat")
      val uid = captured("uid").toInt()
      val payload = captured("payload.pid").toInt()
      val (ticks, group) = procIdentity(stat)
      check(pid > 1 && payload > 1 && payload != pid && stat.substringBefore(' ').toInt() == pid &&
        group == pid.toString() && ticks.matches(Regex("[0-9]+"))) { "Captured PID/group identity is inconsistent" }
      check(uid == if (record.getString("identity") == "root") 0 else android.os.Process.myUid()) { "Captured execution UID differs from requested identity" }
      record.put("pid", pid).put("startTicks", ticks).put("observedUid", uid).put("payloadPid", payload)
        .put("identityRecoveredFromSidecars", true)
      true
    } catch (error: Exception) {
      record.put("identityRecoveryError", (error.message ?: error.javaClass.simpleName).take(300))
      false
    }
  }

  fun stop(id: String, generation: String? = null): Map<String, Any?> {
    var record = synchronized(lock) {
      val current = records[id] ?: error("Unknown process instance")
      if (generation != null && serviceOwners[id] != generation) return publicRecord(current)
      if (current.optString("state") == "queued") {
        current.put("state", "exited").put("stopRequested", true).put("processMaySurvive", false).put("reason", "Canceled before launch")
        try { save() } catch (error: Exception) { current.put("persistenceError", (error.message ?: "Registry update failed").take(500)) }
        return publicRecord(current)
      }
      if (current.optString("state") in setOf("exited", "failed") && !current.optBoolean("processMaySurvive")) return publicRecord(current)
      if (!current.has("initialFailureReason")) {
        val previous = listOf(current.optString("ioError"), current.optString("reason")).filter { it.isNotEmpty() }.distinct().joinToString("; ")
        if (previous.isNotEmpty()) current.put("initialFailureReason", previous.take(1000))
      }
      recoverCapturedIdentity(current)
      current.put("state", "stopping").put("stopRequested", true)
      try { save() } catch (error: Exception) { current.put("persistenceError", (error.message ?: "Registry update failed").take(500)) }
      JSONObject(current.toString())
    }
    changed?.invoke()
    try {
      val deadline = SystemClock.elapsedRealtime() + 15500
      while (!record.has("pid") && record.optString("state") in activeStates && SystemClock.elapsedRealtime() < deadline) {
        Thread.sleep(25)
        record = synchronized(lock) { JSONObject(records.getValue(id).toString()) }
      }
      if (record.optString("state") in setOf("exited", "failed") && !record.optBoolean("processMaySurvive")) return inspect(id)
      val sent = signal(record, 15)
      if (sent) Thread.sleep(1000)
      if (sent && signal(record, 0)) signal(record, 9)
      active[id]?.process?.let { if (!it.waitFor(2, TimeUnit.SECONDS)) it.destroyForcibly() }
      if (!awaitGroupGone(record)) error("The verified process group is still alive")
      update(id) { it.put("state", "exited").put("processMaySurvive", false).put("endedAt", System.currentTimeMillis()).put("reason", "Stopped explicitly") }
    } catch (error: Exception) {
      update(id) {
        val diagnostic = listOf(error.message ?: "Stop outcome is unknown", it.optString("initialFailureReason"), it.optString("identityRecoveryError"))
          .filter { value -> value.isNotEmpty() }.distinct().joinToString("; ").take(1000)
        it.put("state", "lost").put("processMaySurvive", true).put("reason", diagnostic)
      }
      throw error
    }
    return inspect(id)
  }
  fun stopAll(includeLost: Boolean = true) { for (row in list()) {
    val id = row.getValue("id") as String
    if (row["state"] in activeStates || active[id]?.process?.isAlive == true || includeLost && row["state"] == "lost") runCatching { stop(id) }
  } }
  private fun potentiallyLiveLocked(): Int = records.values.count {
    it.optString("state") in activeStates || it.optBoolean("processMaySurvive") || active[it.getString("id")]?.process?.isAlive == true
  }
  fun activeCount(): Int = synchronized(lock) { potentiallyLiveLocked() }
  fun definitions(offset: Int, limit: Int): Map<String, Any?> = synchronized(lock) {
    require(offset in 0..256 && limit in 1..32) { "Invalid service definition page" }
    val rows = definitions.values.toList().asReversed()
    mapOf("items" to rows.drop(offset).take(limit).map { definition -> mapOf("id" to definition.getString("id"), "schemaVersion" to 1,
      "name" to definition.getJSONObject("configuration").getString("name"), "identity" to definition.getJSONObject("configuration").getString("identity"),
      "createdAt" to definition.getLong("createdAt"), "instances" to records.values.count { it.optString("definitionId") == definition.getString("id") }) },
      "total" to rows.size, "nextOffset" to (offset + limit).takeIf { it < rows.size })
  }
  fun definition(id: String): Map<String, Any?> = synchronized(lock) {
    ServiceDefinitions.valid(id)
    val row = definitions[id] ?: error("Unknown service definition")
    val config = row.getJSONObject("configuration")
    mapOf("id" to id, "schemaVersion" to 1, "createdAt" to row.getLong("createdAt"),
      "configuration" to config.keys().asSequence().filter { it != "environment" }.associateWith { config.opt(it).takeUnless { it == JSONObject.NULL } },
      "hasEnvironment" to (config.getJSONObject("environment").length() > 0))
  }
  fun removeDefinition(id: String) { synchronized(lock) {
    ServiceDefinitions.valid(id)
    check(records.values.none { it.optString("definitionId") == id }) { "Remove retained execution records before deleting their definition" }
    val old = definitions.remove(id) ?: error("Unknown service definition")
    try { save() } catch (error: Exception) { definitions[id] = old; throw error }
  } }

  fun remove(id: String) {
    synchronized(lock) {
      check(records[id]?.optString("state") in setOf("exited", "failed") && records[id]?.optBoolean("processMaySurvive") != true) { "Stop and verify the process before removing its record" }
      val record = records.remove(id) ?: error("Unknown process instance")
      val owner = serviceOwners.remove(id)
      try { save() } catch (error: Exception) { records[id] = record; if (owner != null) serviceOwners[id] = owner; throw error }
      directory(id).deleteRecursively(); output.remove("$id/stdout"); output.remove("$id/stderr")
    }
  }
}
