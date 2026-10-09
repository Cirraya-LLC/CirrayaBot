package com.cirraya.multiagent

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

// The few things Dart can't do on Android by itself, on one channel (lib/platform.dart is the
// other end): where the app may keep its settings, handing a file to another app, and the
// notification feed (NoticeService) — starting it, and opening the conversation a notice was about.
class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null

    /** Speech: recognizer, voices, recorder, player (lib/data/speech.dart). */
    private var voice: VoiceBridge? = null

    /** A photo / video being taken: where it goes, and who is waiting for the answer. */
    private var capture: Pair<File, MethodChannel.Result>? = null

    /** A notice tapped while the app wasn't running: Dart asks for it once it is up. */
    private var launchTarget: Map<String, String>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        launchTarget = targetOf(intent)
        voice = VoiceBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "cirraya/platform")
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "dirs" -> result.success(mapOf("files" to filesDir.absolutePath, "cache" to cacheDir.absolutePath))
                "open", "share" -> {
                    val path = call.argument<String>("path")
                    val mime = call.argument<String>("mime") ?: "application/octet-stream"
                    if (path == null) { result.success(false); return@setMethodCallHandler }
                    result.success(hand(call.method == "share", File(path), mime))
                }
                "noticesStart" -> {
                    val texts = call.argument<Map<String, String>>("texts") ?: emptyMap()
                    NoticeService.start(this, call.argument<String>("base") ?: "", call.argument<String>("token") ?: "", texts)
                    // the permission first; the battery question once it is answered (two system dialogs at once collide)
                    if (notificationsAllowed()) askBatteryOnce() else askNotificationPermission()
                    result.success(true)
                }
                "noticesStop" -> { NoticeService.stop(this); result.success(true) }
                "noticesAllowed" -> result.success(notificationsAllowed())
                // Doze cuts an app's network while the phone sleeps unless it is exempted — then the
                // feed goes quiet for hours. Asks the system (a dialog); true when already exempt.
                "batteryExempt" -> result.success(askBattery())
                "launchTarget" -> { result.success(launchTarget); launchTarget = null }
                // The system camera app takes it and writes into our cache through the FileProvider, so
                // this app needs no camera permission. Answers with the file's path, or null if cancelled.
                "capture" -> {
                    val video = call.argument<Boolean>("video") == true
                    val dir = File(cacheDir, "shared/capture").apply { mkdirs() }
                    val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
                    val file = File(dir, if (video) "video-$stamp.mp4" else "photo-$stamp.jpg")
                    val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
                    val intent = Intent(if (video) android.provider.MediaStore.ACTION_VIDEO_CAPTURE else android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                        .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
                        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    intent.clipData = ClipData.newRawUri(file.name, uri)
                    try {
                        capture?.second?.success(null)
                        capture = file to result
                        @Suppress("DEPRECATION") startActivityForResult(intent, 8)
                    } catch (e: ActivityNotFoundException) {
                        capture = null
                        result.success(null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    @Deprecated("startActivityForResult is all a FlutterActivity has without extra dependencies")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 8) return
        val (file, result) = capture ?: return
        capture = null
        result.success(if (resultCode == RESULT_OK && file.length() > 0) file.absolutePath else null)
    }

    override fun onResume() { super.onResume(); NoticeService.appVisible = true }
    override fun onDestroy() { voice?.dispose(); voice = null; super.onDestroy() }
    override fun onPause() { NoticeService.appVisible = false; super.onPause() }

    // A notice tapped while the app was already running (singleTop): open that conversation now.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val target = targetOf(intent) ?: return
        channel?.invokeMethod("openConversation", target)
    }

    private fun targetOf(i: Intent?): Map<String, String>? {
        val kind = i?.getStringExtra("conv_kind") ?: return null
        return mapOf("kind" to kind, "id" to (i.getStringExtra("conv_id") ?: ""), "session" to (i.getStringExtra("session") ?: ""))
    }

    /** True when already spared from battery optimisation; otherwise asks (a system dialog). */
    private fun askBattery(): Boolean {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) return true
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: ActivityNotFoundException) { }
        return false
    }

    /** Asked unprompted only once: after that it's the person's call, and the bell asks again. */
    private fun askBatteryOnce() {
        val p = NoticeService.prefs(this)
        if (p.getBoolean("askedBattery", false)) return
        p.edit().putBoolean("askedBattery", true).apply()
        askBattery()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == VoiceBridge.MIC_REQUEST) {
            voice?.onPermission(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
            return
        }
        if (requestCode == 7 && notificationsAllowed()) {
            // the "connected" notice was posted before there was permission to show it
            ContextCompat.startForegroundService(this, Intent(this, NoticeService::class.java))
            askBatteryOnce()
        }
    }

    private fun notificationsAllowed() = Build.VERSION.SDK_INT < 33 ||
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun askNotificationPermission() {
        if (!notificationsAllowed()) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
    }

    /** Open with / share one file. False when no app takes it. */
    private fun hand(share: Boolean, file: File, mime: String): Boolean {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val intent = if (share) {
            Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
        } else {
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
        }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // ClipData too: the chooser itself reads the file for its preview, and a grant on the
        // inner intent doesn't reach it (logcat: "Permission Denial … intentresolver").
        intent.clipData = ClipData.newRawUri(file.name, uri)
        val chooser = Intent.createChooser(intent, file.name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        chooser.clipData = intent.clipData
        return try {
            startActivity(chooser)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }
}
