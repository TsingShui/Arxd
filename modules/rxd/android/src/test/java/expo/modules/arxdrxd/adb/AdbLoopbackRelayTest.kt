package expo.modules.arxdrxd.adb

import org.junit.Assert.*
import org.junit.Test
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class AdbLoopbackRelayTest {
  @Test fun opaquePairingTrafficIsRelayedOnlyToTheSelectedLoopbackPort() {
    ServerSocket(0).use { target ->
      val worker = thread {
        target.accept().use { socket ->
          assertEquals(42, socket.getInputStream().read())
          socket.getOutputStream().write(43)
        }
      }
      AdbLoopbackRelay(target.localPort, false).use { relay ->
        relay.bounded(1000) {
          Socket("127.0.0.1", relay.port).use { client ->
            client.getOutputStream().write(42)
            assertEquals(43, client.getInputStream().read())
          }
        }
      }
      worker.join(1000); assertFalse(worker.isAlive)
    }
  }
  @Test fun connectionRejectsAPlaintextAdbPeer() {
    ServerSocket(0).use { target ->
      val worker = thread { target.accept().use { it.getOutputStream().write("CNXN".toByteArray() + ByteArray(20)) } }
      AdbLoopbackRelay(target.localPort, true).use { relay ->
        relay.bounded(1000) {
          Socket("127.0.0.1", relay.port).use { client -> assertEquals(-1, client.getInputStream().read()) }
        }
      }
      worker.join(1000); assertFalse(worker.isAlive)
    }
  }
  @Test fun stlsHeaderPassesThroughWithoutInspectingEncryptedPayload() {
    ServerSocket(0).use { target ->
      val header = "STLS".toByteArray() + ByteArray(20)
      val worker = thread { target.accept().use { it.getOutputStream().write(header) } }
      AdbLoopbackRelay(target.localPort, true).use { relay ->
        relay.bounded(1000) {
          Socket("127.0.0.1", relay.port).use { client ->
            val actual = ByteArray(24); DataInputStream(client.getInputStream()).readFully(actual)
            assertArrayEquals(header, actual)
          }
        }
      }
      worker.join(1000); assertFalse(worker.isAlive)
    }
  }
  @Test fun timeoutClosesEvenAHandshakeThatHasNotExposedStreamsYet() {
    ServerSocket(0).use { target ->
      val done = CountDownLatch(1)
      val worker = thread { target.accept().use { assertEquals(-1, it.getInputStream().read()); done.countDown() } }
      AdbLoopbackRelay(target.localPort, true).use { relay ->
        val start = System.nanoTime()
        val failure = assertThrows(AdbFailure::class.java) {
          relay.bounded(150) {
            Socket("127.0.0.1", relay.port).use { client -> client.getInputStream().read() }
          }
        }
        assertEquals("timeout", failure.code)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 1500)
        assertFalse(relay.alive)
      }
      assertTrue(done.await(1, TimeUnit.SECONDS)); worker.join(1000)
    }
  }
}
