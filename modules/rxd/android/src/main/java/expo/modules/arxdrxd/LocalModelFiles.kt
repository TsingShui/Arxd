package expo.modules.arxdrxd

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-private, content-addressed GGUF storage.
 *
 * Imports are copied, hashed, structurally checked and only then published under
 * an id derived from SHA-256. Nothing here executes model or input code. Every
 * cold load re-hashes the complete file before handing its path to llama.cpp, so
 * a stale registry entry can never authorize different bytes.
 */
class LocalModelFiles(private val context: Context) {
  private companion object {
    const val ceiling = 8L * 1024 * 1024 * 1024
    const val slack = 256L * 1024 * 1024
    const val registryVersion = 1
    const val maxModels = 16
    val idPattern = Regex("[a-z0-9][a-z0-9-]{0,63}")
    val shaPattern = Regex("[0-9a-f]{64}")
  }

  private data class Model(
    val id: String,
    val name: String,
    val file: String,
    val bytes: Long,
    val sha256: String,
    val source: String,
    val contextWindow: Int,
    val maxTokens: Int,
    val thinking: Boolean,
    val createdAt: Long,
  ) {
    fun json(): Map<String, Any> = mapOf(
      "id" to id, "name" to name, "bytes" to bytes, "sha256" to sha256, "source" to source,
      "contextWindow" to contextWindow, "maxTokens" to maxTokens, "thinking" to thinking,
    )

    fun encode(): JSONObject = JSONObject().put("id", id).put("name", name).put("file", file)
      .put("bytes", bytes).put("sha256", sha256).put("source", source)
      .put("contextWindow", contextWindow).put("maxTokens", maxTokens).put("thinking", thinking).put("createdAt", createdAt)
  }

  private val spec = context.assets.open("qwen-model.json").bufferedReader().use { JSONObject(it.readText()) }
  private val pinnedId = spec.getString("id")
  private val pinnedFile = spec.getString("file")
  private val pinnedSha = spec.getString("sha256")
  private val pinnedBytes = spec.getLong("bytes")
  private val pinnedName = spec.getString("model").substringAfterLast('/')
  private val defaultContext = spec.getInt("contextWindow")
  private val defaultMax = spec.getInt("maxTokens")
  private val pinnedThinking = spec.optBoolean("thinking", false)
  private val directory = File(context.noBackupFilesDir, "local-models")
  private val index = File(directory, "index.json")
  private val indexPartial = File(directory, "index.json.part")
  private val partial = File(directory, "import.part")
  private val cancelled = AtomicBoolean(false)
  private val running = AtomicBoolean(false)
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
    .callTimeout(30, TimeUnit.MINUTES).build()
  private val models = LinkedHashMap<String, Model>()
  @Volatile private var call: Call? = null
  @Volatile private var phase = "idle"
  @Volatile private var bytes = 0L
  @Volatile private var totalBytes = 0L

  init {
    directory.mkdirs()
    check(directory.isDirectory) { "端侧模型目录不可用" }
    models.putAll(loadRegistry())
    migrateLegacyPinned()
  }

  /** Registry state plus the running file operation. The JS layer owns busy/loading. */
  fun status(): Map<String, Any> {
    val installed = synchronized(this) { models.values.map { it.json() + mapOf("available" to available(it)) } }
    return mapOf(
      "operation" to if (running.get()) phase else "idle",
      "bytes" to bytes,
      "totalBytes" to totalBytes,
      "models" to installed,
    )
  }

  fun cancel() {
    cancelled.set(true)
    call?.cancel()
  }

  /** Download the single pinned release. Imported content never becomes this entry. */
  fun download() {
    begin("downloading", pinnedBytes)
    val deadline = SystemClock.elapsedRealtime() + 30 * 60_000
    var response: Response? = null
    try {
      val existing = synchronized(this) { models[pinnedId] }
      if (existing != null && available(existing)) return
      partial.delete()
      check(directory.usableSpace > pinnedBytes + slack) { "存储空间不足，无法下载端侧模型" }
      var url = URL("https://huggingface.co/${spec.getString("repository")}/resolve/${spec.getString("revision")}/${spec.getString("file")}")
      for (redirect in 0..5) {
        check(deadline)
        check(url.protocol == "https" && url.userInfo == null) { "端侧模型下载需要 HTTPS" }
        val request = http.newCall(Request.Builder().url(url).header("Accept-Encoding", "identity").build())
        request.timeout().timeout(deadline - SystemClock.elapsedRealtime(), TimeUnit.MILLISECONDS)
        call = request
        check(deadline)
        if (VerificationAccess.enabled(context)) android.util.Log.i("ArxdVerify", JSONObject().put("event", "arxd-local-transport").put("stage", "request").put("host", url.host).toString())
        val reply = request.execute()
        if (VerificationAccess.enabled(context)) android.util.Log.i("ArxdVerify", JSONObject().put("event", "arxd-local-transport").put("stage", "headers").put("status", reply.code).toString())
        response = reply
        if (reply.code in listOf(301, 302, 303, 307, 308)) {
          val location = reply.header("Location") ?: error("缺少模型下载重定向地址")
          url = URL(url, location)
          reply.close()
          response = null
        } else {
          check(reply.code == 200) { "端侧模型下载失败（HTTP ${reply.code}）" }
          break
        }
      }
      val body = response?.body ?: error("端侧模型下载重定向过多或响应为空")
      check(body.contentLength() == -1L || body.contentLength() == pinnedBytes) { "端侧模型下载大小不符" }
      val hash = MessageDigest.getInstance("SHA-256")
      body.byteStream().use { input -> FileOutputStream(partial).use { output ->
        val buffer = ByteArray(256 * 1024)
        while (true) {
          check(deadline)
          val read = input.read(buffer)
          if (read < 0) break
          check(bytes + read <= pinnedBytes) { "端侧模型超出下载预算" }
          output.write(buffer, 0, read)
          hash.update(buffer, 0, read)
          bytes += read
        }
        output.fd.sync()
      } }
      check(deadline)
      phase = "verifying"
      check(bytes == pinnedBytes && hash.digest().joinToString("") { "%02x".format(it) } == pinnedSha) { "端侧模型校验失败" }
      val target = File(directory, pinnedFile)
      check(partial.renameTo(target)) { "无法保存端侧模型" }
      synchronized(this) {
        models[pinnedId] = Model(pinnedId, pinnedName, pinnedFile, pinnedBytes, pinnedSha, "download", defaultContext, defaultMax, pinnedThinking, System.currentTimeMillis())
        File(directory, "qwen.sha256").delete()
        save()
      }
    } finally {
      response?.close()
      call = null
      partial.delete()
      running.set(false)
    }
  }

  /**
   * Copy one user-selected GGUF, bind it to its content hash and register it.
   * Returns the existing record when the exact bytes are already installed.
   */
  fun importModel(uri: String, name: String): Map<String, Any> {
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "content" || parsed.scheme == "file") { "端侧模型需要本地文件" }
    begin("importing", 0)
    val deadline = SystemClock.elapsedRealtime() + 30 * 60_000
    try {
      partial.delete()
      check(directory.usableSpace > slack) { "存储空间不足，无法导入端侧模型" }
      val input = context.contentResolver.openInputStream(parsed) ?: error("无法读取所选文件")
      input.use { source -> FileOutputStream(partial).use { output ->
        copy(source, output, deadline)
        output.fd.sync()
      } }
      val (model, imported) = registerImport(name, deadline)
      return model.json() + mapOf("available" to available(model), "imported" to imported)
    } finally {
      partial.delete()
      running.set(false)
    }
  }

  /** Re-hash a registered model before a cold llama.cpp load. */
  fun verifiedPath(id: String): String {
    val model = synchronized(this) { models[id] } ?: error("端侧模型不存在，请重新下载或导入")
    begin("verifying", model.bytes)
    try {
      val file = fileFor(model)
      check(file.isFile && file.length() == model.bytes) { "端侧模型文件缺失，请重新导入" }
      check(digest(file, SystemClock.elapsedRealtime() + 120_000) == model.sha256) { "端侧模型校验失败，请重新导入" }
      return file.absolutePath
    } finally { running.set(false) }
  }

  /** Persist compatibility limits discovered by the real llama.cpp probe. */
  fun setLimits(id: String, contextWindow: Int, maxTokens: Int, thinking: Boolean) {
    require(contextWindow in 2048..8192) { "端侧模型上下文超出范围" }
    require(maxTokens in 128..2048) { "端侧模型输出预算超出范围" }
    synchronized(this) {
      val model = models[id] ?: error("端侧模型不存在")
      models[id] = model.copy(contextWindow = contextWindow, maxTokens = maxTokens, thinking = thinking)
      save()
    }
  }

  fun remove(id: String) {
    begin("removing", 0)
    try {
      synchronized(this) {
        val model = models[id] ?: error("端侧模型不存在")
        val file = fileFor(model)
        check(!file.exists() || file.delete()) { "无法删除端侧模型文件" }
        models.remove(id)
        save()
      }
    } finally { running.set(false) }
  }

  /** Verification-only transport fixture for the pinned bytes; still checks the production hash. */
  fun stageVerificationFixture() {
    begin("verifying", pinnedBytes)
    val deadline = SystemClock.elapsedRealtime() + 120_000
    try {
      val source = File("/data/local/tmp/arxd-qwen-${context.packageName}.gguf")
      check(source.isFile && source.length() == pinnedBytes) { "测试模型文件缺失或大小不符" }
      check(directory.usableSpace > pinnedBytes + slack) { "存储空间不足" }
      partial.delete()
      source.inputStream().use { input -> FileOutputStream(partial).use { output ->
        copy(input, output, deadline)
        output.fd.sync()
      } }
      check(bytes == pinnedBytes && digest(partial, deadline) == pinnedSha) { "测试模型文件校验失败" }
      val target = File(directory, pinnedFile)
      check(partial.renameTo(target)) { "无法保存测试模型文件" }
      synchronized(this) {
        models[pinnedId] = Model(pinnedId, pinnedName, pinnedFile, pinnedBytes, pinnedSha, "download", defaultContext, defaultMax, pinnedThinking, System.currentTimeMillis())
        File(directory, "qwen.sha256").delete()
        save()
      }
    } finally {
      partial.delete()
      running.set(false)
    }
  }

  /** Verification-only disclosure of the fixed, hash-checked fixture path. */
  fun fixturePath(): String {
    val file = File("/data/local/tmp/arxd-qwen-${context.packageName}.gguf")
    check(file.isFile && file.length() == pinnedBytes) { "测试模型文件缺失或大小不符" }
    return file.absolutePath
  }

  private fun begin(state: String, total: Long) {
    check(running.compareAndSet(false, true)) { "端侧模型正在执行其他操作" }
    cancelled.set(false)
    phase = state
    bytes = 0
    totalBytes = total
  }

  private fun available(model: Model): Boolean = fileFor(model).let { it.isFile && it.length() == model.bytes }

  private fun fileFor(model: Model) = File(directory, model.file)

  private fun check(deadline: Long) {
    check(!cancelled.get()) { "端侧模型操作已取消" }
    check(SystemClock.elapsedRealtime() < deadline) { "端侧模型操作超时" }
  }

  private fun digest(file: File, deadline: Long): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1024 * 1024)
      while (true) {
        check(deadline)
        val read = input.read(buffer)
        if (read < 0) break
        hash.update(buffer, 0, read)
      }
    }
    return hash.digest().joinToString("") { "%02x".format(it) }
  }

  /** Copy with a hard ceiling, cancellation and a stalled-provider deadline. */
  private fun copy(input: InputStream, output: OutputStream, deadline: Long) {
    val buffer = ByteArray(256 * 1024)
    var lastProgress = SystemClock.elapsedRealtime()
    while (true) {
      check(deadline)
      check(SystemClock.elapsedRealtime() - lastProgress < 60_000) { "端侧模型导入停滞超过 60 秒" }
      val read = input.read(buffer)
      if (read < 0) break
      check(bytes + read <= ceiling) { "端侧模型超过 8 GiB 导入上限" }
      output.write(buffer, 0, read)
      bytes += read
      lastProgress = SystemClock.elapsedRealtime()
    }
  }

  private fun registerImport(name: String, deadline: Long): Pair<Model, Boolean> {
    phase = "verifying"
    val sha = digest(partial, deadline)
    synchronized(this) {
      models.values.firstOrNull { it.sha256 == sha }?.let { return it to false }
      check(models.size < maxModels) { "端侧模型数量已达上限（16）" }
      checkGguf(partial)
      val id = "gguf-" + sha.substring(0, 16)
      check(!models.containsKey(id)) { "端侧模型 ID 冲突" }
      val target = File(directory, "$id.gguf")
      check(partial.renameTo(target)) { "无法发布端侧模型" }
      val model = Model(id, displayName(name), target.name, target.length(), sha, "import", defaultContext, defaultMax, false, System.currentTimeMillis())
      models[id] = model
      save()
      return model to true
    }
  }

  /** Structural GGUF gate. The runtime probe still proves architecture and template support. */
  private fun checkGguf(file: File) {
    check(file.length() >= 24) { "不是有效的 GGUF 模型" }
    FileInputStream(file).use { input ->
      val header = ByteArray(24)
      var read = 0
      while (read < header.size) {
        val count = input.read(header, read, header.size - read)
        if (count < 0) break
        read += count
      }
      check(read == header.size) { "不是有效的 GGUF 模型" }
      check(String(header, 0, 4, Charsets.US_ASCII) == "GGUF") { "不是有效的 GGUF 模型" }
      val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
      val version = buffer.getInt(4)
      check(version == 2 || version == 3) { "不支持的 GGUF 版本" }
      val tensors = buffer.getLong(8)
      val metadata = buffer.getLong(16)
      check(tensors in 1..10_000_000 && metadata in 1..1_000_000) { "GGUF 元数据异常" }
    }
  }

  private fun displayName(raw: String): String {
    val base = raw.substringAfterLast('/').substringAfterLast('\\')
      .replace(Regex("\\.gguf$", RegexOption.IGNORE_CASE), "")
      .replace(Regex("[\\p{Cntrl}]"), " ")
      .trim()
    return base.take(80).ifBlank { "端侧模型" }
  }

  private fun loadRegistry(): Map<String, Model> {
    if (!index.isFile) return emptyMap()
    return try {
      val root = JSONObject(index.readText())
      check(root.getInt("version") == registryVersion) { "端侧模型注册表版本不兼容" }
      val array = root.getJSONArray("models")
      check(array.length() <= maxModels) { "端侧模型数量超出上限" }
      val result = LinkedHashMap<String, Model>()
      for (i in 0 until array.length()) {
        val item = array.getJSONObject(i)
        val id = item.getString("id")
        val model = Model(
          id, item.getString("name"), item.getString("file"), item.getLong("bytes"),
          item.getString("sha256"), item.getString("source"), item.getInt("contextWindow"),
          item.getInt("maxTokens"),
          if (item.has("thinking")) item.getBoolean("thinking") else id == pinnedId && pinnedThinking,
          item.optLong("createdAt", 0),
        )
        check(model.id.matches(idPattern) && model.sha256.matches(shaPattern)) { "端侧模型身份无效" }
        check(model.file == "${model.id}.gguf" || model.id == pinnedId && model.file == pinnedFile) { "端侧模型路径无效" }
        check(model.bytes in 1..ceiling) { "端侧模型大小无效" }
        check(model.contextWindow in 2048..8192 && model.maxTokens in 128..2048) { "端侧模型预算无效" }
        check(model.source == "download" || model.source == "import") { "端侧模型来源无效" }
        result[model.id] = model
      }
      result
    } catch (error: Throwable) {
      // A damaged registry must not authorize model use. Quarantine it and let
      // the user re-import; the bytes stay untouched in this private directory.
      index.renameTo(File(directory, "index.corrupt-${SystemClock.elapsedRealtime()}.json"))
      if (VerificationAccess.enabled(context)) android.util.Log.i("ArxdVerify", JSONObject().put("event", "arxd-local-registry").put("stage", "quarantined").put("error", error.toString().take(300)).toString())
      emptyMap()
    }
  }

  /** Adopt the pre-registry single-model install without trusting it beyond its receipt. */
  private fun migrateLegacyPinned() {
    if (models.containsKey(pinnedId)) return
    val legacy = File(directory, pinnedFile)
    val receipt = File(directory, "qwen.sha256")
    if (!legacy.isFile || legacy.length() != pinnedBytes) return
    if (!receipt.isFile || receipt.readText().trim() != pinnedSha) return
    models[pinnedId] = Model(pinnedId, pinnedName, pinnedFile, pinnedBytes, pinnedSha, "download", defaultContext, defaultMax, pinnedThinking, System.currentTimeMillis())
    runCatching { save() }
  }

  @Synchronized private fun save() {
    val array = JSONArray()
    for (model in models.values) array.put(model.encode())
    val payload = JSONObject().put("version", registryVersion).put("models", array).toString().toByteArray(Charsets.UTF_8)
    check(payload.size <= 64 * 1024) { "端侧模型注册表超出预算" }
    FileOutputStream(indexPartial).use { output ->
      output.write(payload)
      output.fd.sync()
    }
    check(indexPartial.renameTo(index)) { "无法保存端侧模型注册表" }
  }
}
