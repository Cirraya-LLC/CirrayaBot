/// A voice call with the open conversation: listen → send → read the answer → listen again.
/// All the logic is the VoiceController's; this page only shows it and gives it three controls —
/// the circle (cut in, or "that's all, send it"), mute, and hang up.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/voice.dart';
import '../../theme/app_theme.dart';
import 'message_view.dart';

class CallPage extends StatefulWidget {
  const CallPage({super.key, required this.voice, required this.conversation});

  final VoiceController voice;
  final Conversation conversation;

  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100));
  bool _leaving = false;

  VoiceController get v => widget.voice;

  @override
  void initState() {
    super.initState();
    v.addListener(_changed);
    _changed();
  }

  void _changed() {
    if (!mounted) return;
    // Ended from elsewhere (an error, the conversation changed): leave the page too.
    if (!v.inCall) {
      if (!_leaving) {
        _leaving = true;
        Navigator.of(context).maybePop();
      }
      return;
    }
    final animate = (v.callState == CallState.speaking || v.callState == CallState.thinking) && !MediaQuery.disableAnimationsOf(context);
    if (animate && !_pulse.isAnimating) _pulse.repeat(reverse: true);
    if (!animate && _pulse.isAnimating) _pulse.stop();
    setState(() {});
  }

  @override
  void dispose() {
    v.removeListener(_changed);
    _pulse.dispose();
    if (v.inCall) v.endCall();
    super.dispose();
  }

  String get _stateText => switch (v.callState) {
    CallState.listening => tr('vo.state.listening'),
    CallState.transcribing => tr('vo.state.transcribing'),
    CallState.thinking => tr('vo.state.thinking'),
    CallState.speaking => tr('vo.state.speaking'),
    CallState.muted => tr('vo.state.muted'),
  };

  @override
  Widget build(BuildContext context) {
    final c = widget.conversation;
    final s = v.callState;
    final ringColor = s == CallState.muted ? C.dim2 : C.accent;
    // Listening: the ring follows the microphone's level. Speaking / working: it breathes.
    final ring = AnimatedBuilder(
      animation: _pulse,
      builder: (_, _) {
        final scale = switch (s) {
          CallState.listening => 1 + (v.level * 0.35).clamp(0.0, 0.35),
          CallState.speaking || CallState.thinking => 1 + _pulse.value * 0.1,
          _ => 1.0,
        };
        return Transform.scale(
          scale: scale,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: ringColor.withValues(alpha: s == CallState.thinking ? 0.45 : 0.9), width: 2),
            ),
          ),
        );
      },
    );
    return Scaffold(
      backgroundColor: C.bg,
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Semantics(
                        button: true,
                        label: tr('vo.tapHint'),
                        child: GestureDetector(
                          key: const ValueKey('call-orb'),
                          behavior: HitTestBehavior.opaque,
                          onTap: v.tap,
                          child: SizedBox(
                            width: 150,
                            height: 150,
                            child: Stack(
                              alignment: Alignment.center,
                              children: [
                                Positioned.fill(child: ring),
                                c.isGroup
                                    ? Transform.scale(
                                        scale: 2.4,
                                        child: GroupAvatar(colors: [for (final h in c.colors) C.parse(h)], count: c.members.length),
                                      )
                                    : Avatar(label: c.name, color: C.parse(c.color), size: 104),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 22),
                      Text(c.name, textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 6),
                      Text(_stateText, key: const ValueKey('call-state'), style: TextStyle(fontSize: 13, color: C.dim)),
                      const SizedBox(height: 16),
                      Text(
                        v.heard,
                        textAlign: TextAlign.center,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 15, height: 1.5),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        v.saying,
                        textAlign: TextAlign.center,
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, height: 1.5, color: C.dim),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton.filled(
                  key: const ValueKey('call-mute'),
                  tooltip: tr(v.muted ? 'vo.unmute' : 'vo.mute'),
                  isSelected: v.muted,
                  onPressed: v.toggleMute,
                  iconSize: 24,
                  style: IconButton.styleFrom(
                    fixedSize: const Size(60, 60),
                    backgroundColor: v.muted ? C.ink : C.chip,
                    foregroundColor: v.muted ? C.bg : C.ink,
                  ),
                  icon: Icon(v.muted ? Icons.mic_off : Icons.mic_none),
                ),
                const SizedBox(width: 28),
                IconButton.filled(
                  key: const ValueKey('call-end'),
                  tooltip: tr('vo.end'),
                  onPressed: () => v.endCall(),
                  iconSize: 26,
                  style: IconButton.styleFrom(fixedSize: const Size(60, 60), backgroundColor: C.bad, foregroundColor: C.onAccent),
                  icon: const Icon(Icons.call_end),
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 14, 24, 18),
              child: Text(
                tr(v.canBargeIn ? 'vo.hintTalk' : 'vo.hintTap'),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: C.dim2),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
