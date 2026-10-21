package expo.modules.arxdrxd

import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import android.net.Uri
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel

class ArxdRxdModule : Module() {
  private companion object { const val importCeiling = 8L * 1024 * 1024 * 1024 }
  private val fileExecutor = Executors.newSingleThreadExecutor()
  private val fileQueue = CoroutineScope(SupervisorJob() + fileExecutor.asCoroutineDispatcher())
  private fun files() = WorkspaceFiles(appContext.reactContext ?: error("Android context unavailable"))
  private val modelExecutor = Executors.newSingleThreadExecutor()
  private val modelQueue = CoroutineScope(SupervisorJob() + modelExecutor.asCoroutineDispatcher())
  private var localModelFiles: LocalModelFiles? = null
  @Synchronized private fun localModel(): LocalModelFiles = localModelFiles ?: LocalModelFiles(appContext.reactContext ?: error("Android context unavailable")).also { localModelFiles = it }
  private var skillFiles: SkillFiles? = null
  @Synchronized private fun skills(): SkillFiles = skillFiles ?: SkillFiles(appContext.reactContext ?: error("Android context unavailable")).also { skillFiles = it }
  private var preloadRuntime: PreloadRuntime? = null
  private var codeMode: CodeModeSidecar? = null
  @Synchronized private fun preload(): PreloadRuntime {
    return preloadRuntime ?: PreloadRuntime(appContext.reactContext ?: error("Android context unavailable")).also { preloadRuntime = it }
  }
  override fun definition() = ModuleDefinition {
    Name("ArxdRxd")
    Events("onCodeModeMessage", "onCodeModeExit")
    View(CodeEditorView::class) {
      Name("CodeEditor")
      Prop("text") { view: CodeEditorView, value: String -> view.setInitialText(value) }
      Prop("spans") { view: CodeEditorView, value: String -> view.setSpans(value) }
      Prop("textColor") { view: CodeEditorView, value: String -> view.setTextColor(value) }
      Prop("editable") { view: CodeEditorView, value: Boolean -> view.setEditable(value) }
      Prop("maxLength") { view: CodeEditorView, value: Int -> view.setMaxLength(value) }
      Prop("wrap") { view: CodeEditorView, value: Boolean -> view.setWrap(value) }
      Prop("label") { view: CodeEditorView, value: String -> view.setLabel(value) }
    }
    Function("verificationEnabled") { VerificationAccess.enabled(appContext.reactContext ?: error("Android context unavailable")) }

    Function("getAppIcon") {
      val context = appContext.reactContext ?: error("Android context unavailable")
      val pm = context.packageManager
      val dark = ComponentName(context.packageName, context.packageName + ".MainActivityDark")
      val light = ComponentName(context.packageName, context.packageName + ".MainActivityLight")
      val lightState = pm.getComponentEnabledSetting(light)
      if (lightState == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) "light"
      else if (lightState == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) "dark"
      else if (pm.getComponentEnabledSetting(dark) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) "dark"
      else "light"
    }
    Function("setAppIcon") { style: String ->
      require(style == "dark" || style == "light") { "Unknown app icon style" }
      val context = appContext.reactContext ?: error("Android context unavailable")
      val pm = context.packageManager
      val dark = ComponentName(context.packageName, context.packageName + ".MainActivityDark")
      val light = ComponentName(context.packageName, context.packageName + ".MainActivityLight")
      val selected = if (style == "light") light else dark
      val other = if (style == "light") dark else light
      pm.setComponentEnabledSetting(selected, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
      pm.setComponentEnabledSetting(other, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
      style
    }
    OnDestroy { localModelFiles?.cancel(); modelQueue.cancel(); modelExecutor.shutdownNow(); codeMode?.stop(); codeMode = null; skillFiles?.close(); skillFiles = null; fileQueue.cancel(); fileExecutor.shutdownNow() }
    Function("localModelStatus") { localModel().status() }
    Function("cancelLocalModelOperation") { localModel().cancel() }
    AsyncFunction("stageLocalModelFixture") { VerificationAccess.requireEnabled(appContext.reactContext ?: error("Android context unavailable")); localModel().stageVerificationFixture() }.runOnQueue(modelQueue)
    Function("localModelFixturePath") { VerificationAccess.requireEnabled(appContext.reactContext ?: error("Android context unavailable")); localModel().fixturePath() }
    AsyncFunction("downloadLocalModel") { localModel().download() }.runOnQueue(modelQueue)
    AsyncFunction("importLocalModel") { uri: String, name: String -> localModel().importModel(uri, name) }.runOnQueue(modelQueue)
    AsyncFunction("setLocalModelLimits") { id: String, contextWindow: Int, maxTokens: Int, thinking: Boolean -> localModel().setLimits(id, contextWindow, maxTokens, thinking) }.runOnQueue(modelQueue)
    AsyncFunction("verifiedLocalModelPath") { id: String -> localModel().verifiedPath(id) }.runOnQueue(modelQueue)
    AsyncFunction("removeLocalModel") { id: String -> localModel().remove(id) }.runOnQueue(modelQueue)
    // Shared skills discovery and idle-only snapshot collection use the file queue.
    AsyncFunction("discoverSkills") { skills().discover() }.runOnQueue(fileQueue)
    AsyncFunction("skillsRevision") { skills().revision() }.runOnQueue(fileQueue)
    AsyncFunction("renameSkill") { id: String, name: String -> skills().rename(id, name) }.runOnQueue(fileQueue)
    AsyncFunction("collectSkillVersions") { keep: List<String> -> skills().collect(keep) }.runOnQueue(fileQueue)
    AsyncFunction("importSkillFile") { id: String, uri: String -> skills().importFile(id, uri) }.runOnQueue(fileQueue)
    AsyncFunction("importSkillArchive") { id: String, uri: String -> skills().importArchive(id, uri) }.runOnQueue(fileQueue)
    AsyncFunction("importSkillWorkspace") { id: String, path: String -> skills().importWorkspace(id, path) }.runOnQueue(fileQueue)
    AsyncFunction("readSkillWorking") { id: String -> skills().readWorking(id) }.runOnQueue(fileQueue)
    AsyncFunction("writeSkillDefinition") { id: String, text: String, expected: String -> skills().writeDefinition(id, text, expected) }.runOnQueue(fileQueue)
    AsyncFunction("snapshotSkill") { id: String, name: String, prune: Boolean -> skills().snapshot(id, name, prune) }.runOnQueue(fileQueue)
    AsyncFunction("readSkillResource") { id: String, name: String, version: String, path: String, expected: String, offset: Int, limit: Int -> skills().readResource(id, name, version, path, expected, offset, limit) }.runOnQueue(fileQueue)
    AsyncFunction("removeSkill") { id: String -> skills().remove(id) }.runOnQueue(fileQueue)

    AsyncFunction("listFiles") { root: String, path: String, offset: Int, query: String -> files().list(root, path, offset, query) }.runOnQueue(fileQueue)
    AsyncFunction("readFile") { root: String, path: String -> files().read(root, path) }.runOnQueue(fileQueue)
    AsyncFunction("writeFile") { root: String, path: String, text: String, expected: String -> files().write(root, path, text, expected) }.runOnQueue(fileQueue)
    AsyncFunction("createDirectory") { root: String, path: String -> files().mkdir(root, path) }.runOnQueue(fileQueue)
    AsyncFunction("moveFile") { root: String, path: String, targetRoot: String, target: String -> files().move(root, path, targetRoot, target) }.runOnQueue(fileQueue)
    AsyncFunction("copyFile") { root: String, path: String, targetRoot: String, target: String -> files().copy(root, path, targetRoot, target) }.runOnQueue(fileQueue)
    AsyncFunction("deleteFile") { root: String, path: String -> files().delete(root, path) }.runOnQueue(fileQueue)
    AsyncFunction("captureFile") { root: String, path: String ->
      files().captureSource(root, path) { file -> file.inputStream().use { capture(it, file.name, importCeiling) } }
    }.runOnQueue(fileQueue)
    AsyncFunction("saveArtifact") { name: String, text: String ->
      require(text.toByteArray().size <= 256 * 1024) { "Artifact exceeds 256 KiB" }
      text.byteInputStream().use { capture(it, name, importCeiling) }
    }.runOnQueue(fileQueue)
    AsyncFunction("readCapture") { uri: String, expected: String -> files().readCapture(uri, expected) }.runOnQueue(fileQueue)
    AsyncFunction("copyCapture") { uri: String, expected: String, root: String, path: String -> files().copyCapture(uri, expected, root, path) }.runOnQueue(fileQueue)
    AsyncFunction("deleteCapture") { uri: String, expected: String -> files().deleteCapture(uri, expected) }.runOnQueue(fileQueue)
    AsyncFunction("shareFile") { root: String, path: String -> files().share(root, path) }.runOnQueue(fileQueue)
    AsyncFunction("shareCapture") { uri: String, expected: String, name: String -> files().shareCapture(uri, expected, name) }.runOnQueue(fileQueue)

    AsyncFunction("prepareTermux") {
      preload().prepare()
    }

    AsyncFunction("startCodeMode") {
      val context = appContext.reactContext ?: error("Android context unavailable")
      preload().prepare()
      synchronized(this@ArxdRxdModule) {
        val sidecar = codeMode ?: CodeModeSidecar(
          context,
          onMessage = { line -> sendEvent("onCodeModeMessage", mapOf("line" to line)) },
          onExit = { code, stderr -> sendEvent("onCodeModeExit", mapOf("code" to code, "stderr" to stderr)) },
        ).also { codeMode = it }
        val info = sidecar.start(File(context.filesDir, "termux-preload/files"))
        mapOf("protocol" to info.protocol, "hostSha256" to info.hostSha256, "wasmSha256" to info.wasmSha256,
          "hostBytes" to info.hostBytes, "wasmBytes" to info.wasmBytes)
      }
    }

    Function("writeCodeMode") { line: String ->
      require(line.length <= 4 * 1024 * 1024) { "CodeMode message exceeds its budget" }
      codeMode?.write(line) ?: error("CodeMode sidecar is not running")
    }

    AsyncFunction("stopCodeMode") {
      synchronized(this@ArxdRxdModule) { codeMode?.stop(); codeMode = null }
    }

    AsyncFunction("runTermux") { script: String, timeoutMs: Int ->
      preload().execute(script, timeoutMs)
    }

    AsyncFunction("runShell") { requestId: String, script: String, timeoutMs: Int ->
      require(requestId.length in 1..128) { "Invalid shell request ID" }
      preload().execute(script, timeoutMs, requestId)
    }

    // Synchronous, bounded cancellation must not queue behind a running job.
    Function("registerShell") { requestId: String -> preload().register(requestId) }
    Function("cancelShell") { requestId: String -> preload().cancel(requestId) }
    Function("shellProgress") { requestId: String ->
      require(requestId.length in 1..128) { "Invalid shell request ID" }
      preload().progress(requestId)
    }

    AsyncFunction("keepPreloadAwake") { enabled: Boolean ->
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread {
          if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    AsyncFunction("listInstalledApps") { query: String, offset: Int, includeSystem: Boolean ->
      InstalledApps(appContext.reactContext ?: error("Android context unavailable")).list(query, offset, includeSystem)
    }.runOnQueue(fileQueue)
    AsyncFunction("importInstalledApp") { packageName: String, revision: String, limitBytes: Double ->
      InstalledApps(appContext.reactContext ?: error("Android context unavailable"))
        .import(packageName, revision, importLimit(limitBytes), ::capture)
    }.runOnQueue(fileQueue)

    AsyncFunction("importFile") { uri: String, name: String, limitBytes: Double ->
      val context = appContext.reactContext ?: error("Android context unavailable")
      val limit = importLimit(limitBytes)
      val parsed = Uri.parse(uri)
      require(parsed.scheme in listOf("content", "file")) { "Unsupported input URI" }
      context.contentResolver.openInputStream(parsed)?.use { capture(it, name, limit) }
        ?: error("Cannot read selected file")
    }

    AsyncFunction("importSource") { name: String, source: String ->
      require(source.toByteArray(Charsets.UTF_8).size <= 4096) { "Sample exceeds source budget" }
      source.byteInputStream().use { capture(it, name, importCeiling) }
    }

    AsyncFunction("exportText") { name: String, text: String ->
      val context = appContext.reactContext ?: error("Android context unavailable")
      val bytes = text.toByteArray(Charsets.UTF_8)
      require(bytes.size <= 256 * 1024) { "Artifact exceeds 256 KiB" }
      val directory = File(context.cacheDir, "shared-artifacts/${UUID.randomUUID()}").also { it.mkdirs() }
      val safeName = name.replace(Regex("[\\p{Cntrl}/\\\\]"), "_").take(120).ifBlank { "report.txt" }
      val file = File(directory, safeName)
      file.outputStream().use { it.write(bytes) }
      Uri.fromFile(file).toString()
    }

    AsyncFunction("getInfo") {
      val context = appContext.reactContext ?: error("Android context unavailable")
      val binary = File(context.applicationInfo.nativeLibraryDir, "librxd.so")
      if (!binary.isFile) return@AsyncFunction mapOf(
        "engineSha256" to "",
        "sourceRevision" to "",
        "available" to false,
        "abi" to Build.SUPPORTED_ABIS.first(),
        "sdk" to Build.VERSION.SDK_INT,
        "pageSize" to Os.sysconf(OsConstants._SC_PAGESIZE),
        "processId" to android.os.Process.myPid(),
        "debuggable" to ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
      )
      val digest = sha256(binary.readBytes())
      val manifest = JSONObject(context.assets.open("rxd-build.json").bufferedReader().use { it.readText() })
      check(digest == manifest.getString("binarySha256")) { "Installed rxd identity mismatch" }
      mapOf(
        "engineSha256" to digest,
        "sourceRevision" to manifest.getString("sourceRevision"),
        "available" to true,
        "abi" to Build.SUPPORTED_ABIS.first(),
        "sdk" to Build.VERSION.SDK_INT,
        "pageSize" to Os.sysconf(OsConstants._SC_PAGESIZE),
        "processId" to android.os.Process.myPid(),
        "debuggable" to ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
      )
    }

    AsyncFunction("runOutline") { source: String, inputSha256: String, engineSha256: String ->
      val context = appContext.reactContext ?: error("Android context unavailable")
      val input = source.toByteArray(Charsets.UTF_8)
      require(input.size <= 4096) { "Input exceeds 4096 UTF-8 bytes" }
      require(sha256(input) == inputSha256) { "Input identity changed" }
      val binary = File(context.applicationInfo.nativeLibraryDir, "librxd.so")
      check(binary.isFile) { "本机构建未包含分析引擎" }
      check(sha256(binary.readBytes()) == engineSha256) { "rxd changed since this task was admitted" }
      check(binary.canExecute()) { "rxd was not extracted into executable nativeLibraryDir" }
      val sample = File.createTempFile("arxd-", ".js", context.cacheDir)
      val readers = Executors.newFixedThreadPool(2)
      val started = SystemClock.elapsedRealtime()
      var process: Process? = null
      try {
        sample.writeBytes(input)
        val builder = ProcessBuilder(
          binary.absolutePath, "js", "outline", sample.absolutePath, "--jsonl",
          "--max-input-bytes", "4096", "--max-entities", "128", "--max-records", "128",
          "--max-output-bytes", "32768", "--max-ast-depth", "128"
        ).directory(context.filesDir)
        builder.environment()["TMPDIR"] = context.cacheDir.absolutePath
        val child = builder.start()
        process = child
        val stdout = readers.submit<String> { bounded(child.inputStream, 65536) }
        val stderr = readers.submit<String> { bounded(child.errorStream, 16384) }
        check(child.waitFor(10, TimeUnit.SECONDS)) { "rxd exceeded the process timeout" }
        mapOf(
          "stdout" to stdout.get(2, TimeUnit.SECONDS),
          "stderr" to stderr.get(2, TimeUnit.SECONDS),
          "exitCode" to child.exitValue(),
          "inputSha256" to inputSha256,
          "engineSha256" to engineSha256,
          "durationMs" to SystemClock.elapsedRealtime() - started
        )
      } finally {
        process?.destroyForcibly()
        readers.shutdownNow()
        sample.delete()
      }
    }

    // Bounded logging must not wait behind a running shell's async-module queue.
    Function("report") { json: String ->
      require(json.length <= 6000) { "Report too large" }
      Log.i("ArxdVerify", json)
    }
  }

  // The caller-configured import limit is bounded here so the JS side can never
  // grant more than the app ceiling.
  private fun importLimit(value: Double): Long {
    require(value.isFinite() && value >= 1 && value <= importCeiling.toDouble()) { "Import limit must be between 1 byte and 8 GiB" }
    return value.toLong()
  }

  private fun capture(input: InputStream, displayName: String, limit: Long): Map<String, Any?> {
    val context = appContext.reactContext ?: error("Android context unavailable")
    val id = UUID.randomUUID().toString()
    val name = displayName.replace(Regex("[\\p{Cntrl}/\\\\]"), "_").take(240).ifBlank { "input.bin" }
    val extension = name.substringAfterLast('.', "bin").lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,8}")) } ?: "bin"
    val directory = File(context.filesDir, "workspace-inputs").also { it.mkdirs() }
    val file = File(directory, "$id.$extension")
    var size = 0L
    val digest = MessageDigest.getInstance("SHA-256")
    // A stalled provider read fails; a slow but progressing large import does not.
    var lastProgress = SystemClock.elapsedRealtime()
    try {
      java.io.FileOutputStream(file).use { output ->
        val buffer = ByteArray(65536)
        while (true) {
          require(SystemClock.elapsedRealtime() - lastProgress < 60_000) { "File import stalled for 60 seconds" }
          val count = input.read(buffer); if (count < 0) break
          size += count
          require(size <= limit) { "Input exceeds the configured import limit" }
          digest.update(buffer, 0, count); output.write(buffer, 0, count)
          lastProgress = SystemClock.elapsedRealtime()
        }
        output.fd.sync()
      }
      val source = if (size <= 4096 && extension in listOf("js", "mjs", "cjs")) {
        runCatching { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(file.readBytes())).toString() }.getOrNull()
      } else null
      file.setWritable(false, true)
      return mapOf("id" to id, "name" to name, "uri" to Uri.fromFile(file).toString(),
        "size" to size, "sha256" to digest.digest().joinToString("") { "%02x".format(it) },
        "source" to source, "format" to extension.uppercase())
    } catch (error: Throwable) { file.delete(); throw error }
  }

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }

  private fun bounded(stream: InputStream, maximum: Int): String {
    val result = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    stream.use {
      while (true) {
        val count = it.read(buffer)
        if (count < 0) break
        check(result.size() + count <= maximum) { "rxd output exceeded its host limit" }
        result.write(buffer, 0, count)
      }
    }
    return result.toString("UTF-8")
  }
}
