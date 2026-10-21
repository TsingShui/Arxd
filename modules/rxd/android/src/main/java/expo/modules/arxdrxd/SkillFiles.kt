package expo.modules.arxdrxd

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** Skill content is copied and pinned as data. Import and snapshot never execute it. */
class SkillFiles(private val context: Context) {
  private val catalog = SharedSkillCatalog(context)
  fun discover(): Map<String, Any?> = catalog.discover()
  fun rename(id: String, name: String): Unit { validId(id); validName(name); catalog.rename(id, name) }
  fun revision(): String = catalog.revision()
  fun close() = catalog.close()
  private val workspace = WorkspaceFiles(context)
  private val packageLimit = 8L * 1024 * 1024
  private class Budget { var bytes = 0L; var entries = 0; val started = SystemClock.elapsedRealtime() }
  private fun check(budget: Budget) {
    require(budget.entries <= 256 && budget.bytes <= packageLimit && SystemClock.elapsedRealtime() - budget.started < 60000) { "Skill package exceeds 256 entries, 8 MiB or time budget" }
  }
  private fun validId(id: String) { require(id.matches(Regex("[a-f0-9-]{36}"))) { "Invalid skill identity" } }
  private fun component(name: String) {
    require(name.isNotEmpty() && name != "." && name != ".." && name.toByteArray().size <= 255 && name.none { it == '/' || it == '\\' || it.code < 32 || it.code == 127 }) { "Invalid skill resource name" }
  }
  private fun validName(name: String) { require(name.matches(Regex("[a-z0-9]+(?:-[a-z0-9]+)*")) && name.length <= 64) { "Invalid skill name" } }
  private fun container(id: String): File {
    validId(id)
    val root = workspace.skillsDirectory()
    check(root.isDirectory || root.mkdir()) { "Cannot create skills directory" }
    return File(root, id)
  }
  private fun versionRoot(id: String): File {
    validId(id)
    val root = File(context.filesDir.canonicalFile, "skill-versions")
    require(!Files.isSymbolicLink(root.toPath())) { "Invalid skill version root" }
    val child = File(root, id)
    require(!Files.isSymbolicLink(child.toPath())) { "Invalid skill version identity" }
    return child
  }
  private fun current(id: String): File {
    validId(id)
    val directory = catalog.directory(id)
    require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) { "Skill directory is missing or linked" }
    return directory
  }
  private fun bytes(file: File, limit: Int): ByteArray {
    require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() <= limit) { "Skill file is missing, linked or too large" }
    val output = java.io.ByteArrayOutputStream()
    file.inputStream().use { stream ->
      val buffer = ByteArray(16384)
      while (true) { val n = stream.read(buffer); if (n < 0) break; require(output.size() + n <= limit) { "Skill file changed beyond budget" }; output.write(buffer, 0, n) }
    }
    return output.toByteArray()
  }
  private fun hash(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
  private fun text(data: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString()
  private fun copy(input: InputStream, target: File, budget: Budget) {
    var size = 0L
    input.use { source ->
      budget.entries++; check(budget)
      target.outputStream().use { output ->
      val buffer = ByteArray(65536)
      while (true) {
        val n = source.read(buffer); if (n < 0) break
        size += n; budget.bytes += n; require(size <= 2 * 1024 * 1024) { "Skill resource exceeds 2 MiB" }; check(budget); output.write(buffer, 0, n)
      }
      output.fd.sync()
    } }
  }
  private fun erase(root: File) {
    if (!Files.exists(root.toPath(), NOFOLLOW_LINKS)) return
    var entries = 0
    val started = SystemClock.elapsedRealtime()
    Files.walkFileTree(root.toPath(), object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
      private fun bound() { entries++; require(entries <= 65536 && SystemClock.elapsedRealtime() - started < 60000) { "Skill cleanup exceeds budget" } }
      override fun preVisitDirectory(path: java.nio.file.Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult { bound(); return java.nio.file.FileVisitResult.CONTINUE }
      override fun visitFile(path: java.nio.file.Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult { bound(); Files.delete(path); return java.nio.file.FileVisitResult.CONTINUE }
      override fun postVisitDirectory(path: java.nio.file.Path, error: java.io.IOException?): java.nio.file.FileVisitResult { if (error != null) throw error; Files.delete(path); return java.nio.file.FileVisitResult.CONTINUE }
    })
  }
  private fun local(source: File, target: File, budget: Budget, depth: Int = 0) {
    require(depth <= 16 && !Files.isSymbolicLink(source.toPath())) { "Skill links or deep paths are not supported" }
    component(source.name)
    if (source.isDirectory) {
      budget.entries++; check(budget); check(target.mkdir()) { "Cannot create skill resource directory" }
      Files.newDirectoryStream(source.toPath()).use { stream -> for (path in stream) local(path.toFile(), File(target, path.fileName.toString()), budget, depth + 1) }
    } else { require(source.isFile) { "Skill resources must be regular files" }; copy(source.inputStream(), target, budget) }
  }
  private fun install(id: String, write: (File) -> Unit): Map<String, Any> {
    val root = container(id)
    require(!root.exists()) { "Skill identity already exists" }
    check(root.mkdir()) { "Cannot create skill container" }
    try {
      val stage = File(root, "incoming")
      check(stage.mkdir()) { "Cannot create skill staging directory" }
      write(stage)
      return readWorking(id)
    } catch (error: Throwable) { erase(root); throw error }
  }
  fun importFile(id: String, source: String): Map<String, Any> = install(id) { target ->
    val uri = Uri.parse(source); require(uri.scheme in listOf("file", "content")) { "Unsupported skill URI" }
    copy(context.contentResolver.openInputStream(uri) ?: error("Cannot open SKILL.md"), File(target, "SKILL.md"), Budget())
  }
  private fun copyEntry(input: InputStream, target: File, budget: Budget) {
    var size = 0L
    budget.entries++; check(budget)
    target.outputStream().use { output ->
      val buffer = ByteArray(65536)
      while (true) {
        val count = input.read(buffer); if (count < 0) break
        size += count; budget.bytes += count
        require(size <= 2 * 1024 * 1024) { "Skill resource exceeds 2 MiB" }
        check(budget); output.write(buffer, 0, count)
      }
      output.fd.sync()
    }
  }
  private fun normalizeArchive(target: File) {
    if (File(target, "SKILL.md").isFile) return
    val roots = target.listFiles()?.filter { it.name != "__MACOSX" && it.name != ".DS_Store" } ?: emptyList()
    if (roots.size == 1 && roots[0].isDirectory && File(roots[0], "SKILL.md").isFile) {
      val inner = roots[0]
      for (child in inner.listFiles()?.toList() ?: emptyList()) {
        val destination = File(target, child.name)
        require(!Files.exists(destination.toPath(), NOFOLLOW_LINKS)) { "Duplicate skill resource name" }
        Files.move(child.toPath(), destination.toPath(), ATOMIC_MOVE)
      }
      check(inner.delete()) { "Cannot remove archive wrapper directory" }
    }
    require(File(target, "SKILL.md").isFile) { "Skill archive must contain SKILL.md at its root or in one top-level directory" }
  }
  fun importArchive(id: String, source: String): Map<String, Any> = install(id) { target ->
    val uri = Uri.parse(source); require(uri.scheme in listOf("file", "content")) { "Unsupported skill archive URI" }
    val budget = Budget()
    context.contentResolver.openInputStream(uri)?.use { raw ->
      ZipInputStream(BufferedInputStream(raw)).use { zip ->
        while (true) {
          val entry = zip.nextEntry ?: break
          val name = entry.name.replace('\\', '/')
          require(name.isNotBlank() && !name.startsWith('/') && !name.contains("\u0000")) { "Invalid skill archive entry" }
          val parts = name.trimEnd('/').split('/').filter { it.isNotEmpty() && it != "." }
          require(parts.none { it == ".." } && parts.size <= 16) { "Invalid skill archive path" }
          if (parts.isEmpty() || parts.first() == "__MACOSX" || parts.last() == ".DS_Store") { zip.closeEntry(); continue }
          parts.forEach(::component)
          var file = target
          for (part in parts) file = File(file, part)
          if (entry.isDirectory) {
            budget.entries++; check(budget)
            check(file.isDirectory || file.mkdirs()) { "Cannot create archive directory" }
          } else {
            require(!Files.exists(file.toPath(), NOFOLLOW_LINKS)) { "Duplicate skill archive entry" }
            file.parentFile?.let { check(it.isDirectory || it.mkdirs()) { "Cannot create archive directory" } }
            copyEntry(zip, file, budget)
          }
          zip.closeEntry()
        }
      }
    } ?: error("Cannot open skill archive")
    normalizeArchive(target)
  }
  fun importWorkspace(id: String, path: String): Map<String, Any> = install(id) { target ->
    require(path.isNotEmpty() && path != "." && path != ".." && !path.startsWith("/")) { "Choose a workspace directory" }
    val source = workspace.workspaceDirectory(path)
    require(source.isDirectory) { "Not a skill directory" }
    val budget = Budget()
    Files.newDirectoryStream(source.toPath()).use { stream -> for (file in stream) local(file.toFile(), File(target, file.fileName.toString()), budget) }
  }
  /**
   * Installs a skill fetched from a public skill registry. The payload is data:
   * paths are validated before anything is written, the byte budget matches local
   * imports, and the result goes through the same working/snapshot admission.
   */
  fun importMarket(id: String, filesJson: String, source: String): Map<String, Any> = install(id) { target ->
    require(filesJson.length <= 3 * 1024 * 1024) { "Market skill payload exceeds 3 MiB" }
    require(source.isNotEmpty() && source.length <= 240 && source.matches(Regex("[A-Za-z0-9._@/+\\-]+"))) { "Invalid market skill source" }
    val files = org.json.JSONArray(filesJson)
    require(files.length() in 1..128) { "Market skill must contain 1..128 files" }
    val budget = Budget()
    val seen = HashSet<String>()
    for (index in 0 until files.length()) {
      val entry = files.getJSONObject(index)
      val path = entry.getString("path")
      require(path.isNotEmpty() && path.length <= 400 && !path.startsWith("/") && !path.contains('\\') && !path.contains("\u0000")) { "Invalid market skill path" }
      val parts = path.split('/')
      require(parts.size in 1..16 && parts.none { it.isEmpty() || it == "." || it == ".." }) { "Invalid market skill path" }
      parts.forEach(::component)
      require(seen.add(path)) { "Duplicate market skill path" }
      val bytes = entry.getString("contents").toByteArray(Charsets.UTF_8)
      require(bytes.size <= 1024 * 1024) { "Market skill file exceeds 1 MiB" }
      budget.entries++; budget.bytes += bytes.size; check(budget)
      var directory = target
      for (part in parts.dropLast(1)) {
        val next = File(directory, part)
        require(!Files.isSymbolicLink(next.toPath()) && (next.isDirectory || next.mkdir())) { "Cannot create market skill directory" }
        directory = next
      }
      val file = File(directory, parts.last())
      require(!Files.exists(file.toPath(), NOFOLLOW_LINKS)) { "Duplicate market skill path" }
      file.outputStream().use { output -> output.write(bytes); output.fd.sync() }
    }
    normalizeArchive(target)
  }
  fun readWorking(id: String): Map<String, Any> {
    val directory = current(id)
    val data = bytes(File(directory, "SKILL.md"), 65536)
    return mapOf("id" to id, "folder" to directory.name, "path" to directory.relativeTo(workspace.skillsDirectory()).path, "definition" to text(data), "sha256" to hash(data))
  }
  fun writeDefinition(id: String, value: String, expected: String): Unit {
    require(value.toByteArray().size <= 65536) { "SKILL.md exceeds 64 KiB" }
    val directory = current(id)
    workspace.write("skills", "${directory.relativeTo(workspace.skillsDirectory()).path}/SKILL.md", value, expected)
  }
  private data class Manifest(val files: List<Map<String, Any>>, val version: String, val bytes: Long)
  private fun manifest(root: File): Manifest {
    require(root.isDirectory && !Files.isSymbolicLink(root.toPath())) { "Invalid skill directory" }
    val files = mutableListOf<Map<String, Any>>()
    val directories = mutableListOf<String>()
    val budget = Budget()
    fun scan(directory: File, prefix: String, depth: Int) {
      require(depth <= 16) { "Skill directory is too deep" }
      Files.newDirectoryStream(directory.toPath()).use { stream -> for (entry in stream) {
        val file = entry.toFile(); component(file.name); budget.entries++; check(budget)
        require(!Files.isSymbolicLink(entry)) { "Skill resources cannot be symbolic links" }
        val path = if (prefix.isEmpty()) file.name else "$prefix/${file.name}"
        require(path.length <= 512 && path.split('/').size <= 16) { "Skill resource path is too long or deep" }
        if (file.isDirectory) { directories.add(path); scan(file, path, depth + 1) } else {
          val data = bytes(file, 2 * 1024 * 1024); budget.bytes += data.size; check(budget)
          files.add(mapOf("path" to path, "size" to data.size, "sha256" to hash(data)))
        }
      } }
    }
    scan(root, "", 0)
    val sorted = files.sortedBy { it["path"] as String }
    val identities = directories.map { "d\u0000$it" } + sorted.map { "f\u0000${it["path"]}\u0000${it["sha256"]}\u0000${it["size"]}" }
    return Manifest(sorted, hash(identities.sorted().joinToString("\n").toByteArray()), budget.bytes)
  }
  fun snapshot(id: String, name: String, prune: Boolean): Map<String, Any> {
    validName(name)
    val working = catalog.adopt(id, current(id), name)
    val definitionBytes = bytes(File(working, "SKILL.md"), 65536)
    val definition = text(definitionBytes)
    val inventory = manifest(working)
    val sorted = inventory.files
    require(sorted.find { it["path"] == "SKILL.md" }?.get("sha256") == hash(definitionBytes)) { "SKILL.md changed while scanning" }
    val version = inventory.version
    val versions = versionRoot(id).also { it.mkdirs() }
    val root = File(versions, version)
    require(!Files.isSymbolicLink(root.toPath())) { "Invalid pinned version" }
    val pinned = File(root, name)
    if (!root.exists()) {
      val versionsRoot = versions.parentFile!!
      var retainedBytes = 0L; var retainedFiles = 0; val storageStarted = SystemClock.elapsedRealtime()
      Files.walkFileTree(versionsRoot.toPath(), object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
        override fun preVisitDirectory(path: java.nio.file.Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
          require(++retainedFiles <= 65536 && SystemClock.elapsedRealtime() - storageStarted < 10000) { "Published skills exceed 65536 entries" }; return java.nio.file.FileVisitResult.CONTINUE
        }
        override fun visitFile(path: java.nio.file.Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
          retainedBytes += attrs.size(); require(++retainedFiles <= 65536 && SystemClock.elapsedRealtime() - storageStarted < 10000 && retainedBytes + inventory.bytes <= 512L * 1024 * 1024) { "Published skills exceed 512 MiB storage budget; finish pending tasks before cleanup" }; return java.nio.file.FileVisitResult.CONTINUE
        }
      })
      val stage = File(versions, ".stage-${java.util.UUID.randomUUID()}").also { it.mkdir() }
      try {
        val destination = File(stage, name).also { check(it.mkdir()) }
        val copyBudget = Budget()
        Files.newDirectoryStream(working.toPath()).use { stream -> for (file in stream) local(file.toFile(), File(destination, file.fileName.toString()), copyBudget) }
        Files.move(stage.toPath(), root.toPath(), ATOMIC_MOVE)
      } finally { erase(stage) }
    }
    // Confirm copy identity before the version can be admitted to a model task.
    require(manifest(pinned).version == version) { "Skill changed while snapshotting" }
    // Pruning is a separate idle-only operation, after durable task inspection.
    return mapOf("id" to id, "name" to name, "version" to version, "workingPath" to working.relativeTo(workspace.skillsDirectory()).path, "baseDirectory" to pinned.path,
      "definition" to definition, "definitionSha256" to hash(definitionBytes), "files" to sorted, "totalBytes" to inventory.bytes)
  }
  fun readResource(id: String, name: String, version: String, path: String, expected: String, offset: Int, maxBytes: Int): Map<String, Any?> {
    validName(name); require(version.matches(Regex("[a-f0-9]{64}"))) { "Invalid skill version" }
    require(path.length <= 512 && path.split('/').size <= 16) { "Invalid skill resource path" }
    var file = File(File(versionRoot(id), version), name)
    require(!Files.isSymbolicLink(file.parentFile.toPath()) && !Files.isSymbolicLink(file.toPath())) { "Linked skill version" }
    for (part in path.split('/')) { component(part); file = File(file, part); require(!Files.isSymbolicLink(file.toPath())) { "Linked skill resource" } }
    val data = bytes(file, 2 * 1024 * 1024)
    require(hash(data) == expected) { "Pinned skill resource identity changed" }
    require(offset in 0..data.size && maxBytes in 256..65536) { "Invalid resource range" }
    val source = runCatching { text(data) }.getOrNull()?.takeUnless { value -> value.any { it.code == 127 || (it.code < 32 && it != '\n' && it != '\r' && it != '\t') } }
    if (source == null) return mapOf("path" to path, "sha256" to expected, "size" to data.size, "text" to null, "offset" to offset, "nextOffset" to data.size, "complete" to true)
    require(offset == data.size || data[offset].toInt() and 0xc0 != 0x80) { "Use a UTF-8 byte boundary" }
    var end = minOf(data.size, offset + maxBytes)
    while (end < data.size && end > offset && data[end].toInt() and 0xc0 == 0x80) end--
    return mapOf("path" to path, "sha256" to expected, "size" to data.size, "text" to String(data, offset, end - offset, Charsets.UTF_8), "offset" to offset, "nextOffset" to end, "complete" to (end == data.size))
  }
  fun remove(id: String): Unit {
    validId(id)
    // Refresh path identities before a resumable delete, including completed shell moves.
    catalog.discover()
    val working = runCatching { catalog.directory(id) }.getOrNull() ?: return
    val target = if (working.parentFile?.parentFile == catalog.root() && working.parentFile!!.name == id) working.parentFile!! else working
    if (Files.exists(target.toPath(), NOFOLLOW_LINKS)) workspace.delete("skills", target.relativeTo(catalog.root()).path)
    // Retain admitted versions. The host collects only when no pending work exists.
  }
  fun collect(keep: List<String>): Unit {
    catalog.validate()
    require(keep.size <= 256 && keep.all { it.matches(Regex("[a-f0-9-]{36}/[a-f0-9]{64}")) }) { "Invalid retained skill versions" }
    val root = File(context.filesDir.canonicalFile, "skill-versions")
    require(!Files.isSymbolicLink(root.toPath())) { "Invalid version root" }
    if (!root.exists()) return
    var count = 0
    val started = SystemClock.elapsedRealtime()
    Files.newDirectoryStream(root.toPath()).use { ids -> for (id in ids) {
      require(++count <= 8192 && SystemClock.elapsedRealtime() - started < 60000 && !Files.isSymbolicLink(id)) { "Skill version cleanup exceeds budget" }
      if (!Files.isDirectory(id, NOFOLLOW_LINKS)) continue
      Files.newDirectoryStream(id).use { versions -> for (version in versions) {
        require(++count <= 8192 && SystemClock.elapsedRealtime() - started < 60000) { "Skill version cleanup exceeds budget" }
        if ("${id.fileName}/${version.fileName}" !in keep) erase(version.toFile())
      } }
    } }
  }
}
