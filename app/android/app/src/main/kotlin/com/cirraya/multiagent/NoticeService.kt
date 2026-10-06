package com.cirraya.multiagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Notifications without Google's push service: a self-hosted server can't be expected to have a
// Firebase project. This service keeps the server's notification feed open (/api/notifications/stream,
// SSE), reconnects with backoff, resumes after the last id it saw, and shows a notice only while the
// app isn't on screen. Android only keeps a background connection alive in a foreground service, so
// there is one quiet "connected" notification (its own channel, minimum importance — hide it there).
class NoticeService : Service() {
    companion object {
        /** The app's activity is in front: the person sees what happens, no system notice. */
        @Volatile var appVisible = false

        private const val CH_CONN = "connection"
        private const val CH_MSG = "messages"
        private const val ID_CONN = 1

        fun prefs(ctx: Context) = ctx.getSharedPreferences("notices", Context.MODE_PRIVATE)

        /** Save what to connect to (and the texts, in the app's language) and start. */
        fun start(ctx: Context, base: String, token: String, texts: Map<String, String>) {
            val p = prefs(ctx)
            val e = p.edit()
            // another server or token: its ids mean nothing here, start from "now"
            if (p.getString("base", "") != base || p.getString("token", "") != token) e.putLong("after", 0)
            e.putString("base", base).putString("token", token).putBoolean("on", true)
            for ((k, v) in texts) e.putString("t_$k", v)
            e.apply()
            ContextCompat.startForegroundService(ctx, Intent(ctx, NoticeService::class.java))
        }

        fun stop(ctx: Context) {
            prefs(ctx).edit().putBoolean("on", false).apply()
            ctx.stopService(Intent(ctx, NoticeService::class.java))
        }
    }

    @Volatile private var running = false
    private var worker: Thread? = null
    @Volatile private var conn: HttpURLConnection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val p = prefs(this)
        val base = p.getString("base", "") ?: ""
        if (!p.getBoolean("on", false) || base.isEmpty()) { stopSelf(); return START_NOT_STICKY }
        channels()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, ID_CONN, connectionNotice(Uri.parse(base).host ?: base), type)
        if (worker?.isAlive != true) {
            running = true
            worker = Thread({ loop() }, "notice-feed").apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        conn?.disconnect()
        super.onDestroy()
    }

    private fun text(key: String, fallback: String) = prefs(this).getString("t_$key", null) ?: fallback

    private fun channels() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CH_MSG, text("chMessages", "Messages"), NotificationManager.IMPORTANCE_HIGH))
            nm.createNotificationChannel(NotificationChannel(CH_CONN, text("chConnection", "Connection"), NotificationManager.IMPORTANCE_MIN))
        }
    }

    private fun openApp(extra: Map<String, String>, code: Int): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        for ((k, v) in extra) i.putExtra(k, v)
        return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun connectionNotice(host: String): Notification =
        NotificationCompat.Builder(this, CH_CONN)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(text("connected", "Connected to {host}").replace("{host}", host))
            .setContentText(text("connectedNote", "Keeps notifications coming while the app is closed"))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openApp(emptyMap(), 0))
            .build()

    private fun loop() {
        var wait = 2000L
        while (running) {
            try {
                val p = prefs(this)
                val base = p.getString("base", "") ?: ""
                val token = p.getString("token", "") ?: ""
                val after = p.getLong("after", 0)
                val c = URL("$base/api/notifications/stream?k=${URLEncoder.encode(token, "UTF-8")}&after=$after")
                    .openConnection() as HttpURLConnection
                conn = c
                c.connectTimeout = 15_000
                c.readTimeout = 70_000          // the server pings every 25s; silence longer than this is a dead line
                c.setRequestProperty("Accept", "text/event-stream")
                if (c.responseCode != 200) throw java.io.IOException("HTTP ${c.responseCode}")
                wait = 2000L
                c.inputStream.bufferedReader(Charsets.UTF_8).use { r ->
                    var event = ""
                    val data = StringBuilder()
                    while (running) {
                        val line = r.readLine() ?: break
                        when {
                            line.isEmpty() -> { handle(event, data.toString()); event = ""; data.setLength(0) }
                            line.startsWith("event:") -> event = line.substring(6).trim()
                            line.startsWith("data:") -> data.append(line.substring(5).trim())
                        }
                    }
                }
            } catch (e: Exception) {
                // network gone, server restarting, phone dozing: try again, a little later each time
            } finally {
                conn?.disconnect()
            }
            if (!running) break
            try { Thread.sleep(wait) } catch (e: InterruptedException) { break }
            wait = minOf(wait * 2, 60_000L)
        }
    }

    private fun handle(event: String, data: String) {
        if (data.isEmpty()) return
        val p = prefs(this)
        val j = JSONObject(data)
        if (event == "hello") {
            // first contact with this server: start from now, not from whatever it still remembers
            if (p.getLong("after", 0) == 0L) p.edit().putLong("after", j.optLong("last")).apply()
            return
        }
        if (event != "notice") return
        p.edit().putLong("after", j.optLong("id")).apply()
        if (appVisible) return
        show(j)
    }

    private fun show(n: JSONObject) {
        val conv = n.optJSONObject("conv") ?: JSONObject()
        val agent = n.optString("agent")
        val title = when (n.optString("kind")) {
            "asked" -> text("asked", "{name} needs an answer").replace("{name}", agent)
            "approval" -> text("approval", "{name} asks for approval").replace("{name}", agent)
            else -> if (conv.optString("kind") == "group")
                text("replyIn", "{name} · {conv}").replace("{name}", agent).replace("{conv}", conv.optString("name"))
            else agent
        }
        val key = "${conv.optString("kind")}:${conv.optString("id")}"
        val tap = openApp(mapOf("conv_kind" to conv.optString("kind"), "conv_id" to conv.optString("id"),
            "session" to n.optString("session")), key.hashCode())
        val notice = NotificationCompat.Builder(this, CH_MSG)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(n.optString("text"))
            .setStyle(NotificationCompat.BigTextStyle().bigText(n.optString("text")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        // one per conversation: the newest replaces the last, instead of a pile
        try { getSystemService(NotificationManager::class.java).notify(key.hashCode(), notice) } catch (e: SecurityException) { }
    }
}

/** After a reboot, pick the feed back up if it was on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val p = NoticeService.prefs(context)
        if (p.getBoolean("on", false) && !p.getString("base", "").isNullOrEmpty())
            ContextCompat.startForegroundService(context, Intent(context, NoticeService::class.java))
    }
}
