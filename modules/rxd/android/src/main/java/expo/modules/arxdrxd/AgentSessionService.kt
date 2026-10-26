package expo.modules.arxdrxd

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** A real Headless JS task keeps RN's timers running after Activity.onPause. */
class AgentSessionService : HeadlessJsTaskService() {
  private var generation: String? = null
  private val handler = Handler(Looper.getMainLooper())
  private val expire = Runnable { AgentSessions.requestStop() }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val token = intent?.getStringExtra("generation")
    if (intent?.action == "arxd.agent.STOP") {
      android.util.Log.i("ArxdAgentSession", "User requested Stop")
      AgentSessions.requestStop()
      if (generation == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (token == null || AgentSessions.session(token) == null) { stopSelf(startId); return START_NOT_STICKY }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("arxd-agent", "Arxd Agent", NotificationManager.IMPORTANCE_LOW))
    val open = packageManager.getLaunchIntentForPackage(packageName)!!.apply { data = Uri.parse("arxd://"); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    val stop = Intent(this, AgentSessionService::class.java).setAction("arxd.agent.STOP")
    val notification = Notification.Builder(this, "arxd-agent").setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Arxd · Agent").setContentText("任务执行中 · Task running")
      .setContentIntent(PendingIntent.getActivity(this, 159, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .addAction(Notification.Action.Builder(null, "停止 / Stop", PendingIntent.getService(this, 160, stop, PendingIntent.FLAG_IMMUTABLE)).build())
      .setOngoing(true).setOnlyAlertOnce(true).build()
    if (Build.VERSION.SDK_INT >= 34) startForeground(159, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(159, notification)
    if (generation == null) {
      generation = token
      handler.postDelayed(expire, 30 * 60 * 1000L)
      startTask(HeadlessJsTaskConfig("ArxdAgentSession", Arguments.createMap().apply { putString("generation", token) }, 0, true))
    }
    // Never automatically restart tasks or replay an interrupted ADB command.
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    generation?.let { AgentSessions.destroyed(it) }
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
}
