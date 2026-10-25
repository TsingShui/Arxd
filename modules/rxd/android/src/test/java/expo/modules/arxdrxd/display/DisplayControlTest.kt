package expo.modules.arxdrxd.display

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class DisplayControlTest {
  private val request = DisplayRequest("org.example.fixture", "org.example.fixture/.MainActivity")
  private fun ready() = DisplayState("running", request.packageName, request.component, 42, 17, 2000)
  private class Session(var state: DisplayState) : DisplaySession {
    var closed = false
    override fun refresh() = state
    override fun snapshot() = "fixture-not-live-image"
    override fun close() { closed = true }
  }
  @Test fun usesHostDensityWithoutExceedingTheFramebufferBudget() {
    for (density in listOf(120, 160, 320, 420, 480, 640, 960)) {
      val request = displayRequestForDensity("org.example.fixture", "org.example.fixture/.MainActivity", density)
      request.validate()
      assertEquals(density.coerceIn(160, 640), request.densityDpi)
      assertTrue(request.width.toLong() * request.height <= 2073600)
    }
    val pixel = displayRequestForDensity("org.example.fixture", "org.example.fixture/.MainActivity", 420)
    assertEquals(945, pixel.width); assertEquals(1680, pixel.height)
  }
  @Test fun detectsMidTaskActivitiesButIgnoresStaleExitingWindows() {
    val header = "ACTIVITY MANAGER ACTIVITIES\nDisplay #0\n"
    val middle = "* Hist #1: ActivityRecord{abc u0 org.example.fixture/.A t17}\n"
    val stale = "mLastWakeLockObscuringWindow=Window{abc u0 org.example.fixture/.A EXITING}"
    assertTrue(hasActivityHistory(header + middle, "org.example.fixture"))
    assertFalse(hasActivityHistory(header + stale, "org.example.fixture"))
    assertThrows(DisplayFailure::class.java) { hasActivityHistory("unrecognized vendor dump", "org.example.fixture") }
  }
  @Test fun validatesAppIdentityAndBoundsBeforeOpeningAnything() {
    val owner = DisplayControl({ error("Must not open") }, {})
    for (bad in listOf(request.copy(packageName = "x;id"), request.copy(component = "other.pkg/.A"),
      request.copy(component = "org.example.fixture/.A;id"), request.copy(width = 0),
      request.copy(width = 1920, height = 1920), request.copy(densityDpi = 0))) {
      assertThrows(DisplayFailure::class.java) { owner.start(bad) }
    }
  }
  @Test fun rejectsDefaultDisplayWrongUidAndWrongTaskIdentity() {
    for (invalid in listOf(ready().copy(displayId = 0), ready().copy(uid = 0),
      ready().copy(packageName = "other.pkg"), ready().copy(taskId = null), ready().copy(width = 1080))) {
      val session = Session(invalid)
      val owner = DisplayControl({ session }, {})
      assertEquals("invalid_reply", owner.start(request).error)
      assertTrue(session.closed)
    }
  }
  @Test fun preflightRefusalDoesNotInventAnOwnedDisplay() {
    val owner = DisplayControl({ throw DisplayFailure("app_running") }, {})
    assertEquals("app_running", owner.start(request).error)
    assertEquals("stopped", owner.stop().phase)
  }
  @Test fun oneDisplayIsExplicitlyStoppedBeforeReplacement() {
    val session = Session(ready()); val owner = DisplayControl({ session }, {})
    assertEquals(42, owner.start(request).displayId)
    assertThrows(DisplayFailure::class.java) { owner.start(request) }
    assertEquals("fixture-not-live-image", owner.snapshot())
    assertEquals("stopped", owner.stop().phase); assertTrue(session.closed)
    assertThrows(DisplayFailure::class.java) { owner.snapshot() }
  }
  @Test fun interruptedStartupCannotPublishALateDisplay() {
    val began = CountDownLatch(1); val release = CountDownLatch(1); val candidate = Session(ready())
    val owner = DisplayControl({ began.countDown(); release.await(2, TimeUnit.SECONDS); candidate }, { release.countDown() })
    val worker = thread { owner.start(request) }
    assertTrue(began.await(1, TimeUnit.SECONDS))
    owner.stop(); worker.join(1000)
    assertFalse(worker.isAlive); assertTrue(candidate.closed); assertEquals("stopped", owner.status().phase)
  }
  @Test fun invalidRefreshAndFailedCleanupAreNotReportedAsSuccessful() {
    val session = Session(ready()); val owner = DisplayControl({ session }, {})
    owner.start(request); session.state = ready().copy(displayId = 0)
    assertEquals("session_lost", owner.check().error); assertTrue(session.closed)
    val failing = DisplayControl({ object : DisplaySession {
      override fun refresh() = ready()
      override fun snapshot() = ""
      override fun close() { throw IllegalStateException("cleanup fixture") }
    } }, {})
    failing.start(request); assertEquals("cleanup_pending", failing.stop().error)
  }
}
