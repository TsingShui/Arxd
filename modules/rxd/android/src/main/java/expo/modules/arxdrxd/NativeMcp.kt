package expo.modules.arxdrxd

import android.content.Context
import android.os.SystemClock
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Native transport ownership is independent of JS promises, screens and Agent turns. */
internal class NativeMcp private constructor(private val context: Context) {
  companion object {
    const val VERSION = "2025-11-25"
    private const val MESSAGE_BYTES = 1048576
    private const val PARAM_BYTES = 262144
    private const val MAX_PENDING = 16
    @Volatile private var singleton: NativeMcp? = null
    fun get(context: Context): NativeMcp = singleton ?: synchronized(this) {
      singleton ?: NativeMcp(context.applicationContext).also { singleton = it }
    }
    private val toolName = Regex("[a-zA-Z0-9_.-]{1,128}")
    private fun objectCopy(value: JSONObject) = JSONObject(value.toString())
    private fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes)).toString()
    // org.json is recursive: reject adversarial nesting before entering its parser.
    private fun json(bytes: ByteArray): JSONObject {
      require(bytes.size <= MESSAGE_BYTES) { "MCP JSON exceeds message budget" }
      val text = utf8(bytes)
      var depth = 0; var quoted = false; var escaped = false
      for (ch in text) {
        if (quoted) { if (escaped) escaped = false else if (ch == '\\') escaped = true else if (ch == '"') quoted = false }
        else if (ch == '"') quoted = true
        else if (ch == '{' || ch == '[') { check(++depth <= 64) { "MCP JSON nesting exceeds budget" } }
        else if (ch == '}' || ch == ']') depth--
      }
      return JSONObject(text)
    }
    private fun validId(value: String) { require(runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)) { "Invalid MCP identifier" } }
    val limits: Map<String, Any> = mapOf("maxConnections" to 16, "maxPending" to MAX_PENDING,
      "maxPendingPerServer" to 8, "maxMessageBytes" to MESSAGE_BYTES, "maxParamsBytes" to PARAM_BYTES,
      "maxToolsPerPage" to 128, "maxTimeoutMs" to 120000, "automaticReplay" to false,
      "supportedProtocolVersion" to VERSION, "serverRequests" to listOf("ping"))
  }
  private class Client(val id: String, val transport: String, val processId: String?, val url: HttpUrl?, val headers: Map<String, String>) {
    @Volatile var connectionId = UUID.randomUUID().toString()
    @Volatile var catalogId: String? = null
    @Volatile var ended = false
    val writeLock = Any()
    val input = ByteArrayOutputStream()
    val lifecycle = Any()
    val epoch = AtomicLong()
    val revision = AtomicLong(0)
    @Volatile var enabled = true
    @Volatile var phase = "connecting"
    @Volatile var reason: String? = null
    @Volatile var initialized = false
    @Volatile var initializeSent = false
    @Volatile var session: String? = null
    @Volatile var serverInfo = JSONObject()
    @Volatile var capabilities = JSONObject()
    @Volatile var listener: Call? = null
    @Volatile var listening = false
    var notificationWindow = 0L
    var notifications = 0
  }
  private class Pending(val client: Client, val id: String, val invocation: String, val method: String, val deadline: Long) {
    val done = AtomicBoolean(false)
    val ready = CountDownLatch(1)
    @Volatile var result: JSONObject? = null
    @Volatile var error: String? = null
    @Volatile var call: Call? = null
    fun finish(value: JSONObject? = null, failure: String? = null) {
      if (done.compareAndSet(false, true)) { result = value; error = failure; ready.countDown() }
    }
  }
  private val clients = ConcurrentHashMap<String, Client>()
  private val byProcess = ConcurrentHashMap<String, Client>()
  private val pending = ConcurrentHashMap<String, Pending>()
  private val httpCalls = ConcurrentHashMap<Call, Client>()
  private val invocations = linkedSetOf<String>()
  private val admission = Any()
  private val httpPolicy = PlainHttpMcpPolicy(context)
  private fun requireHttpPolicy(url: HttpUrl?) {
    check(url?.scheme != "http" || httpPolicy.allowed) { "Plain HTTP MCP is disabled; enable it explicitly in the MCP page. HTTPS and stdio are unaffected" }
  }
  fun httpPolicy(): JSONObject = synchronized(admission) { httpPolicy.view() }
  fun setHttpPolicy(allowed: Boolean): JSONObject = synchronized(admission) {
    try { httpPolicy.set(allowed) } finally {
      if (!httpPolicy.allowed) for (c in clients.values) if (c.url?.scheme == "http") {
        disconnectClient(c); c.initialized = false; c.catalogId = null; c.revision.incrementAndGet()
        c.reason = "Plain HTTP MCP disabled; any in-flight effect may be unknown; no automatic replay"
        publish(c)
      }
      if (!httpPolicy.allowed) for ((call, c) in httpCalls) if (c.url?.scheme == "http") call.cancel()
    }
    httpPolicy.view()
  }
  private val sequence = AtomicLong()
  private val workers = ThreadPoolExecutor(8, 8, 30, TimeUnit.SECONDS, ArrayBlockingQueue(32))
  private val listeners = ThreadPoolExecutor(16, 16, 30, TimeUnit.SECONDS, ArrayBlockingQueue(16))
  private val controls = ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS, ArrayBlockingQueue(32))
  // No authenticator, redirects, automatic connection retry or repeatable POST bodies.
  private val http = OkHttpClient.Builder().retryOnConnectionFailure(false)
    .followRedirects(false).followSslRedirects(false).connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(10, TimeUnit.SECONDS).build()
  @Volatile var changed: (() -> Unit)? = null

  private fun publish(@Suppress("UNUSED_PARAMETER") client: Client) { runCatching { changed?.invoke() } }
  private fun safe(client: Client, text: String): String {
    var value = text.take(2048)
    for (secret in client.headers.values.sortedByDescending { it.length }) if (secret.isNotEmpty()) {
      value = value.replace(secret, "[redacted]")
      if (secret.startsWith("Bearer ", true)) value = value.replace(secret.substring(7), "[redacted]")
    }
    client.session?.takeIf { it.isNotEmpty() }?.let { value = value.replace(it, "[session]") }
    return value.take(1000)
  }
  private fun fail(client: Client, reason: String) {
    client.phase = "failed"; client.reason = safe(client, reason)
    client.listener?.cancel(); client.listener = null
    for (p in pending.values) if (p.client === client) { p.call?.cancel(); p.finish(failure = client.reason) }
    publish(client)
  }
  private fun view(c: Client) = JSONObject().put("id", c.id).put("connectionId", c.connectionId).put("catalogId", c.catalogId ?: JSONObject.NULL)
    .put("transport", c.transport).put("processId", c.processId ?: JSONObject.NULL)
    .put("state", c.phase).put("enabled", c.enabled).put("protocolVersion", if (c.initialized) VERSION else JSONObject.NULL)
    .put("serverInfo", objectCopy(c.serverInfo)).put("capabilities", objectCopy(c.capabilities))
    .put("toolsRevision", c.revision.get()).put("policyBlocked", c.url?.scheme == "http" && !httpPolicy.allowed).put("reason", c.reason ?: JSONObject.NULL).put("limits", JSONObject(limits))
  fun state(id: String): JSONObject = view(clients[id] ?: error("MCP connection is not loaded"))
  fun states(): JSONArray = JSONArray(clients.values.sortedBy { it.id }.map { view(it) })

  fun connect(configJson: String): JSONObject {
    require(configJson.toByteArray().size <= 24576) { "MCP configuration exceeds budget" }
    val config = runCatching { json(configJson.toByteArray(Charsets.UTF_8)) }.getOrElse { error("Invalid MCP configuration JSON") }
    val id = config.getString("id"); validId(id)
    val transport = config.getString("transport"); require(transport == "stdio" || transport == "http") { "Unsupported MCP transport" }
    val processId = config.optString("processId").takeIf { it.isNotEmpty() }; processId?.let { validId(it) }
    require(transport != "stdio" || processId != null) { "Stdio MCP requires a managed process instance" }
    val url = if (transport == "http") {
      require(config.getString("url").length <= 4096) { "MCP endpoint exceeds budget" }
      runCatching { config.getString("url").toHttpUrl() }.getOrElse { error("Invalid HTTP MCP endpoint") }.also {
        require(it.username.isEmpty() && it.password.isEmpty() && it.fragment == null) { "Use authentication headers, not URL credentials or fragments" }
      }
    } else null
    val rawHeaders = config.optJSONObject("headers") ?: JSONObject()
    require(rawHeaders.length() <= 32 && rawHeaders.toString().toByteArray().size <= 16384) { "MCP headers exceed budget" }
    val headers = rawHeaders.keys().asSequence().associateWith { key ->
      require(key.matches(Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+"))) { "Invalid MCP header name" }
      require(key.lowercase() !in setOf("host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version")) { "Reserved MCP header" }
      rawHeaders.getString(key).also { value -> require(value.all { it.code in 32..126 || it == '\t' }) { "Invalid MCP header value" } }
    }
    val c = synchronized(admission) {
      requireHttpPolicy(url)
      val old = clients[id]
      if (old != null && old.transport == transport && old.processId == processId && old.url == url && old.headers == headers) old
      else {
        check(old == null || old.ended || (old.transport == "http" && transport == "http")) { "An existing stdio binding cannot be changed; use a new managed process" }
        if (clients.size >= 16 && old == null) {
          val retired = clients.values.firstOrNull { candidate ->
            (candidate.ended || (candidate.transport == "http" && (!candidate.enabled || candidate.phase == "failed"))) && pending.values.none { it.client === candidate }
          }
          retired?.let { disconnectClient(it); clients.remove(it.id, it); it.processId?.let { pid -> byProcess.remove(pid, it) } }
        }
        check(clients.size < 16 || old != null) { "MCP connection budget reached" }
        if (transport == "stdio" && processId != null) check(byProcess[processId] == null || byProcess[processId] === old) { "Managed process already has an MCP binding" }
        old?.let { disconnectClient(it); it.processId?.let { pid -> byProcess.remove(pid, it) } }
        Client(id, transport, processId, url, headers).also { clients[id] = it; if (transport == "stdio" && processId != null) byProcess[processId] = it }
      }
    }
    synchronized(c.lifecycle) {
      val epoch = c.epoch.get()
      try {
      if (processId != null) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (true) {
          check(c.epoch.get() == epoch) { "MCP connection was disconnected" }
          val record = ManagedProcesses.get(context).inspect(processId)
          if (transport == "stdio") check(record["protocolOwner"] == id) { "The managed process does not reserve protocol pipes for this MCP configuration" }
          if (record["state"] == "running") break
          check(record["state"] in setOf("queued", "starting")) { "The managed process is unavailable; no restart was attempted" }
          check(SystemClock.elapsedRealtime() < deadline) { "Managed process startup exceeded 15 seconds" }
          Thread.sleep(25)
        }
      }
      check(c.epoch.get() == epoch) { "MCP connection was disconnected" }
      synchronized(admission) { requireHttpPolicy(c.url) }
      if (c.initialized && c.phase != "failed") {
        c.enabled = true; c.phase = "connecting"; c.reason = null
        invoke(c, "connect-ping-" + UUID.randomUUID(), "ping", JSONObject(), 15000, internal = true)
        check(c.epoch.get() == epoch) { "MCP connection was disconnected" }
        c.phase = "connected"
        if (transport == "http") listen(c)
        publish(c); return view(c)
      }
      check(transport != "stdio" || !c.initializeSent) { "Stdio initialization was already attempted; refusing to replay it on the same pipes" }
      if (c.initializeSent) c.connectionId = UUID.randomUUID().toString()
      c.enabled = true; c.phase = "connecting"; c.reason = null; c.session = null
        val result = invoke(c, "connect-" + UUID.randomUUID(), "initialize", JSONObject()
          .put("protocolVersion", VERSION).put("capabilities", JSONObject())
          .put("clientInfo", JSONObject().put("name", "Arxd").put("version", "1")), 15000, internal = true)
        check(result.optString("protocolVersion") == VERSION) { "Unsupported MCP protocol version (expected $VERSION)" }
        val capabilities = result.getJSONObject("capabilities")
        val info = result.getJSONObject("serverInfo")
        check(info.toString().toByteArray().size <= 8192 && capabilities.toString().toByteArray().size <= 8192) { "MCP negotiation exceeds metadata budget" }
        c.capabilities = objectCopy(capabilities); c.serverInfo = objectCopy(info)
        check(c.epoch.get() == epoch) { "MCP connection was disconnected during initialization" }
        c.initialized = true
        notify(c, "notifications/initialized", JSONObject())
        check(c.epoch.get() == epoch) { "MCP connection was disconnected during initialization" }
        c.phase = "connected"; c.revision.incrementAndGet()
        if (transport == "http") listen(c)
        publish(c); return view(c)
      } catch (error: Exception) {
        if (c.epoch.get() == epoch) fail(c, safe(c, error.message ?: "MCP initialization failed"))
        throw IllegalStateException(c.reason ?: "MCP connection was disconnected")
      }
    }
  }

  fun publishCatalog(serverId: String, connectionId: String, revision: Long, catalogId: String): JSONObject = synchronized(admission) {
    require(catalogId.matches(Regex("[a-f0-9]{32}"))) { "Invalid offered MCP catalog identity" }
    val c = clients[serverId] ?: error("MCP connection is not loaded")
    requireHttpPolicy(c.url)
    check(c.enabled && c.phase == "connected" && c.connectionId == connectionId && c.revision.get() == revision) { "MCP binding changed before catalog publication" }
    c.catalogId = catalogId
    view(c)
  }

  fun request(serverId: String, invocationId: String, method: String, paramsJson: String, timeoutMs: Int,
    expectedConnectionId: String? = null, expectedToolsRevision: Long? = null, expectedCatalogId: String? = null): JSONObject {
    val c = clients[serverId] ?: error("MCP connection is not loaded")
    require(method in setOf("tools/list", "tools/call", "ping")) { "Unsupported MCP client method" }
    require(paramsJson.toByteArray().size <= PARAM_BYTES) { "MCP parameters exceed budget" }
    val params = runCatching { json(paramsJson.toByteArray(Charsets.UTF_8)) }.getOrElse { error("Invalid MCP request JSON") }
    if (method == "tools/list") require(!params.has("cursor") || params.getString("cursor").length <= 4096) { "MCP pagination cursor exceeds budget" }
    if (method == "tools/call") {
      require(params.getString("name").matches(toolName)) { "Invalid MCP tool name" }
      require(!params.has("arguments") || params.optJSONObject("arguments") != null) { "MCP tool arguments must be an object" }
    }
    check(method == "ping" || c.capabilities.optJSONObject("tools") != null) { "MCP server does not advertise tools" }
    return invoke(c, invocationId, method, params, timeoutMs, expectedConnectionId = expectedConnectionId, expectedToolsRevision = expectedToolsRevision, expectedCatalogId = expectedCatalogId)
  }
  private fun invoke(c: Client, invocation: String, method: String, params: JSONObject, timeoutMs: Int, internal: Boolean = false,
    expectedConnectionId: String? = null, expectedToolsRevision: Long? = null, expectedCatalogId: String? = null): JSONObject {
    require(invocation.length in 1..160 && timeoutMs in 100..120000) { "Invalid MCP invocation or timeout" }
    val p = synchronized(admission) {
      requireHttpPolicy(c.url)
      check(clients[c.id] === c) { "MCP connection binding changed before native admission" }
      if (expectedConnectionId != null) {
        check(c.connectionId == expectedConnectionId && c.revision.get() == expectedToolsRevision) { "MCP connection or catalog revision changed before native admission" }
      }
      if (expectedCatalogId != null) {
        check(c.catalogId == expectedCatalogId) { "Offered MCP catalog changed before native admission" }
      }
      check(internal || (c.enabled && c.phase == "connected")) { "MCP server is disabled or disconnected" }
      check(pending.size < MAX_PENDING && pending.values.count { it.client === c } < 8) { "MCP pending-request budget reached" }
      check(!invocations.contains(invocation)) { "MCP invocation was already admitted; unsafe requests are never replayed" }
      check(invocations.size < 4096) { "MCP invocation ledger is full; reopen the host before admitting more requests" }
      invocations.add(invocation)
      Pending(c, sequence.incrementAndGet().toString(), invocation, method, SystemClock.elapsedRealtime() + timeoutMs).also { pending[invocation] = it }
    }
    try {
      val message = JSONObject().put("jsonrpc", "2.0").put("id", p.id).put("method", method).put("params", params)
      if (method == "initialize") c.initializeSent = true
      workers.execute { try {
        if (!p.done.get()) { if (c.transport == "stdio") sendStdio(c, message, p) else post(c, message, p) }
      } catch (error: Exception) {
        val reason = if (error.message?.startsWith("MCP ") == true) error.message!! else "MCP transport failed: " + error.javaClass.simpleName
        if (!p.done.get()) {
          p.finish(failure = safe(c, reason + "; execution may be uncertain, no automatic replay"))
          if (c.transport == "http") { c.reason = p.error; c.phase = "disconnected"; publish(c) }
        }
      } }
      if (!p.ready.await((p.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1), TimeUnit.MILLISECONDS)) cancelPending(p, "MCP request timed out; execution outcome may be unknown")
      p.error?.let { throw IllegalStateException(it) }
      return p.result ?: error("MCP response is unavailable; do not replay automatically")
    } catch (error: InterruptedException) {
      cancelPending(p, "MCP request interrupted; execution outcome may be unknown"); Thread.currentThread().interrupt()
      throw IllegalStateException(p.error)
    } finally { pending.remove(invocation, p) }
  }
  private fun cancelPending(p: Pending, reason: String) {
    if (p.done.get()) return
    p.finish(failure = reason); p.call?.cancel()
    if (p.method != "initialize") runCatching { controls.execute { runCatching { notify(p.client, "notifications/cancelled", JSONObject().put("requestId", p.id).put("reason", "Client cancelled")) } } }
  }
  fun cancel(invocationId: String) {
    val p = synchronized(admission) {
      pending[invocationId].also {
        if (it == null && invocationId.length in 1..160 && invocations.size < 4096) invocations.add(invocationId)
      }
    }
    p?.let { cancelPending(it, "MCP request cancelled; execution outcome may be unknown") }
  }
  fun setEnabled(id: String, value: Boolean): JSONObject {
    val c = clients[id] ?: error("MCP connection is not loaded")
    synchronized(admission) { if (value) requireHttpPolicy(c.url); c.enabled = value }
    if (!value) for (p in pending.values) if (p.client === c) cancelPending(p, "MCP access disabled; execution outcome may be unknown")
    publish(c); return view(c)
  }
  private fun disconnectClient(c: Client) {
    c.epoch.incrementAndGet(); c.enabled = false; c.phase = "disconnected"; c.listener?.cancel(); c.listener = null; c.listening = false
    for (p in pending.values) if (p.client === c) cancelPending(p, "MCP disconnected; execution outcome may be unknown")
    publish(c)
  }
  fun disconnect(id: String): JSONObject { val c = clients[id] ?: error("MCP connection is not loaded"); disconnectClient(c); return view(c) }
  fun processEnded(instanceId: String) { for (c in clients.values) if (c.processId == instanceId) { c.ended = true; fail(c, "Managed process exited or ownership was lost; no restart was attempted") } }

  private fun sendStdio(c: Client, message: JSONObject, p: Pending? = null) {
    val frame = (message.toString() + "\n").toByteArray(Charsets.UTF_8)
    require(frame.size <= MESSAGE_BYTES) { "MCP protocol message exceeds budget" }
    synchronized(c.writeLock) {
      check(c.phase != "failed" && !c.ended) { "MCP protocol writes are unavailable after connection failure" }
      var offset = 0
      try {
        while (offset < frame.size) {
          check(p == null || (!p.done.get() && SystemClock.elapsedRealtime() < p.deadline)) { "MCP write cancelled or timed out" }
          val end = (offset + 16384).coerceAtMost(frame.size)
          ManagedProcesses.get(context).write(c.processId!!, frame.copyOfRange(offset, end), protocolOwner = c.id)
          offset = end
        }
      } catch (error: Exception) {
        if (offset > 0 || p?.done?.get() != true) fail(c, "MCP stdin delivery is uncertain; refusing further protocol writes")
        throw error
      }
    }
  }
  fun accept(instanceId: String, bytes: ByteArray) {
    val c = byProcess[instanceId] ?: return
    if (c.phase == "failed") return // stdout is still drained by its owner
    synchronized(c.input) {
      try {
        for (byte in bytes) {
          if (byte == 10.toByte()) {
            val frame = c.input.toByteArray(); c.input.reset()
            check(frame.isNotEmpty()) { "Empty stdio MCP frame" }
            receive(c, json(frame))
          } else { check(c.input.size() < MESSAGE_BYTES) { "MCP stdout frame exceeds budget" }; c.input.write(byte.toInt()) }
        }
      } catch (_: Exception) { c.input.reset(); fail(c, "Malformed or oversized MCP stdout frame") }
    }
  }
  private fun receive(c: Client, message: JSONObject) {
    check(message.optString("jsonrpc") == "2.0") { "Invalid JSON-RPC version" }
    synchronized(c) {
      val now = SystemClock.elapsedRealtime()
      if (now - c.notificationWindow >= 1000) { c.notificationWindow = now; c.notifications = 0 }
      check(++c.notifications <= 256) { "MCP inbound message rate exceeds budget" }
    }
    if (message.has("method")) {
      val method = message.getString("method")
      if (!message.has("id")) {
        if (method == "notifications/tools/list_changed") { c.revision.incrementAndGet(); publish(c) }
        if (method == "notifications/cancelled") {
          val id = message.optJSONObject("params")?.opt("requestId")?.toString()
          pending.values.firstOrNull { it.client === c && it.id == id }?.finish(failure = "MCP server cancelled the request; execution outcome may be unknown")
        }
        return // optional notifications are drained without unbounded retention
      }
      val reply = JSONObject().put("jsonrpc", "2.0").put("id", message.get("id"))
      if (method == "ping") reply.put("result", JSONObject())
      else reply.put("error", JSONObject().put("code", -32601).put("message", "Client capability is not supported"))
      controls.execute { runCatching { if (c.transport == "stdio") sendStdio(c, reply) else post(c, reply, null) } }
      return
    }
    val id = message.opt("id")?.toString() ?: error("Missing JSON-RPC response id")
    val p = pending.values.firstOrNull { it.client === c && it.id == id } ?: return // late response after cancellation
    if (message.has("error")) {
      val error = message.getJSONObject("error")
      p.finish(failure = safe(c, "MCP RPC error " + error.optInt("code") + ": " + error.optString("message").take(800)))
    } else {
      check(message.has("result")) { "Missing JSON-RPC result" }
      val result = message.getJSONObject("result")
      if (p.method == "tools/list") {
        val tools = result.getJSONArray("tools"); check(tools.length() <= 128) { "MCP tools page exceeds 128 tools" }
        val names = hashSetOf<String>()
        for (i in 0 until tools.length()) {
          val tool = tools.getJSONObject(i)
          check(tool.getString("name").matches(toolName) && names.add(tool.getString("name"))) { "Invalid or duplicate MCP tool name" }
          check(tool.getJSONObject("inputSchema").optString("type") == "object") { "MCP tool schema must describe an object" }
        }
        check(!result.has("nextCursor") || result.getString("nextCursor").length <= 4096) { "MCP pagination cursor exceeds budget" }
      }
      if (p.method == "tools/call") {
        check(result.getJSONArray("content").length() <= 1024) { "MCP tool content count exceeds budget" }
        check(!result.has("isError") || result.get("isError") is Boolean) { "Invalid MCP tool error flag" }
      }
      p.finish(value = result)
    }
  }
  private fun notify(c: Client, method: String, params: JSONObject) {
    val message = JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params)
    if (c.transport == "stdio") sendStdio(c, message) else post(c, message, null)
  }
  private fun builder(c: Client): Request.Builder {
    val request = Request.Builder().url(c.url!!)
    for ((key, value) in c.headers) request.header(key, value)
    if (c.initialized) request.header("MCP-Protocol-Version", VERSION)
    c.session?.let { request.header("MCP-Session-Id", it) }
    return request
  }
  private fun body(bytes: ByteArray) = object : RequestBody() {
    override fun contentType() = "application/json".toMediaType()
    override fun contentLength() = bytes.size.toLong()
    override fun isOneShot() = true
    override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
  }
  private class Events { var lastId: String? = null; var retryMs = 1000L }
  private fun execute(c: Client, request: Request, p: Pending?, events: Events? = null, listener: Boolean = false, expectedEpoch: Long = c.epoch.get()) {
    // Serialize final policy admission and handle publication with an OFF toggle.
    // A toggle after this block cancels the registered call before/while it runs.
    val call = synchronized(admission) {
      requireHttpPolicy(c.url)
      check(c.epoch.get() == expectedEpoch) { "MCP connection changed before HTTP dispatch" }
      check(c.enabled && !c.ended && clients[c.id] === c) { "MCP connection is disabled or replaced" }
      http.newCall(request).also { call ->
        httpCalls[call] = c
        call.timeout().timeout(if (listener) 0 else p?.let { (it.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1) } ?: 10000, TimeUnit.MILLISECONDS)
        if (p != null) { p.call = call; if (p.done.get()) call.cancel() }
        if (listener) { c.listener = call; if (!c.initialized || c.phase != "connected") call.cancel() }
      }
    }
    try {
    if (call.isCanceled()) return
    call.execute().use { response ->
      if (listener && response.code == 405) return
      if (response.code == 404 && c.session != null) {
        c.initialized = false; c.phase = "disconnected"; c.reason = "MCP HTTP session expired; explicitly reconnect before a new call (no request replay)"; publish(c)
      }
      check(response.isSuccessful) { "MCP HTTP status ${response.code}" }
      if (p?.method == "initialize") response.header("MCP-Session-Id")?.let {
        check(it.length in 1..1024 && it.all { ch -> ch.code in 0x21..0x7e }) { "Invalid MCP session header" }; c.session = it
      }
      if (p == null && !listener) { check(response.code == 202) { "MCP notification/response was not accepted" }; return }
      val stream = response.body ?: error("Missing MCP HTTP response body")
      val type = response.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase()
      when (type) {
        "application/json" -> { check(!listener) { "MCP GET requires SSE" }; receive(c, json(readBounded(stream.byteStream(), MESSAGE_BYTES))) }
        "text/event-stream" -> readEvents(c, stream.byteStream(), p, events ?: Events(), listener)
        else -> error("Unsupported MCP HTTP response content type")
      }
    }
    } finally { httpCalls.remove(call) }
  }
  private fun post(c: Client, message: JSONObject, p: Pending?) {
    val bytes = message.toString().toByteArray(Charsets.UTF_8)
    require(bytes.size <= MESSAGE_BYTES) { "MCP message exceeds budget" }
    val events = Events()
    try { execute(c, builder(c).header("Accept", "application/json, text/event-stream").post(body(bytes)).build(), p, events) }
    catch (error: IOException) { if (p == null || events.lastId == null || p.done.get()) throw error }
    // Resume only a server-issued SSE cursor via GET. Never replay a POST or a tool call.
    if (p != null) for (attempt in 0 until 3) {
      if (p.done.get() || events.lastId == null) break
      val remaining = p.deadline - SystemClock.elapsedRealtime()
      if (remaining <= events.retryMs) break
      Thread.sleep(events.retryMs)
      if (p.done.get()) break
      try { execute(c, builder(c).header("Accept", "text/event-stream").header("Last-Event-ID", events.lastId!!).get().build(), p, events) }
      catch (_: IOException) { /* GET-only recovery stays inside the original request deadline. */ }
    }
    if (p != null && !p.done.get()) p.finish(failure = "MCP response stream ended before its result; execution outcome may be unknown (no replay)")
  }
  private fun listen(c: Client) {
    val epoch = synchronized(c) {
      if (c.listening) return
      c.listening = true
      c.epoch.get()
    }
    try { listeners.execute {
      try { execute(c, builder(c).header("Accept", "text/event-stream").get().build(), null, listener = true, expectedEpoch = epoch) }
      catch (_: Exception) { /* optional GET stream failure does not replay calls; next explicit connect can reopen it */ }
      finally { synchronized(c) { if (c.epoch.get() == epoch) { c.listener = null; c.listening = false } } }
    } } catch (_: Exception) { synchronized(c) { if (c.epoch.get() == epoch) c.listening = false } }
  }
  private fun readBounded(stream: InputStream, limit: Int): ByteArray {
    val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val n = stream.read(buffer); if (n < 0) break; check(out.size() + n <= limit) { "MCP response exceeds message budget" }; out.write(buffer, 0, n) }
    return out.toByteArray()
  }
  private fun readEvents(c: Client, input: InputStream, p: Pending?, events: Events, listener: Boolean) {
    val line = ByteArrayOutputStream(); val data = StringBuilder(); var eventBytes = 0; var requestBytes = 0L
    var skipLf = false
    fun finishLine() {
      val text = utf8(line.toByteArray()).removePrefix("\uFEFF"); line.reset()
      if (text.isEmpty()) {
        if (data.isNotEmpty()) { val frame = data.toString().removeSuffix("\n"); if (frame.isNotEmpty()) receive(c, json(frame.toByteArray(Charsets.UTF_8))) }
        data.setLength(0); eventBytes = 0
      } else when {
        text == "data" -> data.append('\n')
        text == "id" -> { events.lastId = null }
        text.startsWith("data:") -> { data.append(text.substring(5).removePrefix(" ")).append('\n') }
        text.startsWith("id:") -> { val id = text.substring(3).removePrefix(" "); check(id.length <= 4096 && !id.contains('\u0000')) { "Invalid SSE cursor" }; events.lastId = id.takeIf { it.isNotEmpty() } }
        text.startsWith("retry:") -> { text.substring(6).trim().toLongOrNull()?.let { check(it in 0..10000) { "SSE retry exceeds reconnect budget" }; events.retryMs = it } }
      }
    }
    val buffer = ByteArray(8192)
    while (p?.done?.get() != true) {
      val n = input.read(buffer); if (n < 0) return
      requestBytes += n
      check(listener || requestBytes <= 4L * MESSAGE_BYTES) { "MCP SSE request exceeds stream budget" }
      for (i in 0 until n) {
        val b = buffer[i]
        if (skipLf && b == 10.toByte()) { skipLf = false; continue }; skipLf = false
        check(++eventBytes <= MESSAGE_BYTES) { "MCP SSE event exceeds budget" }
        if (b == 13.toByte() || b == 10.toByte()) { finishLine(); skipLf = b == 13.toByte(); if (p?.done?.get() == true) return }
        else line.write(b.toInt())
      }
    }
  }
}
