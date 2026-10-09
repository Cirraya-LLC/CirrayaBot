/// What is said out loud: the same rules as the web's `web/voice.mjs`, so a reply sounds the
/// same on the phone as in the browser. Pure — no platform code. `test/voice_test.dart` runs the
/// same cases as that file's self-test.
library;

/// Voice settings as the server keeps them (`/api/settings/voice`): which engine hears and which
/// speaks. `device` = the phone's own; `upstream` = one of the person's upstreams, by the server.
class VoiceSettings {
  const VoiceSettings({this.stt = const VoicePart(), this.tts = const VoicePart()});
  final VoicePart stt;
  final VoicePart tts;

  static VoiceSettings fromJson(Map<String, Object?> j) => VoiceSettings(
    stt: VoicePart.fromJson((j['stt'] as Map?)?.cast<String, Object?>() ?? const {}),
    tts: VoicePart.fromJson((j['tts'] as Map?)?.cast<String, Object?>() ?? const {}),
  );
  Map<String, Object?> toJson() => {'stt': stt.toJson(), 'tts': tts.toJson()};
}

class VoicePart {
  const VoicePart({this.mode = 'device', this.providerId = '', this.model = '', this.voice = ''});
  final String mode;
  final String providerId;
  final String model;

  /// Only for speaking: the default voice name on the upstream.
  final String voice;

  bool get upstream => mode == 'upstream';

  static VoicePart fromJson(Map<String, Object?> j) => VoicePart(
    mode: j['mode'] == 'upstream' ? 'upstream' : 'device',
    providerId: (j['provider_id'] as String?) ?? '',
    model: (j['model'] as String?) ?? '',
    voice: (j['voice'] as String?) ?? '',
  );
  Map<String, Object?> toJson() => {
    'mode': mode,
    if (upstream) ...{'provider_id': providerId, 'model': model, if (voice.isNotEmpty) 'voice': voice},
  };
}

/// A reply as it should sound: code is "(code)" ([codeWord]), links are their words, URLs and
/// Markdown's marks are not read.
String speakable(String md, {String codeWord = 'code'}) {
  var t = md;
  t = t.replaceAll(RegExp(r'```[\s\S]*?(```|$)'), ' ($codeWord) ');
  t = t.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!);
  t = t.replaceAllMapped(RegExp(r'\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'https?://\S+'), '');
  t = t.replaceAllMapped(RegExp(r'`([^`\n]+)`'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'^\s{0,3}#{1,6}\s+', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^\s*[-*+]\s+', multiLine: true), '').replaceAll(RegExp(r'^\s*\d+[.)]\s+', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^\s*>\s?', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^[ \t]*\|?[ \t]*:?-{3,}.*$', multiLine: true), '');
  t = t.replaceAllMapped(RegExp(r'^[ \t]*\|(.*)\|[ \t]*$', multiLine: true),
      (m) => m[1]!.split('|').map((c) => c.trim()).where((c) => c.isNotEmpty).join(', '));
  t = t.replaceAllMapped(RegExp(r'(\*\*|__|~~)(.+?)\1'), (m) => m[2]!);
  t = t.replaceAllMapped(RegExp(r'(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)', multiLine: true), (m) => '${m[1]}${m[2]}');
  t = t.replaceAllMapped(RegExp(r'@(\S+)'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'\*\*|__|~~|`'), '');
  return t
      .replaceAll(RegExp(r'[ \t]+'), ' ')
      .replaceAll(RegExp(r'\s*\n\s*'), '\n')
      .replaceAll(RegExp(r'\n{2,}'), '\n')
      .trim();
}

// CJK sentence marks end a sentence where they stand; . ! ? only before a space or the end ("3.14").
final _end = RegExp('[。！？…]+["\'”’」』)\\]*_]*|[.!?]+["\'”’)\\]*_]*(\\s+|\$)|\\n+');
final _hasWord = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Split text into pieces to speak one after another: whole sentences in `out`, the unfinished
/// tail in `rest` (unless [isFinal]). Long runs are cut at a comma or a space.
({List<String> out, String rest}) sentences(String text, {bool isFinal = false, int max = 220}) {
  final out = <String>[];
  var from = 0;
  for (final m in _end.allMatches(text)) {
    if (m.end == text.length && !isFinal && RegExp(r'^[.!?]').hasMatch(m[0]!) && !RegExp(r'\s$').hasMatch(m[0]!)) break;
    final piece = text.substring(from, m.end).trim();
    if (piece.isNotEmpty) out.addAll(_cut(piece, max));
    from = m.end;
  }
  var rest = text.substring(from);
  if (isFinal && rest.trim().isNotEmpty) {
    out.addAll(_cut(rest.trim(), max));
    rest = '';
  } else if (rest.length > max) {
    final at = _lastBreak(rest, max - 1, cjkComma: false);
    if (at > 40) {
      out.add(rest.substring(0, at + 1).trim());
      rest = rest.substring(at + 1);
    }
  }
  return (out: out.where(_hasWord.hasMatch).toList(), rest: rest);
}

int _lastBreak(String s, int before, {bool cjkComma = true}) {
  var at = -1;
  for (final sep in [', ', '，', if (cjkComma) '、', ' ']) {
    final i = s.lastIndexOf(sep, before);
    if (i > at) at = i;
  }
  return at;
}

List<String> _cut(String s, int max) {
  final out = <String>[];
  while (s.length > max) {
    var at = _lastBreak(s, max - 1);
    if (at < 40) at = max - 1;
    out.add(s.substring(0, at + 1).trim());
    s = s.substring(at + 1).trim();
  }
  if (s.isNotEmpty) out.add(s);
  return out;
}

/// Reads a reply as it streams: [push] the new text, get back what can be spoken now. A code
/// block is held until it closes (then "(code)" once), never read line by line; a sentence comes
/// out only once complete. `push('', isFinal: true)` flushes the rest.
class Reader {
  Reader({this.codeWord = 'code', this.max = 220});
  final String codeWord;
  final int max;
  String _raw = '';
  int _at = 0;

  List<String> push(String delta, {bool isFinal = false}) {
    _raw += delta;
    final p = _raw.substring(_at);
    var cut = 0;
    if (isFinal) {
      cut = p.length;
    } else {
      final fences = [for (final m in RegExp('```').allMatches(p)) m.start];
      bool inFence(int i) => fences.where((f) => f < i).length.isOdd;
      for (final m in _end.allMatches(p)) {
        if (inFence(m.start)) continue;
        if (m.end == p.length && RegExp(r'^[.!?]').hasMatch(m[0]!) && !RegExp(r'\s$').hasMatch(m[0]!)) break;
        cut = m.end;
      }
      if (cut == 0 && p.length > max && fences.isEmpty) {
        final at = _lastBreak(p, max - 1, cjkComma: false);
        if (at > 40) cut = at + 1;
      }
    }
    if (cut == 0) return const [];
    _at += cut;
    return sentences(speakable(p.substring(0, cut), codeWord: codeWord), isFinal: true, max: max).out;
  }
}

/// The language a piece is written in, by script — enough to pick a voice that can say it:
/// 'zh' / 'ja' / 'ko' / 'ru', or '' for anything else.
String scriptOf(String text) {
  if (RegExp(r'[぀-ヿ]').hasMatch(text)) return 'ja';
  if (RegExp(r'[가-힯]').hasMatch(text)) return 'ko';
  if (RegExp(r'[一-鿿]').hasMatch(text)) return 'zh';
  if (RegExp(r'[Ѐ-ӿ]').hasMatch(text)) return 'ru';
  return '';
}

/// Each agent's own pitch and pace on a device voice, from its id — so in a group you hear who
/// is speaking. The same numbers as the web gives the same agent (FNV-1a over the code points).
({double pitch, double rate}) deviceTone(String? agentId) {
  var h = 0x811c9dc5;
  for (final c in (agentId ?? '').runes) {
    h ^= c;
    h = (h * 0x01000193) & 0xffffffff;
  }
  double r3(double x) => double.parse(x.toStringAsFixed(3));
  return (pitch: r3(0.85 + (h % 13) * 0.025), rate: r3(0.94 + ((h >> 8) % 5) * 0.03));
}
