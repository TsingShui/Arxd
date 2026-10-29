package expo.modules.arxdrxd

import android.content.Context
import android.system.Os
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream
import org.json.JSONObject

/** Ownership admission only; dpkg separately refuses downgrades and final versions are checked. */
internal fun runtimePackageCanReplace(installed: String?, required: String, bootstrap: String?, previousManaged: String?): Boolean =
  installed == null || installed == required || installed == bootstrap || installed == previousManaged

/** Authenticated offline package installation into a private, recoverable generation. */
class RuntimeBundle(private val context: Context,
  private val readAsset: (String) -> InputStream = { context.assets.open(it) }) {
  private val appRoot = File(context.filesDir, "termux-preload")
  private val root = File(appRoot, "files")
  private val prefix = File(root, "usr")
  private val backup = File(root, "usr.previous")
  private fun sha(input: InputStream): String {
    val hash = MessageDigest.getInstance("SHA-256")
    input.use { stream -> val bytes = ByteArray(65536); while (true) {
      val n = stream.read(bytes); if (n < 0) break; hash.update(bytes, 0, n)
    } }
    return hash.digest().joinToString("") { "%02x".format(it) }
  }
  private fun asset(name: String) = JSONObject(readAsset(name).bufferedReader().use { it.readText() })
  private fun marker(directory: File) = File(directory, ".arxd-bundle.json")
  private fun copyTree(source: File, target: File) {
    Files.walk(source.toPath()).use { paths -> paths.forEach { path ->
      val destination = target.toPath().resolve(source.toPath().relativize(path))
      if (Files.isSymbolicLink(path)) {
        Files.createDirectories(destination.parent)
        Files.createSymbolicLink(destination, Files.readSymbolicLink(path))
      } else if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) Files.createDirectories(destination)
      else Files.copy(path, destination, StandardCopyOption.COPY_ATTRIBUTES)
    } }
  }
  private fun deleteTree(directory: File) {
    if (!directory.exists()) return
    Files.walk(directory.toPath()).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach { Files.delete(it) } }
  }
  private fun extract(assetName: String, target: File, limit: Long) {
    var total = 0L
    var entries = 0
    ZipInputStream(readAsset(assetName)).use { zip -> while (true) {
      val entry = zip.nextEntry ?: break
      check(++entries <= 30000) { "Runtime archive entry budget exceeded" }
      val file = File(target, entry.name).canonicalFile
      check(file.path.startsWith(target.canonicalPath + File.separator)) { "Unsafe runtime archive path" }
      if (entry.isDirectory) file.mkdirs() else {
        file.parentFile!!.mkdirs()
        file.outputStream().use { output -> val buffer = ByteArray(65536); while (true) {
          val n = zip.read(buffer); if (n < 0) break
          total += n; check(total <= limit) { "Runtime archive extraction budget exceeded" }
          output.write(buffer, 0, n)
        } }
      }
      zip.closeEntry()
    } }
  }
  private fun installed(directory: File): Map<String, String> {
    val status = File(directory, "var/lib/dpkg/status")
    if (!status.isFile) return emptyMap()
    return status.readText().split("\n\n").mapNotNull { paragraph ->
      val fields = paragraph.lines().filter { it.contains(": ") }.associate { it.substringBefore(": ") to it.substringAfter(": ") }
      if (fields["Status"] != "install ok installed") null
      else fields["Package"]?.let { it to (fields["Version"] ?: "") }
    }.toMap()
  }
  private fun restoreModes(directory: File, bootstrap: JSONObject) {
    val paths = bootstrap.getJSONArray("executablePaths")
    for (index in 0 until paths.length()) {
      val file = File(directory, paths.getString(index)).canonicalFile
      check(file.path.startsWith(directory.canonicalPath + File.separator)) { "Unsafe executable path" }
      if (file.isFile) check(file.setExecutable(true, true)) { "Cannot restore executable mode: ${file.name}" }
    }
  }
  private fun bootstrap(directory: File, bootstrap: JSONObject) {
    extract("termux-bootstrap.zip", directory, 512L * 1024 * 1024)
    File(directory, "SYMLINKS.txt").forEachLine { line ->
      val parts = line.split('←', limit = 2)
      check(parts.size == 2) { "Invalid bootstrap symlink" }
      val link = File(directory, parts[1]).normalize()
      check(link.path.startsWith(directory.path + File.separator)) { "Unsafe bootstrap symlink path" }
      val target = if (parts[0].startsWith("/data/data/com.termux/files/usr/")) {
        link.parentFile!!.toPath().relativize(File(directory, parts[0].removePrefix("/data/data/com.termux/files/usr/")).toPath()).toString()
      } else parts[0]
      check(!target.startsWith("/")) { "Unexpected absolute bootstrap link" }
      link.parentFile!!.mkdirs()
      Os.symlink(target, link.path)
    }
    restoreModes(directory, bootstrap)
  }
  private fun relocateLinks(directory: File) {
    Files.walk(directory.toPath()).use { paths -> paths.filter { Files.isSymbolicLink(it) }.forEach { path ->
      val value = Files.readSymbolicLink(path).toString()
      val suffix = when {
        value.startsWith("/data/data/com.termux/files/usr/") -> value.removePrefix("/data/data/com.termux/files/usr/")
        value.startsWith("/data/user/0/com.termux/files/usr/") -> value.removePrefix("/data/user/0/com.termux/files/usr/")
        value.startsWith(prefix.path + "/") -> value.removePrefix(prefix.path + "/")
        else -> null
      }
      if (suffix != null) {
        Files.delete(path)
        Files.createSymbolicLink(path, path.parent.relativize(File(directory, suffix).toPath()))
      }
    } }
  }
  private fun run(stageRoot: File, script: String, log: File) {
    val scriptFile = File(stageRoot.parentFile, "install.sh").also { it.writeText(script) }
    val pid = File(stageRoot.parentFile, "install.pid")
    val process = RuntimeLaunch.builder(context, stageRoot, scriptFile, pid).redirectErrorStream(true).redirectOutput(log).start()
    process.outputStream.close()
    try {
      check(process.waitFor(240, TimeUnit.SECONDS)) { "Offline runtime preparation timed out; retry is safe" }
      check(process.exitValue() == 0) { "Offline runtime preparation failed (${process.exitValue()}): ${log.readText().takeLast(6000)}" }
    } finally {
      pid.takeIf { it.isFile }?.readText()?.trim()?.toIntOrNull()?.takeIf { it > 1 }?.let { try { Os.kill(-it, 9) } catch (_: Exception) { } }
      process.destroyForcibly()
    }
  }
  private fun hostToolPath(prefix: File, relative: String): File {
    check(relative.isNotEmpty() && !relative.startsWith("/") && relative.split('/').none { it == ".." || it.isEmpty() }) { "Invalid host tool path" }
    val target = File(prefix, relative)
    check(!Files.isSymbolicLink(target.toPath()) && target.canonicalPath.startsWith(prefix.canonicalPath + File.separator)) { "Unsafe host tool path" }
    return target
  }
  private fun verifyHostTools(prefix: File, pin: JSONObject) {
    val tools = pin.getJSONArray("hostTools")
    for (index in 0 until tools.length()) {
      val tool = tools.getJSONObject(index)
      val target = hostToolPath(prefix, tool.getString("Path"))
      check(target.isFile && target.length() == tool.getLong("Size") && sha(target.inputStream()) == tool.getString("SHA256") &&
        (!tool.getBoolean("Executable") || target.canExecute())) { "Bundled host tool changed; explicit reconciliation is required" }
    }
  }
  private fun installHostTools(prefix: File, payload: File, pin: JSONObject, previous: JSONObject?) {
    val owned = mutableMapOf<String, String>()
    previous?.optJSONArray("hostTools")?.let { tools -> for (index in 0 until tools.length()) {
      val tool = tools.getJSONObject(index)
      owned[tool.getString("Path")] = tool.getString("SHA256")
    } }
    val tools = pin.getJSONArray("hostTools")
    val retained = mutableSetOf<String>()
    for (index in 0 until tools.length()) {
      val tool = tools.getJSONObject(index)
      val relative = tool.getString("Path")
      retained.add(relative)
      val target = hostToolPath(prefix, relative)
      val source = File(payload, "host-tools/$relative")
      val expected = tool.getString("SHA256")
      check(source.length() == tool.getLong("Size") && sha(source.inputStream()) == expected) { "Offline host tool identity mismatch" }
      if (target.exists()) {
        check(target.isFile) { "Host tool destination is not a regular file" }
        val current = sha(target.inputStream())
        check(current == expected || current == owned[relative]) { "Host tool conflict: $relative; user changes were preserved" }
      }
      check(target.parentFile.isDirectory || target.parentFile.mkdirs()) { "Cannot create host tool directory" }
      source.copyTo(target, overwrite = true)
      if (tool.getBoolean("Executable")) check(target.setExecutable(true, true)) { "Cannot set host tool mode" }
    }
    for ((relative, expected) in owned) {
      if (relative in retained) continue
      val target = hostToolPath(prefix, relative)
      if (!target.exists()) continue
      check(target.isFile && sha(target.inputStream()) == expected) { "Removed host tool was modified: $relative; user changes were preserved" }
      check(target.delete()) { "Cannot remove retired host tool: $relative" }
    }
    verifyHostTools(prefix, pin)
  }
  fun prepare(bootstrapPin: JSONObject): Map<String, Any> {
    val pin = asset("termux-runtime-packages.json")
    check(pin.getInt("schemaVersion") == 2) { "Unsupported runtime bundle schema; rebuild the pinned assets" }
    check(pin.getString("bootstrapSha256") == bootstrapPin.getString("sha256")) { "Runtime bundle/bootstrap mismatch" }
    root.mkdirs()
    // Crash between publication renames: retain the previous complete prefix.
    if (!prefix.exists() && backup.exists()) check(backup.renameTo(prefix)) { "Cannot recover previous runtime generation" }
    appRoot.listFiles()?.filter { it.name.startsWith("stage-") }?.forEach { deleteTree(it) }
    val current = marker(prefix).takeIf { it.isFile }?.let { JSONObject(it.readText()) }
    val expected = pin.getString("bundleSha256")
    if (current?.optString("bundleSha256") == expected) {
      for (tool in listOf("uv", "uvx", "python", "node", "npm", "npx", "git", "adb", "frida", "frida-ps", "frida-trace", "frida-server", "tshark", "tc", "ecapture")) {
        check(File(prefix, "bin/$tool").canExecute()) { "Managed tool $tool is missing or not executable; reconcile the modified runtime before retrying" }
      }
      verifyHostTools(prefix, pin)
      if (backup.exists()) deleteTree(backup)
      return diagnostics(pin)
    }
    check(sha(readAsset("termux-bootstrap.zip")) == bootstrapPin.getString("sha256")) { "Official bootstrap identity mismatch" }
    check(sha(readAsset("termux-runtime-packages.zip")) == expected) { "Offline runtime bundle identity mismatch" }
    appRoot.listFiles()?.filter { it.name.startsWith("stage-") }?.forEach { deleteTree(it) }
    val stage = File(appRoot, "stage-${UUID.randomUUID()}").also { it.mkdirs() }
    val stageRoot = File(stage, "files").also { it.mkdirs() }
    val stagePrefix = File(stageRoot, "usr")
    val baseline = File(stage, "baseline").also { it.mkdirs() }
    try {
      bootstrap(baseline, bootstrapPin)
      val previous = installed(prefix)
      val original = installed(baseline)
      val previousManaged = mutableMapOf<String, String>()
      if (current != null && current.optString("bootstrapSha256") == pin.getString("bootstrapSha256")) {
        current.optJSONArray("packages")?.let { old -> for (index in 0 until old.length()) {
          val pkg = old.getJSONObject(index)
          previousManaged[pkg.getString("Package")] = pkg.getString("Version")
        } }
      }
      val packages = pin.getJSONArray("packages")
      for (index in 0 until packages.length()) {
        val pkg = packages.getJSONObject(index)
        val name = pkg.getString("Package")
        val version = previous[name]
        check(runtimePackageCanReplace(version, pkg.getString("Version"), original[name], previousManaged[name])) {
          "Runtime package conflict: $name is $version, bundle requires ${pkg.getString("Version")}; existing runtime was preserved. Explicit package reconciliation is required."
        }
      }
      if (prefix.isDirectory) { copyTree(prefix, stagePrefix); relocateLinks(stagePrefix) }
      else check(baseline.renameTo(stagePrefix)) { "Cannot stage bootstrap" }
      restoreModes(stagePrefix, bootstrapPin)
      File(root, "home").mkdirs()
      Os.symlink(File(root, "home").path, File(stageRoot, "home").path)
      File(stagePrefix, "tmp").mkdirs()
      File(stage, "cache/apt/archives/partial").mkdirs()
      val payload = File(stage, "packages").also { it.mkdirs() }
      extract("termux-runtime-packages.zip", payload, 512L * 1024 * 1024)
      for (index in 0 until packages.length()) {
        val pkg = packages.getJSONObject(index)
        val file = File(payload, File(pkg.getString("Filename")).name)
        check(file.length() == pkg.getString("Size").toLong() && sha(file.inputStream()) == pkg.getString("SHA256")) { "Offline package identity mismatch: ${file.name}" }
      }
      val repositories = pin.getJSONArray("repositories")
      check(repositories.length() == 2) { "Expected authenticated main and root repositories" }
      val repositoryNames = mutableSetOf<String>()
      for (index in 0 until repositories.length()) {
        val repository = repositories.getJSONObject(index)
        val name = repository.getString("name")
        check(name in setOf("main", "root") && repositoryNames.add(name)) { "Invalid runtime repository" }
        for ((file, key) in listOf("InRelease" to "inReleaseSha256", "Packages.gz" to "packagesSha256")) {
          check(sha(File(payload, "repository/$name/$file").inputStream()) == repository.getString(key)) { "Repository identity mismatch: $name" }
        }
      }
      val wheels = pin.getJSONObject("pythonWheels").getJSONArray("wheels")
      for (index in 0 until wheels.length()) {
        val wheel = wheels.getJSONObject(index)
        val name = wheel.getString("Filename")
        check(File(name).name == name && name.endsWith("-none-any.whl")) { "Invalid offline Python wheel" }
        val file = File(payload, "wheels/$name")
        check(file.length() == wheel.getLong("Size") && sha(file.inputStream()) == wheel.getString("SHA256")) { "Offline wheel identity mismatch: $name" }
      }
      val log = File(stage, "install.log")
      run(stageRoot, """
        set -eu
        set --
        for key in "${'$'}PREFIX"/share/termux-keyring/*.gpg; do set -- "${'$'}@" --keyring "${'$'}key"; done
        for repository in '${payload.path}'/repository/*; do
          gpgv --status-fd 1 "${'$'}@" "${'$'}repository/InRelease"
        done
        # The unchanged Frida postinst uses pip. Its complete wheel closure is
        # verified above; neither user pip configuration nor the network is used.
        export PIP_CONFIG_FILE=/dev/null PIP_NO_INDEX=1 PIP_FIND_LINKS='${payload.path}/wheels'
        export PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
        dpkg --skip-same-version --refuse-downgrade --install '${payload.path}'/*.deb
        test -z "${'$'}(dpkg --audit)"
      """.trimIndent(), log)
      val installedVersions = installed(stagePrefix)
      for (index in 0 until packages.length()) {
        val pkg = packages.getJSONObject(index)
        check(installedVersions[pkg.getString("Package")] == pkg.getString("Version")) { "Runtime package version reconciliation failed" }
      }
      relocateLinks(stagePrefix)
      installHostTools(stagePrefix, payload, pin, current)
      val probe = readAsset("termux-toolchain-probe.sh").bufferedReader().use { it.readText() }
      run(stageRoot, "export UV_CACHE_DIR=\"\$TMPDIR/arxd-setup-uv-cache\" npm_config_cache=\"\$TMPDIR/arxd-setup-npm-cache\"\n" + probe, File(stage, "functional.log"))
      marker(stagePrefix).writeText(pin.toString(2))
      if (backup.exists()) deleteTree(backup)
      if (prefix.exists()) check(prefix.renameTo(backup)) { "Cannot retain previous runtime" }
      if (!stagePrefix.renameTo(prefix)) {
        if (backup.exists()) backup.renameTo(prefix)
        error("Cannot publish prepared runtime; previous generation preserved")
      }
      File(appRoot, "bootstrap.complete").writeText(bootstrapPin.getString("sha256"))
      File(appRoot, "bundle-install.log").writeText(log.readText())
      File(appRoot, "bundle-functional.log").writeText(File(stage, "functional.log").readText())
      deleteTree(backup)
      return diagnostics(pin)
    } finally { deleteTree(stage) }
  }
  private fun diagnostics(pin: JSONObject): Map<String, Any> = mapOf(
    "runtimeBundleSha256" to pin.getString("bundleSha256"), "runtimeBundleBytes" to pin.getLong("bundleBytes"),
    "runtimeInstalledKiB" to pin.getLong("installedKiB"), "runtimePackageCount" to pin.getJSONArray("packages").length(),
    "runtimeManifest" to marker(prefix).path, "runtimeReady" to true)
}
