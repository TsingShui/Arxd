package expo.modules.arxdrxd.windows

import android.content.Context
import android.content.Intent

internal fun validLauncherPackage(value: String): Boolean =
  value.length <= 255 && Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$").matches(value)

/** Shared catalog only; listing never launches apps or opens an ADB connection. */
internal object LauncherApps {
  fun intent(context: Context, packageName: String): Intent {
    require(validLauncherPackage(packageName) && packageName != context.packageName)
    val pm = context.packageManager
    val intent = pm.getLaunchIntentForPackage(packageName) ?: throw IllegalArgumentException("invalid_app")
    val component = intent.component ?: throw IllegalArgumentException("invalid_app")
    val info = pm.getActivityInfo(component, 0)
    require(info.enabled && info.exported && info.applicationInfo.enabled)
    return intent
  }

  fun page(context: Context, query: String, offset: Int): Map<String, Any?> {
    require(offset in 0..4096 && query.length <= 128)
    val pm = context.packageManager
    val matches = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
    check(matches.size <= 4096)
    val rows = matches.filter { it.activityInfo.exported && it.activityInfo.enabled &&
      it.activityInfo.applicationInfo.enabled && it.activityInfo.packageName != context.packageName }
      .distinctBy { it.activityInfo.packageName }
      .map { mapOf("packageName" to it.activityInfo.packageName,
        "label" to it.loadLabel(pm).toString().replace(Regex("[\\p{Cntrl}]"), " ").take(128)) }
      .filter { row -> query.isBlank() || row.values.any { it.contains(query.trim(), ignoreCase = true) } }
      .sortedBy { it["label"]!!.lowercase(java.util.Locale.ROOT) }
    return mapOf("apps" to rows.drop(offset).take(30),
      "nextOffset" to if (offset + 30 < rows.size) offset + 30 else null)
  }
}
