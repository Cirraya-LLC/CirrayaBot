package com.cirraya.multiagent

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

// The few things Dart can't do on Android by itself, on one channel (lib/platform.dart is the
// other end): where the app may keep its settings, and handing a file to another app.
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "cirraya/platform").setMethodCallHandler { call, result ->
            when (call.method) {
                "dirs" -> result.success(mapOf("files" to filesDir.absolutePath, "cache" to cacheDir.absolutePath))
                "open", "share" -> {
                    val path = call.argument<String>("path")
                    val mime = call.argument<String>("mime") ?: "application/octet-stream"
                    if (path == null) { result.success(false); return@setMethodCallHandler }
                    result.success(hand(call.method == "share", File(path), mime))
                }
                else -> result.notImplemented()
            }
        }
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
