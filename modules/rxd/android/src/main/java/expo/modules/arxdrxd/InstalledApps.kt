package expo.modules.arxdrxd

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** PackageManager is the sole source of paths. Never reads app data or launches a target. */
@Suppress("DEPRECATION")
internal class InstalledApps(private val context: Context) {
  private data class Snapshot(val info: PackageInfo, val app: ApplicationInfo, val parts: List<File>) {
    val packageName get() = info.packageName
    val versionCode get() = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toString() else info.versionCode.toString()
    val bytes get() = parts.sumOf { it.length() }
    val revision: String get() {
      val identity = listOf(packageName, versionCode, info.lastUpdateTime.toString()) +
        parts.map { "${it.absolutePath}\u0000${it.length()}\u0000${it.lastModified()}" }
      return MessageDigest.getInstance("SHA-256").digest(identity.joinToString("\n").toByteArray())
        .joinToString("") { "%02x".format(it) }
    }
  }

  private fun snapshot(info: PackageInfo): Snapshot {
    val app = info.applicationInfo ?: error("Application metadata unavailable")
    val base = app.sourceDir ?: error("Base APK unavailable")
    val splits = app.splitSourceDirs?.toList().orEmpty()
    require(splits.size < 128) { "Application has too many split APKs" }
    val paths = listOf(base) + splits.sorted()
    require(paths.distinct().size == paths.size) { "Duplicate APK paths" }
    val parts = paths.map(::File)
    require(parts.all { it.isFile && it.length() > 0 }) { "Application APKs are unavailable" }
    return Snapshot(info, app, parts)
  }

  fun list(query: String, offset: Int, includeSystem: Boolean): Map<String, Any?> {
    require(query.length <= 200 && offset in 0..20000) { "Invalid installed-app query" }
    val pm = context.packageManager
    val needle = query.trim()
    val records = pm.getInstalledPackages(0).mapNotNull { info ->
      val app = info.applicationInfo ?: return@mapNotNull null
      if (!includeSystem && app.flags and ApplicationInfo.FLAG_SYSTEM != 0) return@mapNotNull null
      val label = runCatching { pm.getApplicationLabel(app).toString().take(240) }.getOrDefault(info.packageName)
      if (!info.packageName.contains(needle, true) && !label.contains(needle, true)) return@mapNotNull null
      val state = runCatching { snapshot(info) }.getOrNull() ?: return@mapNotNull null
      label to state
    }.sortedWith(compareBy<Pair<String, Snapshot>> { it.first.lowercase() }.thenBy { it.second.packageName })
    val page = records.drop(offset).take(100)
    return mapOf("apps" to page.map { (label, state) -> mapOf(
      "packageName" to state.packageName, "label" to label,
      "versionName" to state.info.versionName, "versionCode" to state.versionCode,
      "revision" to state.revision, "apkCount" to state.parts.size, "bytes" to state.bytes,
      "system" to (state.app.flags and ApplicationInfo.FLAG_SYSTEM != 0)
    ) }, "nextOffset" to if (offset + page.size < records.size) offset + page.size else null)
  }

  fun import(packageName: String, expectedRevision: String, limit: Long,
             capture: (InputStream, String, Long) -> Map<String, Any?>): Map<String, Any?> {
    require(packageName.matches(Regex("[a-zA-Z0-9_]+(\\.[a-zA-Z0-9_]+)+"))) { "Invalid package name" }
    require(expectedRevision.matches(Regex("[a-f0-9]{64}"))) { "Invalid application revision" }
    val pm = context.packageManager
    val before = snapshot(pm.getPackageInfo(packageName, 0))
    require(before.revision == expectedRevision) { "Application changed. Refresh the list and select it again." }
    require(before.bytes <= limit) { "Application APKs exceed the configured import limit" }
    val imported = mutableListOf<Map<String, Any?>>()
    try {
      var remaining = limit
      for ((index, part) in before.parts.withIndex()) {
        val name = if (index == 0) "$packageName-base.apk" else "$packageName-${part.name}"
        val size = part.length()
        val file = part.inputStream().use { capture(it, name, remaining) }
        imported.add(file)
        val copied = (file["size"] as Number).toLong()
        require(copied == size) { "Application APK changed while importing" }
        remaining -= copied
      }
      val after = snapshot(pm.getPackageInfo(packageName, 0))
      require(after.revision == expectedRevision) { "Application changed while importing. Try again." }
      return mapOf("packageName" to packageName,
        "label" to pm.getApplicationLabel(before.app).toString().take(240),
        "versionName" to before.info.versionName, "versionCode" to before.versionCode,
        "files" to imported)
    } catch (failure: Throwable) {
      // Every capture here was freshly allocated. Never delete an installed APK.
      for (file in imported) File(Uri.parse(file["uri"] as String).path!!).delete()
      throw failure
    }
  }
}
