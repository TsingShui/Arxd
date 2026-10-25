package expo.modules.arxdrxd.adb

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import io.github.muntashirakon.adb.AdbConnection
import io.github.muntashirakon.adb.AdbStream
import expo.modules.arxdrxd.display.DisplayFailure
import expo.modules.arxdrxd.display.DisplayRequest
import expo.modules.arxdrxd.display.DisplayServer
import expo.modules.arxdrxd.display.DisplaySession
import io.github.muntashirakon.adb.PairingConnectionCtx
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.Certificate
import java.util.Date
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import javax.security.auth.x500.X500Principal

/** Non-exportable RSA identity. Only a non-secret pairing history marker is stored in files. */
internal class AndroidAdbIdentity(context: Context) : AdbPairingStore {
  private val directory = File(context.noBackupFilesDir, "adb")
  private val marker = AtomicFile(File(directory, "paired-v1"))
  val name = "Arxd (${context.packageName})"
  private val keyStore: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun paired(): Boolean = runCatching {
    marker.openRead().use { it.read() == 49 && it.read() == -1 } && keyStore.containsAlias(ALIAS)
  }.getOrDefault(false)

  override fun remember() {
    check(directory.isDirectory || directory.mkdirs())
    val output = marker.startWrite()
    try { output.write(byteArrayOf(49)); marker.finishWrite(output) }
    catch (error: Exception) { marker.failWrite(output); throw error }
  }

  @Synchronized fun keys(): Pair<PrivateKey, Certificate> {
    val store = keyStore
    if (!store.containsAlias(ALIAS)) {
      val now = System.currentTimeMillis()
      val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
        .setKeySize(2048)
        // Conscrypt's delegated-key upcalls sign already-encoded TLS digests.
        // Raw RSA still uses PURPOSE_SIGN; the key is never authorized for decryption.
        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
        .setCertificateSubject(X500Principal("CN=Arxd ADB"))
        .setCertificateSerialNumber(BigInteger.ONE)
        .setCertificateNotBefore(Date(now - 3600000))
        .setCertificateNotAfter(Date(now + 3650L * 86400000))
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }
    return (store.getKey(ALIAS, null) as PrivateKey) to store.getCertificate(ALIAS)
  }
  private companion object { const val ALIAS = "arxd.adb.identity.v1" }
}

internal class AndroidAdbWire(port: Int, pairing: Boolean, private val identity: AndroidAdbIdentity) : AdbWire {
  private val relay = AdbLoopbackRelay(port, requireTls = !pairing)
  private val closed = AtomicBoolean(false)
  @Volatile private var connection: AdbConnection? = null
  private val displayEpoch = AtomicLong(0)
  private val opening = AtomicReference<AdbStream?>(null)
  private val display = AtomicReference<ShellDisplaySession?>(null)
  override val alive: Boolean get() = !closed.get() && relay.alive && connection?.isConnected == true

  override fun pair(code: String) = relay.bounded(30000) {
    val (key, certificate) = identity.keys()
    val password = code.toByteArray(Charsets.UTF_8)
    try {
      PairingConnectionCtx("127.0.0.1", relay.port, password, key, certificate, identity.name).use { it.start() }
    } finally { password.fill(0) }
  }

  override fun uid(): Int = relay.bounded(if (connection == null) 15000 else 5000) {
    val current = connection ?: run {
      val (key, certificate) = identity.keys()
      val created = AdbConnection.Builder("127.0.0.1", relay.port)
        .setApi(Build.VERSION.SDK_INT).setPrivateKey(key).setCertificate(certificate).setDeviceName(identity.name).build()
      connection = created
      if (closed.get()) { created.close(); throw AdbFailure("connection_lost") }
      if (!created.connect(10, TimeUnit.SECONDS, true)) throw AdbFailure("connection_failed")
      created
    }
    current.open("shell:id -u").use { stream ->
      stream.openInputStream().use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(32)
        while (true) {
          val count = input.read(buffer)
          if (count == -1) break
          if (output.size() + count > 32) throw AdbFailure("not_shell")
          output.write(buffer, 0, count)
        }
        output.toString("UTF-8").trim().toIntOrNull() ?: throw AdbFailure("not_shell")
      }
    }
  }

  override fun openDisplay(apkPath: String, request: DisplayRequest): DisplaySession {
    request.validate()
    if (!alive || display.get() != null) throw DisplayFailure("adb_required")
    val epoch = displayEpoch.get()
    // sourceDir is supplied by PackageManager, never a JS/file-manager path.
    val quoted = "'" + apkPath.replace("'", "'\\''") + "'"
    val command = "CLASSPATH=$quoted /system/bin/app_process /system/bin " + DisplayServer::class.java.name
    val stream = relay.bounded(15000) { connection!!.open("shell:$command") }
    opening.set(stream)
    try {
      if (closed.get() || epoch != displayEpoch.get()) throw DisplayFailure("cancelled")
      val candidate = ShellDisplaySession(stream, relay, request) { display.compareAndSet(it, null) }
      if (closed.get() || epoch != displayEpoch.get()) { candidate.close(); throw DisplayFailure("cancelled") }
      if (!display.compareAndSet(null, candidate)) { candidate.close(); throw DisplayFailure("already_running") }
      return candidate
    } catch (error: Exception) { runCatching { stream.close() }; throw error }
    finally { opening.compareAndSet(stream, null) }
  }
  override fun cancelDisplayOpening() {
    displayEpoch.incrementAndGet()
    runCatching { opening.getAndSet(null)?.close() }
  }
  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    relay.close() // Unblock upstream before joining its reader thread.
    cancelDisplayOpening()
    display.getAndSet(null)?.closeTransport()
    runCatching { connection?.close() }
    connection = null
  }
}
