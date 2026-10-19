package expo.modules.arxdrxd

import android.content.Context
import android.util.AtomicFile
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.FileInputStream
import java.io.File
import org.json.JSONObject

/** App-owned, conversation-independent policy. All access uses NativeMcp's admission lock. */
internal class PlainHttpMcpPolicy(context: Context) {
  private val file = AtomicFile(File(context.filesDir, "http-mcp-policy.json"))
  @Volatile var allowed = false
    private set
  private var source = "default"
  private var diagnostic: String? = null
  init {
    try {
      file.openRead().use { input ->
        val buffer = ByteArray(257)
        var size = 0
        while (size < buffer.size) { val n = input.read(buffer, size, buffer.size - size); if (n < 0) break; size += n }
        check(size in 1..256) { "Policy exceeds its 256-byte budget" }
        val value = JSONObject(String(buffer, 0, size, Charsets.UTF_8))
        check(value.length() == 2 && value.get("version") is Int && value.getInt("version") == 1 && value.get("allowPlaintextHttp") is Boolean) { "Unsupported HTTP MCP policy" }
        allowed = value.getBoolean("allowPlaintextHttp"); source = "saved"
      }
    } catch (_: java.io.FileNotFoundException) {
      // Missing is the default, but a broken existing file is never permission.
      if (file.baseFile.exists()) { source = "invalid"; diagnostic = "HTTP MCP policy is unreadable; disabled" }
    } catch (_: Exception) { allowed = false; source = "invalid"; diagnostic = "HTTP MCP policy is invalid; disabled" }
  }
  fun view(): JSONObject = JSONObject().put("version", 1).put("allowPlaintextHttp", allowed)
    .put("source", source).put("error", diagnostic ?: JSONObject.NULL)
  private fun requireAbsent(path: String) {
    try { Os.lstat(path); error("Atomic policy staging is still present") }
    catch (error: ErrnoException) { if (error.errno != OsConstants.ENOENT) throw error }
  }
  private fun verifyCommit(bytes: ByteArray, device: Long, inode: Long) {
    // finishWrite() logs rename/delete failures without throwing on Android.
    // Do not use AtomicFile.openRead(): it can delete .new and hide that failure.
    requireAbsent(file.baseFile.path + ".new")
    requireAbsent(file.baseFile.path + ".bak")
    val descriptor = Os.open(file.baseFile.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC, 0)
    try { FileInputStream(descriptor).use { input ->
      val stat = Os.fstat(input.fd)
      check(OsConstants.S_ISREG(stat.st_mode) && stat.st_dev == device && stat.st_ino == inode) { "Atomic policy replacement did not commit the written file" }
      val buffer = ByteArray(257)
      var size = 0
      while (size < buffer.size) { val n = input.read(buffer, size, buffer.size - size); if (n < 0) break; size += n }
      check(size in 1..256 && size == bytes.size && buffer.copyOf(size).contentEquals(bytes)) { "Committed HTTP policy differs from the requested value" }
    } } finally { Os.close(descriptor) } // Android FileInputStream(fd) does not own this descriptor.
  }
  fun set(value: Boolean) {
    val bytes = JSONObject().put("version", 1).put("allowPlaintextHttp", value).toString().toByteArray(Charsets.UTF_8)
    var output: java.io.FileOutputStream? = null
    try {
      output = file.startWrite(); output.write(bytes); output.fd.sync()
      val written = Os.fstat(output.fd)
      file.finishWrite(output)
      verifyCommit(bytes, written.st_dev, written.st_ino)
      allowed = value; source = "saved"; diagnostic = null
    } catch (error: Exception) {
      allowed = false; source = "invalid"; diagnostic = "HTTP MCP policy could not be saved; disabled in this process"
      output?.let { runCatching { file.failWrite(it) } }
      throw IllegalStateException(diagnostic, error)
    }
  }
}
