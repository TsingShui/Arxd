package expo.modules.arxdrxd.display

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.PrintWriter
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/** A shell-owned, stdin-leased controller. Never an exported app service or TCP listener. */
object DisplayServer {
  const val PREFIX = "ARXD_VD_V1 "
  @JvmStatic fun main(args: Array<String>) {
    // Keep protocol on the original descriptors even if Android redirects System.out to logcat.
    val output = PrintWriter(FileOutputStream(FileDescriptor.out), true)
    val outputLock = Any()
    fun reply(json: JSONObject) = synchronized(outputLock) { output.println(PREFIX + json.toString()) }
    val session = AtomicReference<OwnedDisplay?>(null)
    val lastCommand = AtomicLong(SystemClock.elapsedRealtime())
    val born = lastCommand.get()
    val watchdog = Executors.newSingleThreadScheduledExecutor()
    try {
      if (Process.myUid() != 2000 || Build.VERSION.SDK_INT < 35) throw DisplayFailure("unsupported")
      watchdog.scheduleAtFixedRate({
        val now = SystemClock.elapsedRealtime()
        if (now - lastCommand.get() > 30000 || now - born > 600000) {
          session.get()?.close(); exitProcess(0)
        }
      }, 5, 5, TimeUnit.SECONDS)
      if (Looper.getMainLooper() == null) Looper.prepareMainLooper()
      val input = InputStreamReader(FileInputStream(FileDescriptor.`in`), Charsets.UTF_8)
      val first = JSONObject(readLine(input) ?: throw DisplayFailure("invalid_request"))
      if (first.getString("op") != "start" || first.getInt("protocol") != 1) throw DisplayFailure("invalid_request")
      val request = DisplayRequest(first.getString("packageName"), first.getString("component"),
        first.getInt("width"), first.getInt("height"), first.getInt("densityDpi"), first.getString("token"))
      request.validate()
      val owner = OwnedDisplay(request)
      session.set(owner)
      owner.create()
      // Keep reading stdin while launch waits: EOF can clean up before the initial reply.
      thread(name = "arxd-vd-launch", isDaemon = true) {
        try { owner.launch(); if (!owner.closed) reply(owner.status()) }
        catch (error: Throwable) {
          if (!owner.closed) reply(failure((error as? DisplayFailure)?.code ?: "launch_failed", request.token))
          owner.close()
        }
      }
      while (true) {
        val line = readLine(input) ?: break
        lastCommand.set(SystemClock.elapsedRealtime())
        val command = JSONObject(line)
        if (command.getString("token") != request.token) throw DisplayFailure("invalid_request")
        when (command.getString("op")) {
          "status" -> reply(owner.status())
          "snapshot" -> try { reply(owner.status().put("image", owner.snapshot())) }
            catch (error: DisplayFailure) {
              if (error.code != "no_frame") throw error
              reply(failure("no_frame", request.token))
            }
          "stop" -> {
            owner.close()
            reply(JSONObject().put("ok", true).put("protocol", 1).put("token", request.token).put("phase", "stopped"))
            break
          }
          else -> throw DisplayFailure("invalid_request")
        }
      }
    } catch (error: Throwable) {
      reply(failure((error as? DisplayFailure)?.code ?: "controller_failed", ""))
    } finally {
      session.get()?.close()
      watchdog.shutdownNow()
    }
    exitProcess(0)
  }
  private fun failure(code: String, token: String) = JSONObject().put("ok", false).put("protocol", 1).put("error", code).put("token", token)
  private fun readLine(input: InputStreamReader): String? {
    val result = StringBuilder()
    while (true) {
      val char = input.read()
      if (char == -1) return if (result.isEmpty()) null else throw DisplayFailure("invalid_request")
      if (char == 10) return result.toString()
      if (result.length >= 8192) throw DisplayFailure("invalid_request")
      result.append(char.toChar())
    }
  }

  private class OwnedDisplay(private val request: DisplayRequest) : Closeable {
    private val closing = AtomicBoolean(false)
    val closed get() = closing.get()
    private val lifecycle = Any()
    private val frames = Any()
    private val context: Context = shellContext()
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val activities = context.getSystemService(ActivityManager::class.java)
    private val handlerThread = HandlerThread("arxd-vd-frames")
    private var reader: ImageReader? = null
    private var latest: Image? = null
    private var display: VirtualDisplay? = null
    private var launcher: java.lang.Process? = null
    @Volatile private var ready = false

    fun create() {
      // Refuse to move/reuse an existing application task from the physical screen.
      val tasks = activities.getRunningTasks(512)
      if (tasks.size >= 512) throw DisplayFailure("task_budget")
      if (tasks.any { it.baseActivity?.packageName == request.packageName || it.topActivity?.packageName == request.packageName }) throw DisplayFailure("app_running")
      val component = android.content.ComponentName.unflattenFromString(request.component) ?: throw DisplayFailure("invalid_app")
      val info = context.packageManager.getActivityInfo(component, 0)
      if (!info.exported || !info.enabled || !info.applicationInfo.enabled) throw DisplayFailure("invalid_app")
      // A singleTask/instance activity may sit in the middle of a task whose
      // base/top belong to other apps. Do not let launch reuse/clear that task.
      if (info.launchMode >= ActivityInfo.LAUNCH_SINGLE_TASK && hasAnyActivityRecord()) throw DisplayFailure("app_running")
      handlerThread.start()
      val images = ImageReader.newInstance(request.width, request.height, PixelFormat.RGBA_8888, 3)
      reader = images
      images.setOnImageAvailableListener({ source ->
        synchronized(frames) {
          if (!closed) runCatching { source.acquireLatestImage()?.let { next -> latest?.close(); latest = next } }
        }
      }, Handler(handlerThread.looper))
      // Require isolation/removal flags. Never substitute auto-mirroring or migrate content to display 0.
      fun flag(name: String) = try { DisplayManager::class.java.getField(name).getInt(null) }
        catch (_: Exception) { throw DisplayFailure("unsupported") }
      val flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
        DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or flag("VIRTUAL_DISPLAY_FLAG_TRUSTED") or
        flag("VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL") or flag("VIRTUAL_DISPLAY_FLAG_OWN_FOCUS") or
        flag("VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED") or flag("VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP") or
        flag("VIRTUAL_DISPLAY_FLAG_ALWAYS_UNLOCKED")
      display = try { displays.createVirtualDisplay("Arxd VD " + request.token, request.width, request.height,
        request.densityDpi, images.surface, flags) } catch (_: Exception) { throw DisplayFailure("unsupported") }
      if (display?.display?.displayId == null || display!!.display.displayId <= 0) throw DisplayFailure("unsupported")
    }

    private fun hasAnyActivityRecord(): Boolean {
      val child = ProcessBuilder("/system/bin/dumpsys", "activity", "activities").redirectErrorStream(true).start()
      val worker = Executors.newSingleThreadExecutor()
      try {
        val captured = worker.submit<String> {
          val bytes = ByteArrayOutputStream()
          child.inputStream.use { input ->
            val buffer = ByteArray(4096)
            while (true) {
              val count = input.read(buffer)
              if (count == -1) break
              if (bytes.size() + count > 512 * 1024) throw DisplayFailure("task_budget")
              bytes.write(buffer, 0, count)
            }
          }
          bytes.toString("UTF-8")
        }
        if (!child.waitFor(5, TimeUnit.SECONDS) || child.exitValue() != 0) throw DisplayFailure("task_budget")
        val text = try { captured.get(1, TimeUnit.SECONDS) } catch (_: Exception) { throw DisplayFailure("task_budget") }
        return hasActivityHistory(text, request.packageName)
      } finally { child.destroyForcibly(); worker.shutdownNow() }
    }

    fun launch() {      val id = display?.display?.displayId ?: throw DisplayFailure("not_running")
      val child = synchronized(lifecycle) {
        if (closed) throw DisplayFailure("cancelled")
        ProcessBuilder("/system/bin/cmd", "activity", "start-activity", "-W", "--user", "0",
          "--display", id.toString(), "--windowingMode", "1", "-f",
          (Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS).toString(),
          "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", request.component)
          .redirectOutput(File("/dev/null")).redirectError(File("/dev/null")).start().also { launcher = it }
      }
      try {
        if (!child.waitFor(10, TimeUnit.SECONDS) || child.exitValue() != 0) throw DisplayFailure("launch_failed")
        val until = SystemClock.elapsedRealtime() + 2000
        while (!closed && SystemClock.elapsedRealtime() < until) {
          if (task() != null) { ready = true; return }
          Thread.sleep(50)
        }
        throw DisplayFailure("launch_failed")
      } finally { child.destroyForcibly(); synchronized(lifecycle) { launcher = null } }
    }
    private fun displayOf(task: ActivityManager.RunningTaskInfo): Int =
      task.javaClass.getField("displayId").getInt(task)
    private fun task(): ActivityManager.RunningTaskInfo? {
      val id = display?.display?.displayId ?: return null
      if (closed || displays.getDisplay(id)?.isValid != true) return null
      return activities.getRunningTasks(512).firstOrNull { displayOf(it) == id && it.isRunning &&
        (it.baseActivity?.packageName == request.packageName || it.topActivity?.packageName == request.packageName) }
    }
    fun status(): JSONObject {
      val task = if (ready) task() else null
      if (task == null) throw DisplayFailure("not_running")
      return JSONObject().put("ok", true).put("protocol", 1).put("token", request.token).put("phase", "running")
        .put("packageName", request.packageName).put("component", request.component).put("displayId", displayOf(task))
        .put("taskId", task.taskId).put("uid", Process.myUid()).put("pid", Process.myPid())
        .put("width", request.width).put("height", request.height).put("densityDpi", request.densityDpi)
        .put("topActivity", task.topActivity?.flattenToShortString())
    }
    fun snapshot(): String = synchronized(frames) {
      val image = latest ?: throw DisplayFailure("no_frame")
      val plane = image.planes[0]
      if (plane.pixelStride != 4) throw DisplayFailure("no_frame")
      val packed = java.nio.ByteBuffer.allocate(request.width * request.height * 4)
      val row = ByteArray(request.width * 4)
      val source = plane.buffer
      for (y in 0 until request.height) {
        source.position(y * plane.rowStride); source.get(row); packed.put(row)
      }
      packed.rewind()
      val bitmap = Bitmap.createBitmap(request.width, request.height, Bitmap.Config.ARGB_8888)
      try {
        bitmap.copyPixelsFromBuffer(packed)
        val bytes = ByteArrayOutputStream()
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 65, bytes) || bytes.size() > 1024 * 1024) throw DisplayFailure("no_frame")
        Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
      } finally { bitmap.recycle() }
    }
    override fun close() {
      if (!closing.compareAndSet(false, true)) return
      synchronized(lifecycle) { launcher?.destroyForcibly(); launcher = null }
      // DESTROY_CONTENT_ON_REMOVAL finishes display-local tasks instead of moving them.
      runCatching { display?.release() }; display = null
      synchronized(frames) { latest?.close(); latest = null; reader?.close(); reader = null }
      handlerThread.quitSafely()
    }
    private fun shellContext(): Context {
      val activityThread = Class.forName("android.app.ActivityThread")
      val instance = activityThread.getMethod("systemMain").invoke(null)
      val system = activityThread.getMethod("getSystemContext").invoke(instance) as Context
      // DisplayManager validates that this attribution package belongs to shell UID.
      return system.createPackageContext("com.android.shell", 0)
    }
  }
}
