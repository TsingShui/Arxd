package expo.modules.arxdrxd.display

import java.io.Closeable

internal class DisplayFailure(val code: String) : Exception(code)
internal data class DisplayRequest(val packageName: String, val component: String,
  val width: Int = 720, val height: Int = 1280, val densityDpi: Int = 320,
  val token: String = java.util.UUID.randomUUID().toString()) {
  fun validate() {
    if (!Regex("^[a-f0-9-]{36}$").matches(token)) throw DisplayFailure("invalid_request")
    if (packageName.length > 255 || !Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$").matches(packageName)) throw DisplayFailure("invalid_app")
    val parts = component.split('/')
    if (parts.size != 2 || parts[0] != packageName || !Regex("^[A-Za-z_.$][A-Za-z0-9_.$]*$").matches(parts[1]) || component.length > 512) throw DisplayFailure("invalid_app")
    if (width !in 320..1920 || height !in 320..1920 || width.toLong() * height > 2073600 ||
      densityDpi !in 160..640) throw DisplayFailure("invalid_size")
  }
}
internal data class DisplayState(
  val phase: String = "stopped", val packageName: String? = null, val component: String? = null,
  val displayId: Int? = null, val taskId: Int? = null, val uid: Int? = null,
  val width: Int = 720, val height: Int = 1280, val densityDpi: Int = 320, val error: String? = null,
) {
  fun validate(request: DisplayRequest) {
    if (phase != "running" || uid != 2000 || (displayId ?: 0) <= 0 || (taskId ?: 0) <= 0 ||
      packageName != request.packageName || component != request.component || width != request.width ||
      height != request.height || densityDpi != request.densityDpi) throw DisplayFailure("invalid_reply")
  }
  fun map(): Map<String, Any?> = mapOf("phase" to phase, "packageName" to packageName, "component" to component,
    "displayId" to displayId, "taskId" to taskId, "uid" to uid, "width" to width, "height" to height,
    "densityDpi" to densityDpi, "error" to error)
}
/** Keep the host density: some app frameworks cache application-level font metrics. */
internal fun displayRequestForDensity(packageName: String, component: String, densityDpi: Int): DisplayRequest {
  val density = densityDpi.coerceIn(160, 640)
  val width = (360 * density / 160).coerceIn(720, 1080)
  return DisplayRequest(packageName, component, width, width * 16 / 9, density)
}

/** Read only active history entries, not stale EXITING/window diagnostic references. */
internal fun hasActivityHistory(dump: String, packageName: String): Boolean {
  if (!dump.contains("ACTIVITY MANAGER ACTIVITIES") || !dump.contains("Display #")) throw DisplayFailure("task_budget")
  val entries = dump.lineSequence().filter {
    Regex("^\\s*\\*?\\s*Hist\\s+#[0-9]+:.*ActivityRecord\\{").containsMatchIn(it)
  }.toList()
  if (dump.contains("ActivityRecord{") && entries.isEmpty()) throw DisplayFailure("task_budget")
  return entries.any { it.contains(" " + packageName + "/") }
}

internal interface DisplaySession : Closeable {
  fun refresh(): DisplayState
  fun snapshot(): String
}
/** One user-started display. Late replies never resurrect a cancelled session. */
internal class DisplayControl(
  private val open: (DisplayRequest) -> DisplaySession,
  private val cancelOpening: () -> Unit,
  private val canStart: () -> Boolean = { true },
) : Closeable {
  private val lock = Any()
  private var generation = 0L
  private var cleanupConfirmedAt = -1L
  private var session: DisplaySession? = null
  private var request: DisplayRequest? = null
  private var state = DisplayState()
  fun status(): DisplayState = synchronized(lock) { state }
  fun sessionToken(): String? = synchronized(lock) { request?.token }
  fun confirmRemoved() = synchronized(lock) { if (state.error == "cleanup_pending") state = DisplayState() }

  fun start(input: DisplayRequest): DisplayState {
    input.validate()
    val token = synchronized(lock) {
      if (!canStart()) throw DisplayFailure("experiment_disabled")
      if (state.phase in listOf("starting", "running", "stopping") || state.error == "cleanup_pending") throw DisplayFailure("already_running")
      state = DisplayState(phase = "starting", packageName = input.packageName, component = input.component,
        width = input.width, height = input.height, densityDpi = input.densityDpi)
      request = input
      ++generation
    }
    var candidate: DisplaySession? = null
    try {
      candidate = open(input)
      val ready = candidate.refresh().also { it.validate(input) }
      val adopted = synchronized(lock) {
        if (generation != token) false else { session = candidate; state = ready; true }
      }
      if (!adopted) {
        candidate.close()
        synchronized(lock) {
          if (generation != token && session == null) {
            cleanupConfirmedAt = generation
            if (state.error == "cleanup_pending") state = DisplayState()
          }
        }
      }
    } catch (error: Exception) {
      runCatching { candidate?.close() }
      synchronized(lock) { if (generation == token) state = state.copy(phase = "error", error = (error as? DisplayFailure)?.code ?: "start_failed") }
    }
    return status()
  }
  fun check(): DisplayState {
    val (token, current, input) = synchronized(lock) {
      if (state.phase != "running") return state
      Triple(generation, session ?: return state, request ?: return state)
    }
    try {
      val checked = current.refresh().also { it.validate(input) }
      synchronized(lock) { if (generation == token) state = checked }
    } catch (_: Exception) {
      runCatching { current.close() }
      synchronized(lock) { if (generation == token) { session = null; state = state.copy(phase = "error", error = "session_lost") } }
    }
    return status()
  }
  fun snapshot(): String {
    val (token, current) = synchronized(lock) {
      if (state.phase != "running") throw DisplayFailure("not_running")
      generation to (session ?: throw DisplayFailure("not_running"))
    }
    val image = current.snapshot()
    synchronized(lock) { if (generation != token) throw DisplayFailure("cancelled") }
    return image
  }
  fun stop(): DisplayState {
    val (token, current, pending) = synchronized(lock) {
      val next = ++generation; val previous = session; session = null
      val pending = previous == null && (state.phase == "starting" || state.error == "cleanup_pending" || state.displayId != null)
      state = state.copy(phase = "stopping", error = null)
      Triple(next, previous, pending)
    }
    cancelOpening()
    var failure = pending
    try { current?.close() } catch (_: Exception) { failure = true }
    synchronized(lock) {
      if (generation == token) state = if (failure && cleanupConfirmedAt != token) state.copy(phase = "error", error = "cleanup_pending") else DisplayState()
    }
    return status()
  }
  override fun close() { stop() }
}
