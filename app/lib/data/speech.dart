/// Hearing and speaking on this device. [ChannelVoice] is Android's (the other end is
/// android/app/src/main/kotlin/.../VoiceBridge.kt): the system recognizer, the system voices,
/// a recorder for an upstream recognizer, and a player for an upstream's audio. Tests give the
/// voice controller a fake instead.
library;

import 'dart:async';

import 'package:flutter/services.dart';

/// Why hearing failed: `denied` (no microphone permission), `network` (the recognizer's service
/// can't be reached), `busy`, `language` (not supported here), `unavailable` (no recognizer at all),
/// or `error`.
class VoiceError implements Exception {
  const VoiceError(this.code);
  final String code;
  @override
  String toString() => 'VoiceError($code)';
}

abstract class VoiceEngine {
  /// What this device has: a recognizer of its own, and voices of its own.
  Future<({bool hear, bool speak})> caps();

  /// Listen for one utterance and return its words ('' = nothing was said). [continuous] asks the
  /// recognizer to wait through pauses (dictation), where it allows that.
  Future<String> hear({required String lang, bool continuous = false, void Function(String text)? onPartial, void Function(double level)? onLevel});

  /// Record until a silence after speech, for an upstream recognizer. The WAV file's path, or null
  /// when nobody spoke.
  Future<String?> record({required int endSilenceMs, required int noSpeechMs, required int maxMs, void Function(double level)? onLevel});

  /// Done listening or recording: keep what was said.
  Future<void> stopListening();

  /// Done listening or recording: throw it away (hear gives '', record gives null).
  Future<void> cancelListening();

  /// Say [text] with a voice of this device; completes once said, or silenced.
  Future<void> say(String text, {required double pitch, required double rate, String lang = '', String voice = ''});

  /// Play an audio file; completes once it ends, or is silenced.
  Future<void> play(String path);

  /// Stop saying / playing now.
  Future<void> silence();

  /// This device's voices.
  Future<List<({String name, String lang})>> voices();
}

class ChannelVoice implements VoiceEngine {
  ChannelVoice() {
    _ch.setMethodCallHandler(_on);
  }

  static const _ch = MethodChannel('cirraya/voice');
  var _seq = 0;
  final _waiting = <int, Completer<Object?>>{};
  void Function(String)? _partial;
  void Function(double)? _level;

  Future<Object?> _on(MethodCall c) async {
    final a = (c.arguments as Map?)?.cast<String, Object?>() ?? const {};
    final id = (a['id'] as num?)?.toInt();
    switch (c.method) {
      case 'partial':
        _partial?.call((a['text'] as String?) ?? '');
      case 'level':
        _level?.call((a['level'] as num?)?.toDouble() ?? 0);
      case 'done':
        _waiting.remove(id)?.complete(a['value']);
      case 'failed':
        _waiting.remove(id)?.completeError(VoiceError((a['code'] as String?) ?? 'error'));
    }
    return null;
  }

  /// A long operation: the answer comes back later as `done` / `failed` with the same id.
  Future<Object?> _call(String method, [Map<String, Object?> args = const {}]) {
    final id = ++_seq;
    final c = _waiting[id] = Completer<Object?>();
    _ch.invokeMethod<void>(method, {...args, 'id': id}).catchError((Object _) {
      _waiting.remove(id)?.completeError(const VoiceError('error'));
    });
    return c.future;
  }

  @override
  Future<({bool hear, bool speak})> caps() async {
    final m = await _ch.invokeMapMethod<String, Object?>('caps') ?? const {};
    return (hear: m['hear'] == true, speak: m['speak'] == true);
  }

  @override
  Future<String> hear({required String lang, bool continuous = false, void Function(String)? onPartial, void Function(double)? onLevel}) async {
    _partial = onPartial;
    _level = onLevel;
    try {
      return ((await _call('hear', {'lang': lang, 'continuous': continuous})) as String?) ?? '';
    } finally {
      _partial = null;
      _level = null;
    }
  }

  @override
  Future<String?> record({required int endSilenceMs, required int noSpeechMs, required int maxMs, void Function(double)? onLevel}) async {
    _level = onLevel;
    try {
      return (await _call('record', {'endSilenceMs': endSilenceMs, 'noSpeechMs': noSpeechMs, 'maxMs': maxMs})) as String?;
    } finally {
      _level = null;
    }
  }

  @override
  Future<void> stopListening() => _ch.invokeMethod<void>('stopListening');

  @override
  Future<void> cancelListening() => _ch.invokeMethod<void>('cancelListening');

  @override
  Future<void> say(String text, {required double pitch, required double rate, String lang = '', String voice = ''}) =>
      _call('say', {'text': text, 'pitch': pitch, 'rate': rate, 'lang': lang, 'voice': voice});

  @override
  Future<void> play(String path) => _call('play', {'path': path});

  @override
  Future<void> silence() => _ch.invokeMethod<void>('silence');

  @override
  Future<List<({String name, String lang})>> voices() async {
    final list = await _ch.invokeListMethod<Object?>('voices') ?? const [];
    return [
      for (final v in list)
        if (v is Map) (name: '${v['name']}', lang: '${v['lang']}'),
    ];
  }
}
