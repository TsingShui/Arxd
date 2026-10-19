package expo.modules.arxdrxd

import android.content.Context
import java.io.File

/** Explicit managed shell environment, shared by bounded tasks and staged setup. */
object RuntimeLaunch {
  fun builder(context: Context, runtimeRoot: File, scriptFile: File, pidFile: File,
    cwd: File? = null, overrides: Map<String, String> = emptyMap()): ProcessBuilder {
    val root = runtimeRoot
    val prefix = File(root, "usr")
    val bash = File(prefix, "bin/bash").path
    // The shim's unsetenv cannot erase the original envp imported by Bash.
    // Remove the one-shot job bootstrap variable in Bash itself before any
    // fork/exec, then replace this shell without changing its PID/group.
    val builder = ProcessBuilder("/system/bin/linker64", bash, "--noprofile", "--norc", "-c",
      "unset ARXD_JOB_FILE\nexec \"\$@\"", "arxd-managed-entry", bash,
      "--noprofile", "--norc", scriptFile.path).directory(cwd ?: File(root, "home"))
    builder.environment().apply {
      clear()
      put("ANDROID_ROOT", "/system")
      put("ANDROID_DATA", "/data")
      put("ANDROID_ART_ROOT", "/apex/com.android.art")
      // Expose real App paths: tools such as mkdir -p walk parents via
      // relative dirfd calls, which cannot traverse another App's virtual root.
      put("PATH", File(prefix, "bin").path + ":/system/bin")
      put("HOME", File(root, "home").path)
      put("SHELL", File(prefix, "bin/bash").path)
      put("PREFIX", prefix.path)
      put("TERMUX__PREFIX", prefix.path)
      put("TERMUX__HOME", File(root, "home").path)
      put("TERMUX_APP_PACKAGE_MANAGER", "apt")
      put("TERMUX_MAIN_PACKAGE_FORMAT", "debian")
      // Keep the official source shipped in the verified bootstrap. pkg itself
      // supports this switch; package signatures and HTTPS remain enabled.
      put("TERMUX_PKG_NO_MIRROR_SELECT", "1")
      put("TERMUX_APP__PACKAGE_NAME", context.packageName)
      put("TERMUX_APP__DATA_DIR", root.parentFile!!.path)
      put("TMPDIR", File(prefix, "tmp").path)
      put("LANG", "C.UTF-8")
      put("TERM", "dumb")
      put("DEBIAN_FRONTEND", "noninteractive")
      put("LD_PRELOAD", File(context.applicationInfo.nativeLibraryDir, "libarxdpreload.so").path)
      put("LD_LIBRARY_PATH", File(prefix, "lib").path)
      put("ARXD_TERMUX_ROOT", root.path)
      put("ARXD_SKILLS", File(context.filesDir, "skills").also { it.mkdirs() }.path)
      put("ARXD_WORKSPACE", File(context.filesDir, "workspace").also { it.mkdirs() }.path)
      put("ARXD_TERMUX_APP_ROOT", root.parentFile!!.path)
      put("ARXD_EXECUTABLE", File(prefix, "bin/bash").path)
      put("ARXD_JOB_FILE", pidFile.path)
      put("ARXD_RXD", File(context.applicationInfo.nativeLibraryDir, "librxd.so").path)
    }
    val reserved = setOf("ARXD_TERMUX_ROOT", "ARXD_TERMUX_APP_ROOT", "LD_PRELOAD", "LD_LIBRARY_PATH", "PREFIX",
      "ARXD_JOB_FILE", "ARXD_EXECUTABLE", "ARXD_RXD", "ARXD_WORKSPACE", "ARXD_SKILLS",
      "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "BASH_XTRACEFD")
    require(overrides.keys.none { it in reserved }) { "Cannot override managed runtime identity or shell startup" }
    require(overrides.entries.all { it.key.matches(Regex("[A-Za-z_][A-Za-z0-9_]*")) && !it.value.contains('\u0000') }) { "Invalid environment override" }
    builder.environment().putAll(overrides)
    return builder
  }
}
