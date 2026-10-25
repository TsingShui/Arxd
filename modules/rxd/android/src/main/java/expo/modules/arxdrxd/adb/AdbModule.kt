package expo.modules.arxdrxd.adb

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.os.SystemClock
import android.hardware.display.DisplayManager
import expo.modules.arxdrxd.display.DisplayControl
import expo.modules.arxdrxd.display.DisplayFailure
import expo.modules.arxdrxd.display.DisplayRequest
import expo.modules.arxdrxd.display.DisplayState
import expo.modules.arxdrxd.display.displayRequestForDensity
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AdbModule : Module() {
  private var access: AdbAuthorization? = null
  private var virtual: DisplayControl? = null
  private var heartbeat: ScheduledFuture<*>? = null
  private val scheduler = Executors.newSingleThreadScheduledExecutor { job -> Thread(job, "arxd-vd-heartbeat").apply { isDaemon = true } }
  @Synchronized private fun displays(): DisplayControl = virtual ?: DisplayControl(
    { request -> authorization().openDisplay(context().applicationInfo.sourceDir, request) },
    { authorization().cancelDisplayOpening() },
  ).also { virtual = it }
  private fun context() = appContext.reactContext?.applicationContext ?: error("Android context unavailable")
  private var cleanupAt = 0L
  private fun displayState(): DisplayState {
    if (Build.VERSION.SDK_INT < 35) return DisplayState(phase = "unsupported", error = "unsupported")
    val owner = displays()
    val state = owner.status()
    if (state.error == "cleanup_pending") {
      val manager = context().getSystemService(DisplayManager::class.java)
      val removed = state.displayId?.let { manager.getDisplay(it) == null } ?:
        (cleanupAt > 0 && SystemClock.elapsedRealtime() - cleanupAt > 40000 &&
          manager.displays.none { it.name == "Arxd VD " + owner.sessionToken() })
      if (removed) owner.confirmRemoved()
    }
    return owner.status()
  }
  private fun stopDisplay(): DisplayState {
    heartbeat?.cancel(false); heartbeat = null
    val state = displays().stop()
    if (state.error == "cleanup_pending") cleanupAt = SystemClock.elapsedRealtime()
    return displayState()
  }
  private fun displayRequest(action: () -> DisplayState): Map<String, Any?> = try { action().map() }
    catch (error: Exception) { displayState().copy(error = (error as? DisplayFailure)?.code ?: "controller_failed").map() }
  private fun target(packageName: String): DisplayRequest {
    if (Build.VERSION.SDK_INT < 35 || context().applicationInfo.uid >= 100000) throw DisplayFailure("unsupported")
    if (packageName == context().packageName || packageName.length > 255 ||
      !Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$").matches(packageName)) throw DisplayFailure("invalid_app")
    val pm = context().packageManager
    val component = pm.getLaunchIntentForPackage(packageName)?.component ?: throw DisplayFailure("invalid_app")
    val info = pm.getActivityInfo(component, 0)
    if (!info.enabled || !info.exported || !info.applicationInfo.enabled) throw DisplayFailure("invalid_app")
    return displayRequestForDensity(packageName, component.flattenToShortString(), context().resources.displayMetrics.densityDpi)
  }
  @Synchronized private fun authorization(): AdbAuthorization = access ?: run {
    val context = appContext.reactContext?.applicationContext ?: error("Android context unavailable")
    val identity = AndroidAdbIdentity(context)
    AdbAuthorization(Build.VERSION.SDK_INT >= 30, identity, { port, pairing -> AndroidAdbWire(port, pairing, identity) })
      .also { access = it }
  }
  private fun request(action: (AdbAuthorization) -> AdbStatus): Map<String, Any?> {
    val owner = authorization()
    return try { action(owner).map() }
    catch (error: AdbFailure) { owner.status().copy(error = error.code).map() }
  }
  override fun definition() = ModuleDefinition {
    Name("ArxdAdb")
    Function("status") { authorization().status().map() }
    AsyncFunction("pair") Coroutine { port: Int, code: String ->
      withContext(Dispatchers.IO) { stopDisplay(); request { it.pair(port, code) } }
    }
    AsyncFunction("connect") Coroutine { port: Int ->
      withContext(Dispatchers.IO) { stopDisplay(); request { it.connect(port) } }
    }
    AsyncFunction("check") Coroutine { ->
      withContext(Dispatchers.IO) { request { it.check() } }
    }
    // Independent of an in-flight handshake; closing the relay cancels its sockets.
    AsyncFunction("disconnect") Coroutine { ->
      withContext(Dispatchers.IO) { stopDisplay(); authorization().disconnect().map() }
    }
    Function("virtualDisplayStatus") { displayState().map() }
    AsyncFunction("virtualDisplayApps") Coroutine { query: String, offset: Int ->
      withContext(Dispatchers.IO) {
        require(offset in 0..4096 && query.length <= 128)
        val pm = context().packageManager
        val matches = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        if (matches.size > 4096) throw DisplayFailure("task_budget")
        val rows = matches.filter { it.activityInfo.exported && it.activityInfo.enabled && it.activityInfo.applicationInfo.enabled &&
          it.activityInfo.packageName != context().packageName }
          .distinctBy { it.activityInfo.packageName }
          .map { mapOf("packageName" to it.activityInfo.packageName,
            "label" to it.loadLabel(pm).toString().replace(Regex("[\\p{Cntrl}]"), " ").take(128)) }
          .filter { row -> query.isBlank() || row.values.any { it.contains(query.trim(), ignoreCase = true) } }
          .sortedBy { it["label"]!!.lowercase(java.util.Locale.ROOT) }
        mapOf("apps" to rows.drop(offset).take(30), "nextOffset" to if (offset + 30 < rows.size) offset + 30 else null)
      }
    }
    AsyncFunction("startVirtualDisplay") Coroutine { packageName: String ->
      withContext(Dispatchers.IO) {
        displayRequest {
          val state = displays().start(target(packageName))
          if (state.phase == "running") {
            heartbeat?.cancel(false)
            heartbeat = scheduler.scheduleAtFixedRate({
              runCatching { if (displays().check().phase != "running") heartbeat?.cancel(false) }
            }, 5, 5, TimeUnit.SECONDS)
          }
          state
        }
      }
    }
    AsyncFunction("stopVirtualDisplay") Coroutine { -> withContext(Dispatchers.IO) { displayRequest { stopDisplay() } } }
    AsyncFunction("virtualDisplaySnapshot") Coroutine { ->
      withContext(Dispatchers.IO) {
        try { mapOf("image" to displays().snapshot(), "error" to null) }
        catch (error: Exception) { mapOf("image" to null, "error" to ((error as? DisplayFailure)?.code ?: "no_frame")) }
      }
    }
    AsyncFunction("openSettings") {
      val context = appContext.reactContext ?: error("Android context unavailable")
      val actions = listOf("android.settings.WIRELESS_DEBUGGING_SETTINGS", Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS, Settings.ACTION_SETTINGS)
      for (action in actions) {
        try { context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return@AsyncFunction true }
        catch (_: ActivityNotFoundException) { /* Try the supported OEM fallback. */ }
      }
      error("Cannot open Android developer settings")
    }
    OnDestroy {
      heartbeat?.cancel(false); scheduler.shutdownNow()
      access?.close()
      virtual?.close(); virtual = null
      access = null
    }
  }
}
