package expo.modules.arxdrxd.windows

import org.junit.Assert.*
import org.junit.Test

class LauncherAppsTest {
  @Test fun packageInputCannotBeAnIntentCommandOrAddress() {
    assertTrue(validLauncherPackage("org.example.fixture"))
    for (bad in listOf("", "x", "x;id", "org.example/A", "127.0.0.1:5555", "org.example\n", "a".repeat(256))) {
      assertFalse(bad, validLauncherPackage(bad))
    }
  }
}
