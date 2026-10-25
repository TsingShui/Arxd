package expo.modules.arxdrxd.adb

import java.io.Closeable
import java.io.DataInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One-connection, loopback-only relay around upstream's blocking sockets. Closing
 * it cancels even a PAKE/TLS handshake before the library exposes its streams.
 * No ADB credentials or decrypted traffic are inspected here.
 */
internal class AdbLoopbackRelay(targetPort: Int, private val requireTls: Boolean) : Closeable {
  private val lock = Any()
  private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
  private val running = AtomicBoolean(true)
  private var client: Socket? = null
  private var target: Socket? = null
  private val workers = Executors.newFixedThreadPool(2) { job -> Thread(job, "arxd-adb-relay").apply { isDaemon = true } }
  val port: Int = server.localPort
  val alive: Boolean get() = running.get()

  init {
    require(targetPort in 1..65535)
    workers.execute {
      try {
        val accepted = server.accept()
        val upstream = Socket()
        synchronized(lock) {
          if (!running.get()) { accepted.close(); upstream.close(); return@execute }
          client = accepted; target = upstream
        }
        server.close() // Never accept a second local client.
        upstream.connect(InetSocketAddress("127.0.0.1", targetPort), 4000)
        accepted.tcpNoDelay = true; upstream.tcpNoDelay = true
        workers.execute {
          try { accepted.getInputStream().copyTo(upstream.getOutputStream()) }
          catch (_: Exception) { /* Closed socket cancels the peer copy as well. */ }
          finally { close() }
        }
        val source = upstream.getInputStream()
        val sink = accepted.getOutputStream()
        if (requireTls) {
          upstream.soTimeout = 5000
          val header = ByteArray(24)
          DataInputStream(source).readFully(header)
          // Wireless debugging must start with STLS, never classic AUTH/plain CNXN.
          if (!header.copyOfRange(0, 4).contentEquals(byteArrayOf(83, 84, 76, 83))) throw AdbFailure("tls_required")
          sink.write(header); sink.flush()
          upstream.soTimeout = 0
        }
        source.copyTo(sink)
      } catch (_: Exception) { /* The operation returns a fixed, non-sensitive error. */ }
      finally { close() }
    }
  }

  fun <T> bounded(timeoutMs: Long, action: () -> T): T {
    val expired = AtomicBoolean(false)
    val timer = deadlines.schedule({ expired.set(true); close() }, timeoutMs, TimeUnit.MILLISECONDS)
    try {
      val result = action()
      if (expired.get()) throw AdbFailure("timeout")
      return result
    } catch (error: Exception) {
      if (expired.get()) throw AdbFailure("timeout")
      throw error
    } finally { timer.cancel(false) }
  }

  override fun close() {
    if (!running.compareAndSet(true, false)) return
    synchronized(lock) {
      runCatching { server.close() }; runCatching { client?.close() }; runCatching { target?.close() }
    }
    workers.shutdownNow()
  }
  private companion object {
    val deadlines = Executors.newSingleThreadScheduledExecutor { job -> Thread(job, "arxd-adb-deadline").apply { isDaemon = true } }
  }
}
