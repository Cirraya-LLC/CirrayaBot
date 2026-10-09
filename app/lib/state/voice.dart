/// Speaking to an agent and hearing it answer, on this device: the composer's microphone,
/// replies read aloud, and calls. What is read out of a reply is `data/voice.dart` (the same rules
/// as the web); the device's recognizer, voices, recorder and player are a [VoiceEngine].
///
/// Which engine hears and which speaks is a platform setting (the server's); what only makes sense
/// per device — reading replies aloud, the language spoken, the device voice — is kept here, in
/// `voice.json` beside the app's settings.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

import '../data/api.dart';
import '../data/speech.dart';
import '../data/voice.dart';
import '../l10n.dart';
import '../platform.dart';
import 'workbench.dart';

enum CallState { listening, transcribing, thinking, speaking, muted }

class VoicePrefs {
  const VoicePrefs({this.autoRead = false, this.lang = '', this.voice = '', this.voiceLang = ''});

  /// Read replies aloud as they arrive.
  final bool autoRead;

  /// The language the person speaks ('' = the interface's on the device recognizer; detected by an upstream).
  final String lang;

  /// A device voice chosen by name, and its language ('' = one picked per sentence).
  final String voice;
  final String voiceLang;

  VoicePrefs copyWith({bool? autoRead, String? lang, String? voice, String? voiceLang}) => VoicePrefs(
    autoRead: autoRead ?? this.autoRead,
    lang: lang ?? this.lang,
    voice: voice ?? this.voice,
    voiceLang: voiceLang ?? this.voiceLang,
  );

  Map<String, Object?> toJson() => {'autoRead': autoRead, 'lang': lang, 'voice': voice, 'voiceLang': voiceLang};

  static VoicePrefs fromJson(Map<String, Object?> j) => VoicePrefs(
    autoRead: j['autoRead'] == true,
    lang: (j['lang'] as String?) ?? '',
    voice: (j['voice'] as String?) ?? '',
    voiceLang: (j['voiceLang'] as String?) ?? '',
  );
}

class _Piece {
  _Piece(this.text, this.agent, this.gen);
  final String text;
  final String? agent;
  final int gen;

  /// Upstream voice: the audio file, fetched ahead of its turn.
  Future<String>? audio;
}

class VoiceController extends ChangeNotifier {
  VoiceController(this.bench, this.engine, {Directory? dir, List<ui.Locale>? deviceLocales})
    : _dir = dir ?? AppPlatform.dataDir,
      _locales = deviceLocales {
    bench.onSpeech = _onStream;
  }

  final Workbench bench;
  final VoiceEngine engine;
  final Directory _dir;
  final List<ui.Locale>? _locales;
  File get _file => File('${_dir.path}${Platform.pathSeparator}voice.json');

  VoiceSettings settings = const VoiceSettings();
  VoicePrefs prefs = const VoicePrefs();
  bool deviceHears = false;
  bool deviceSpeaks = false;

  /// Something went wrong that the person should hear about (a line for a snackbar).
  void Function(String message)? onError;

  bool _disposed = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> init() async {
    try {
      prefs = VoicePrefs.fromJson(jsonDecode(await _file.readAsString()) as Map<String, Object?>);
    } catch (_) {
      // nothing saved yet
    }
    try {
      final c = await engine.caps();
      deviceHears = c.hear;
      deviceSpeaks = c.speak;
    } catch (_) {
      // no engine answers: everything is "can't" and says why
    }
    await loadSettings();
  }

  Future<void> loadSettings() async {
    try {
      settings = await bench.api.voiceSettings();
    } on ApiException {
      // an older server without voice: the device's own, the default
    }
    _notify();
  }

  /// Saves on the server; an ApiException (what's missing) is for the page to show.
  Future<void> saveSettings(VoiceSettings v) async {
    settings = await bench.api.saveVoiceSettings(v);
    _notify();
  }

  Future<void> savePrefs(VoicePrefs p) async {
    final stopReading = prefs.autoRead && !p.autoRead && !inCall;
    prefs = p;
    if (stopReading) await stopSpeaking();
    _notify();
    try {
      await _dir.create(recursive: true);
      await _file.writeAsString(jsonEncode(p.toJson()));
    } catch (_) {
      // a read-only disk keeps the choice for this run
    }
  }

  /// Why this device can't hear / speak with the engine chosen (an l10n key), or null.
  String? get cantHear => settings.stt.upstream || deviceHears ? null : 'vo.noRecognizer';
  String? get cantSpeak => settings.tts.upstream || deviceSpeaks ? null : 'vo.noVoices';

  // ── languages ──

  static const _nonLatin = ['zh', 'ja', 'ko', 'ru', 'cmn', 'yue'];
  List<String> get _deviceTags => [for (final l in _locales ?? ui.PlatformDispatcher.instance.locales) l.toLanguageTag()];
  static bool _latin(String tag) => tag.isNotEmpty && !_nonLatin.any(tag.toLowerCase().startsWith);

  /// What the device recognizer listens for: the person's choice, else the interface language.
  String get hearLang => hearLangFor(prefs.lang);

  String hearLangFor(String choice) {
    if (choice.isNotEmpty) return choice;
    switch (currentLang.value.code) {
      case 'zh-Hans':
        return 'zh-CN';
      case 'zh-Hant':
        return _deviceTags.firstWhere((t) => RegExp(r'^zh-(TW|HK|MO|Hant)', caseSensitive: false).hasMatch(t), orElse: () => 'zh-TW');
    }
    return _deviceTags.firstWhere((t) => t.toLowerCase().startsWith('en'), orElse: () => 'en-US');
  }

  /// The language a sentence is said in, by the script it is written in — a Chinese sentence needs
  /// a voice that speaks Chinese whatever the interface is.
  String speakLang(String piece) {
    switch (scriptOf(piece)) {
      case 'zh':
        return currentLang.value.code == 'zh-Hant' ? 'zh-TW' : 'zh-CN';
      case 'ja':
        return 'ja-JP';
      case 'ko':
        return 'ko-KR';
      case 'ru':
        return 'ru-RU';
    }
    if (_latin(prefs.lang)) return prefs.lang;
    return _deviceTags.where(_latin).firstOrNull ?? 'en-US';
  }

  String _voiceFor(String lang) {
    if (prefs.voice.isEmpty) return '';
    final want = lang.split('-').first.toLowerCase();
    return prefs.voiceLang.toLowerCase().startsWith(want) ? prefs.voice : '';
  }

  // ── speaking: one sentence after another ──

  final _queue = <_Piece>[];
  _Piece? _playing;
  int _gen = 0;
  int _fileSeq = 0;
  bool _warned = false;

  /// What is being said right now ('' = nothing).
  String saying = '';

  /// The message whose 🔊 is playing (the text it started from), for its button to show it.
  String? reading;

  bool get speaking => _playing != null || _queue.isNotEmpty;

  void say(String text, String? agent) {
    if (text.trim().isEmpty) return;
    _queue.add(_Piece(text, agent, _gen));
    if (settings.tts.upstream) _prefetch();
    if (_playing == null) unawaited(_next());
  }

  void _prefetch() {
    for (final p in _queue.take(3)) {
      p.audio ??= (_fetch(p)..ignore());
    }
  }

  Future<String> _fetch(_Piece p) async {
    final bytes = await bench.api.speech(p.text, agent: p.agent);
    final dir = Directory('${AppPlatform.downloadRoot.path}${Platform.pathSeparator}voice');
    await dir.create(recursive: true);
    final f = File('${dir.path}${Platform.pathSeparator}say-${++_fileSeq}.mp3');
    await f.writeAsBytes(bytes);
    return f.path;
  }

  Future<void> _next() async {
    if (_queue.isEmpty) {
      if (_playing != null) {
        _playing = null;
        saying = '';
        reading = null;
        _spoke(false);
      }
      return;
    }
    final p = _queue.removeAt(0);
    final first = _playing == null;
    _playing = p;
    saying = p.text;
    if (first) {
      _spoke(true);
    } else {
      _notify();
    }
    try {
      if (settings.tts.upstream) {
        _prefetch();
        final path = await (p.audio ??= _fetch(p));
        if (p.gen == _gen) await engine.play(path);
        File(path).delete().ignore();
      } else {
        final tone = deviceTone(p.agent);
        final lang = speakLang(p.text);
        await engine.say(p.text, pitch: tone.pitch, rate: tone.rate, lang: lang, voice: _voiceFor(lang));
      }
      _warned = false;
    } catch (e) {
      // One line per run of failures: a reply of twenty sentences shouldn't say so twenty times.
      if (p.gen == _gen && !_warned) {
        _warned = true;
        onError?.call(tr('vo.speakFailed', {'msg': e is ApiException ? e.message : '$e'}));
      }
    }
    if (p.gen != _gen) return; // silenced meanwhile; stopSpeaking() already settled the state
    await _next();
  }

  /// Silence now and forget what was queued.
  Future<void> stopSpeaking() async {
    _gen++;
    for (final p in _queue) {
      p.audio?.then((path) => File(path).delete()).ignore();
    }
    _queue.clear();
    final was = _playing != null;
    _playing = null;
    saying = '';
    reading = null;
    await engine.silence().catchError((Object _) {});
    if (was) _spoke(false);
  }

  /// Read one message aloud — again = stop.
  Future<void> readMessage(String text, String? agent) async {
    final again = reading == text && speaking;
    await stopSpeaking();
    if (again) return;
    final why = cantSpeak;
    if (why != null) {
      onError?.call(tr(why));
      return;
    }
    final pieces = sentences(speakable(text, codeWord: tr('vo.code')), isFinal: true).out;
    for (final s in pieces) {
      say(s, agent);
    }
    if (pieces.isNotEmpty) reading = text;
    _notify();
  }

  // ── a reply streaming here, read as it arrives ──

  final _readers = <String, Reader>{};

  /// Interrupted in a call: the rest of this answer stays unread until what was said reaches it.
  bool muteTurn = false;
  bool get _reads => (prefs.autoRead || inCall) && !muteTurn;

  void _feed(String bot, String text, {bool isFinal = false}) {
    final r = _readers.putIfAbsent(bot, () => Reader(codeWord: tr('vo.code')));
    final out = r.push(text, isFinal: isFinal);
    if (isFinal) _readers.remove(bot);
    if (_reads) {
      for (final s in out) {
        say(s, bot.isEmpty ? null : bot);
      }
    }
  }

  void _flush([String? bot]) {
    for (final id in bot == null ? [..._readers.keys] : [bot]) {
      if (_readers.containsKey(id)) _feed(id, '', isFinal: true);
    }
  }

  void _onStream(String kind, String bot, String text) {
    switch (kind) {
      case 'begin':
        _readers.clear();
        muteTurn = false;
      case 'start' || 'flush':
        _flush(bot);
      case 'delta':
        _feed(bot, text);
      case 'drop':
        _readers.remove(bot);
      case 'interject':
        _flush(bot);
        muteTurn = false;
      case 'end':
        _flush();
        if (inCall) _afterTurn();
      case 'sent':
        if (inCall) _afterTurn();
    }
  }

  // ── hearing ──

  bool dictating = false;
  bool transcribing = false;

  /// What the microphone heard so far ('' when nothing yet), and how loud it is (0–1).
  String heard = '';
  double level = 0;
  bool _thrown = false;

  Future<String> _listen({required bool continuous}) async {
    heard = '';
    _thrown = false;
    if (settings.stt.upstream) {
      final path = await engine.record(
        endSilenceMs: continuous ? 2500 : 1100,
        noSpeechMs: continuous ? 15000 : 9000,
        maxMs: continuous ? 120000 : 60000,
        onLevel: (l) {
          level = l;
          _notify();
        },
      );
      level = 0;
      if (path == null || _thrown) return '';
      transcribing = true;
      if (inCall) callState = CallState.transcribing;
      _notify();
      try {
        final l = prefs.lang.length >= 2 ? prefs.lang.substring(0, 2).toLowerCase() : '';
        return await bench.api.transcribe(path, 'audio/wav', language: l);
      } finally {
        transcribing = false;
        File(path).delete().ignore();
      }
    }
    final text = await engine.hear(
      lang: hearLang,
      continuous: continuous,
      onPartial: (t) {
        heard = t;
        _notify();
      },
      onLevel: (l) {
        level = l;
        _notify();
      },
    );
    level = 0;
    return _thrown ? '' : text;
  }

  String _errorText(Object e) => switch (e) {
    VoiceError(:final code) => tr('vo.err.$code'),
    ApiException(:final message) => message,
    _ => '$e',
  };

  /// The composer's microphone: listen through pauses until [stopDictation] (or a long silence),
  /// and return what was said ('' for nothing, or when [cancelDictation] threw it away).
  Future<String> dictate() async {
    if (dictating) return '';
    final why = cantHear;
    if (why != null) {
      onError?.call(tr(why));
      return '';
    }
    await stopSpeaking();
    dictating = true;
    _notify();
    try {
      return await _listen(continuous: true);
    } catch (e) {
      if (!_thrown) onError?.call(_errorText(e));
      return '';
    } finally {
      dictating = false;
      transcribing = false;
      heard = '';
      _notify();
    }
  }

  Future<void> stopDictation() => engine.stopListening();

  Future<void> cancelDictation() async {
    _thrown = true;
    await engine.cancelListening();
  }

  // ── a call: listen → send → read the answer → listen again ──

  Conversation? callWith;
  bool get inCall => callWith != null;
  CallState callState = CallState.listening;
  bool muted = false;
  bool _listening = false;
  int _listenGen = 0;

  /// Hearing errors in a row. A recognizer has passing failures (its service reconnecting, busy for a
  /// moment); a call shouldn't hang up on one of them — only on a run, or on one that can't pass.
  int _failures = 0;
  static const _fatal = {'denied', 'unavailable', 'language'};

  void _state(CallState s) {
    callState = s;
    _notify();
  }

  /// Starts a call with the open conversation. Returns why it can't (a sentence), or null.
  Future<String?> startCall() async {
    final c = bench.current;
    if (c == null) return null;
    if (inCall) return null;
    await loadSettings();
    final why = cantHear ?? cantSpeak;
    if (why != null) return tr(why);
    await stopSpeaking();
    callWith = c;
    muted = false;
    muteTurn = false;
    heard = '';
    _failures = 0;
    if (bench.busyHere) {
      _state(CallState.thinking); // a reply already streaming is read from now on
    } else {
      unawaited(_callListen());
    }
    return null;
  }

  Future<void> endCall() async {
    if (!inCall) return;
    callWith = null;
    _listenGen++;
    if (_listening) {
      _thrown = true;
      await engine.cancelListening().catchError((Object _) {});
    }
    await stopSpeaking();
    _notify();
  }

  Future<void> _callListen() async {
    if (!inCall || _listening) return;
    if (muted) {
      _state(CallState.muted);
      return;
    }
    _state(CallState.listening);
    _listening = true;
    final gen = ++_listenGen;
    final began = DateTime.now();
    String text;
    try {
      text = await _listen(continuous: false);
    } catch (e) {
      _listening = false;
      if (gen != _listenGen || !inCall) return;
      final passing = e is VoiceError && !_fatal.contains(e.code);
      if (passing && ++_failures < 3) {
        await Future<void>.delayed(const Duration(seconds: 1));
        if (gen == _listenGen) unawaited(_callListen());
        return;
      }
      onError?.call(_errorText(e));
      await endCall();
      return;
    }
    _listening = false;
    _failures = 0;
    if (gen != _listenGen || !inCall) return;
    if (text.isEmpty) {
      // Nothing said: listen again — after a pause if the recognizer gave up at once, so a broken one can't spin.
      if (DateTime.now().difference(began).inMilliseconds < 1000) await Future<void>.delayed(const Duration(milliseconds: 800));
      if (gen == _listenGen) unawaited(_callListen());
      return;
    }
    heard = text;
    final c = bench.current;
    if (c == null || c.id != callWith!.id || c.kind != callWith!.kind) {
      await endCall();
      return;
    }
    _state(CallState.thinking);
    if (bench.atWork) {
      await bench.interject(text, spoken: true);
    } else {
      await bench.send(text, spoken: true);
    }
  }

  /// The turn ended (or a message was handed to one still at work): listen once it's quiet.
  void _afterTurn() {
    if (!inCall || bench.busy || _listening || speaking) return;
    unawaited(_callListen());
  }

  void _spoke(bool on) {
    _notify();
    if (!inCall) return;
    if (on) {
      if (!_listening) _state(CallState.speaking);
      return;
    }
    if (bench.busy) {
      if (!_listening) _state(CallState.thinking);
    } else {
      _afterTurn();
    }
  }

  /// Cut in: the rest of this answer goes unread, and what is said now reaches the turn.
  Future<void> interrupt() async {
    if (!inCall) return;
    if (speaking || bench.busy) muteTurn = true;
    await stopSpeaking();
    unawaited(_callListen());
  }

  /// The big circle: while listening = "that's all, send it"; while it speaks or works = cut in.
  Future<void> tap() async {
    if (!inCall) return;
    switch (callState) {
      case CallState.listening:
        await engine.stopListening();
      case CallState.speaking || CallState.thinking:
        await interrupt();
      case CallState.transcribing || CallState.muted:
        break;
    }
  }

  Future<void> toggleMute() async {
    muted = !muted;
    if (muted) {
      _listenGen++;
      if (_listening) {
        _listening = false;
        _thrown = true;
        await engine.cancelListening().catchError((Object _) {});
      }
      if (!speaking && !bench.busy) _state(CallState.muted);
    } else if (!speaking && !bench.busy) {
      unawaited(_callListen());
    }
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    if (bench.onSpeech == _onStream) bench.onSpeech = null;
    callWith = null;
    _gen++;
    _queue.clear();
    engine.silence().catchError((Object _) {});
    if (_listening || dictating) engine.cancelListening().catchError((Object _) {});
    super.dispose();
  }
}
