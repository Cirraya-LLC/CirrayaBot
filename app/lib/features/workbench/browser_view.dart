/// The Agent's browser, live: a thumbnail in the right panel, and a
/// full-window page where a person can take over — log in, get past a
/// captcha — then hand it back.
///
/// It is the same browser the Agent drives (one per Agent, in his machine).
/// What you see is Chromium's own screencast, pushed as the page changes;
/// screenshots every second or so are only the fallback when the stream is
/// unavailable. What you do is sent as a click at a coordinate, typed text,
/// a key or a wheel turn.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../theme/app_theme.dart';

/// The page is 1280×800 in the Agent's browser (browserd.py's viewport).
const _viewW = 1280.0, _viewH = 800.0;

typedef _Shot = ({Uint8List image, String url, String title});

/// Keeps [shot] current while on screen: the live stream first, and when that
/// is not available (no browser open yet, stream dropped) a screenshot every
/// [every] — which also notices when a browser appears, and then the stream is
/// tried again.
mixin _ShotPoller<T extends StatefulWidget> on State<T> {
  Api get api;
  String get agentId;
  Duration get every;

  _Shot? shot;
  bool loaded = false;
  bool streaming = false;
  String error = '';
  Timer? _timer;
  bool _inFlight = false;
  StreamSubscription<_Shot>? _live;

  void startPolling() {
    _timer?.cancel();
    refresh();
    _connect();
    _timer = Timer.periodic(every, (_) {
      if (streaming || !(ModalRoute.of(context)?.isCurrent ?? true)) return;
      // A browser is open but the stream is not running: try it again.
      if (shot != null && _live == null) _connect();
      refresh();
    });
  }

  void _connect() {
    if (_live != null) return;
    _live = api
        .browserStream(agentId)
        .listen(
          (s) {
            if (!mounted) return;
            setState(() {
              shot = s;
              loaded = true;
              streaming = true;
              error = '';
            });
            onShot();
          },
          onError: (_) => _dropped(),
          onDone: _dropped,
          cancelOnError: true,
        );
  }

  /// A new picture arrived (from the stream or a screenshot).
  void onShot() {}

  void _dropped() {
    _live = null;
    if (mounted) setState(() => streaming = false);
  }

  Future<void> refresh() async {
    if (_inFlight) return;
    _inFlight = true;
    try {
      final s = await api.browserShot(agentId);
      if (!mounted) return;
      setState(() {
        shot = s;
        loaded = true;
        error = '';
      });
      onShot();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      _inFlight = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _live?.cancel();
    super.dispose();
  }
}

class BrowserThumb extends StatefulWidget {
  const BrowserThumb({
    super.key,
    required this.api,
    required this.agentId,
    required this.name,
    this.hideWhenOff = false,
  });
  final Api api;
  final String agentId;
  final String name;

  /// In a group only the members whose browser is open are worth a tile.
  final bool hideWhenOff;

  @override
  State<BrowserThumb> createState() => _BrowserThumbState();
}

class _BrowserThumbState extends State<BrowserThumb> with _ShotPoller {
  @override
  Api get api => widget.api;
  @override
  String get agentId => widget.agentId;
  @override
  Duration get every => const Duration(seconds: 3);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => startPolling());
  }

  Future<void> _open() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BrowserPage(api: widget.api, agentId: widget.agentId, name: widget.name),
      ),
    );
    refresh();
  }

  @override
  Widget build(BuildContext context) {
    final s = shot;
    if (s == null) {
      if (widget.hideWhenOff || !loaded) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 8, 4),
        child: Row(
          children: [
            Expanded(
              child: Text(tr('br.notOpen'), style: TextStyle(fontSize: 12, color: C.dim2)),
            ),
            TextButton(
              onPressed: _open,
              child: Text(tr('br.open'), style: const TextStyle(fontSize: 12)),
            ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 6),
      child: Tooltip(
        message: tr('br.takeOver', {'name': widget.name}),
        child: InkWell(
          onTap: _open,
          borderRadius: BorderRadius.circular(8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: AspectRatio(
                  aspectRatio: _viewW / _viewH,
                  child: Image.memory(s.image, fit: BoxFit.cover, gaplessPlayback: true),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                widget.hideWhenOff
                    ? '${widget.name} · ${s.title.isEmpty ? s.url : s.title}'
                    : (s.title.isEmpty ? s.url : s.title),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: C.dim),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Full-window view: the Agent's browser, operated directly — the mouse moves,
/// drags, double-clicks and scrolls in it, and once you click into the page
/// the keyboard is his too (IME included: composed Chinese goes straight in).
/// Back returns to the workbench exactly as it was.
///
/// Input goes over one WebSocket, one event per message; the picture comes
/// back over the screencast stream. Address bar, back and reload stay as
/// separate requests — they are not typing.
class BrowserPage extends StatefulWidget {
  const BrowserPage({super.key, required this.api, required this.agentId, required this.name});
  final Api api;
  final String agentId;
  final String name;

  @override
  State<BrowserPage> createState() => _BrowserPageState();
}

/// Keys that are not text: sent as key presses. Everything else that types
/// something reaches the hidden text field (so the IME works) and is sent as
/// text. Cmd on a Mac becomes Control in his (Linux) browser.
final _named = <LogicalKeyboardKey, String>{
  LogicalKeyboardKey.enter: 'Enter',
  LogicalKeyboardKey.numpadEnter: 'Enter',
  LogicalKeyboardKey.backspace: 'Backspace',
  LogicalKeyboardKey.delete: 'Delete',
  LogicalKeyboardKey.tab: 'Tab',
  LogicalKeyboardKey.escape: 'Escape',
  LogicalKeyboardKey.arrowLeft: 'ArrowLeft',
  LogicalKeyboardKey.arrowRight: 'ArrowRight',
  LogicalKeyboardKey.arrowUp: 'ArrowUp',
  LogicalKeyboardKey.arrowDown: 'ArrowDown',
  LogicalKeyboardKey.home: 'Home',
  LogicalKeyboardKey.end: 'End',
  LogicalKeyboardKey.pageUp: 'PageUp',
  LogicalKeyboardKey.pageDown: 'PageDown',
  LogicalKeyboardKey.shiftLeft: 'Shift',
  LogicalKeyboardKey.shiftRight: 'Shift',
  LogicalKeyboardKey.controlLeft: 'Control',
  LogicalKeyboardKey.controlRight: 'Control',
  LogicalKeyboardKey.metaLeft: 'Control',
  LogicalKeyboardKey.metaRight: 'Control',
  LogicalKeyboardKey.altLeft: 'Alt',
  LogicalKeyboardKey.altRight: 'Alt',
};

class _BrowserPageState extends State<BrowserPage> with _ShotPoller {
  @override
  Api get api => widget.api;
  @override
  String get agentId => widget.agentId;
  @override
  Duration get every => const Duration(milliseconds: 1200);

  final _address = TextEditingController();
  final _addressFocus = FocusNode();
  final _keys = FocusNode();

  /// IME sink: holds whatever is being typed/composed until it is committed.
  final _ime = TextEditingController();
  bool _busy = false;

  WebSocket? _ws;
  bool _wsFailed = false;
  Offset? _pendingMove;
  Timer? _moveTimer;
  DateTime _lastDown = DateTime(0);
  Offset _lastDownAt = Offset.zero;
  int _clickCount = 1;

  @override
  void initState() {
    super.initState();
    startPolling();
    _ime.addListener(_onIme);
    _keys.addListener(() => setState(() {}));
    _connectInput();
  }

  Future<void> _connectInput() async {
    try {
      final ws = await widget.api.browserInput(widget.agentId);
      if (!mounted) {
        await ws.close();
        return;
      }
      ws.listen(
        (_) {},
        onDone: () {
          if (mounted) setState(() => _ws = null);
        },
        onError: (_) {},
      );
      setState(() {
        _ws = ws;
        _wsFailed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _wsFailed = true);
    }
  }

  @override
  void dispose() {
    _ws?.close();
    _moveTimer?.cancel();
    _imeIdle?.cancel();
    _address.dispose();
    _addressFocus.dispose();
    _keys.dispose();
    _ime.dispose();
    super.dispose();
  }

  @override
  void onShot() {
    // Keep the address bar in step with where the page is — unless you are typing in it.
    final url = shot?.url ?? '';
    if (!_addressFocus.hasFocus && url.isNotEmpty && _address.text != url) _address.text = url;
  }

  void _send(Map<String, Object?> e) {
    final ws = _ws;
    if (ws != null) {
      ws.add(jsonEncode(e));
    } else if (e['t'] == 'down') {
      // No input channel (older server, blocked WebSocket): a click still works.
      _act({'action': 'click_xy', 'x': e['x'], 'y': e['y']});
    }
  }

  Future<void> _act(Map<String, Object?> action) async {
    setState(() {
      _busy = true;
      error = '';
    });
    try {
      await widget.api.browserAct(widget.agentId, action);
      // The browser may have just been started by this: now there is something to stream.
      if (_ws == null) _connectInput();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!streaming) await refresh();
  }

  void _openAddress() {
    final url = _address.text.trim();
    if (url.isEmpty) return;
    _addressFocus.unfocus();
    _act({'action': 'open', 'url': url});
  }

  // ── mouse ──
  Map<String, Object?> _at(Offset p, Size box) => {
    'x': (p.dx / box.width * _viewW).clamp(0, _viewW),
    'y': (p.dy / box.height * _viewH).clamp(0, _viewH),
  };

  String _button(int buttons) => buttons & kSecondaryMouseButton != 0
      ? 'right'
      : buttons & kMiddleMouseButton != 0
      ? 'middle'
      : 'left';

  /// Moves are many; send at most one every 30 ms, always the latest.
  void _move(Offset p, Size box) {
    _pendingMove = p;
    _moveTimer ??= Timer(const Duration(milliseconds: 30), () {
      _moveTimer = null;
      final m = _pendingMove;
      if (m != null) _send({'t': 'move', ..._at(m, box)});
    });
  }

  String _downButton = 'left';

  void _down(PointerDownEvent e, Size box) {
    _keys.requestFocus(); // clicking into the page hands it the keyboard
    final now = DateTime.now();
    final near = (e.localPosition - _lastDownAt).distance < 6;
    _clickCount = now.difference(_lastDown) < const Duration(milliseconds: 400) && near ? _clickCount + 1 : 1;
    _lastDown = now;
    _lastDownAt = e.localPosition;
    _downButton = _button(e.buttons);
    _send({'t': 'down', ..._at(e.localPosition, box), 'button': _downButton, 'count': _clickCount});
  }

  void _up(PointerUpEvent e, Size box) =>
      _send({'t': 'up', ..._at(e.localPosition, box), 'button': _downButton, 'count': _clickCount});

  // ── keyboard ──
  /// What of the sink's text has already been sent.
  String _imeSent = '';
  Timer? _imeIdle;

  /// Sends only what was added since last time. Clearing the field after every
  /// character looked simpler and doubled letters when typing fast: the
  /// platform's input state still held the old text and sent it again.
  /// So the field is emptied only after a pause.
  void _onIme() {
    final v = _ime.value;
    if (v.composing.isValid) return; // still composing: wait for the commit
    final t = v.text;
    if (t.startsWith(_imeSent) && t.length > _imeSent.length) {
      _send({'t': 'text', 'text': t.substring(_imeSent.length)});
    }
    _imeSent = t;
    _imeIdle?.cancel();
    _imeIdle = Timer(const Duration(milliseconds: 800), () {
      if (!mounted || _ime.value.composing.isValid || _ime.text.isEmpty) return;
      _imeSent = '';
      _ime.value = TextEditingValue.empty;
    });
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    // While the IME is composing, its keys (Backspace, Enter to pick a word) are its own.
    if (_ime.value.composing.isValid) return KeyEventResult.ignored;
    final hw = HardwareKeyboard.instance;
    final shortcut = (hw.isControlPressed || hw.isMetaPressed) && !hw.isAltPressed;
    final named = _named[e.logicalKey];
    String? key = named;
    // Cmd/Ctrl + letter or digit: a shortcut in his browser (select all, copy, find…), not text.
    if (key == null && shortcut) {
      final label = e.logicalKey.keyLabel;
      if (label.length == 1) key = label.toLowerCase();
    }
    if (key == null) return KeyEventResult.ignored; // plain typing: let it reach the text field / IME
    if (e is KeyDownEvent || e is KeyRepeatEvent) {
      _send({'t': 'keydown', 'key': key});
    } else if (e is KeyUpEvent) {
      _send({'t': 'keyup', 'key': key});
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final s = shot;
    final typing = _keys.hasFocus;
    return Scaffold(
      appBar: AppBar(
        backgroundColor: C.side,
        titleSpacing: 0,
        title: Row(
          children: [
            Text(tr('br.title', {'name': widget.name}), style: const TextStyle(fontSize: 14.5)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                s?.title ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: C.dim),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: tr('br.back'),
            onPressed: _busy || s == null ? null : () => _act({'action': 'back'}),
            icon: const Icon(Icons.arrow_back_ios_new, size: 16),
          ),
          IconButton(
            tooltip: tr('common.refresh'),
            onPressed: _busy || s == null ? null : () => _act({'action': 'reload'}),
            icon: const Icon(Icons.refresh, size: 18),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _address,
                    focusNode: _addressFocus,
                    onSubmitted: (_) => _openAddress(),
                    style: const TextStyle(fontSize: 13),
                    decoration: InputDecoration(isDense: true, hintText: tr('br.addressHint')),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _busy ? null : _openAddress, child: Text(tr('br.open'))),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Center(
                child: s == null
                    ? Text(tr(loaded ? 'br.notOpenLong' : 'br.connecting'), style: TextStyle(color: C.dim))
                    // Not focusable itself: key events from the hidden text field (which
                    // holds the focus) bubble up here first, before the app's own shortcuts.
                    : Focus(
                        canRequestFocus: false,
                        skipTraversal: true,
                        onKeyEvent: _onKey,
                        child: AspectRatio(
                          aspectRatio: _viewW / _viewH,
                          child: LayoutBuilder(
                            builder: (context, box) => Stack(
                              children: [
                                // The IME sink. It has to be on screen and focused for the
                                // input method to attach; invisible and a pixel wide.
                                Positioned(
                                  left: 0,
                                  top: 0,
                                  width: 1,
                                  height: 1,
                                  child: Opacity(
                                    opacity: 0,
                                    child: TextField(
                                      controller: _ime,
                                      focusNode: _keys,
                                      autocorrect: false,
                                      enableSuggestions: false,
                                    ),
                                  ),
                                ),
                                Positioned.fill(
                                  child: MouseRegion(
                                    cursor: SystemMouseCursors.basic,
                                    onHover: (e) => _move(e.localPosition, box.biggest),
                                    child: Listener(
                                      onPointerDown: (e) => _down(e, box.biggest),
                                      onPointerMove: (e) => _move(e.localPosition, box.biggest),
                                      onPointerUp: (e) => _up(e, box.biggest),
                                      onPointerSignal: (e) {
                                        if (e is PointerScrollEvent) {
                                          _send({
                                            't': 'wheel',
                                            ..._at(e.localPosition, box.biggest),
                                            'dx': e.scrollDelta.dx,
                                            'dy': e.scrollDelta.dy,
                                          });
                                        }
                                      },
                                      child: DecoratedBox(
                                        position: DecorationPosition.foreground,
                                        decoration: BoxDecoration(
                                          border: Border.all(color: typing ? C.accent : C.line, width: typing ? 2 : 1),
                                        ),
                                        child: Image.memory(s.image, fit: BoxFit.fill, gaplessPlayback: true),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    error.isNotEmpty
                        ? error
                        : [
                            tr(
                              _wsFailed
                                  ? 'br.noDirect'
                                  : typing
                                  ? 'br.typing'
                                  : 'br.clickToType',
                            ),
                            tr(streaming ? 'br.live' : 'br.polling'),
                            tr('br.shared', {'name': widget.name}),
                          ].join(' · '),
                    style: TextStyle(fontSize: 11.5, color: error.isNotEmpty ? C.code : C.dim2),
                  ),
                ),
                if (_busy)
                  SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 1.6, color: C.dim),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
