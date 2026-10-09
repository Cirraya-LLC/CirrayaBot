package com.cirraya.multiagent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import kotlin.math.max
import kotlin.math.sqrt

// Speech on the phone, for lib/data/speech.dart (channel "cirraya/voice"): the system recognizer, the
// system voices, a recorder that stops on silence (for an upstream recognizer), and a player (for an
// upstream's audio). A long operation answers later with "done" / "failed" carrying the id Dart sent,
// so one Dart Future maps to one operation; "partial" and "level" stream in between.
class VoiceBridge(private val activity: MainActivity, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    private val ch = MethodChannel(messenger, "cirraya/voice").also { it.setMethodCallHandler(this) }
    private val main = Handler(Looper.getMainLooper())

    private var recognizer: SpeechRecognizer? = null
    private var hearId = 0
    private var lastText = ""

    /** Dictation in a segmented session: the utterances so far, joined. */
    private var segText = ""

    private var recorder: Recorder? = null

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val ttsWaiting = mutableListOf<() -> Unit>()
    private var sayId = 0

    private var player: MediaPlayer? = null
    private var playId = 0

    /** Waiting for the microphone permission: what to do with the answer. */
    private var micWaiting: ((Boolean) -> Unit)? = null

    private fun emit(method: String, args: Map<String, Any?>) = main.post { ch.invokeMethod(method, args) }
    private fun done(id: Int, value: Any? = null) { if (id != 0) emit("done", mapOf("id" to id, "value" to value)) }
    private fun failed(id: Int, code: String) { if (id != 0) emit("failed", mapOf("id" to id, "code" to code)) }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val id = call.argument<Int>("id") ?: 0
        when (call.method) {
            "caps" -> result.success(mapOf("hear" to SpeechRecognizer.isRecognitionAvailable(activity), "speak" to true))
            "hear" -> {
                result.success(null)
                withMic(id) { hear(id, call.argument<String>("lang") ?: "", call.argument<Boolean>("continuous") == true) }
            }
            "record" -> {
                result.success(null)
                withMic(id) {
                    record(id, call.argument<Int>("endSilenceMs") ?: 1100, call.argument<Int>("noSpeechMs") ?: 9000,
                        call.argument<Int>("maxMs") ?: 60000)
                }
            }
            "stopListening" -> { recognizer?.stopListening(); recorder?.finish(keep = true); result.success(null) }
            "cancelListening" -> { cancelHearing(); recorder?.finish(keep = false); result.success(null) }
            "say" -> {
                result.success(null)
                withTts(id) { say(id, call.argument<String>("text") ?: "", call.argument<Double>("pitch") ?: 1.0,
                    call.argument<Double>("rate") ?: 1.0, call.argument<String>("lang") ?: "", call.argument<String>("voice") ?: "") }
            }
            "play" -> { result.success(null); play(id, call.argument<String>("path") ?: "") }
            "silence" -> { silence(); result.success(null) }
            "voices" -> withTts(0) {
                val list = tts?.voices?.sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.name }))
                    ?.map { mapOf("name" to it.name, "lang" to it.locale.toLanguageTag()) } ?: emptyList()
                result.success(list)
            }
            else -> result.notImplemented()
        }
    }

    // ── the microphone permission ──

    private fun withMic(id: Int, go: () -> Unit) {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { go(); return }
        micWaiting?.invoke(false)
        micWaiting = { ok -> if (ok) go() else failed(id, "denied") }
        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST)
    }

    fun onPermission(granted: Boolean) { val w = micWaiting; micWaiting = null; w?.invoke(granted) }

    // ── the system recognizer ──

    private fun hear(id: Int, lang: String, continuous: Boolean) {
        cancelHearing()
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) { failed(id, "unavailable"); return }
        val r = SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = r
        hearId = id
        lastText = ""
        segText = ""
        var lastLevel = 0L
        fun soFar(partial: String) = listOf(segText, partial).filter { it.isNotEmpty() }.joinToString(" ")
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {
                val now = System.currentTimeMillis()
                if (now - lastLevel < 90) return
                lastLevel = now
                emit("level", mapOf("level" to ((rmsdB + 2f) / 12f).coerceIn(0f, 1f).toDouble()))
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                if (recognizer !== r) return
                Log.i(TAG, "recognizer error $error")
                finishHearing(r)
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_CLIENT -> done(id, soFar(lastText))
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> failed(id, "denied")
                    // ERROR_SERVER_DISCONNECTED (11, API 31): the recognition service went away mid-session
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER, 11 -> failed(id, "network")
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY, 10 -> failed(id, "busy") // 10 = ERROR_TOO_MANY_REQUESTS
                    12, 13 -> failed(id, "language") // ERROR_LANGUAGE_NOT_SUPPORTED / _UNAVAILABLE (API 31)
                    else -> failed(id, "error")
                }
            }
            override fun onResults(results: Bundle?) {
                if (recognizer !== r) return
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: lastText
                finishHearing(r)
                done(id, soFar(text))
            }
            override fun onPartialResults(partial: Bundle?) {
                if (recognizer !== r) return
                val text = partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
                if (text.isEmpty()) return
                lastText = text
                emit("partial", mapOf("text" to (if (continuous) soFar(text) else text)))
            }
            // A segmented session (Android 13+): one session through silence, each utterance a segment.
            // A call takes the first thing said; dictation keeps adding until it is stopped.
            override fun onSegmentResults(segmentResults: Bundle) {
                if (recognizer !== r) return
                val text = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim() ?: ""
                lastText = ""
                if (text.isEmpty()) return
                if (!continuous) { finishHearing(r); done(id, text); return }
                segText = soFar(text)
                emit("partial", mapOf("text" to segText))
            }
            override fun onEndOfSegmentedSession() {
                if (recognizer !== r) return
                finishHearing(r)
                done(id, soFar(lastText))
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        if (lang.isNotEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
        if (Build.VERSION.SDK_INT >= 33) {
            // Without this a session ends after a few seconds of silence and a new one has to start — and what
            // is said in that gap is lost (a call heard "+ 4" of "what is three plus four"). Recognizers that
            // don't support it ignore it and behave as below.
            intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS)
            // An Int: Google's service reads it with getInt, and a Long reads as 0 — the session is then ignored.
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 60_000)
        } else if (continuous) {
            // Dictation: wait through pauses. Recognizers may ignore these; then a pause ends it, like voice typing.
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        }
        r.startListening(intent)
    }

    private fun finishHearing(r: SpeechRecognizer) {
        if (recognizer === r) { recognizer = null; hearId = 0 }
        r.destroy()
    }

    /** Thrown away: the waiting Future gets '' (no callback comes after cancel()). */
    private fun cancelHearing() {
        val r = recognizer ?: return
        val id = hearId
        r.cancel()
        finishHearing(r)
        done(id, "")
    }

    // ── recording for an upstream recognizer: 16 kHz mono WAV, ended by silence after speech ──

    private fun record(id: Int, endSilenceMs: Int, noSpeechMs: Int, maxMs: Int) {
        recorder?.finish(keep = false)
        val rec = Recorder(id, endSilenceMs, noSpeechMs, maxMs)
        recorder = rec
        Thread(rec, "voice-record").start()
    }

    private inner class Recorder(val id: Int, val endSilenceMs: Int, val noSpeechMs: Int, val maxMs: Int) : Runnable {
        @Volatile private var stop = false
        @Volatile private var keep = true
        fun finish(keep: Boolean) { this.keep = keep; stop = true }

        override fun run() {
            val rate = 16000
            val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val ar = try {
                @Suppress("MissingPermission")
                AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, rate))
            } catch (e: Exception) { null }
            if (ar == null || ar.state != AudioRecord.STATE_INITIALIZED) { ar?.release(); main.post { if (recorder === this) recorder = null }; failed(id, "error"); return }
            val pcm = ByteArrayOutputStream()
            val frame = ShortArray(rate / 20) // 50 ms
            val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            // The same speech-versus-noise rule as the web (speech.js Voice): louder than the room for 140 ms.
            var floor = 0.004
            var loudFor = 0
            var heard = false
            var quietFor = 0
            var t = 0
            var sinceLevel = 0
            ar.startRecording()
            while (!stop) {
                val n = ar.read(frame, 0, frame.size)
                if (n <= 0) break
                var sum = 0.0
                bytes.clear()
                for (i in 0 until n) { val s = frame[i]; sum += (s.toDouble() / 32768.0).let { it * it }; bytes.putShort(s) }
                pcm.write(bytes.array(), 0, n * 2)
                val level = sqrt(sum / n)
                val threshold = max(0.012, floor * 3)
                val loud = level > threshold
                if (!loud) floor = floor * 0.97 + minOf(level, 0.012) * 0.03
                loudFor = if (loud) loudFor + 50 else 0
                if (loudFor >= 140) heard = true
                quietFor = if (level > threshold * 0.7) 0 else quietFor + 50
                t += 50
                sinceLevel += 50
                if (sinceLevel >= 100) { sinceLevel = 0; emit("level", mapOf("level" to (level * 9).coerceIn(0.0, 1.0))) }
                if ((heard && quietFor >= endSilenceMs) || (!heard && t >= noSpeechMs) || t >= maxMs) break
            }
            ar.stop()
            ar.release()
            main.post { if (recorder === this) recorder = null }
            if (!keep || !heard) { done(id, null); return }
            val dir = File(activity.cacheDir, "voice").apply { mkdirs() }
            val file = File(dir, "heard-$id.wav")
            file.outputStream().use { out -> out.write(wavHeader(pcm.size(), rate)); pcm.writeTo(out) }
            done(id, file.absolutePath)
        }
    }

    private fun wavHeader(dataLen: Int, rate: Int): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray()); putInt(36 + dataLen); put("WAVE".toByteArray()); put("fmt ".toByteArray())
        putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
        put("data".toByteArray()); putInt(dataLen)
    }.array()

    // ── the system voices ──

    private fun withTts(id: Int, go: () -> Unit) {
        if (ttsReady) { go(); return }
        ttsWaiting.add(go)
        if (tts != null) return
        tts = TextToSpeech(activity) { status ->
            main.post {
                if (status != TextToSpeech.SUCCESS) {
                    tts = null
                    ttsWaiting.clear()
                    failed(id, "unavailable")
                    return@post
                }
                ttsReady = true
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { utteranceId?.toIntOrNull()?.let { saidDone(it) } }
                    @Deprecated("the one-argument form is what every API level calls")
                    override fun onError(utteranceId: String?) { utteranceId?.toIntOrNull()?.let { saidDone(it) } }
                    override fun onStop(utteranceId: String?, interrupted: Boolean) { utteranceId?.toIntOrNull()?.let { saidDone(it) } }
                })
                val waiting = ttsWaiting.toList()
                ttsWaiting.clear()
                waiting.forEach { it() }
            }
        }
    }

    private fun saidDone(id: Int) { if (sayId == id) sayId = 0; done(id) }

    private fun say(id: Int, text: String, pitch: Double, rate: Double, lang: String, voice: String) {
        val t = tts ?: run { failed(id, "unavailable"); return }
        val chosen = if (voice.isNotEmpty()) t.voices?.firstOrNull { it.name == voice } else null
        if (chosen != null) t.voice = chosen
        else if (lang.isNotEmpty()) {
            val r = t.setLanguage(Locale.forLanguageTag(lang))
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) t.language = Locale.getDefault()
        }
        t.setPitch(pitch.toFloat())
        t.setSpeechRate(rate.toFloat())
        sayId = id
        if (t.speak(text, TextToSpeech.QUEUE_ADD, null, id.toString()) != TextToSpeech.SUCCESS) { sayId = 0; failed(id, "error") }
    }

    // ── playing an upstream's audio ──

    private fun play(id: Int, path: String) {
        stopPlayer()
        val p = MediaPlayer()
        player = p
        playId = id
        p.setOnCompletionListener { if (player === p) { stopPlayer() }; done(id) }
        p.setOnErrorListener { _, _, _ -> if (player === p) { stopPlayer() }; failed(id, "error"); true }
        try {
            p.setDataSource(path)
            p.prepare()
            p.start()
        } catch (e: Exception) {
            stopPlayer()
            failed(id, "error")
        }
    }

    private fun stopPlayer() {
        val p = player ?: return
        player = null
        playId = 0
        try { p.stop() } catch (e: IllegalStateException) { }
        p.release()
    }

    /** Stop whatever is being said or played; the Futures waiting on them complete. */
    private fun silence() {
        if (sayId != 0) { val id = sayId; sayId = 0; tts?.stop(); done(id) } else tts?.stop()
        if (player != null) { val id = playId; stopPlayer(); done(id) }
    }

    fun dispose() {
        cancelHearing()
        recorder?.finish(keep = false)
        silence()
        tts?.shutdown()
        tts = null
        ch.setMethodCallHandler(null)
    }

    companion object {
        const val MIC_REQUEST = 11
        private const val TAG = "VoiceBridge"
    }
}
