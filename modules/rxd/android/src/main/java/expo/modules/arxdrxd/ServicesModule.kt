package expo.modules.arxdrxd

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import android.system.Os
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import org.json.JSONArray
import org.json.JSONObject

/** Short control operations never queue behind a permanent process or blocking MCP call. */
class ServicesModule : Module() {
  private val controls = ThreadPoolExecutor(4, 4, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(32))
  private val rpc = ThreadPoolExecutor(8, 8, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(32))
  private val controlQueue = CoroutineScope(SupervisorJob() + controls.asCoroutineDispatcher())
  private val rpcQueue = CoroutineScope(SupervisorJob() + rpc.asCoroutineDispatcher())
  private fun context() = appContext.reactContext?.applicationContext ?: error("Android context unavailable")
  private fun processes() = ManagedProcesses.get(context())
  private fun broker() = NativeMcp.get(context())
  override fun definition() = ModuleDefinition {
    Name("ArxdServices")
    OnDestroy { controlQueue.cancel(); rpcQueue.cancel(); controls.shutdownNow(); rpc.shutdownNow() }
    Function("mcpHttpPolicy") { broker().httpPolicy().toString() }
    AsyncFunction("mcpSetHttpPolicy") { allowed: Boolean -> broker().setHttpPolicy(allowed).toString() }.runOnQueue(controlQueue)
    Function("capabilities") { JSONObject(ManagedProcesses.capabilities).toString() }
    Function("notificationsAllowed") {
      Build.VERSION.SDK_INT < 33 || context().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    AsyncFunction("definitions") { offset: Int, limit: Int -> JSONObject(processes().definitions(offset, limit)).toString() }.runOnQueue(controlQueue)
    AsyncFunction("definition") { id: String -> JSONObject(processes().definition(id)).toString() }.runOnQueue(controlQueue)
    AsyncFunction("removeDefinition") { id: String -> processes().removeDefinition(id) }.runOnQueue(controlQueue)
    AsyncFunction("start") { admission: String, request: String ->
      val id = processes().admit(admission, request)
      if (processes().inspect(id)["state"] == "queued") ManagedProcessService.start(context(), id)
      JSONObject(processes().inspect(id)).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("list") { offset: Int, limit: Int ->
      require(offset >= 0 && limit in 1..32) { "Invalid process page" }
      val all = processes().list()
      JSONObject().put("items", JSONArray(all.drop(offset).take(limit))).put("total", all.size)
        .put("nextOffset", if (offset + limit < all.size) offset + limit else JSONObject.NULL).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("inspect") { id: String -> JSONObject(processes().inspect(id)).toString() }.runOnQueue(controlQueue)
    AsyncFunction("inspectOptional") { id: String ->
      val record = processes().inspectOptional(id)
      if (record == null) JSONObject().put("found", false).put("code", "ERR_MANAGED_PROCESS_NOT_FOUND").toString()
      else JSONObject().put("found", true).put("record", JSONObject(record)).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("logs") { id: String, stream: String, cursor: Double, limit: Int ->
      require(cursor.isFinite() && cursor >= -1 && cursor <= 9007199254740991.0 && cursor % 1.0 == 0.0) { "Invalid log cursor" }
      JSONObject(processes().logs(id, stream, cursor.toLong(), limit)).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("write") { id: String, encoded: String, close: Boolean ->
      require(encoded.length <= 21848) { "Stdin payload exceeds budget" }
      processes().write(id, Base64.decode(encoded, Base64.DEFAULT), close)
      "{\"delivered\":true}"
    }.runOnQueue(controlQueue)
    AsyncFunction("stop") { id: String -> JSONObject(processes().stop(id)).toString() }.runOnQueue(controlQueue)
    AsyncFunction("remove") { id: String -> processes().remove(id) }.runOnQueue(controlQueue)
    AsyncFunction("fixture") { name: String ->
      VerificationAccess.requireEnabled(context())
      require(name in setOf("mcp-fixture.py", "process-fixture.py")) { "Unknown trusted verification fixture" }
      val bytes = context().assets.open(name).use { it.readBytes() }
      check(bytes.size <= 65536) { "Verification fixture exceeds its package budget" }
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
      // APK upgrades may legitimately change a trusted fixture. Keep old asset
      // generations for existing processes rather than overwriting their paths.
      val root = File(context().filesDir, "managed-process-fixtures/$digest").also { check(it.isDirectory || it.mkdirs()) }
      val target = File(root, name)
      if (target.exists()) check(target.isFile && target.readBytes().contentEquals(bytes)) { "Verification fixture was modified" }
      else {
        val staged = File(root, "$name.staging")
        FileOutputStream(staged).use { it.write(bytes); it.fd.sync() }
        Os.rename(staged.path, target.path)
      }
      target.path
    }.runOnQueue(controlQueue)
    Function("verifyHttpPolicy") { host: String ->
      VerificationAccess.requireEnabled(context())
      require(host.length in 1..253 && host.matches(Regex("[A-Za-z0-9.-]+"))) { "Invalid HTTP policy host" }
      val policy = android.security.NetworkSecurityPolicy.getInstance()
      JSONObject().put("host", host).put("cleartextPermitted", policy.isCleartextTrafficPermitted(host))
        .put("globalCleartextPermitted", policy.isCleartextTrafficPermitted()).toString()
    }
    AsyncFunction("verifyHttpPolicyCommitFailure") {
      VerificationAccess.requireEnabled(context())
      JSONObject(ServiceSafetyVerification.httpPolicyCommitFailure(context())).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("verifyLaunchPersistenceFailure") {
      VerificationAccess.requireEnabled(context())
      JSONObject(ServiceSafetyVerification.launchPersistenceFailure(context())).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("verifyInterruptedStop") { id: String ->
      VerificationAccess.requireEnabled(context())
      JSONObject(ServiceSafetyVerification.interruptedStop(context(), id)).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("mcpConnect") { config: String -> broker().connect(config).toString() }.runOnQueue(rpcQueue)
    AsyncFunction("mcpRequest") { server: String, invocation: String, method: String, params: String, timeout: Int ->
      broker().request(server, invocation, method, params, timeout).toString()
    }.runOnQueue(rpcQueue)
    AsyncFunction("mcpRequestBound") { server: String, connection: String, revision: Double, invocation: String, method: String, params: String, timeout: Int ->
      require(revision.isFinite() && revision >= 0 && revision <= 9007199254740991.0 && revision % 1.0 == 0.0) { "Invalid MCP catalog revision" }
      broker().request(server, invocation, method, params, timeout, connection, revision.toLong()).toString()
    }.runOnQueue(rpcQueue)
    AsyncFunction("mcpPublishCatalog") { server: String, connection: String, revision: Double, catalog: String ->
      require(revision.isFinite() && revision >= 0 && revision <= 9007199254740991.0 && revision % 1.0 == 0.0) { "Invalid MCP catalog revision" }
      broker().publishCatalog(server, connection, revision.toLong(), catalog).toString()
    }.runOnQueue(controlQueue)
    AsyncFunction("mcpRequestCatalogBound") { server: String, connection: String, revision: Double, catalog: String, invocation: String, method: String, params: String, timeout: Int ->
      require(revision.isFinite() && revision >= 0 && revision <= 9007199254740991.0 && revision % 1.0 == 0.0 && catalog.matches(Regex("[a-f0-9]{32}"))) { "Invalid offered MCP catalog binding" }
      broker().request(server, invocation, method, params, timeout, connection, revision.toLong(), catalog).toString()
    }.runOnQueue(rpcQueue)
    Function("mcpCancel") { invocation: String -> broker().cancel(invocation) }
    AsyncFunction("mcpEnabled") { server: String, enabled: Boolean -> broker().setEnabled(server, enabled).toString() }.runOnQueue(controlQueue)
    AsyncFunction("mcpDisconnect") { server: String -> broker().disconnect(server).toString() }.runOnQueue(controlQueue)
    AsyncFunction("mcpStates") { broker().states().toString() }.runOnQueue(controlQueue)
  }
}
