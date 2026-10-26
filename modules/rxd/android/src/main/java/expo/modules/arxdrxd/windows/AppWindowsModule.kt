package expo.modules.arxdrxd.windows

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Public Android adjacent launch. No shell, task reparenting or privileged window APIs. */
class AppWindowsModule : Module() {
  private var requestedPackage: String? = null
  private var requestedAt: Long? = null
  private fun context() = appContext.reactContext?.applicationContext ?: error("Android context unavailable")
  private fun status(error: String? = null): Map<String, Any?> {
    val activity = appContext.currentActivity
    return mapOf("supported" to (Build.VERSION.SDK_INT >= 32),
      // This observes Arxd only; it is NOT proof of the target app's placement.
      "multiWindow" to (activity?.isInMultiWindowMode == true && !activity.isInPictureInPictureMode),
      "packageName" to requestedPackage, "requestedAt" to requestedAt,
      "elapsedMs" to requestedAt?.let { SystemClock.elapsedRealtime() - it }, "error" to error)
  }
  override fun definition() = ModuleDefinition {
    Name("ArxdAppWindows")
    AsyncFunction("launcherApps") { query: String, offset: Int -> LauncherApps.page(context(), query, offset) }
    AsyncFunction("splitStatus") { status() }.runOnQueue(Queues.MAIN)
    AsyncFunction("launchAdjacent") { packageName: String ->
      if (Build.VERSION.SDK_INT < 32) return@AsyncFunction status("unsupported")
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) {
        return@AsyncFunction status("not_foreground")
      }
      val intent = try { LauncherApps.intent(context(), packageName) }
        catch (_: Exception) { return@AsyncFunction status("invalid_app") }
      try {
        // Do not force a duplicate instance, clear a task, or choose a private windowing mode.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
        activity.startActivity(intent)
        requestedPackage = packageName
        requestedAt = SystemClock.elapsedRealtime()
        status()
      } catch (_: ActivityNotFoundException) { status("invalid_app") }
        catch (_: SecurityException) { status("launch_failed") }
        catch (_: RuntimeException) { status("launch_failed") }
    }.runOnQueue(Queues.MAIN)
  }
}
