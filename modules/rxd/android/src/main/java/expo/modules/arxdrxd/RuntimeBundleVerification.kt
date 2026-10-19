package expo.modules.arxdrxd

import android.content.Context
import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray

/** Android preparation seam with damaged packaged input and preserved user files. */
object RuntimeBundleVerification {
  fun run(context: Context): Map<String, Any> {
    val testFiles = File(context.filesDir, "runtime-acceptance-${UUID.randomUUID()}").also { it.mkdirs() }
    val isolated = object : ContextWrapper(context) { override fun getFilesDir() = testFiles }
    val pin = JSONObject(context.assets.open("termux-bootstrap.json").bufferedReader().use { it.readText() })
    val home = File(testFiles, "termux-preload/files/home/keep-skill/SKILL.md").also { it.parentFile!!.mkdirs(); it.writeText("keep-user-skill") }
    val workspace = File(testFiles, "workspace/keep.txt").also { it.parentFile!!.mkdirs(); it.writeText("keep-workspace") }
    val failed = mutableListOf<String>()
    for (kind in listOf("missing-bundle", "corrupt-bundle", "incompatible-bootstrap")) {
      val runtime = RuntimeBundle(isolated) { name ->
        when {
          name == "termux-runtime-packages.zip" && kind == "missing-bundle" -> throw FileNotFoundException("Missing packaged runtime fixture")
          name == "termux-runtime-packages.zip" && kind == "corrupt-bundle" -> ByteArrayInputStream(byteArrayOf(1, 2, 3))
          name == "termux-runtime-packages.json" && kind == "incompatible-bootstrap" -> {
            val manifest = JSONObject(context.assets.open(name).bufferedReader().use { it.readText() })
            ByteArrayInputStream(manifest.put("bootstrapSha256", "0".repeat(64)).toString().toByteArray())
          }
          else -> context.assets.open(name)
        }
      }
      check(runCatching { runtime.prepare(pin) }.isFailure) { "$kind was accepted" }
      check(!File(testFiles, "termux-preload/files/usr/.arxd-bundle.json").exists()) { "Incomplete generation was marked ready" }
      check(home.readText() == "keep-user-skill" && workspace.readText() == "keep-workspace") { "Preparation failure changed user files" }
      failed.add(kind)
    }
    val abandoned = File(testFiles, "termux-preload/stage-interrupted/files/usr/bin/uv").also { it.parentFile!!.mkdirs(); it.writeText("incomplete") }
    val identity = PreloadRuntime(isolated).prepare()
    check(identity["runtimeReady"] == true && !abandoned.exists()) { "Retry did not discard the interrupted stage" }
    check(home.readText() == "keep-user-skill" && workspace.readText() == "keep-workspace")
    val uv = File(testFiles, "termux-preload/files/usr/bin/uv")
    check(uv.setExecutable(false, false))
    check(runCatching { PreloadRuntime(isolated).prepare() }.isFailure) { "Non-executable tool was accepted" }
    check(uv.setExecutable(true, true))
    check(PreloadRuntime(isolated).prepare()["runtimeReady"] == true)
    return mapOf("exitCode" to 0, "identity" to identity, "stdout" to JSONObject().put("probe", "runtime-failures")
      .put("rejected", JSONArray(failed)).put("retryReady", true).put("abandonedStageRemoved", true)
      .put("executableModeChecked", true).put("homeAndWorkspacePreserved", true).toString(), "stderr" to "")
  }
}
