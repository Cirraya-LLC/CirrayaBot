/// The window: conversations on the left, the transcript in the middle,
/// members and shared memory on the right.
///
/// Same three columns as the web UI on purpose. The list mixes groups and
/// one-to-ones and is sorted by recency — people look for "that conversation
/// just now", not for "a group".
library;

import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import 'browser_view.dart';
import 'editors.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';
import '../settings/providers_page.dart';
import '../settings/skills_page.dart';
import 'message_view.dart';

/// Expanded and collapsed widths of the conversation list.
///
/// Everything inside stays laid out at [_wide] and is clipped, so collapsing
/// animates one number and nothing reflows — the labels fade, the avatars do
/// not move. [_rail] is chosen so the 34px avatar (8px list padding + 11px row
/// padding) is already centred in the rail.
const double _wide = 308;
const double _rail = 72;
const double _side2 = 290;

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({
    super.key,
    required this.bench,
    required this.onEditServer,
    required this.collapsed,
    required this.onCollapsed,
  });

  final Workbench bench;
  final VoidCallback onEditServer;

  /// Restored from the settings file; [onCollapsed] writes it back.
  final bool collapsed;
  final ValueChanged<bool> onCollapsed;

  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  final _input = TextEditingController();
  final _inputFocus = FocusNode();
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  final _scroll = ScrollController();
  final _memory = TextEditingController();
  final _selfMemory = TextEditingController();
  final _scaffold = GlobalKey<ScaffoldState>();
  bool _rightOpen = true;
  late bool _railed = widget.collapsed;

  /// Kept across builds so a row's tooltip can be shown on keyboard focus —
  /// Tooltip only opens itself on hover.
  final _tips = <String, GlobalKey<TooltipState>>{};
  GlobalKey<TooltipState> _tipKey(String id) =>
      _tips.putIfAbsent(id, () => GlobalKey<TooltipState>());

  void _setRailed(bool on) {
    setState(() => _railed = on);
    widget.onCollapsed(on);
  }
  String _memoryStatus = '';
  String? _memoryShownFor;
  String _selfMemoryStatus = '';
  String? _selfMemoryShownFor;

  // @ autocomplete: the group members matching what's typed after the @.
  List<Agent> _mentions = const [];
  int _mentionSel = 0;

  Workbench get bench => widget.bench;

  @override
  void initState() {
    super.initState();
    bench.addListener(_onChange);
    _boot();
  }

  Future<void> _boot() async {
    await bench.refresh();
    // Coming back from server settings keeps the conversation that was open.
    final start = bench.current ?? bench.conversations.firstOrNull;
    if (start != null && mounted) await bench.open(start);
  }

  String? _shownId;

  void _onChange() {
    if (!mounted) return;
    // One place decides scrolling, so every way a conversation gets opened —
    // a click, creating something, deleting the open one — lands at the bottom,
    // and a streaming reply is followed. Someone scrolled up to read history
    // is left alone.
    final id = bench.current?.id;
    final atBottom = !_scroll.hasClients || _scroll.position.maxScrollExtent - _scroll.position.pixels < 160;
    if (id != _shownId || atBottom) _toBottom();
    if (id != _shownId) _mentions = const [];
    _shownId = id;
    // Only when a different conversation's memory arrives — never over what
    // someone is typing into the box.
    if (bench.memoryFor != _memoryShownFor) {
      _memoryShownFor = bench.memoryFor;
      _memory.text = bench.memory;
      _memoryStatus = '';
    }
    if (bench.selfMemoryFor != _selfMemoryShownFor) {
      _selfMemoryShownFor = bench.selfMemoryFor;
      _selfMemory.text = bench.selfMemory;
      _selfMemoryStatus = '';
    }
    setState(() {});
  }

  void _toBottom([int tries = 3]) {
    // After the frame, or the extent is still the old one. And again until it
    // stops moving: a lazy list only measures the rows it has built, so the
    // first jump can land short of the newest message.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final max = _scroll.position.maxScrollExtent;
      _scroll.jumpTo(max);
      if (tries > 1) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _scroll.hasClients && _scroll.position.maxScrollExtent != max) _toBottom(tries - 1);
        });
      }
    });
  }

  @override
  void dispose() {
    bench.removeListener(_onChange);
    _input.dispose();
    _inputFocus.dispose();
    _search.dispose();
    _searchFocus.dispose();
    _scroll.dispose();
    _memory.dispose();
    _selfMemory.dispose();
    super.dispose();
  }

  void _updateMentions() {
    final c = bench.current;
    final sel = _input.selection;
    String? q;
    if (c != null && c.isGroup && sel.isValid && sel.isCollapsed) {
      q = RegExp(r'@([^\s@]*)$').firstMatch(_input.text.substring(0, sel.baseOffset))?.group(1)?.toLowerCase();
    }
    final next = q == null
        ? const <Agent>[]
        : [
            for (final id in c!.members)
              if (bench.agentById(id) case final a? when a.name.toLowerCase().contains(q)) a,
          ];
    if (next.isEmpty && _mentions.isEmpty) return;
    setState(() {
      _mentions = next;
      _mentionSel = 0;
    });
  }

  void _pickMention(Agent a) {
    final pos = _input.selection.baseOffset;
    final head = _input.text.substring(0, pos).replaceFirst(RegExp(r'@[^\s@]*$'), '@${a.name} ');
    _input.value = TextEditingValue(
      text: head + _input.text.substring(pos),
      selection: TextSelection.collapsed(offset: head.length),
    );
    setState(() => _mentions = const []);
    _inputFocus.requestFocus();
  }

  static const _jsonType = XTypeGroup(label: 'JSON', extensions: ['json'], mimeTypes: ['application/json']);

  void _say(String s) {
    if (mounted) setState(() => _memoryStatus = s);
  }

  Future<void> _exportChat(Conversation c) async {
    try {
      final text = await bench.api.exportChat(c);
      final day = DateTime.now().toIso8601String().substring(0, 10);
      final loc = await getSaveLocation(suggestedName: '${c.name}-$day.json', acceptedTypeGroups: const [_jsonType]);
      if (loc == null) return; // cancelled
      await File(loc.path).writeAsString(text);
      _say(tr('wb.exported', {'path': loc.path}));
    } on ApiException catch (e) {
      _say(tr('wb.exportFailed', {'msg': e.message}));
    } on FileSystemException catch (e) {
      _say(tr('wb.cantWrite', {'msg': e.osError?.message ?? e.message}));
    }
  }

  Future<void> _importChat(Conversation c) async {
    final file = await openFile(acceptedTypeGroups: const [_jsonType]);
    if (file == null || !mounted) return;
    final replace = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(tr('wb.importInto', {'name': c.name}), style: const TextStyle(fontSize: 15)),
        content: Text(tr('wb.importHow'), style: TextStyle(fontSize: 13, color: C.dim)),
        actions: [
          TextButton(onPressed: () => Navigator.of(d).pop(), child: Text(tr('common.cancel'))),
          TextButton(
            onPressed: () => Navigator.of(d).pop(true),
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('wb.replace')),
          ),
          FilledButton(onPressed: () => Navigator.of(d).pop(false), child: Text(tr('wb.append'))),
        ],
      ),
    );
    if (replace == null) return;
    try {
      final n = await bench.api.importChat(c, await file.readAsString(), replace: replace);
      await bench.reload(id: c.id);
      _say(tr('wb.imported', {'n': n}));
    } on ApiException catch (e) {
      _say(tr('wb.importFailed', {'msg': e.message}));
    } on FileSystemException catch (e) {
      _say(tr('wb.cantRead', {'msg': e.osError?.message ?? e.message}));
    }
  }

  KeyEventResult _onComposerKey(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    if (_mentions.isNotEmpty && !_input.value.composing.isValid) {
      if (k == LogicalKeyboardKey.arrowDown || k == LogicalKeyboardKey.arrowUp) {
        final n = _mentions.length;
        setState(() => _mentionSel = (_mentionSel + (k == LogicalKeyboardKey.arrowDown ? 1 : n - 1)) % n);
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.tab) {
        _pickMention(_mentions[_mentionSel]);
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.escape) {
        setState(() => _mentions = const []);
        return KeyEventResult.handled;
      }
    }
    if (e is! KeyDownEvent || k != LogicalKeyboardKey.enter) return KeyEventResult.ignored;
    if (HardwareKeyboard.instance.isShiftPressed) return KeyEventResult.ignored; // newline
    // A Chinese / Japanese IME uses Enter to commit what is being composed.
    // Treating that Enter as "send" would post half-typed pinyin.
    if (_input.value.composing.isValid) return KeyEventResult.ignored;
    _send();
    return KeyEventResult.handled;
  }

  Future<void> _send() async {
    // The key event can arrive before the last keystroke's text update does.
    // Reading now would send the message minus its last character, and that
    // character's late update would then put the whole text back in the box.
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    final text = _input.text.trim();
    if (text.isEmpty || bench.busy) return;
    _input.clear();
    _toBottom();
    await bench.send(text);
    // The field was disabled while busy, which took focus away. Give it back
    // so the next message can just be typed.
    if (mounted) _inputFocus.requestFocus();
    _toBottom();
  }

  @override
  Widget build(BuildContext context) {
    final narrow = _narrow(context);
    return CallbackShortcuts(
      bindings: {
        // The conventional toggle everywhere else. The Agent's browser is a
        // pushed route, so its own Ctrl+B forwarding is out of this subtree.
        const SingleActivator(LogicalKeyboardKey.keyB, control: true): () => _setRailed(!_railed),
        const SingleActivator(LogicalKeyboardKey.keyB, meta: true): () => _setRailed(!_railed),
      },
      child: Scaffold(
      key: _scaffold,
      // Too narrow for three columns: the right panel slides over instead of
      // disappearing. Hiding it outright left its toggle doing nothing, and a
      // new macOS window starts at 800 wide — so on a Mac it never showed.
      endDrawer: narrow ? Drawer(width: _side2, shape: const RoundedRectangleBorder(), child: _right()) : null,
      body: Row(
        children: [
          _sidebar(),
          Expanded(child: _centre()),
          if (!narrow) _rightPane(),
        ],
      ),
    ),
    );
  }

  /// Zero when the desktop asks for less motion: the end state, no travel.
  Duration _motion(BuildContext context) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 200);

  // ── left ──────────────────────────────────────────────────────────────
  Widget _sidebar() {
    final filter = _search.text.trim().toLowerCase();
    final rows = bench.conversations.where((c) {
      if (filter.isEmpty) return true;
      return '${c.name}${c.tag}${c.preview}'.toLowerCase().contains(filter);
    }).toList();

    final motion = _motion(context);
    return AnimatedContainer(
      key: const ValueKey('sidebar'),
      duration: motion,
      curve: Curves.easeInOutCubic,
      width: _railed ? _rail : _wide,
      decoration: BoxDecoration(
        color: C.side,
        border: Border(right: BorderSide(color: C.line)),
      ),
      // OverflowBox pins the child at _wide whatever the parent has animated
      // down to, so the rows are clipped rather than re-laid-out.
      child: ClipRect(
        child: OverflowBox(
          alignment: Alignment.centerLeft,
          minWidth: _wide,
          maxWidth: _wide,
          child: Column(
        children: [
          SizedBox(
            height: 60,
            // Two layers, each pinned to the width it belongs to, cross-faded.
            // Neither drifts while the aside animates — they only fade.
            child: Stack(
              children: [
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: _wide,
                  child: _fade(!_railed, motion, IgnorePointer(
                    ignoring: _railed,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(14, 14, 8, 10),
                      child: Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _search,
                              focusNode: _searchFocus,
                              onChanged: (_) => setState(() {}),
                              decoration: InputDecoration(hintText: tr('wb.search')),
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          _newMenu(),
                        ],
                      ),
                    ),
                  )),
                ),
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: _rail,
                  child: _fade(_railed, motion, IgnorePointer(
                    ignoring: !_railed,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        // A search box you cannot type in is a dead control, so
                        // the rail's magnifier opens the list and focuses it.
                        Tooltip(
                          message: tr('wb.search'),
                          child: InkWell(
                            onTap: () {
                              _setRailed(false);
                              _searchFocus.requestFocus();
                            },
                            borderRadius: BorderRadius.circular(8),
                            child: SizedBox(
                              width: 32,
                              height: 32,
                              child: Icon(Icons.search, size: 18, color: C.dim),
                            ),
                          ),
                        ),
                        const SizedBox(width: 4),
                        _newMenu(compact: true),
                      ],
                    ),
                  )),
                ),
              ],
            ),
          ),
          Expanded(
            child: bench.loading
                ? Center(
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: C.dim),
                    ),
                  )
                : rows.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(
                        tr('wb.noConversations'),
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12.5, color: C.dim2),
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                    itemCount: rows.length,
                    itemBuilder: (_, i) => _row(rows[i]),
                  ),
          ),
          const Divider(height: 1),
          _foot(),
        ],
      ),
        ),
      ),
    );
  }

  Widget _newMenu({bool compact = false}) => PopupMenuButton<String>(
    tooltip: tr('wb.new'),
    padding: EdgeInsets.zero,
    icon: compact ? null : Icon(Icons.add, size: 20, color: C.dim),
    child: compact
        ? SizedBox(width: 32, height: 32, child: Icon(Icons.add, size: 20, color: C.dim))
        : null,
    onSelected: (v) => v == 'agent' ? showAgentEditor(context, bench) : showGroupEditor(context, bench),
    itemBuilder: (_) => [
      PopupMenuItem(value: 'agent', child: Text(tr('wb.newAgent'), style: const TextStyle(fontSize: 13))),
      PopupMenuItem(value: 'group', child: Text(tr('wb.newGroup'), style: const TextStyle(fontSize: 13))),
    ],
  );

  /// Labels go quickly and come back only once there is room for them.
  Widget _fade(bool show, Duration motion, Widget child) => AnimatedOpacity(
    opacity: show ? 1 : 0,
    duration: motion == Duration.zero ? Duration.zero : const Duration(milliseconds: 130),
    curve: Curves.easeInOut,
    child: child,
  );

  /// The footer is one row of icons. The collapse toggle's centre sits at
  /// half the rail's width, so collapsing moves it nowhere; everything after
  /// it fades out with the labels. Names come from tooltips, collapsed or not.
  Widget _foot() {
    final motion = _motion(context);
    final day = moneyText(bench.usage.day.costMicro ?? 0);
    final month = moneyText(bench.usage.month.costMicro ?? 0);
    return SizedBox(
      height: 50,
      child: Row(
        children: [
          const SizedBox(width: (_rail - 32) / 2),
          _footIcon(
            _railed ? Icons.keyboard_double_arrow_right : Icons.keyboard_double_arrow_left,
            tr(_railed ? 'wb.expandSidebar' : 'wb.collapseSidebar'),
            () => _setRailed(!_railed),
          ),
          Expanded(
            child: _fade(!_railed, motion, IgnorePointer(
              ignoring: _railed,
              child: ExcludeFocus(
                excluding: _railed,
                child: Row(
                  children: [
                    _footIcon(Icons.tune, tr('wb.providers'), () async {
                      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProvidersPage(api: bench.api)));
                    }),
                    _footIcon(Icons.auto_awesome_outlined, tr('wb.skillLibrary'), () => _openSkills()),
                    _footIcon(Icons.dns_outlined, tr('wb.server'), widget.onEditServer),
                    // The app root persists these choices and rebuilds everything.
                    PopupMenuButton<ThemeMode>(
                      tooltip: tr('common.theme'),
                      initialValue: currentTheme.value,
                      onSelected: (m) => currentTheme.value = m,
                      itemBuilder: (_) => [
                        for (final m in ThemeMode.values)
                          PopupMenuItem(
                            value: m,
                            child: Text(tr('theme.${m.name}'), style: const TextStyle(fontSize: 13)),
                          ),
                      ],
                      child: _iconBox(C.isLight ? Icons.light_mode_outlined : Icons.dark_mode_outlined),
                    ),
                    PopupMenuButton<Lang>(
                      tooltip: tr('common.language'),
                      initialValue: currentLang.value,
                      onSelected: (l) => currentLang.value = l,
                      itemBuilder: (_) => [
                        for (final l in Lang.values)
                          PopupMenuItem(
                            value: l,
                            child: Text(l.label, style: const TextStyle(fontSize: 13)),
                          ),
                      ],
                      child: _iconBox(Icons.language),
                    ),
                    // Today's figure in the row; today and the month in its tooltip.
                    // It gives way before the icons do.
                    Expanded(
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: Tooltip(
                          message: tr('wb.spendFooter', {'day': day, 'month': month}),
                          child: Padding(
                            padding: const EdgeInsets.only(right: 12, left: 4),
                            child: Text(
                              day,
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12,
                                color: C.dim,
                                fontFeatures: const [FontFeature.tabularFigures()],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            )),
          ),
        ],
      ),
    );
  }

  Widget _iconBox(IconData icon) => SizedBox(
    width: 32,
    height: 32,
    child: Icon(icon, size: 17, color: C.dim),
  );

  Widget _footIcon(IconData icon, String label, VoidCallback onTap) => Tooltip(
    message: label,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Semantics(label: label, button: true, child: _iconBox(icon)),
    ),
  );

  Widget _row(Conversation c) {
    final on = bench.current?.id == c.id;
    final key = _tipKey(c.id);
    return Tooltip(
      key: key,
      message: _railed ? c.name : '',
      child: InkWell(
      onTap: () async {
        await bench.open(c);
      },
      onFocusChange: (has) {
        if (has && _railed) key.currentState?.ensureTooltipVisible();
      },
      borderRadius: BorderRadius.circular(10),
      child: Container(
        margin: const EdgeInsets.only(top: 2),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        decoration: BoxDecoration(
          color: on && !_railed ? C.selected : null,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              // A ring, not padding: box shadows cost no layout, so nothing
              // shifts when the selection moves.
              decoration: on && _railed
                  ? BoxDecoration(
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(color: C.accent, spreadRadius: 4),
                        BoxShadow(color: C.side, spreadRadius: 2),
                      ],
                    )
                  : null,
              child: c.isGroup
                  ? GroupAvatar(colors: [for (final h in c.colors) C.parse(h)], count: c.members.length)
                  : Avatar(label: c.name, color: C.parse(c.color), size: 34),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _fade(!_railed, _motion(context), Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          c.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: C.ink),
                        ),
                      ),
                      if (c.tag.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Flexible(
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: C.chip,
                              borderRadius: BorderRadius.circular(5),
                            ),
                            child: Text(
                              c.tag,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 10.5, color: C.dim),
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(width: 6),
                      Text(when(c.at), style: TextStyle(fontSize: 10.5, color: C.dim2)),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    c.preview.isEmpty ? tr('wb.nothingSaid') : c.preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: c.preview.isEmpty ? C.dim2 : C.dim),
                  ),
                ],
              )),
            ),
          ],
        ),
      ),
    ),
    );
  }

  // ── centre ────────────────────────────────────────────────────────────
  Widget _centre() {
    final c = bench.current;
    return Column(
      children: [
        Container(
          height: 60,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: C.line)),
          ),
          child: Row(
            children: [
              if (c != null)
                c.isGroup
                    ? GroupAvatar(colors: [for (final h in c.colors) C.parse(h)], count: c.members.length)
                    : Avatar(label: c.name, color: C.parse(c.color), size: 32),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      c?.name ?? tr('wb.pickConversation'),
                      style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                    ),
                    Text(
                      c == null
                          ? tr('wb.pickOnLeft')
                          : c.isGroup
                          ? tr('wb.groupSub', {
                              'members': c.members.map((id) => bench.agentById(id)?.name ?? id).join(tr('wb.listSep')),
                            })
                          : c.tag,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: C.dim),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: tr(_rightOpen ? 'wb.hideRight' : 'wb.showRight'),
                onPressed: () => _narrow(context)
                    ? _scaffold.currentState?.openEndDrawer()
                    : setState(() => _rightOpen = !_rightOpen),
                icon: Icon(
                  _rightOpen && !_narrow(context) ? Icons.chevron_right : Icons.chevron_left,
                  size: 18,
                  color: C.dim,
                ),
              ),
            ],
          ),
        ),
        if (bench.error != null)
          Container(
            width: double.infinity,
            color: C.badBg,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
            child: Text(bench.error!, style: TextStyle(fontSize: 12, color: C.bad)),
          ),
        Expanded(
          child: bench.entries.isEmpty
              ? Center(
                  child: Text(
                    c == null ? '' : tr('wb.sayTo', {'name': c.name}),
                    style: TextStyle(color: C.dim2, fontSize: 13),
                  ),
                )
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(26, 16, 26, 16),
                  itemCount: bench.entries.length,
                  itemBuilder: (_, i) => EntryView(
                    entry: bench.entries[i],
                    names: bench.agentNames,
                    colorOf: (n) => C.parse(bench.agentByName(n)?.color ?? ''),
                    onApprove: bench.answer,
                  ),
                ),
        ),
        _composer(),
      ],
    );
  }

  Widget _mentionList() => Container(
    margin: const EdgeInsets.only(bottom: 6),
    constraints: const BoxConstraints(maxWidth: 340, maxHeight: 240),
    padding: const EdgeInsets.all(5),
    decoration: BoxDecoration(
      color: C.panel,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: C.line),
      boxShadow: [BoxShadow(color: C.shadow, blurRadius: 18, offset: const Offset(0, 6))],
    ),
    child: ListView(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      children: [
        for (final (i, a) in _mentions.indexed)
          InkWell(
            onTap: () => _pickMention(a),
            borderRadius: BorderRadius.circular(8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
              decoration: BoxDecoration(
                color: i == _mentionSel ? C.selected : null,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Avatar(label: a.name, color: C.parse(a.color), size: 22),
                  const SizedBox(width: 9),
                  Text(a.name, style: const TextStyle(fontSize: 13)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      a.description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: C.dim2),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );

  Widget _composer() {
    final ready = bench.current != null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(26, 6, 26, 18),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_mentions.isNotEmpty) _mentionList(),
          // Keyed: without it, inserting the popup above shifts this box to a
          // new index, Flutter rebuilds it, and the TextField loses focus —
          // every key after the @ went nowhere.
          Container(
            key: const ValueKey('composer'),
            padding: const EdgeInsets.fromLTRB(14, 6, 8, 6),
            decoration: BoxDecoration(
              color: C.panel,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: C.line),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  // Enter sends, Shift+Enter is a newline — the IM convention, and
                  // the one the web UI already uses.
                  child: Focus(
                    onKeyEvent: _onComposerKey,
                    child: TextField(
                      controller: _input,
                      focusNode: _inputFocus,
                      onChanged: (_) => _updateMentions(),
                      onTap: () => WidgetsBinding.instance.addPostFrameCallback((_) => _updateMentions()),
                      enabled: ready && !bench.busy,
                      maxLines: 6,
                      minLines: 1,
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        filled: false,
                        hintText: ready
                            ? (bench.busy ? tr('wb.working') : tr('wb.sendTo', {'name': bench.current!.name}))
                            : tr('wb.pickFirst'),
                      ),
                      style: const TextStyle(fontSize: 14, height: 1.5),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                IconButton.filled(
                  onPressed: ready && !bench.busy ? _send : null,
                  icon: bench.busy
                      ? SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2, color: C.onAccent),
                        )
                      : const Icon(Icons.arrow_upward, size: 17),
                  style: IconButton.styleFrom(backgroundColor: C.accent, foregroundColor: C.onAccent),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _openSkills({String? open, List<String> preselect = const []}) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SkillsPage(api: bench.api, agents: bench.agents, open: open, preselect: preselect),
      ),
    );
    await bench.loadSkills();
  }

  /// What this agent has spent, the cap in force, and — when the upstream has
  /// no prices — why neither number can be trusted to hold it back.
  Widget _spendTile(String id, {required bool group}) {
    final u = bench.usage.of(id);
    if (u == null) return const SizedBox.shrink();
    final cap = u.capMicro == null
        ? tr('wb.noCap')
        : tr(u.ownCap ? 'wb.cap' : 'wb.capDefault', {'cap': moneyText(u.capMicro)});
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (group) Text(u.name, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          Text(
            tr('wb.spendLine', {'day': moneyText(u.day.costMicro), 'month': moneyText(u.month.costMicro)}),
            style: TextStyle(fontSize: 12, color: C.dim),
          ),
          Text(
            '${tr('wb.spendTokens', {'n': _tokens(u.month.tokens)})} · $cap',
            style: TextStyle(fontSize: 11.5, color: C.dim2),
          ),
          if (!u.priced)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(tr('wb.unpriced'), style: TextStyle(fontSize: 11, color: C.warn)),
            ),
        ],
      ),
    );
  }

  static String _tokens(int n) => n >= 10000
      ? '${(n / 1000).round()}k'
      : n >= 1000
      ? '${(n / 1000).toStringAsFixed(1)}k'
      : '$n';

  Widget _routineTile(Conversation c, Routine r) {
    final (label, color, bg) = r.running
        ? (tr('wb.running'), C.tintInk, C.tint)
        : r.lastStatus == 'failed'
        ? (tr('wb.lastFailed'), C.bad, C.badBg)
        : r.lastStatus == 'capped'
        ? (tr('wb.lastCapped'), C.warn, C.warnBg)
        : !r.enabled
        ? (tr('wb.paused'), C.dim, C.selected)
        : ('', C.dim, Colors.transparent);
    final sub = [scheduleText(r), nextRunText(r)].where((s) => s.isNotEmpty).join(' · ');
    return InkWell(
      onTap: () => showRoutineEditor(context, bench, c, routine: r),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(
                    r.name,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: r.enabled ? C.ink : C.dim),
                  ),
                ),
                if (label.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Tooltip(
                    message: r.lastStatus == 'failed' || r.lastStatus == 'capped' ? r.lastError : '',
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(5)),
                      child: Text(label, style: TextStyle(fontSize: 10.5, color: color)),
                    ),
                  ),
                ],
              ],
            ),
            Text(
              sub,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: C.dim2),
            ),
          ],
        ),
      ),
    );
  }

  // ── right ─────────────────────────────────────────────────────────────
  /// The panel closing is the same move as the sidebar collapsing: animate the
  /// width, pin the contents at [_side2] and clip them, so nothing inside
  /// re-lays-out on the way out. ExcludeFocus because a 0px panel must not
  /// still be reachable by Tab.
  Widget _rightPane() => AnimatedContainer(
    key: const ValueKey('rightpane'),
    duration: _motion(context),
    curve: Curves.easeInOutCubic,
    width: _rightOpen ? _side2 : 0,
    child: ClipRect(
      child: OverflowBox(
        alignment: Alignment.centerLeft,
        minWidth: _side2,
        maxWidth: _side2,
        child: ExcludeFocus(excluding: !_rightOpen, child: _right()),
      ),
    ),
  );

  Widget _right() {
    final c = bench.current;
    final ids = c == null ? <String>[] : (c.isGroup ? c.members : [c.id]);
    return Container(
      width: _side2,
      decoration: BoxDecoration(
        color: C.side,
        border: Border(left: BorderSide(color: C.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 8, 4),
            child: Row(
              children: [
                Expanded(child: _heading(tr('wb.members'))),
                if (c != null)
                  TextButton.icon(
                    onPressed: () {
                      final agent = bench.agentById(c.id);
                      if (c.isGroup) {
                        showGroupEditor(context, bench, group: c);
                      } else if (agent != null) {
                        showAgentEditor(context, bench, agent: agent);
                      }
                    },
                    icon: const Icon(Icons.edit_outlined, size: 14),
                    label: Text(tr(c.isGroup ? 'wb.editGroup' : 'wb.editAgent'), style: const TextStyle(fontSize: 12)),
                  ),
              ],
            ),
          ),
          // Scrolls: a big group at the minimum window height would otherwise
          // push the memory box off the bottom (RenderFlex overflow).
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                for (final id in ids)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                    child: Row(
                      children: [
                        Avatar(
                          label: bench.agentById(id)?.name ?? '?',
                          color: C.parse(bench.agentById(id)?.color ?? ''),
                        ),
                        const SizedBox(width: 10),
                        Expanded(child: Text(bench.agentById(id)?.name ?? id, style: const TextStyle(fontSize: 13))),
                        if (c != null && c.isGroup && c.lead == id)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: C.tint,
                              borderRadius: BorderRadius.circular(5),
                            ),
                            child: Text(
                              tr('wb.lead'),
                              style: TextStyle(fontSize: 10.5, color: C.tintInk),
                            ),
                          ),
                      ],
                    ),
                  ),
                if (c != null) ...[
                  const Divider(height: 22),
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 4), child: _heading(tr('wb.spend'))),
                  for (final id in ids) _spendTile(id, group: c.isGroup),
                  const Divider(height: 22),
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 4), child: _heading(tr('wb.browser'))),
                  // Keyed by agent: switching conversations must not show the
                  // previous Agent's page for a moment.
                  for (final id in ids)
                    BrowserThumb(
                      key: ValueKey('browser-$id'),
                      api: bench.api,
                      agentId: id,
                      name: bench.agentById(id)?.name ?? id,
                      hideWhenOff: c.isGroup,
                    ),
                ],
                if (c != null && !c.isGroup) ...[
                  const Divider(height: 22),
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 4), child: _heading(tr('wb.skills'))),
                  for (final k in bench.skills)
                    InkWell(
                      onTap: () => _openSkills(open: k.id),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              k.savedBy != null ? tr('wb.savedBySelf', {'name': k.name}) : k.name,
                              style: const TextStyle(fontSize: 13),
                            ),
                            Text(
                              k.description,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 11.5, color: C.dim2),
                            ),
                          ],
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(8, 2, 8, 0),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () => _openSkills(preselect: [c.id]),
                        icon: const Icon(Icons.add, size: 15),
                        label: Text(tr('wb.addSkill'), style: const TextStyle(fontSize: 12)),
                      ),
                    ),
                  ),
                ],
                if (c != null) ...[
                  const Divider(height: 22),
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 4), child: _heading(tr('wb.routines'))),
                  for (final r in bench.routines) _routineTile(c, r),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(8, 2, 8, 8),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () => showRoutineEditor(context, bench, c),
                        icon: const Icon(Icons.add, size: 15),
                        label: Text(tr('wb.newRoutine'), style: const TextStyle(fontSize: 12)),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  c == null ? tr('wb.memory') : tr(c.isGroup ? 'wb.groupMemory' : 'wb.agentMemory', {'name': c.name}),
                  style: TextStyle(fontSize: 11, color: C.dim),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _memory,
                  onChanged: (_) {
                    if (_memoryStatus.isNotEmpty) setState(() => _memoryStatus = '');
                  },
                  enabled: c != null,
                  maxLines: 7,
                  minLines: 7,
                  decoration: InputDecoration(
                    hintText: tr(c?.isGroup == true ? 'wb.groupMemoryHint' : 'wb.agentMemoryHint'),
                  ),
                  style: const TextStyle(fontSize: 12, height: 1.5),
                ),
                const SizedBox(height: 8),
                // These buttons are filled, so they need real gaps — packed into
                // two Rows they sat flush and read as one bar.
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    TextButton(
                      onPressed: () async {
                        String status;
                        try {
                          await bench.saveMemory(_memory.text);
                          status = tr('wb.saved');
                        } on ApiException catch (e) {
                          status = tr('wb.notSaved', {'msg': e.message});
                        }
                        if (!mounted) return;
                        setState(() => _memoryStatus = status);
                      },
                      child: Text(tr('common.save')),
                    ),
                    TextButton.icon(
                      onPressed: c == null ? null : () => _exportChat(c),
                      icon: const Icon(Icons.download_outlined, size: 15),
                      label: Text(tr('wb.exportChat'), style: const TextStyle(fontSize: 12)),
                    ),
                    TextButton.icon(
                      onPressed: c == null || bench.busy ? null : () => _importChat(c),
                      icon: const Icon(Icons.upload_outlined, size: 15),
                      label: Text(tr('common.import'), style: const TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
                if (_memoryStatus.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    _memoryStatus,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: C.dim),
                  ),
                ],
                // The Agent's own notes: a second, separate store he writes with
                // the remember tool. Not for groups — only a person writes a
                // group's memory.
                if (c != null && !c.isGroup) ...[
                  const SizedBox(height: 14),
                  const Divider(height: 1),
                  const SizedBox(height: 10),
                  Text(
                    tr('wb.selfMemory', {'name': c.name}),
                    style: TextStyle(fontSize: 11, color: C.dim),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    tr('wb.selfMemoryNote'),
                    style: TextStyle(fontSize: 10.5, color: C.dim2, height: 1.5),
                  ),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _selfMemory,
                    onChanged: (_) {
                      if (_selfMemoryStatus.isNotEmpty) setState(() => _selfMemoryStatus = '');
                    },
                    maxLines: 4,
                    minLines: 4,
                    decoration: InputDecoration(hintText: tr('wb.selfMemoryHint')),
                    style: const TextStyle(fontSize: 12, height: 1.5),
                  ),
                  const SizedBox(height: 4),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: () async {
                        String status;
                        try {
                          await bench.saveSelfMemory(_selfMemory.text);
                          status = tr('wb.saved');
                        } on ApiException catch (e) {
                          status = tr('wb.notSaved', {'msg': e.message});
                        }
                        if (!mounted) return;
                        setState(() => _selfMemoryStatus = status);
                      },
                      child: Text(tr('common.save')),
                    ),
                  ),
                  if (_selfMemoryStatus.isNotEmpty)
                    Text(
                      _selfMemoryStatus,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: C.dim),
                    ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Widget _heading(String text) => Text(text, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600));

bool _narrow(BuildContext context) => MediaQuery.sizeOf(context).width < 1180;

String _two(int n) => n.toString().padLeft(2, '0');

/// IM-style timestamps: a time today, a weekday this week, a date before that.
String when(int ms) {
  if (ms == 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  if (d.year == now.year && d.month == now.month && d.day == now.day) {
    return '${_two(d.hour)}:${_two(d.minute)}';
  }
  final days = now.difference(d).inDays;
  if (days < 7) {
    return tr('wb.wd${d.weekday % 7}');
  }
  return '${d.month}/${d.day}';
}
