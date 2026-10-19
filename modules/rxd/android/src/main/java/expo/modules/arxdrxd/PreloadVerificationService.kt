package expo.modules.arxdrxd

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** Fixed developer verification entry point; protected by the shell's DUMP permission. */
class PreloadVerificationService : Service() {
  private val worker = Executors.newSingleThreadExecutor()
  private var running = false
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!VerificationAccess.enabled(this)) { stopSelf(startId); return START_NOT_STICKY }
    if (running) return START_NOT_STICKY
    running = true
    val channel = "arxd-preload-verification"
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(channel, "Arxd 工具环境验证", NotificationManager.IMPORTANCE_LOW))
    val notification = Notification.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("Arxd")
      .setContentText("正在验证内置工具环境")
      .setOngoing(true).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(137, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(137, notification)
    val bootstrapOnly = intent?.getBooleanExtra("bootstrapOnly", false) ?: false
    val bundleFailures = intent?.getBooleanExtra("bundleFailures", false) ?: false
    val offlineToolchain = intent?.getBooleanExtra("offlineToolchain", false) ?: false
    val resetRuntime = intent?.getBooleanExtra("resetRuntime", false) ?: false
    worker.execute {
      val wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Arxd:preload-verification")
      wake.acquire(20 * 60 * 1000L)
      val runId = UUID.randomUUID().toString()
      var message = 0
      fun publish(report: JSONObject) {
        val data = report.toString()
        val parts = (data.length + 1499) / 1500
        val messageId = message++
        for (index in 0 until parts) {
          Log.i("ArxdVerify", JSONObject().put("event", "arxd-preload").put("runner", "native-service")
            .put("runId", runId).put("messageId", messageId).put("index", index).put("parts", parts)
            .put("data", data.substring(index * 1500, minOf((index + 1) * 1500, data.length))).toString())
        }
      }
      val report = JSONObject().put("runId", runId).put("verified", false).put("runner", "native-service")
      val stages = JSONArray()
      report.put("stages", stages)
      try {
        val runtime = PreloadRuntime(this)
        if (resetRuntime) runtime.reset()
        val identity = JSONObject(runtime.prepare())
        report.put("identity", identity)
        publish(JSONObject().put("kind", "prepared").put("identity", identity))
        val probes = if (offlineToolchain) JSONArray().put(JSONArray().put("offline-toolchain")
          .put(assets.open("termux-toolchain-probe.sh").bufferedReader().use { it.readText() }).put(120000))
        else JSONArray(assets.open("termux-probes.json").bufferedReader().use { it.readText() })
        for (index in 0 until probes.length()) {
          val probe = probes.getJSONArray(index)
          val stage = probe.getString(0)
          if (bootstrapOnly && stage != "bootstrap") break
          val result = JSONObject(runtime.execute(probe.getString(1), probe.getInt(2)))
          stages.put(JSONObject().put("stage", stage).put("result", result))
          publish(JSONObject().put("kind", "stage").put("stage", stage).put("result", result))
          check(result.getInt("exitCode") == 0) { "$stage exited ${result.getInt("exitCode")}: ${result.getString("stderr").takeLast(2000)}" }
        }
        if (!bootstrapOnly && !offlineToolchain) {
          val id = "cancel-$runId"
          val pidFile = File(identity.getString("root"), "usr/tmp/$id")
          val pool = Executors.newSingleThreadExecutor()
          runtime.register(id)
          val started = android.os.SystemClock.elapsedRealtime()
          val future = pool.submit(java.util.concurrent.Callable {
            runtime.execute("sleep 30 &\nprintf '%s' \"\$!\" > \"\$ARXD_TERMUX_ROOT/usr/tmp/$id\"\nwait\n", 60000, id)
          })
          try {
            val deadline = started + 10000
            while (!pidFile.isFile && !future.isDone && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
            check(pidFile.isFile && !future.isDone) { "Cancellation probe did not start its child" }
            val childPid = pidFile.readText().toInt()
            check(File("/proc/$childPid/stat").canRead()) { "Cannot inspect owned child" }
            runtime.cancel(id)
            val outcome = runCatching { future.get(5, java.util.concurrent.TimeUnit.SECONDS) }
            if (outcome.isSuccess) {
              check(outcome.getOrThrow()["exitCode"] != 0) { "Cancelled shell exited successfully" }
            } else {
              // Android may close Process streams while the collectors are
              // reading. This is a valid cancelled-call rejection, not success.
              val causes = generateSequence(outcome.exceptionOrNull()) { it.cause }.toList()
              check(causes.any { it is java.io.InterruptedIOException ||
                (it is IllegalStateException && it.message == "Shell task cancelled") }) {
                "Unexpected cancellation failure: ${outcome.exceptionOrNull()}"
              }
            }
            fun childAlive(): Boolean {
              val stat = File("/proc/$childPid/stat")
              return runCatching { stat.readText().substringAfterLast(") ").firstOrNull() != 'Z' }.getOrDefault(false)
            }
            val reapDeadline = android.os.SystemClock.elapsedRealtime() + 5000
            while (childAlive() && android.os.SystemClock.elapsedRealtime() < reapDeadline) Thread.sleep(50)
            check(!childAlive()) { "Cancelled shell left a live sleep child" }
            val result = JSONObject().put("exitCode", 0).put("identity", identity)
              .put("stdout", JSONObject().put("probe", "cancel").put("childTerminated", true)
                .put("completion", if (outcome.isSuccess) "nonzero-exit" else "cancelled-rejection").toString())
              .put("stderr", "").put("durationMs", android.os.SystemClock.elapsedRealtime() - started)
            stages.put(JSONObject().put("stage", "cancel").put("result", result))
            publish(JSONObject().put("kind", "stage").put("stage", "cancel").put("result", result))
          } finally {
            runtime.cancel(id)
            future.cancel(true)
            pool.shutdownNow()
            pidFile.delete()
          }
        }
        if (bundleFailures) {
          val result = JSONObject(RuntimeBundleVerification.run(this))
          stages.put(JSONObject().put("stage", "runtime-failures").put("result", result))
          publish(JSONObject().put("kind", "stage").put("stage", "runtime-failures").put("result", result))
        }
        report.put("verified", !bootstrapOnly)
      } catch (error: Throwable) {
        report.put("error", error.toString())
      } finally {
        report.put("kind", "complete")
        File(filesDir, "preload-verification-$runId.json").writeText(report.toString(2))
        publish(report)
        if (wake.isHeld) wake.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    worker.shutdownNow()
    super.onDestroy()
  }
}
