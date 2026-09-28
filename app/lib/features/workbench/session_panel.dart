/// The sessions of the open conversation, and search across all of them.
///
/// One panel for both on purpose: a search result is always "a message in some
/// session", so the list of sessions and the list of hits are two views of the
/// same thing — and opening either one means switching the session on screen.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';
import 'workbench_page.dart' show when;

/// Opens the panel under [anchor]. [focusSearch] puts the cursor in the search box.
Future<void> showSessionPanel(BuildContext context, Workbench bench, Rect anchor, {bool focusSearch = false}) {
  final screen = MediaQuery.sizeOf(context);
  const width = 380.0;
  final left = (anchor.right - width).clamp(8.0, screen.width - width - 8);
  return showDialog<void>(
    context: context,
    barrierColor: Colors.transparent,
    builder: (_) => Stack(
      children: [
        Positioned(
          top: anchor.bottom + 6,
          left: left,
          width: width,
          child: SessionPanel(bench: bench, focusSearch: focusSearch),
        ),
      ],
    ),
  );
}

class SessionPanel extends StatefulWidget {
  const SessionPanel({super.key, required this.bench, this.focusSearch = false});

  final Workbench bench;
  final bool focusSearch;

  @override
  State<SessionPanel> createState() => _SessionPanelState();
}

class _SessionPanelState extends State<SessionPanel> {
  final _q = TextEditingController();
  Timer? _debounce;
  int _asked = 0;
  List<SearchHit>? _hits; // null = not searching: show the sessions
  String? _renaming;
  final _rename = TextEditingController();

  Workbench get bench => widget.bench;

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    _rename.dispose();
    super.dispose();
  }

  void _onQuery(String v) {
    _debounce?.cancel();
    if (v.trim().isEmpty) {
      _asked++;
      setState(() => _hits = null);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 180), () async {
      final mine = ++_asked;
      try {
        final hits = await bench.search(v);
        if (mounted && mine == _asked) setState(() => _hits = hits);
      } on ApiException catch (_) {
        if (mounted && mine == _asked) setState(() => _hits = const []);
      }
    });
  }

  void _open(String? id, {int? jumpTo}) {
    Navigator.of(context).pop();
    if (id != bench.session || jumpTo != null) unawaited(bench.openSession(id, jumpTo: jumpTo));
  }

  Future<void> _finishRename(Session x, bool save) async {
    final title = _rename.text.trim();
    setState(() => _renaming = null);
    if (!save || title == (x.named ? x.title : '')) return;
    try {
      await bench.renameSession(x, title);
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  Future<void> _delete(Session x) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        content: Text(tr('ses.confirmDelete', {'name': _title(x), 'n': x.count}), style: const TextStyle(fontSize: 13.5)),
        actions: [
          TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.of(d).pop(true),
            style: FilledButton.styleFrom(backgroundColor: C.bad, foregroundColor: C.onAccent),
            child: Text(tr('common.delete')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await bench.deleteSession(x);
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  void _toast(String msg) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(msg)));

  static String _title(Session? x) => (x?.title ?? '').isEmpty ? tr('ses.untitled') : x!.title;

  @override
  Widget build(BuildContext context) {
    final maxH = (MediaQuery.sizeOf(context).height * .7).clamp(200.0, 560.0);
    return Material(
      color: C.panel,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: C.line)),
      clipBehavior: Clip.antiAlias,
      child: Container(
        constraints: BoxConstraints(maxHeight: maxH),
        decoration: BoxDecoration(boxShadow: [BoxShadow(color: C.shadow, blurRadius: 28, offset: const Offset(0, 10))]),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(10),
              child: TextField(
                controller: _q,
                autofocus: widget.focusSearch,
                onChanged: _onQuery,
                style: const TextStyle(fontSize: 13),
                decoration: InputDecoration(
                  hintText: tr('ses.search'),
                  prefixIcon: Icon(Icons.search, size: 17, color: C.dim),
                  isDense: true,
                ),
              ),
            ),
            Divider(height: 1, color: C.line),
            Flexible(
              child: AnimatedBuilder(
                animation: bench,
                builder: (_, _) => ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.all(6),
                  children: _hits == null ? _sessionRows() : _hitRows(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _head(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: C.dim2),
    ),
  );

  List<Widget> _sessionRows() => [
    _head(tr('ses.list')),
    _row(
      on: bench.session == null,
      onTap: () => _open(null),
      child: Text('＋ ${tr('ses.new')}', style: TextStyle(fontSize: 13, color: C.accent)),
    ),
    for (final x in bench.sessions)
      _row(
        key: ValueKey(x.id),
        on: x.id == bench.session,
        onTap: _renaming == x.id ? null : () => _open(x.id),
        child: Row(
          children: [
            Expanded(
              child: _renaming == x.id
                  ? Focus(
                      onKeyEvent: (_, e) => KeyEventResult.ignored,
                      child: TextField(
                        controller: _rename,
                        autofocus: true,
                        maxLength: 80,
                        style: const TextStyle(fontSize: 13),
                        decoration: InputDecoration(isDense: true, counterText: '', hintText: _title(x)),
                        onSubmitted: (_) => _finishRename(x, true),
                        onTapOutside: (_) => _finishRename(x, true),
                      ),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_title(x), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                        Text(
                          tr('ses.count', {'n': x.count, 'when': when(x.updatedAt)}),
                          style: TextStyle(fontSize: 11.5, color: C.dim2),
                        ),
                      ],
                    ),
            ),
            if (_renaming != x.id) ...[
              _icon(Icons.edit_outlined, tr('ses.rename'), () {
                _rename.text = x.named ? x.title : '';
                setState(() => _renaming = x.id);
              }),
              _icon(Icons.delete_outline, tr('common.delete'), () => _delete(x), danger: true),
            ],
          ],
        ),
      ),
  ];

  List<Widget> _hitRows() {
    final hits = _hits!;
    if (hits.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.all(14),
          child: Text(
            tr('ses.noHits', {'q': _q.text.trim()}),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: C.dim2),
          ),
        ),
      ];
    }
    final out = <Widget>[];
    String? last;
    final q = _q.text.trim();
    for (final h in hits) {
      if (h.session != last) {
        last = h.session;
        out.add(_head(_title(bench.sessions.where((x) => x.id == h.session).firstOrNull)));
      }
      final who = h.mine ? tr('wb.you') : (h.speaker.isEmpty ? (bench.current?.name ?? '') : h.speaker);
      out.add(
        _row(
          on: false,
          onTap: () => _open(h.session, jumpTo: h.id),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$who · ${when(h.at)}', style: TextStyle(fontSize: 11, color: C.dim2)),
              const SizedBox(height: 1),
              Text.rich(_marked(h.snippet, q), style: const TextStyle(fontSize: 12.5, height: 1.45)),
            ],
          ),
        ),
      );
    }
    return out;
  }

  /// The query highlighted wherever it occurs, case-insensitively — what made this a hit.
  TextSpan _marked(String s, String q) {
    final spans = <TextSpan>[];
    final lo = s.toLowerCase(), k = q.toLowerCase();
    var i = 0;
    while (k.isNotEmpty) {
      final j = lo.indexOf(k, i);
      if (j < 0) break;
      spans.add(TextSpan(text: s.substring(i, j)));
      spans.add(
        TextSpan(
          text: s.substring(j, j + k.length),
          style: TextStyle(backgroundColor: C.warnBg, color: C.ink),
        ),
      );
      i = j + k.length;
    }
    spans.add(TextSpan(text: s.substring(i)));
    return TextSpan(children: spans);
  }

  Widget _row({Key? key, required bool on, required VoidCallback? onTap, required Widget child}) => Padding(
    key: key,
    padding: const EdgeInsets.only(bottom: 1),
    child: Material(
      color: on ? C.selected : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 40),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
            child: Align(alignment: Alignment.centerLeft, child: child),
          ),
        ),
      ),
    ),
  );

  Widget _icon(IconData icon, String label, VoidCallback onTap, {bool danger = false}) => Tooltip(
    message: label,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: 28,
        height: 28,
        child: Icon(icon, size: 16, color: danger ? C.bad : C.dim),
      ),
    ),
  );
}
