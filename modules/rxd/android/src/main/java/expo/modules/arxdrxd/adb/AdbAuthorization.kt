package expo.modules.arxdrxd.adb

import java.io.Closeable
import expo.modules.arxdrxd.display.DisplayFailure
import expo.modules.arxdrxd.display.DisplayRequest
import expo.modules.arxdrxd.display.DisplaySession

/** Internal transport seam. Closing must cancel blocking network work. No shell is exposed to JS. */
internal interface AdbWire : Closeable {
  val alive: Boolean
  fun pair(code: String)
  fun uid(): Int
  fun openDisplay(apkPath: String, request: DisplayRequest): DisplaySession = throw DisplayFailure("unsupported")
  fun cancelDisplayOpening() {}
}
internal class AdbFailure(val code: String) : Exception(code)
internal interface AdbPairingStore {
  fun paired(): Boolean
  fun remember()
}
internal data class AdbStatus(
  val supported: Boolean,
  val phase: String = "disconnected",
  // Historical pairing is not proof of a current grant or connection.
  val paired: Boolean = false,
  val port: Int? = null,
  val uid: Int? = null,
  val checkedAt: Long? = null,
  val error: String? = null,
) {
  fun map(): Map<String, Any?> = mapOf("supported" to supported, "phase" to phase, "paired" to paired,
    "port" to port, "uid" to uid, "checkedAt" to checkedAt, "error" to error)
}

/** Owns admission, cancellation and verified shell identity, independently of React lifetimes. */
internal class AdbAuthorization(
  supported: Boolean,
  private val store: AdbPairingStore,
  private val open: (port: Int, pairing: Boolean) -> AdbWire,
  private val clock: () -> Long = System::currentTimeMillis,
) : Closeable {
  private val lock = Any()
  private var state = AdbStatus(supported, paired = store.paired())
  private var generation = 0L
  private var wire: AdbWire? = null

  fun status(): AdbStatus = synchronized(lock) {
    if (state.phase == "connected" && wire?.alive != true) {
      state = state.copy(phase = "disconnected", uid = null, checkedAt = null, error = "connection_lost")
    }
    state
  }

  private fun begin(phase: String, port: Int): Long = synchronized(lock) {
    if (!state.supported) throw AdbFailure("unsupported")
    if (port !in 1..65535) throw AdbFailure("invalid_port")
    if (state.phase in listOf("pairing", "connecting", "checking")) throw AdbFailure("busy")
    ++generation
    state = state.copy(phase = phase, port = port, uid = null, checkedAt = null, error = null)
    generation
  }

  private fun attach(token: Long, candidate: AdbWire): Boolean = synchronized(lock) {
    if (generation != token) { candidate.close(); false }
    else { wire?.close(); wire = candidate; true }
  }

  private fun failed(token: Long, error: Exception, fallback: String): AdbStatus = synchronized(lock) {
    if (generation == token) {
      wire?.close(); wire = null
      state = state.copy(phase = "disconnected", uid = null, checkedAt = null,
        error = (error as? AdbFailure)?.code ?: fallback)
    }
    state
  }

  fun pair(port: Int, code: String): AdbStatus {
    if (!Regex("^[0-9]{6}$").matches(code)) throw AdbFailure("invalid_code")
    val token = begin("pairing", port)
    try {
      val candidate = open(port, true)
      if (!attach(token, candidate)) return status()
      candidate.pair(code)
      synchronized(lock) {
        if (generation == token) {
          store.remember()
          candidate.close(); wire = null
          state = state.copy(phase = "disconnected", paired = true, port = null)
        }
      }
    } catch (error: Exception) { return failed(token, error, "pairing_failed") }
    return status()
  }

  fun connect(port: Int): AdbStatus {
    val token = begin("connecting", port)
    try {
      if (!state.paired) throw AdbFailure("pair_first")
      val candidate = open(port, false)
      if (!attach(token, candidate)) return status()
      val uid = candidate.uid()
      if (uid != 2000) throw AdbFailure("not_shell")
      synchronized(lock) {
        if (generation == token) state = state.copy(phase = "connected", uid = uid, checkedAt = clock())
      }
    } catch (error: Exception) { return failed(token, error, "connection_failed") }
    return status()
  }

  /** A refresh only probes an existing channel. It never reconnects or grants anything. */
  fun check(): AdbStatus {
    val token: Long
    val candidate: AdbWire
    synchronized(lock) {
      if (state.phase != "connected") return status()
      candidate = wire ?: return status()
      token = ++generation
      state = state.copy(phase = "checking", uid = null, checkedAt = null, error = null)
    }
    try {
      val uid = candidate.uid()
      if (uid != 2000) throw AdbFailure("not_shell")
      synchronized(lock) {
        if (generation == token) state = state.copy(phase = "connected", uid = uid, checkedAt = clock())
      }
    } catch (error: Exception) { return failed(token, error, "connection_lost") }
    return status()
  }

  fun cancelDisplayOpening() { synchronized(lock) { wire }?.cancelDisplayOpening() }
  fun openDisplay(apkPath: String, request: DisplayRequest): DisplaySession {
    request.validate()
    val token: Long
    val selected: AdbWire
    synchronized(lock) {
      if (state.phase != "connected" || wire?.alive != true) throw DisplayFailure("adb_required")
      selected = wire!!
      token = ++generation
      state = state.copy(phase = "checking", uid = null, checkedAt = null, error = null)
    }
    var verified = false
    var candidate: DisplaySession? = null
    try {
      if (selected.uid() != 2000) throw AdbFailure("not_shell")
      verified = true
      candidate = selected.openDisplay(apkPath, request)
      synchronized(lock) {
        if (generation != token) throw DisplayFailure("cancelled")
        state = state.copy(phase = "connected", uid = 2000, checkedAt = clock())
      }
      return candidate
    } catch (error: Exception) {
      runCatching { candidate?.close() }
      if (verified) synchronized(lock) {
        if (generation == token) state = state.copy(phase = "connected", uid = 2000, checkedAt = clock())
      } else failed(token, error, "connection_lost")
      throw (error as? DisplayFailure ?: DisplayFailure("adb_required"))
    }
  }

  fun disconnect(): AdbStatus = synchronized(lock) {
    ++generation
    wire?.close(); wire = null
    state = state.copy(phase = "disconnected", uid = null, checkedAt = null, error = null)
    state
  }
  override fun close() { disconnect() }
}
