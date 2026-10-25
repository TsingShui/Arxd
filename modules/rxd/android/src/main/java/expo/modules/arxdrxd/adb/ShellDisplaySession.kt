package expo.modules.arxdrxd.adb

import expo.modules.arxdrxd.display.DisplayFailure
import expo.modules.arxdrxd.display.DisplayRequest
import expo.modules.arxdrxd.display.DisplayServer
import expo.modules.arxdrxd.display.DisplaySession
import expo.modules.arxdrxd.display.DisplayState
import io.github.muntashirakon.adb.AdbStream
import org.json.JSONObject
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean

/** Fixed framed protocol on an authenticated ADB stream; never a JS shell interface. */
internal class ShellDisplaySession(
  private val stream: AdbStream, private val relay: AdbLoopbackRelay, private val request: DisplayRequest,
  private val onClose: (ShellDisplaySession) -> Unit,
) : DisplaySession {
  private val closed = AtomicBoolean(false)
  private var cleanupConfirmed = false
  private val input = InputStreamReader(stream.openInputStream(), Charsets.UTF_8)
  private val output = stream.openOutputStream()
  init {
    relay.bounded(15000) {
      write(JSONObject().put("op", "start").put("protocol", 1).put("token", request.token)
        .put("packageName", request.packageName).put("component", request.component)
        .put("width", request.width).put("height", request.height).put("densityDpi", request.densityDpi))
      state(readReply()).validate(request)
    }
  }
  private fun write(json: JSONObject) { output.write((json.toString() + "\n").toByteArray(Charsets.UTF_8)); output.flush() }
  private fun readReply(): JSONObject {
    var total = 0
    repeat(32) {
      val line = StringBuilder()
      while (true) {
        val char = input.read()
        if (char == -1) throw DisplayFailure("session_lost")
        if (++total > 2 * 1024 * 1024) throw DisplayFailure("invalid_reply")
        if (char == 10) break
        line.append(char.toChar())
      }
      if (line.startsWith(DisplayServer.PREFIX)) {
        val json = try { JSONObject(line.substring(DisplayServer.PREFIX.length)) }
          catch (_: Exception) { throw DisplayFailure("invalid_reply") }
        if (json.optInt("protocol") != 1) throw DisplayFailure("invalid_reply")
        if (!json.optBoolean("ok")) {
          val code = json.optString("error")
          throw DisplayFailure(if (Regex("^[a-z_]{1,40}$").matches(code)) code else "controller_failed")
        }
        if (json.optString("token") != request.token) throw DisplayFailure("invalid_reply")
        return json
      }
    }
    throw DisplayFailure("invalid_reply")
  }
  private fun state(json: JSONObject) = try {
    DisplayState(json.getString("phase"), json.getString("packageName"), json.getString("component"),
      json.getInt("displayId"), json.getInt("taskId"), json.getInt("uid"),
      json.getInt("width"), json.getInt("height"), json.getInt("densityDpi"))
  } catch (_: Exception) { throw DisplayFailure("invalid_reply") }
  private fun exchange(op: String, timeoutMs: Long = 5000): JSONObject = relay.bounded(timeoutMs) {
    write(JSONObject().put("op", op).put("token", request.token))
    readReply()
  }
  @Synchronized override fun refresh(): DisplayState {
    if (closed.get()) throw DisplayFailure("session_lost")
    return state(exchange("status")).also { it.validate(request) }
  }
  @Synchronized override fun snapshot(): String {
    if (closed.get()) throw DisplayFailure("not_running")
    val json = exchange("snapshot")
    state(json).validate(request)
    val image = json.getString("image")
    if (image.isEmpty() || image.length > 1400000 || !Regex("^[A-Za-z0-9+/=]+$").matches(image)) throw DisplayFailure("invalid_reply")
    return image
  }
  @Synchronized override fun close() {
    if (!closed.compareAndSet(false, true)) {
      if (!cleanupConfirmed) throw DisplayFailure("cleanup_pending")
      return
    }
    try {
      if (exchange("stop", 2000).optString("phase") != "stopped") throw DisplayFailure("cleanup_pending")
      cleanupConfirmed = true
    }
    catch (_: Exception) { throw DisplayFailure("cleanup_pending") }
    finally { closeStreams(); onClose(this) }
  }
  fun closeTransport() {
    closed.set(true)
    closeStreams()
    onClose(this)
  }
  private fun closeStreams() {
    runCatching { stream.close() }; runCatching { input.close() }; runCatching { output.close() }
  }
}
