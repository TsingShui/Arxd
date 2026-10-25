package expo.modules.arxdrxd.adb

import org.junit.Assert.*
import org.junit.Test
import expo.modules.arxdrxd.display.DisplayFailure
import expo.modules.arxdrxd.display.DisplayRequest
import expo.modules.arxdrxd.display.DisplaySession
import expo.modules.arxdrxd.display.DisplayState
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class AdbAuthorizationTest {
  private class Store(var saved: Boolean = false) : AdbPairingStore {
    var writes = 0
    override fun paired() = saved
    override fun remember() { saved = true; writes++ }
  }
  private class Wire(var value: Int = 2000) : AdbWire {
    var closed = false
    var live = true
    var onPair: (() -> Unit)? = null
    var displayCalls = 0
    override val alive get() = live && !closed
    override fun pair(code: String) { onPair?.invoke() }
    override fun uid() = value
    override fun openDisplay(apkPath: String, request: DisplayRequest): DisplaySession {
      displayCalls++
      return object : DisplaySession {
        override fun refresh() = DisplayState("running", request.packageName, request.component, 42, 17, 2000)
        override fun snapshot() = "test fixture, not a live image"
        override fun close() {}
      }
    }
    override fun close() { closed = true }
  }
  @Test fun pairingIsHistoryNotAConnectionAndReopeningNeverRestoresAGrant() {
    val store = Store(); val first = Wire()
    val owner = AdbAuthorization(true, store, { _, _ -> first }, { 123L })
    assertFalse(owner.status().paired)
    val paired = owner.pair(32000, "123456")
    assertTrue(paired.paired); assertNull(paired.uid); assertEquals("disconnected", paired.phase)
    assertTrue(first.closed)
    val reopened = AdbAuthorization(true, store, { _, _ -> error("No automatic network work") })
    assertTrue(reopened.status().paired); assertNull(reopened.status().checkedAt)
    assertEquals("disconnected", reopened.status().phase)
  }
  @Test fun onlyVerifiedShellIsConnectedAndFailedRechecksInvalidateIt() {
    val wire = Wire(); val owner = AdbAuthorization(true, Store(true), { _, _ -> wire }, { 123L })
    val connected = owner.connect(33000)
    assertEquals("connected", connected.phase); assertEquals(2000, connected.uid)
    assertEquals(123L, connected.checkedAt)
    wire.value = 0 // A root daemon is not silently represented as shell.
    val lost = owner.check()
    assertEquals("not_shell", lost.error); assertNull(lost.uid); assertTrue(wire.closed)
  }
  @Test fun malformedRequestsAndUnsupportedDevicesNeverOpenTransport() {
    var calls = 0
    val owner = AdbAuthorization(true, Store(), { _, _ -> calls++; Wire() })
    for (port in listOf(-1, 0, 65536)) {
      assertEquals("invalid_port", assertThrows(AdbFailure::class.java) { owner.pair(port, "123456") }.code)
    }
    for (code in listOf("", "12345", "abcdef", "1234567")) {
      assertEquals("invalid_code", assertThrows(AdbFailure::class.java) { owner.pair(32000, code) }.code)
    }
    assertEquals("pair_first", owner.connect(32000).error)
    val old = AdbAuthorization(false, Store(), { _, _ -> calls++; Wire() })
    assertEquals("unsupported", assertThrows(AdbFailure::class.java) { old.connect(32000) }.code)
    assertEquals(0, calls)
  }
  @Test fun displayOpeningRechecksShellIdentityAndNeverTrustsPairingHistory() {
    val wire = Wire(); val owner = AdbAuthorization(true, Store(true), { _, _ -> wire })
    val request = DisplayRequest("org.example.fixture", "org.example.fixture/.MainActivity")
    assertEquals("adb_required", assertThrows(DisplayFailure::class.java) { owner.openDisplay("/fixture.apk", request) }.code)
    assertEquals(0, wire.displayCalls)
    owner.connect(33000)
    owner.openDisplay("/fixture.apk", request).close()
    assertEquals(1, wire.displayCalls)
    wire.value = 0
    assertThrows(DisplayFailure::class.java) { owner.openDisplay("/fixture.apk", request) }
    assertEquals(1, wire.displayCalls); assertNull(owner.status().uid)
  }
  @Test fun errorsNeverContainPairingSecrets() {
    val wire = Wire().apply { onPair = { throw IllegalStateException("sensitive pairing code 123456") } }
    val state = AdbAuthorization(true, Store(), { _, _ -> wire }).pair(32000, "123456")
    assertEquals("pairing_failed", state.error); assertFalse(state.paired); assertTrue(wire.closed)
  }
  @Test fun disconnectCancelsInFlightPairingAndLateSuccessCannotRestoreIt() {
    val started = CountDownLatch(1); val release = CountDownLatch(1); val store = Store()
    val wire = Wire().apply { onPair = { started.countDown(); release.await(2, TimeUnit.SECONDS) } }
    val owner = AdbAuthorization(true, store, { _, _ -> wire })
    val worker = thread { owner.pair(32000, "123456") }
    assertTrue(started.await(1, TimeUnit.SECONDS))
    assertEquals("busy", assertThrows(AdbFailure::class.java) { owner.connect(33000) }.code)
    owner.disconnect(); assertTrue(wire.closed)
    release.countDown(); worker.join(1000); assertFalse(worker.isAlive)
    assertEquals(0, store.writes); assertFalse(owner.status().paired); assertNull(owner.status().uid)
  }
  @Test fun lossOfTheTransportAndExplicitDisconnectBothRemoveTheVerifiedUid() {
    val wire = Wire(); val owner = AdbAuthorization(true, Store(true), { _, _ -> wire })
    owner.connect(33000); wire.live = false
    assertEquals("connection_lost", owner.status().error); assertNull(owner.status().uid)
    assertTrue(owner.disconnect().paired) // Disconnecting is not revocation of device trust.
    assertNull(owner.status().error)
  }
}
