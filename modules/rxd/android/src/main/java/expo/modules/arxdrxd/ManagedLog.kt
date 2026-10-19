package expo.modules.arxdrxd

import java.io.File
import java.io.RandomAccessFile
import android.util.Base64
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Fixed-size byte ring. The committed byte count is a cursor, not a text offset. */
internal class ManagedLog(private val file: File, private val capacity: Int = 1024 * 1024) {
  private var total: Long = 0
  init {
    if (file.isFile && file.length() >= 8) RandomAccessFile(file, "r").use { total = it.readLong().coerceAtLeast(0) }
  }
  @Synchronized fun append(bytes: ByteArray, length: Int) {
    require(length in 0..bytes.size)
    if (length == 0) return
    file.parentFile!!.mkdirs()
    RandomAccessFile(file, "rw").use { output ->
      var offset = 0
      while (offset < length) {
        val position = (total % capacity).toInt()
        val count = minOf(length - offset, capacity - position)
        output.seek(8L + position); output.write(bytes, offset, count)
        total += count; offset += count
      }
      output.seek(0); output.writeLong(total)
    }
  }
  @Synchronized fun read(cursor: Long, limit: Int): Map<String, Any> {
    require(cursor >= -1 && limit in 1..49152) { "Invalid log cursor or page size" }
    val oldest = maxOf(0L, total - capacity)
    require(cursor <= total) { "Log cursor is beyond this stream" }
    val requested = if (cursor == -1L) maxOf(0L, total - limit) else cursor
    val from = maxOf(requested, oldest)
    val size = minOf(limit.toLong(), total - from).toInt()
    val data = ByteArray(size)
    if (size > 0) RandomAccessFile(file, "r").use { input ->
      var offset = 0
      while (offset < size) {
        val position = ((from + offset) % capacity).toInt()
        val count = minOf(size - offset, capacity - position)
        input.seek(8L + position); input.readFully(data, offset, count); offset += count
      }
    }
    val text = runCatching { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString() }.getOrNull()
    return mapOf("cursor" to from, "nextCursor" to from + size, "totalBytes" to total,
      "droppedBytes" to maxOf(0L, oldest - requested), "base64" to Base64.encodeToString(data, Base64.NO_WRAP),
      "text" to (text ?: org.json.JSONObject.NULL),
      "complete" to (from + size == total), "retainedBytes" to minOf(total, capacity.toLong()))
  }
}
