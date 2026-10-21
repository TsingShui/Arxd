package expo.modules.arxdrxd

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.UUID

/** Typed roots only. No shell commands, implicit package setup or access to internal databases. */
class WorkspaceFiles(private val context: Context) {
  companion object { private val lock = Any() }
  // Workspace ceiling for copies, hashes and captures. Imports are separately
  // capped by the user-configurable limit the adapter passes in.
  private val fileLimit = 8L * 1024 * 1024 * 1024
  private val textLimit = 256 * 1024
  private val stallLimitMs = 10_000L
  private fun checkTime(started: Long) { require(SystemClock.elapsedRealtime() - started < 10000) { "File operation exceeded its 10-second cooperative deadline" } }
  private fun checkProgress(lastProgress: Long) { require(SystemClock.elapsedRealtime() - lastProgress < stallLimitMs) { "File operation stalled for 10 seconds" } }
  // Model weights live outside filesDir so the system cannot back them up; the file
  // manager may browse them read-only, and all deletion stays in model management.
  private val readOnlyRoots = setOf("runtime", "models")
  private fun root(name: String): File {
    if (name == "models") {
      val directory = File(context.noBackupFilesDir.canonicalFile, "local-models")
      require(!Files.isSymbolicLink(directory.toPath())) { "Symbolic root is not allowed" }
      check(directory.isDirectory || directory.mkdirs()) { "Cannot create the model root" }
      return directory
    }
    val relative = when (name) {
      "workspace" -> "workspace"
      "skills" -> "skills"
      "home" -> "termux-preload/files/home"
      "runtime" -> "termux-preload/files/usr"
      else -> error("Unknown file root")
    }
    var current = context.filesDir.canonicalFile
    for (part in relative.split('/')) {
      current = File(current, part)
      require(!Files.isSymbolicLink(current.toPath())) { "Symbolic root is not allowed" }
    }
    if (name != "runtime") check(current.isDirectory || current.mkdirs()) { "Cannot create file root" }
    require(current.isDirectory) { "Runtime environment has not been prepared" }
    return current
  }
  private fun resolve(name: String, relative: String, writable: Boolean = false, leafLink: Boolean = false): File {
    if (writable) require(name !in readOnlyRoots) { "This root is read-only" }
    require(relative.length <= 4096 && !relative.startsWith('/') && !relative.contains('\\') && relative.none { it.code < 32 || it.code == 127 }) { "Invalid relative path" }
    val parts = if (relative.isEmpty()) emptyList() else relative.split('/')
    require(parts.size <= 64 && parts.all { it.isNotEmpty() && it != "." && it != ".." && it.toByteArray().size <= 255 }) { "Invalid path component" }
    var current = root(name)
    for ((index, part) in parts.withIndex()) {
      current = File(current, part)
      if (!leafLink || index != parts.lastIndex) require(!Files.isSymbolicLink(current.toPath())) { "Symbolic links cannot be followed" }
    }
    return current
  }
  internal fun homeDirectory(): File = synchronized(lock) { root("home") }
  internal fun skillsDirectory(): File = synchronized(lock) {
    val target = File(context.filesDir.canonicalFile, "skills")
    val legacy = File(context.filesDir.canonicalFile, "workspace/skills")
    if (legacy.isDirectory && !Files.isSymbolicLink(legacy.toPath())) {
      if (!Files.exists(target.toPath(), NOFOLLOW_LINKS)) Files.move(legacy.toPath(), target.toPath(), ATOMIC_MOVE)
      else if (target.isDirectory && target.list().isNullOrEmpty()) { target.delete(); Files.move(legacy.toPath(), target.toPath(), ATOMIC_MOVE) }
    }
    root("skills")
  }
  internal fun workspaceDirectory(path: String): File = synchronized(lock) { resolve("workspace", path) }
  private fun hash(input: InputStream, limit: Long = fileLimit): String {
    val digest = MessageDigest.getInstance("SHA-256")
    var lastProgress = SystemClock.elapsedRealtime()
    var size = 0L
    input.use { stream ->
      val buffer = ByteArray(65536)
      while (true) {
        checkProgress(lastProgress)
        val count = stream.read(buffer); if (count < 0) break
        size += count; require(size <= limit) { "File exceeds size budget" }
        digest.update(buffer, 0, count)
        lastProgress = SystemClock.elapsedRealtime()
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
  private fun preview(file: File): Map<String, Any?> {
    require(file.isFile) { "Not a regular file" }
    if (file.length() > textLimit) return mapOf("text" to null, "sha256" to null, "size" to file.length(), "reason" to "size")
    val bytes = file.inputStream().use { input ->
      val output = java.io.ByteArrayOutputStream()
      val buffer = ByteArray(16384)
      while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= textLimit) { "File changed beyond preview budget" }; output.write(buffer, 0, count) }
      output.toByteArray()
    }
    require(bytes.size <= textLimit) { "File changed beyond preview budget" }
    val text = runCatching { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString() }.getOrNull()?.takeUnless { it.contains('\u0000') }
    return mapOf("text" to text, "sha256" to hash(bytes.inputStream()), "size" to bytes.size, "reason" to if (text == null) "binary" else null)
  }
  private fun copy(input: InputStream, target: File) {
    input.use { source ->
      require(!Files.exists(target.toPath(), NOFOLLOW_LINKS)) { "Destination already exists" }
      require(target.parentFile.isDirectory) { "Destination directory does not exist" }
      val stage = File(target.parentFile, ".arxd-${UUID.randomUUID()}.tmp")
      var lastProgress = SystemClock.elapsedRealtime()
      try { stage.outputStream().use { output ->
        val buffer = ByteArray(65536); var size = 0L
        while (true) { checkProgress(lastProgress); val count = source.read(buffer); if (count < 0) break; size += count; require(size <= fileLimit) { "File exceeds the 8 GiB workspace ceiling" }; output.write(buffer, 0, count); lastProgress = SystemClock.elapsedRealtime() }
        output.fd.sync()
      }
        Files.move(stage.toPath(), target.toPath(), ATOMIC_MOVE)
      } finally { stage.delete() }
    }
  }
  private fun capture(uri: String): File {
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "file") { "Invalid capture URI" }
    val directory = File(context.filesDir.canonicalFile, "workspace-inputs")
    require(!Files.isSymbolicLink(directory.toPath())) { "Invalid capture directory" }
    val file = File(parsed.path ?: error("Missing capture path"))
    require(file.parentFile.canonicalFile == directory.canonicalFile && !Files.isSymbolicLink(file.toPath())) { "Capture is outside its root" }
    require(file.name.matches(Regex("[a-f0-9-]+\\.[a-z0-9]{1,8}"))) { "Invalid capture identity" }
    return file
  }
  fun list(name: String, path: String, offset: Int, query: String): Map<String, Any?> = synchronized(lock) {
    require(offset in 0..4096 && query.length <= 240) { "Invalid directory query" }
    val directory = resolve(name, path)
    require(directory.isDirectory) { "Not a directory" }
    val started = SystemClock.elapsedRealtime()
    val entries = mutableListOf<Map<String, Any>>()
    var scanned = 0
    Files.newDirectoryStream(directory.toPath()).use { stream -> for (entry in stream) {
      scanned++
      require(scanned <= 4096 && SystemClock.elapsedRealtime() - started < 3000) { "Directory exceeds listing budget" }
      if (!entry.fileName.toString().contains(query, ignoreCase = true)) continue
      val attrs = Files.readAttributes(entry, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      val kind = if (attrs.isSymbolicLink) "symlink" else if (attrs.isDirectory) "directory" else "file"
      val fileName = entry.fileName.toString()
      entries.add(mapOf("root" to name, "path" to if (path.isEmpty()) fileName else "$path/$fileName", "name" to fileName, "kind" to kind, "size" to attrs.size(), "modifiedAt" to attrs.lastModifiedTime().toMillis(), "writable" to (name !in readOnlyRoots)))
    } }
    val sorted = entries.sortedWith(compareBy<Map<String, Any>> { it["kind"] != "directory" }.thenBy { it["name"] as String })
    mapOf("entries" to sorted.drop(offset).take(200), "nextOffset" to if (offset + 200 < sorted.size) offset + 200 else null)
  }
  fun read(name: String, path: String) = synchronized(lock) { preview(resolve(name, path)) }
  fun readCapture(uri: String, expected: String) = synchronized(lock) {
    val file = capture(uri); require(hash(file.inputStream()) == expected) { "Capture identity changed" }; preview(file)
  }
  fun mkdir(name: String, path: String): Unit = synchronized(lock) {
    require(path.isNotEmpty()) { "Cannot replace a root" }
    check(resolve(name, path, true).mkdir()) { "Cannot create directory; it may already exist" }
  }
  fun write(name: String, path: String, text: String, expected: String): Unit = synchronized(lock) {
    require(path.isNotEmpty()) { "Cannot write a root" }
    val bytes = text.toByteArray(Charsets.UTF_8)
    require(bytes.size <= textLimit) { "Text exceeds 256 KiB" }
    val target = resolve(name, path, true)
    if (target.exists()) {
      require(expected.matches(Regex("[a-f0-9]{64}")) && hash(target.inputStream(), textLimit.toLong()) == expected) { "File changed; reopen it before saving" }
    } else require(expected.isEmpty()) { "File no longer exists" }
    val stage = File(target.parentFile, ".arxd-${UUID.randomUUID()}.tmp")
    try {
      require(target.parentFile.isDirectory) { "Parent directory does not exist" }
      stage.outputStream().use { it.write(bytes); it.fd.sync() }
      Files.move(stage.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
    } finally { stage.delete() }
  }
  fun move(name: String, path: String, targetName: String, targetPath: String): Unit = synchronized(lock) {
    require(path.isNotEmpty() && targetPath.isNotEmpty()) { "Cannot move a root" }
    val source = resolve(name, path, true, true)
    val target = resolve(targetName, targetPath, true)
    require(!Files.exists(target.toPath(), NOFOLLOW_LINKS)) { "Destination already exists" }
    require(!target.toPath().startsWith(source.toPath())) { "Cannot move a directory into itself" }
    Files.move(source.toPath(), target.toPath(), ATOMIC_MOVE)
  }
  fun copy(name: String, path: String, targetName: String, targetPath: String): Unit = synchronized(lock) {
    val source = resolve(name, path)
    require(source.isFile) { "Only regular files can be copied" }
    copy(source.inputStream(), resolve(targetName, targetPath, true))
  }
  fun copyCapture(uri: String, expected: String, name: String, path: String): Unit = synchronized(lock) {
    val source = capture(uri)
    require(hash(source.inputStream()) == expected) { "Capture identity changed" }
    copy(source.inputStream(), resolve(name, path, true))
  }
  fun deleteCapture(uri: String, expected: String): Unit = synchronized(lock) {
    val file = capture(uri)
    if (file.exists()) {
      require(hash(file.inputStream()) == expected) { "Capture identity changed" }
      check(file.delete()) { "Cannot delete capture" }
    }
  }
  fun delete(name: String, path: String): Unit = synchronized(lock) {
    require(path.isNotEmpty()) { "Cannot delete a root" }
    val target = resolve(name, path, true, true).toPath()
    var count = 0
    val started = SystemClock.elapsedRealtime()
    Files.walkFileTree(target, object : SimpleFileVisitor<Path>() {
      override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult { checkBudget(); return FileVisitResult.CONTINUE }
      override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult { checkBudget(); return FileVisitResult.CONTINUE }
      private fun checkBudget() { count++; require(count <= 4096 && SystemClock.elapsedRealtime() - started < 3000) { "Deletion exceeds 4096 entries or preparation time budget" } }
    })
    Files.walkFileTree(target, object : SimpleFileVisitor<Path>() {
      override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult { checkTime(started); Files.delete(file); return FileVisitResult.CONTINUE }
      override fun postVisitDirectory(dir: Path, error: java.io.IOException?): FileVisitResult { checkTime(started); if (error != null) throw error; Files.delete(dir); return FileVisitResult.CONTINUE }
    })
  }
  fun <T> captureSource(name: String, path: String, action: (File) -> T): T = synchronized(lock) {
    val file = resolve(name, path)
    require(file.isFile && file.length() <= fileLimit) { "Capture requires a regular file up to 8 GiB" }
    action(file)
  }
  fun share(name: String, path: String): String = synchronized(lock) { share(resolve(name, path), File(path).name) }
  fun shareCapture(uri: String, expected: String, displayName: String): String = synchronized(lock) {
    val file = capture(uri); require(hash(file.inputStream()) == expected) { "Capture identity changed" }; share(file, displayName)
  }
  private fun share(file: File, name: String): String {
    require(file.isFile) { "Only regular files can be shared" }
    val directory = File(context.cacheDir, "shared-files/${UUID.randomUUID()}").also { it.mkdirs() }
    val safeName = name.replace(Regex("[\\p{Cntrl}/\\\\]"), "_").take(120).ifBlank { "file.bin" }
    val target = File(directory, safeName)
    copy(file.inputStream(), target)
    return Uri.fromFile(target).toString()
  }
}
