package expo.modules.arxdrxd

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.UUID

/** Process-local leases, never restored from preferences or mistaken for durable task state. */
internal object AgentSessions {
  class Session {
    val generation = UUID.randomUUID().toString()
    val ids = mutableSetOf<String>()
    @Volatile var stopping = false
    val ready = CompletableDeferred<Unit>()
    val ended = CompletableDeferred<String>()
    val closed = CompletableDeferred<Unit>()
  }
  private val lock = Any()
  private var current: Session? = null
  fun enabled(context: Context) = context.getSharedPreferences("arxd.background", Context.MODE_PRIVATE).getBoolean("enabled", false)
  fun active() = synchronized(lock) { current?.let { it.ids.isNotEmpty() && !it.ended.isCompleted } == true }
  fun stopping() = synchronized(lock) { current?.stopping == true }
  fun generation() = synchronized(lock) { current?.generation }
  fun session(generation: String) = synchronized(lock) { current?.takeIf { it.generation == generation } }
  fun requestStop() { synchronized(lock) { current?.let { it.stopping = true; it.ended.complete("stop") } } }
  fun destroyed(generation: String) { synchronized(lock) {
    current?.takeIf { it.generation == generation }?.let {
      it.ended.complete("stop"); it.ready.cancel(); it.closed.complete(Unit); current = null
    }
  } }
  fun release(id: String) { synchronized(lock) {
    current?.let { if (it.ids.remove(id) && it.ids.isEmpty()) it.ended.complete("finished") }
  } }
  suspend fun acquire(context: Context, id: String) {
    require(id.matches(Regex("[a-f0-9-]{36}")))
    check(enabled(context)) { "Background execution is disabled" }
    check(Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) { "Enable notifications before starting a background session" }
    var selected: Session
    while (true) {
      var closing: CompletableDeferred<Unit>? = null
      selected = synchronized(lock) {
        val old = current
        check(old?.stopping != true) { "Session is stopping; retry after it finishes" }
        if (old != null && old.ended.isCompleted) closing = old.closed
        old ?: Session().also { current = it }
      }
      if (closing == null) break
      withTimeout(15000) { closing!!.await() }
    }
    synchronized(lock) {
      check(current === selected && !selected.ended.isCompleted) { "Session is stopping" }
      check(selected.ids.size < 32 && selected.ids.add(id)) { "Session lease budget exceeded" }
    }
    try {
      withContext(Dispatchers.Main) {
        context.startForegroundService(Intent(context, AgentSessionService::class.java).putExtra("generation", selected.generation))
      }
      withTimeout(15000) { selected.ready.await() }
      check(!selected.ended.isCompleted) { "Session stopped before execution" }
    } catch (error: Exception) {
      release(id)
      // A rejected FGS start will never receive onDestroy.
      if (!selected.ready.isCompleted) destroyed(selected.generation)
      throw error
    }
  }
}

class AgentSessionModule : Module() {
  private fun context() = appContext.reactContext?.applicationContext ?: error("Android context unavailable")
  override fun definition() = ModuleDefinition {
    Name("ArxdAgentSession")
    Function("status") { mapOf("enabled" to AgentSessions.enabled(context()), "active" to AgentSessions.active(), "stopping" to AgentSessions.stopping(), "generation" to AgentSessions.generation()) }
    Function("setEnabled") { enabled: Boolean ->
      if (enabled) check(Build.VERSION.SDK_INT < 33 || context().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
      check(context().getSharedPreferences("arxd.background", Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).commit())
      if (!enabled) AgentSessions.requestStop()
    }
    AsyncFunction("acquire") Coroutine { id: String -> AgentSessions.acquire(context(), id) }
    Function("release") { id: String -> AgentSessions.release(id) }
    Function("ready") { generation: String -> AgentSessions.session(generation)?.ready?.complete(Unit); Unit }
    Function("stop") { AgentSessions.requestStop() }
  }
}
