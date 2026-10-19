package expo.modules.arxdrxd

import android.content.Context
import android.os.FileObserver
import android.os.SystemClock
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Private identity journal; installers only write skills/<folder>/SKILL.md. */
class SharedSkillCatalog(private val context: Context) {
  private val workspace = WorkspaceFiles(context)
  private val journal = File(context.filesDir, "shared-skills-index.json")
  private val revision = AtomicLong(1)
  private val observers = mutableListOf<FileObserver>()
  private val watchDirectories = mutableSetOf<String>()
  private fun exists(file: File) = Files.exists(file.toPath(), NOFOLLOW_LINKS)
  private fun key(file: File): String { val stat = Os.lstat(file.path); return "${stat.st_dev}:${stat.st_ino}" }
  fun root(): File {
    val target = File(context.filesDir, "skills")
    val legacy = File(context.filesDir, "workspace/skills")
    if (!exists(target) && legacy.isDirectory && !Files.isSymbolicLink(legacy.toPath())) {
      Files.move(legacy.toPath(), target.toPath(), ATOMIC_MOVE)
    }
    return workspace.skillsDirectory().also { check(it.isDirectory || it.mkdir()) { "Cannot create shared skills root" } }
  }
  // One descriptor and one limit+1 buffer: a concurrent writer cannot make a
  // stat-then-read allocation unbounded, and a replacement symlink is refused.
  private fun boundedRead(file: File, limit: Int): ByteArray {
    val fd = Os.open(file.path, android.system.OsConstants.O_RDONLY or android.system.OsConstants.O_CLOEXEC or
      android.system.OsConstants.O_NOFOLLOW or android.system.OsConstants.O_NONBLOCK, 0)
    val input = try { java.io.FileInputStream(fd) } catch (error: Throwable) { Os.close(fd); throw error }
    input.use {
      require(android.system.OsConstants.S_ISREG(Os.fstat(fd).st_mode)) { "${file.name} must be a regular file" }
      val buffer = ByteArray(limit + 1)
      var count = 0
      while (count < buffer.size) {
        val read = it.read(buffer, count, buffer.size - count)
        if (read < 0) break
        count += read
      }
      require(count <= limit) { "${file.name} exceeds $limit bytes" }
      return buffer.copyOf(count)
    }
  }
  private fun legacyChildren(directory: File, counted: () -> Unit = {}): List<File> {
    val result = mutableListOf<File>()
    Files.newDirectoryStream(directory.toPath()).use { stream ->
      val iterator = stream.iterator()
      while (result.size < 2 && iterator.hasNext()) { counted(); result.add(iterator.next().toFile()) }
    }
    return result
  }
  private fun read(): MutableList<JSONObject> {
    if (!exists(journal)) return mutableListOf()
    require(!Files.isSymbolicLink(journal.toPath()) && journal.length() <= 1024 * 1024) { "Skill identity journal exceeds budget" }
    val doc = JSONObject(boundedRead(journal, 1024 * 1024).toString(Charsets.UTF_8))
    require(doc.getInt("schema") == 1) { "Unsupported shared skills identity schema" }
    val rows = doc.getJSONArray("items"); require(rows.length() <= 4096) { "Skill identity journal exceeds 4096 records" }
    val ids = mutableSetOf<String>()
    return (0 until rows.length()).map { rows.getJSONObject(it) }.onEach {
      require(it.getString("id").matches(Regex("[a-f0-9-]{36}")) && ids.add(it.getString("id"))) { "Invalid or duplicate skill identity" }
      val path = it.getString("path")
      require(path.isNotEmpty() && !path.contains('/') && !path.contains('\\') && path != "." && path != "..") { "Invalid skill identity path" }
    }.toMutableList()
  }
  private fun save(rows: List<JSONObject>) {
    require(rows.size <= 4096) { "Skill identity journal exceeds 4096 records" }
    val text = JSONObject().put("schema", 1).put("items", JSONArray(rows)).toString()
    require(text.toByteArray().size <= 1024 * 1024) { "Skill identity journal exceeds 1 MiB" }
    if (journal.exists() && boundedRead(journal, 1024 * 1024).toString(Charsets.UTF_8) == text) return
    val stage = File(context.filesDir, ".shared-skills-${UUID.randomUUID()}")
    try {
      stage.outputStream().use { it.write(text.toByteArray()); it.fd.sync() }
      Files.move(stage.toPath(), journal.toPath(), ATOMIC_MOVE)
    } finally { stage.delete() }
  }
  fun alias(): String? = runCatching {
    val home = workspace.homeDirectory()
    val link = File(home, "skills")
    val shared = root()
    if (exists(link)) {
      require(Files.isSymbolicLink(link.toPath())) { "Home skills alias conflicts with existing content; preserve it and move it explicitly" }
      val target = runCatching { Files.readSymbolicLink(link.toPath()) }.getOrNull()
      val resolved = target?.let { link.toPath().parent.resolve(it).normalize() }
      val current = shared.toPath().toAbsolutePath().normalize()
      val legacy = File(context.filesDir, "workspace/skills").toPath().toAbsolutePath().normalize()
      val legacySuffix = File("workspace/skills").path
      val migrated = resolved == legacy || resolved?.toString()?.endsWith(File.separator + legacySuffix) == true
      if (resolved != current) {
        require(migrated) { "Home skills alias conflicts with existing content; preserve it and move it explicitly" }
        Files.delete(link.toPath())
        Files.createSymbolicLink(link.toPath(), shared.toPath())
      }
    } else Files.createSymbolicLink(link.toPath(), shared.toPath())
    require(Os.stat(link.path).st_uid == Os.stat(shared.path).st_uid) { "Skills alias identity mismatch" }
  }.exceptionOrNull()?.message?.take(800)
  fun validate() { read() }
  fun revision(): String = revision.get().toString()
  fun close() { observers.forEach { it.stopWatching() }; observers.clear(); watchDirectories.clear() }
  private fun watch(paths: Set<String>) {
    val wanted = paths.sorted().take(512).toSet()
    if (wanted == watchDirectories) return
    close()
    for (path in wanted) {
      @Suppress("DEPRECATION") val observer = object : FileObserver(path, CREATE or DELETE or MOVED_FROM or MOVED_TO or CLOSE_WRITE or DELETE_SELF or MOVE_SELF or ATTRIB) {
        override fun onEvent(event: Int, path: String?) { revision.incrementAndGet() }
      }
      observer.startWatching(); observers.add(observer)
    }
    watchDirectories.addAll(wanted)
  }
  fun directory(id: String): File {
    val record = read().find { it.getString("id") == id }
    if (record != null) return File(root(), record.getString("path"))
    // Old imports are readable before the first resumable migration.
    val old = File(root(), id)
    require(old.isDirectory) { "Skill directory is missing" }
    val children = legacyChildren(old)
    require(children.size == 1 && children[0].isDirectory && !Files.isSymbolicLink(children[0].toPath())) { "Invalid legacy skill directory" }
    return children[0]
  }
  fun register(id: String, directory: File) {
    val rows = read()
    require(rows.none { it.getString("id") == id || it.getString("path") == directory.name }) { "Skill identity or directory already exists" }
    rows.add(JSONObject().put("id", id).put("path", directory.name).put("key", key(directory)))
    save(rows)
  }
  fun adopt(id: String, source: File, name: String): File {
    if (source.parentFile == root()) return source
    val target = File(root(), name)
    require(!exists(target)) { "Shared skill name/path conflicts with existing content" }
    val rows = read()
    require(rows.none { it.getString("id") == id }) { "Skill identity already registered" }
    val record = JSONObject().put("id", id).put("path", source.parentFile!!.name).put("key", key(source)).put("origin", "app-import")
    rows.add(record); save(rows)
    Files.move(source.toPath(), target.toPath(), ATOMIC_MOVE)
    source.parentFile!!.delete(); record.put("path", name); save(rows)
    return target
  }
  fun rename(id: String, name: String): File {
    val current = directory(id)
    if (current.name == name) return current
    val target = File(root(), name)
    require(!exists(target)) { "Shared skill name/path conflicts with existing content" }
    // Persist identity before moving: inode matching recovers a crash before path commit.
    val rows = read(); val record = rows.find { it.getString("id") == id } ?: error("Missing skill journal record")
    save(rows)
    Files.move(current.toPath(), target.toPath(), ATOMIC_MOVE)
    record.put("path", name); save(rows)
    return target
  }
  fun discover(): Map<String, Any?> {
    val shared = root()
    val aliasError = alias()
    val started = SystemClock.elapsedRealtime()
    val rows = read()
    var scanned = 0
    var totalBytes = 0L
    val watches = mutableSetOf(shared.path)
    val entries = mutableListOf<Map<String, Any?>>()
    val children = mutableListOf<File>()
    Files.newDirectoryStream(shared.toPath()).use { stream -> for (entry in stream) {
      require(++scanned <= 4096 && SystemClock.elapsedRealtime() - started < 15000) { "Skills scan exceeds 4096 entries or 15 seconds; removals were not reconciled" }
      if (!entry.fileName.toString().startsWith('.')) children.add(entry.toFile())
    } }
    require(children.size <= 256) { "Shared skills root exceeds 256 packages; removals were not reconciled" }
    // Legacy UUID/name -> direct name, with journal-before-move and inode recovery.
    for (old in children.toList()) if (old.name.matches(Regex("[a-f0-9-]{36}")) && old.isDirectory && !Files.isSymbolicLink(old.toPath()) && !File(old, "SKILL.md").exists()) {
      val nested = legacyChildren(old) {
        require(++scanned <= 4096 && SystemClock.elapsedRealtime() - started < 15000) { "Legacy skills scan exceeds entry/time budget; removals were not reconciled" }
      }
      if (nested.size == 1 && nested[0].isDirectory && !Files.isSymbolicLink(nested[0].toPath())) {
        val source = nested[0]; val target = File(shared, source.name)
        val record = rows.find { it.getString("id") == old.name } ?: JSONObject().put("id", old.name).put("path", old.name).put("key", key(source)).put("origin", "app-import").also { rows.add(it); save(rows) }
        if (!exists(target)) {
          record.put("key", key(source)); save(rows)
          Files.move(source.toPath(), target.toPath(), ATOMIC_MOVE)
          old.delete(); record.put("path", target.name); save(rows)
          children.remove(old); children.add(target)
        }
      } else if (nested.isEmpty()) {
        val record = rows.find { it.getString("id") == old.name }
        val moved = record?.let { row -> children.find { it != old && key(it) == row.optString("key") } }
        if (record != null && moved != null) { record.put("path", moved.name); save(rows); old.delete(); children.remove(old) }
      }
    }
    val liveIds = mutableSetOf<String>()
    for (directory in children.sortedBy { it.name }) {
      val inode = key(directory)
      val matches = rows.filter { it.optString("key") == inode }
      require(matches.size <= 1) { "Ambiguous shared skill identity" }
      val record = matches.singleOrNull() ?: rows.find { it.getString("path") == directory.name }
        ?: JSONObject().put("id", UUID.randomUUID().toString()).put("path", directory.name).put("key", inode).also { rows.add(it) }
      val id = record.getString("id")
      require(liveIds.add(id)) { "Two directories claim one skill identity" }
      record.put("path", directory.name).put("key", inode)
      val stamps = mutableListOf<String>()
      var packageEntries = 0
      var packageBytes = 0L
      var error: String? = null
      try {
        fun scan(file: File, depth: Int) {
          if (depth > 0) packageEntries++
          require(++scanned <= 4096 && packageEntries <= 256 && depth <= 16 && SystemClock.elapsedRealtime() - started < 15000) { "Skill scan exceeds entry/depth/time budget" }
          require(!Files.isSymbolicLink(file.toPath())) { "Skill packages/resources cannot be symbolic links" }
          val stat = Files.readAttributes(file.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, NOFOLLOW_LINKS)
          stamps.add("${file.relativeTo(shared).path}\u0000${stat.fileKey()}\u0000${stat.size()}\u0000${stat.lastModifiedTime()}\u0000${stat.creationTime()}")
          if (stat.isDirectory) {
            watches.add(file.path)
            Files.newDirectoryStream(file.toPath()).use { stream -> for (entry in stream) scan(entry.toFile(), depth + 1) }
          } else {
            require(stat.isRegularFile && stat.size() <= 2 * 1024 * 1024) { "Skill resource must be a regular file <= 2 MiB" }
            packageBytes += stat.size(); totalBytes += stat.size()
            require(packageBytes <= 8 * 1024 * 1024 && totalBytes <= 512L * 1024 * 1024) { "Skill package/root storage budget exceeded" }
          }
        }
        require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) { "Skill must be a regular directory" }
        scan(directory, 0)
      } catch (failure: Throwable) { error = failure.message?.take(800) ?: "Invalid skill" }
      require(scanned <= 4096 && SystemClock.elapsedRealtime() - started < 15000 && totalBytes <= 512L * 1024 * 1024) { "Incomplete shared skills scan; removals were not reconciled" }
      val definition = runCatching {
        require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) { "Skill packages cannot be symbolic links" }
        val file = File(directory, "SKILL.md")
        require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() <= 65536) { "Pending or invalid SKILL.md" }
        val data = boundedRead(file, 65536)
        Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(data)).toString()
      }.getOrElse { error = it.message?.take(800); "" }
      val fingerprint = MessageDigest.getInstance("SHA-256").digest((stamps.sorted().joinToString("\n") + definition).toByteArray()).joinToString("") { "%02x".format(it) }
      entries.add(mapOf("id" to id, "folder" to directory.name, "path" to directory.name, "definition" to definition, "fingerprint" to fingerprint, "origin" to record.optString("origin", "shell"), "error" to error))
    }
    save(rows); watch(watches)
    return mapOf("items" to entries, "complete" to true, "alias" to "~/skills", "aliasError" to aliasError, "scannedEntries" to scanned, "durationMs" to SystemClock.elapsedRealtime() - started, "revision" to revision())
  }
}
