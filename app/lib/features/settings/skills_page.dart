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
import '../../theme/app_theme.dart';

class SkillsPage extends StatefulWidget {
  const SkillsPage({super.key, required this.api, required this.agents, this.open, this.preselect = const []});
  final Api api;
  final List<Agent> agents;

  /// Skill to open for editing.
  final String? open;

  /// Agents ticked when starting a new skill (the one whose panel we came from).
  final List<String> preselect;

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
    super.dispose();
  }

  String _agentName(String id) => widget.agents.where((a) => a.id == id).firstOrNull?.name ?? id;

  Future<void> _load({String? select}) async {
    try {
      _rows = await widget.api.skills();
      final hit = select == null ? null : _rows.where((k) => k.id == select).firstOrNull;
      if (select != null || _editing == null) _fill(hit);
    } on ApiException catch (e) {
      _say(e.message, bad: true);
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
    _hint = k?.savedBy != null ? tr('skills.savedByHint', {'name': _agentName(k!.savedBy!)}) : '';
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
        content: Text(tr('skills.deleteBody'), style: const TextStyle(fontSize: 13, color: C.dim)),
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

  Future<void> _export() => _act(tr('skills.exporting'), () async {
    final k = _editing!;
    final text = await widget.api.exportSkill(k.id);
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
      appBar: AppBar(backgroundColor: C.side, title: Text(tr('skills.title'), style: const TextStyle(fontSize: 15))),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2, color: C.dim))
          : Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 680),
                child: ListView(
                  padding: const EdgeInsets.all(22),
                  children: [
                    Text(
                      tr('skills.intro'),
                      style: const TextStyle(fontSize: 12, color: C.dim, height: 1.6),
                    ),
                    const SizedBox(height: 12),
                    if (_rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text(tr('skills.none'), style: const TextStyle(fontSize: 12.5, color: C.dim2)),
                      ),
                    for (final k in _rows) _row(k),
                    const SizedBox(height: 16),
                    const Divider(height: 1),
                    const SizedBox(height: 16),
                    Text(
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
                    Text(tr('skills.installOn'), style: const TextStyle(fontSize: 12, color: C.dim)),
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
          color: on ? const Color(0xFF1C2333) : null,
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
                      style: const TextStyle(fontSize: 11, color: C.dim),
                    ),
                ],
              ),
            ),
            Text(
              '${k.description} · $who',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: C.dim),
            ),
          ],
        ),
      ),
    );
  }
}
