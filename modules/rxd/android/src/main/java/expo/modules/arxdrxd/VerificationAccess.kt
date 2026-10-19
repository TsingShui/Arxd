package expo.modules.arxdrxd

import android.content.Context
import android.content.pm.PackageManager

/** Native build metadata is authoritative even if a JS manifest is replaced. */
object VerificationAccess {
  fun enabled(context: Context): Boolean {
    if (!context.packageName.matches(Regex("art\\.tsingshui\\.arxd\\.[a-z][a-z0-9_]*"))) return false
    @Suppress("DEPRECATION") val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    return info.metaData?.getBoolean("art.tsingshui.arxd.ENABLE_VERIFICATION", false) == true
  }
  fun requireEnabled(context: Context) { check(enabled(context)) { "Verification is disabled in this build" } }
}
