/// The skill library: write, install, import and export skills.
///
/// Same things the web page's skill library dialog does, over the same endpoints.
/// A skill an Agent saved himself is marked as his — it changes how he works
/// from then on, so a person has to be able to see who wrote it.
library;

import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../platform.dart';
import '../../theme/app_theme.dart';

class SkillsPage extends StatefulWidget {
  const SkillsPage({super.key, required this.api, required this.agents, this.open, this.preselect = const [], this.draft});
  final Api api;
  final List<Agent> agents;

  /// Skill to open for editing.
  final String? open;

  /// Agents ticked when starting a new skill (the one whose panel we came from).
  final List<String> preselect;

  /// A skill drafted from a demonstration, to read through and save (not saved yet).
  final SkillDraft? draft;

  @override
  State<SkillsPage> createState() => _SkillsPageState();
}

class _SkillsPageState extends State<SkillsPage> {
  List<Skill> _rows = const [];
  Skill? _editing;
  bool _loading = true, _busy = false;
  final _name = TextEditingController();
  final _desc = TextEditingController();
  final _body = TextEditingController();
  final Set<String> _agents = {};
  String _hint = '';
  Color _hintColor = C.dim;
  List<SkillSuggestion> _suggestions = const [];
  late String? _reviewFor = widget.preselect.firstOrNull ?? widget.agents.firstOrNull?.id;
  bool _weekly = false, _reviewing = false;
  String _reviewNote = '';

  static const _mdType = XTypeGroup(label: 'Markdown', extensions: ['md', 'markdown', 'txt']);

  @override
  void initState() {
    super.initState();
    _load(select: widget.open);
  }

  @override
  void dispose() {
    for (final c in [_name, _desc, _body]) {
      c.dispose();
    }
    _scroll.dispose();
    super.dispose();
  }

  String _agentName(String id) => widget.agents.where((a) => a.id == id).firstOrNull?.name ?? id;

  /// The shipped skill templates, for "from a template".
  List<SkillTemplate> _templates = const [];
  bool _draftShown = false;
  final _scroll = ScrollController();
  final _editorKey = GlobalKey();

  Future<void> _load({String? select}) async {
    widget.api.templates().then((t) {
      if (mounted) setState(() => _templates = t.skills);
    }, onError: (_) {});
    widget.api.skillSuggestions().then((x) {
      if (mounted) setState(() => _suggestions = x);
    }, onError: (_) {});
    widget.api.skillReviewWeekly().then((on) {
      if (mounted) setState(() => _weekly = on);
    }, onError: (_) {});
    try {
      _rows = await widget.api.skills();
      final hit = select == null ? null : _rows.where((k) => k.id == select).firstOrNull;
      if (select != null || _editing == null) _fill(hit);
    } on ApiException catch (e) {
      _say(e.message, bad: true);
    }
    // A drafted skill goes in once, as a new one; saving it reloads with its id and leaves this alone.
    final d = widget.draft;
    if (d != null && select == null && !_draftShown) {
      _draftShown = true;
      _name.text = d.name;
      _desc.text = d.description;
      _body.text = d.body;
      _hint = tr('teach.drafted');
      _hintColor = C.dim;
      // The editor sits below the list: bring it into view, or a phone shows only the list.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final c = _editorKey.currentContext;
        if (c != null && c.mounted) Scrollable.ensureVisible(c);
      });
    }
    if (mounted) setState(() => _loading = false);
  }

  void _fill(Skill? k) {
    _editing = k;
    _name.text = k?.name ?? '';
    _desc.text = k?.description ?? '';
    _body.text = k?.body ?? '';
    _agents
      ..clear()
      ..addAll(k?.agents ?? widget.preselect);
    _hint = [
      if (k?.savedBy != null) tr('skills.savedByHint', {'name': _agentName(k!.savedBy!)}),
      if (k?.archived ?? false) tr('skills.archivedNote'),
    ].join(' ');
    _hintColor = C.dim;
    if (mounted) setState(() {});
  }

  void _say(String text, {bool bad = false, bool good = false}) {
    if (!mounted) return;
    setState(() {
      _hint = text;
      _hintColor = bad ? C.code : (good ? C.ok : C.dim);
    });
  }

  Future<void> _act(String doing, Future<void> Function() job) async {
    if (_busy) return;
    setState(() => _busy = true);
    _say(doing);
    try {
      await job();
    } on ApiException catch (e) {
      _say(e.message, bad: true);
    } on FileSystemException catch (e) {
      _say(tr('skills.fileError', {'detail': e.osError?.message ?? e.message}), bad: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() => _act(tr('skills.saving'), () async {
    final saved = await widget.api.saveSkill({
      'name': _name.text.trim(),
      'description': _desc.text.trim(),
      'body': _body.text,
      'agents': _agents.toList(),
    }, id: _editing?.id);
    await _load(select: saved.id);
    _say(tr('skills.saved'), good: true);
  });

  Future<void> _delete() async {
    final k = _editing!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(tr('skills.deleteTitle', {'name': k.name}), style: const TextStyle(fontSize: 15)),
        content: Text(tr('skills.deleteBody'), style: TextStyle(fontSize: 13, color: C.dim)),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.of(c).pop(true),
            style: FilledButton.styleFrom(backgroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _act(tr('skills.deleting'), () async {
      await widget.api.deleteSkill(k.id);
      _fill(null);
      await _load();
      _say(tr('skills.deleted', {'name': k.name}), good: true);
    });
  }

  Future<void> _review() async {
    final agent = _reviewFor;
    if (agent == null || _reviewing) return;
    setState(() {
      _reviewing = true;
      _reviewNote = tr('skills.reviewing', {'name': _agentName(agent)});
    });
    try {
      final r = await widget.api.reviewSkills(agent);
      _suggestions = r.suggestions;
      _reviewNote = (r.added > 0 ? tr('skills.reviewed', {'n': '${r.added}'}) : tr('skills.reviewedNone')) +
          (r.problem.isNotEmpty ? ' ${tr('skills.reviewProblem', {'why': r.problem})}' : '');
    } on ApiException catch (e) {
      _reviewNote = e.message;
    } finally {
      if (mounted) setState(() => _reviewing = false);
    }
  }

  Future<void> _answer(SkillSuggestion x, String action) => _act('', () async {
    final r = await widget.api.answerSuggestion(x.id, action);
    _suggestions = r.suggestions;
    _rows = r.skills;
    final keep = _editing == null ? null : _rows.where((k) => k.id == _editing!.id).firstOrNull;
    _fill(keep);
  });

  Future<void> _archive() => _act('', () async {
    final k = _editing!;
    await widget.api.archiveSkill(k.id, !k.archived);
    await _load(select: k.id);
  });

  Future<void> _export() => _act(tr('skills.exporting'), () async {
    final k = _editing!;
    final text = await widget.api.exportSkill(k.id);
    if (!AppPlatform.canSaveAs) {
      await AppPlatform.shareText('${k.name}.SKILL.md', text, 'text/markdown');
      return _say('');
    }
    final loc = await getSaveLocation(suggestedName: '${k.name}.SKILL.md', acceptedTypeGroups: const [_mdType]);
    if (loc == null) return _say('');
    await File(loc.path).writeAsString(text);
    _say(tr('skills.exported', {'path': loc.path}), good: true);
  });

  Future<void> _import() => _act(tr('skills.importing'), () async {
    final f = await openFile(acceptedTypeGroups: const [_mdType]);
    if (f == null) return _say('');
    // No name in the file: use the file name without .md / .SKILL.md
    final fallback = f.name.replaceAll(RegExp(r'(\.SKILL)?\.(md|markdown|txt)$', caseSensitive: false), '');
    final k = await widget.api.importSkill(await f.readAsString(), fallbackName: fallback, agents: _agents.toList());
    await _load(select: k.id);
    _say(tr('skills.imported', {'name': k.name}), good: true);
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: C.side,
        title: Text(tr('skills.title'), style: const TextStyle(fontSize: 15)),
        actions: [
          PopupMenuButton<SkillTemplate>(
            key: const ValueKey('skill-templates'),
            tooltip: tr('tpl.skillFrom'),
            icon: const Icon(Icons.library_add_outlined, size: 20),
            onSelected: (k) {
              _fill(null);
              _name.text = k.name;
              _desc.text = k.description;
              _body.text = k.body;
              setState(() {});
            },
            itemBuilder: (_) => [
              for (final k in _templates) PopupMenuItem(value: k, child: Text(k.name, style: const TextStyle(fontSize: 13))),
            ],
          ),
        ],
      ),
      body: _loading
          ? Center(child: CircularProgressIndicator(strokeWidth: 2, color: C.dim))
          : Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 680),
                // Not a lazy list: a draft from a demonstration scrolls to the editor below, which has to exist to be found.
                child: SingleChildScrollView(
                  controller: _scroll,
                  padding: const EdgeInsets.all(22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        tr('skills.intro'),
                        style: TextStyle(fontSize: 12, color: C.dim, height: 1.6),
                      ),
                      const SizedBox(height: 10),
                      _reviewRow(),
                      if (_reviewNote.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(_reviewNote, key: const ValueKey('skills-review-note'), style: TextStyle(fontSize: 11.5, color: C.dim)),
                        ),
                      for (final x in _suggestions) _suggestion(x),
                      const SizedBox(height: 12),
                      if (_rows.isEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Text(tr('skills.none'), style: TextStyle(fontSize: 12.5, color: C.dim2)),
                        ),
                      for (final k in _rows.where((k) => !k.archived)) _row(k),
                      if (_rows.any((k) => k.archived)) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                          child: Text(tr('skills.archived'), style: TextStyle(fontSize: 11.5, color: C.dim2)),
                        ),
                        for (final k in _rows.where((k) => k.archived)) Opacity(opacity: 0.6, child: _row(k)),
                      ],
                      const SizedBox(height: 16),
                      const Divider(height: 1),
                      const SizedBox(height: 16),
                      Text(
                        key: _editorKey,
                        _editing == null ? tr('skills.newTitle') : tr('skills.editTitle', {'name': _editing!.name}),
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 12),
                      TextField(controller: _name, decoration: InputDecoration(hintText: tr('skills.nameHint'))),
                      const SizedBox(height: 9),
                      TextField(
                        controller: _desc,
                        decoration: InputDecoration(hintText: tr('skills.descHint')),
                      ),
                      const SizedBox(height: 9),
                      TextField(
                        controller: _body,
                        minLines: 8,
                        maxLines: 20,
                        style: TextStyle(fontFamily: AppTheme.mono, fontFamilyFallback: AppTheme.monoFallback, fontSize: 12.5),
                        decoration: InputDecoration(hintText: tr('skills.bodyHint')),
                      ),
                      const SizedBox(height: 12),
                      Text(tr('skills.installOn'), style: TextStyle(fontSize: 12, color: C.dim)),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final a in widget.agents)
                            FilterChip(
                              label: Text(a.name, style: const TextStyle(fontSize: 12)),
                              selected: _agents.contains(a.id),
                              showCheckmark: false,
                              onSelected: (on) => setState(() => on ? _agents.add(a.id) : _agents.remove(a.id)),
                            ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Text(_hint, style: TextStyle(fontSize: 11.5, color: _hintColor)),
                      const SizedBox(height: 14),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        alignment: WrapAlignment.end,
                        children: [
                          if (_editing != null) ...[
                            TextButton(
                              onPressed: _busy ? null : _delete,
                              style: TextButton.styleFrom(foregroundColor: C.code),
                              child: Text(tr('common.delete')),
                            ),
                            TextButton(
                              key: const ValueKey('skill-archive'),
                              onPressed: _busy ? null : _archive,
                              child: Text(tr(_editing!.archived ? 'skills.restore' : 'skills.archive')),
                            ),
                            TextButton(onPressed: _busy ? null : _export, child: Text(tr('common.export'))),
                          ],
                          TextButton(onPressed: _busy ? null : _import, child: Text(tr('skills.importMd'))),
                          TextButton(onPressed: () => _fill(null), child: Text(tr('skills.new'))),
                          FilledButton(onPressed: _busy ? null : _save, child: Text(tr('common.save'))),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }

  Widget _row(Skill k) {
    final on = _editing?.id == k.id;
    final who = k.agents.isEmpty ? tr('skills.nobody') : k.agents.map(_agentName).join(tr('skills.listSep'));
    return InkWell(
      onTap: () => _fill(k),
      borderRadius: BorderRadius.circular(9),
      child: Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: on ? C.tint : null,
          border: Border.all(color: on ? C.accent : Colors.transparent),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: k.name, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                  if (k.savedBy != null)
                    TextSpan(
                      text: tr('skills.savedBy', {'name': _agentName(k.savedBy!)}),
                      style: TextStyle(fontSize: 11, color: C.dim),
                    ),
                ],
              ),
            ),
            Text(
              '${k.description} · $who · ${k.uses > 0 ? tr('skills.used', {'n': '${k.uses}', 'when': _ago(k.usedAt)}) : tr('skills.never')}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: C.dim),
            ),
          ],
        ),
      ),
    );
  }

  static String _ago(DateTime? t) {
    if (t == null) return '';
    final d = DateTime.now().difference(t);
    return d.inDays >= 1 ? tr('skills.daysAgo', {'n': '${d.inDays}'}) : d.inHours >= 1 ? tr('skills.hoursAgo', {'n': '${d.inHours}'}) : tr('skills.justNow');
  }

  Widget _reviewRow() => Wrap(
    spacing: 8,
    runSpacing: 6,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      DropdownButton<String>(
        key: const ValueKey('skills-review-agent'),
        value: widget.agents.any((a) => a.id == _reviewFor) ? _reviewFor : null,
        hint: Text(tr('skills.reviewFor'), style: const TextStyle(fontSize: 12.5)),
        isDense: true,
        style: TextStyle(fontSize: 12.5, color: C.ink),
        items: [for (final a in widget.agents) DropdownMenuItem(value: a.id, child: Text(a.name))],
        onChanged: (v) => setState(() => _reviewFor = v),
      ),
      OutlinedButton(
        key: const ValueKey('skills-review'),
        onPressed: _reviewing || _reviewFor == null ? null : _review,
        child: Text(tr('skills.review'), style: const TextStyle(fontSize: 12.5)),
      ),
      Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Checkbox(
            key: const ValueKey('skills-weekly'),
            value: _weekly,
            onChanged: (v) async {
              setState(() => _weekly = v ?? false);
              try {
                await widget.api.setSkillReviewWeekly(_weekly);
              } on ApiException catch (e) {
                _say(e.message, bad: true);
              }
            },
          ),
          Text(tr('skills.weekly'), style: TextStyle(fontSize: 12.5, color: C.dim)),
        ],
      ),
    ],
  );

  Widget _suggestion(SkillSuggestion x) {
    final small = TextStyle(fontSize: 11.5, color: C.dim2);
    final title = x.kind == 'merge' ? tr('skills.sug.merge', {'n': '${x.skills.length}'}) : tr('skills.sug.${x.kind}');
    return Container(
      key: ValueKey('suggestion-${x.id}'),
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
      decoration: BoxDecoration(border: Border.all(color: C.line), borderRadius: BorderRadius.circular(10)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text.rich(TextSpan(children: [
            TextSpan(text: title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            TextSpan(text: '  ${x.agentName}', style: TextStyle(fontSize: 11.5, color: C.dim)),
          ])),
          Text(x.skills.map((n) => '"$n"').join(tr('skills.listSep')), style: small),
          if (x.why.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(x.why, style: TextStyle(fontSize: 12.5, color: C.dim))),
          if (x.kind == 'describe' && x.draftDescription.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text('"${x.draftDescription}"', style: const TextStyle(fontSize: 12.5))),
          if (x.kind == 'merge')
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              dense: true,
              title: Text('${x.draftName} — ${x.draftDescription}', style: TextStyle(fontSize: 12.5, color: C.dim)),
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: SelectableText(x.draftBody,
                      style: TextStyle(fontFamily: AppTheme.mono, fontFamilyFallback: AppTheme.monoFallback, fontSize: 12)),
                ),
              ],
            ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            children: [
              FilledButton(onPressed: _busy ? null : () => _answer(x, 'apply'), child: Text(tr('skills.apply'))),
              TextButton(onPressed: _busy ? null : () => _answer(x, 'dismiss'), child: Text(tr('skills.dismiss'))),
            ],
          ),
        ],
      ),
    );
  }
}
