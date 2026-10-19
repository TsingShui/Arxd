package expo.modules.arxdrxd

import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSink
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/** Applied only to explicitly marked model calls; native wall time survives JS suspension. */
object ModelRequestPolicy {
  private const val MARKER = "X-Arxd-Model-Request"
  private const val TIMEOUT = "X-Arxd-Model-Timeout-Ms"
  private const val DEADLINE = "X-Arxd-Model-Deadline-At"
  private const val LIMIT = 64
  private val active = AtomicInteger()
  private val scheduler = ScheduledThreadPoolExecutor(1) { task ->
    Thread(task, "arxd-model-deadlines").apply { isDaemon = true }
  }.apply { removeOnCancelPolicy = true }

  fun apply(builder: OkHttpClient.Builder): OkHttpClient.Builder = builder.addInterceptor { chain ->
    val request = chain.request()
    if (request.header(MARKER) != "1") return@addInterceptor chain.proceed(request)
    val timeout = request.header(TIMEOUT)?.toLongOrNull()
      ?.takeIf { it in 1..90_000 } ?: throw IOException("Invalid model request deadline")
    val deadline = request.header(DEADLINE)?.toLongOrNull()
      ?.takeIf { it > 0 } ?: throw IOException("Invalid model request deadline")
    // A dispatcher backlog must not restart a relative timeout on admission.
    val remaining = minOf(timeout, deadline - System.currentTimeMillis())
    if (remaining <= 0) throw SocketTimeoutException("Arxd model request timeout: deadline expired before dispatch")
    val body = request.body ?: throw IOException("A model generation request requires a body")
    if (active.incrementAndGet() > LIMIT) {
      active.decrementAndGet()
      throw IOException("Model request concurrency limit exceeded")
    }
    val closed = AtomicBoolean()
    val expired = AtomicBoolean()
    val timer = try {
      scheduler.schedule({ if (!closed.get()) { expired.set(true); chain.call().cancel() } }, remaining, TimeUnit.MILLISECONDS)
    } catch (error: RuntimeException) { active.decrementAndGet(); throw IOException("Model deadline scheduling failed", error) }
    fun cleanup() {
      if (closed.compareAndSet(false, true)) { timer.cancel(false); active.decrementAndGet() }
    }
    fun checked(error: IOException): IOException {
      if (expired.get()) return SocketTimeoutException("Arxd model request timeout: deadline expired").apply { initCause(error) }
      // Expo 58 forwards localized messages, discarding the Java exception type.
      // Chunked-body EOFException often has no message. Preserve bounded typed
      // provenance at this real native IO boundary before that information is lost.
      val causes = generateSequence<Throwable>(error) { it.cause }.take(4).toList()
      val types = causes.joinToString(",") { it.javaClass.name }
      val message = error.message?.takeIf { it.isNotBlank() }?.take(400) ?: "No native diagnostic message"
      return IOException("Arxd model transport [$types]: $message", error)
    }
    val once = object : RequestBody() {
      override fun contentType() = body.contentType()
      override fun contentLength() = body.contentLength()
      override fun isDuplex() = body.isDuplex()
      override fun isOneShot() = true
      override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
    }
    try {
      val response = chain.proceed(request.newBuilder().removeHeader(MARKER).removeHeader(TIMEOUT).removeHeader(DEADLINE).method(request.method, once).build())
      val responseBody = response.body
      if (responseBody == null) { cleanup(); return@addInterceptor response }
      val source = object : ForwardingSource(responseBody.source()) {
        override fun read(sink: Buffer, byteCount: Long): Long {
          try {
            val count = super.read(sink, byteCount)
            if (expired.get()) throw SocketTimeoutException("Arxd model request timeout: deadline expired")
            if (count == -1L) cleanup()
            return count
          } catch (error: IOException) { cleanup(); throw checked(error) }
        }
        override fun close() { try { super.close() } finally { cleanup() } }
      }.buffer()
      response.newBuilder().body(object : ResponseBody() {
        override fun contentType() = responseBody.contentType()
        override fun contentLength() = responseBody.contentLength()
        override fun source(): BufferedSource = source
      }).build()
    } catch (error: IOException) { cleanup(); throw checked(error) }
    catch (error: Throwable) { cleanup(); throw error }
  }
}
