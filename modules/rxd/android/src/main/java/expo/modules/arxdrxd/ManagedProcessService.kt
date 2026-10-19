package expo.modules.arxdrxd

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID

/** User-visible process ownership, independent of the React Activity and JS lifecycle. */
class ManagedProcessService : Service() {
  companion object {
    private const val channel = "arxd-managed-processes"
    private const val notificationId = 157
    private const val stopAction = "arxd.services.STOP_ALL"
    fun start(context: Context, id: String) {
      try { context.startForegroundService(Intent(context, ManagedProcessService::class.java).putExtra("instanceId", id)) }
      catch (error: Exception) { ManagedProcesses.get(context).startFailed(id, error); throw error }
    }
  }
  private val handler = Handler(Looper.getMainLooper())
  private val stops = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(1))
  private val stopAllQueued = AtomicBoolean(false)
  private var wake: PowerManager.WakeLock? = null
  private var destroyed = false
  private var latestStartId = 0
  private val generation = UUID.randomUUID().toString()
  private val owned = linkedSetOf<String>()
  private val changedCallback: () -> Unit = {
    handler.post { if (!destroyed) { handler.removeCallbacks(tick); handler.post(tick) } }
  }
  private val tick = object : Runnable {
    override fun run() {
      if (destroyed) return
      handler.removeCallbacks(this)
      val count = ManagedProcesses.get(this@ManagedProcessService).activeCount()
      if (count == 0 && stopSelfResult(latestStartId)) {
        // A newer start intent can already be pending in Android even before
        // onStartCommand runs. Only an accepted stop may relinquish the FGS.
        if (wake?.isHeld == true) wake?.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        return
      }
      pruneOwned()
      if (wake?.isHeld != true) wake?.acquire(10 * 60 * 1000L)
      getSystemService(NotificationManager::class.java).notify(notificationId, notification(count))
      handler.postDelayed(this, 1000)
    }
  }
  private fun pruneOwned() {
    owned.removeAll { id ->
      val record = ManagedProcesses.get(this).inspectOptional(id)
      record == null || record["state"] in setOf("exited", "failed") && record["processMaySurvive"] != true
    }
  }
  override fun onCreate() {
    super.onCreate()
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(channel, "Arxd 后台进程", NotificationManager.IMPORTANCE_LOW))
    wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Arxd:managed-processes")
    ManagedProcesses.get(this).changed = changedCallback
  }
  private fun notification(count: Int): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)!!.apply {
      data = Uri.parse("arxd://processes"); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val open = PendingIntent.getActivity(this, 157, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val stop = PendingIntent.getService(this, 158, Intent(this, ManagedProcessService::class.java).setAction(stopAction),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return Notification.Builder(this, channel).setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Arxd · 后台进程").setContentText("$count 个进程活动或状态待确认").setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "停止全部", stop).build()).setOngoing(true).setOnlyAlertOnce(true).build()
  }
  private fun requestStopAll() {
    if (!stopAllQueued.compareAndSet(false, true)) return
    try {
      stops.execute {
        try { ManagedProcesses.get(this).stopAll() }
        finally { stopAllQueued.set(false); handler.post(tick) }
      }
    } catch (error: java.util.concurrent.RejectedExecutionException) {
      stopAllQueued.set(false)
      android.util.Log.w("ArxdServices", "Stop All is unavailable for the departing service generation", error)
    }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    latestStartId = startId
    pruneOwned()
    if (Build.VERSION.SDK_INT >= 34) startForeground(notificationId, notification(ManagedProcesses.get(this).activeCount()), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(notificationId, notification(ManagedProcesses.get(this).activeCount()))
    if (intent?.action == stopAction) requestStopAll()
    else intent?.getStringExtra("instanceId")?.let { id ->
      val owner = ManagedProcesses.get(this)
      if (owner.claimService(id, generation)) { owned.add(id); owner.launch(id, generation) }
    }
    handler.removeCallbacks(tick); handler.postDelayed(tick, 1000)
    return START_NOT_STICKY
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onDestroy() {
    destroyed = true; handler.removeCallbacksAndMessages(null)
    val owner = ManagedProcesses.get(this)
    if (owner.changed === changedCallback) owner.changed = null
    if (wake?.isHeld == true) wake?.release()
    // A stale generation must never stop IDs admitted by the next service.
    // Generation matching is rechecked atomically inside the process owner.
    val leaving = owned.toList()
    stops.execute { for (id in leaving) runCatching { owner.stop(id, generation) } }
    stops.shutdown(); super.onDestroy()
  }
}
