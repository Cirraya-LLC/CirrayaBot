/// Create / edit / delete Agents and groups — the same things the web page
/// does, over the same endpoints.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';

/// [agent] null = create. Returns once the lists are reloaded.
Future<void> showAgentEditor(BuildContext context, Workbench bench, {Agent? agent}) => showDialog<void>(
  context: context,
  builder: (_) => _AgentEditor(bench: bench, agent: agent),
);

/// [group] null = create.
Future<void> showGroupEditor(BuildContext context, Workbench bench, {Conversation? group}) => showDialog<void>(
  context: context,
  builder: (_) => _GroupEditor(bench: bench, group: group),
);

class _AgentEditor extends StatefulWidget {
  const _AgentEditor({required this.bench, this.agent});
  final Workbench bench;
  final Agent? agent;

  @override
  State<_AgentEditor> createState() => _AgentEditorState();
}

class _AgentEditorState extends State<_AgentEditor> {
  late final _name = TextEditingController(text: widget.agent?.name ?? '');
  late final _desc = TextEditingController(text: widget.agent?.description ?? '');
  late final _persona = TextEditingController(text: widget.agent?.persona ?? '');

  /// Typed model name — only used when the upstream will not list its models.
  late final _manualModel = TextEditingController(text: widget.agent?.model ?? '');
  late String _providerId = widget.agent?.providerId ?? '';
  List<Provider> _providers = const [];
  List<String> _models = const [];
  String _model = '';
  bool _modelsLoading = true;
  int _modelsSeq = 0;
  String _error = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.bench.api.providers().then((list) {
      if (!mounted) return;
      setState(() {
        _providers = list;
        // An upstream deleted elsewhere: fall back to the default rather than
        // a dropdown with a value it cannot show.
        if (!list.any((p) => p.id == _providerId)) _providerId = '';
      });
      _loadModels(_providerId, widget.agent?.model ?? '');
    }, onError: (_) {});
  }

  /// Ask the upstream what it offers. [current] is kept even when the list no
  /// longer has it — silently swapping in another model is worse than showing
  /// the stale one. A new Agent starts on whatever the upstream is already used
  /// with, not the alphabetically first entry.
  Future<void> _loadModels(String providerId, String current) async {
    final seq = ++_modelsSeq;
    setState(() => _modelsLoading = true);
    var models = const <String>[];
    var suggested = '';
    try {
      final r = await widget.bench.api.models(providerId);
      models = r.models;
      suggested = r.suggested;
    } on ApiException {
      // falls through to typing the name
    }
    if (!mounted || seq != _modelsSeq) return; // switched upstream meanwhile
    setState(() {
      _modelsLoading = false;
      _models = current.isNotEmpty && models.isNotEmpty && !models.contains(current) ? [current, ...models] : models;
      _model = current.isNotEmpty ? current : (suggested.isNotEmpty ? suggested : models.firstOrNull ?? '');
      _manualModel.text = current;
    });
  }

  String get _chosenModel => (_models.isEmpty ? _manualModel.text : _model).trim();

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _persona.dispose();
    _manualModel.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final openId = await job();
      await widget.bench.reload(id: openId);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim(), desc = _desc.text.trim(), persona = _persona.text.trim();
    if (name.isEmpty || persona.isEmpty) {
      setState(() => _error = tr('ed.needNamePersona'));
      return;
    }
    if (_chosenModel.isEmpty) {
      setState(() => _error = tr(_modelsLoading ? 'ed.modelsLoading' : 'ed.pickModel'));
      return;
    }
    final a = widget.agent;
    final body = <String, Object?>{
      'name': name,
      'description': desc,
      'persona': persona,
      'provider_id': _providerId,
      'model': _chosenModel,
    };
    await _run(() async {
      if (a == null) return widget.bench.api.createAgent(body);
      await widget.bench.api.updateAgent(a.id, body);
      return a.id;
    });
  }

  Future<void> _delete() async {
    final a = widget.agent!;
    if (!await _confirm(context, tr('ed.deleteAgentQ', {'name': a.name}), tr('ed.deleteAgentBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteAgent(a.id);
      return null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.agent != null;
    return AlertDialog(
      title: Text(
        editing ? tr('ed.editTitle', {'name': widget.agent!.name}) : tr('wb.newAgent'),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _name,
              autofocus: !editing,
              decoration: InputDecoration(hintText: tr('ed.nameHint')),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _desc,
              decoration: InputDecoration(hintText: tr('ed.descHint')),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _persona,
              minLines: 6,
              maxLines: 12,
              decoration: InputDecoration(hintText: tr('ed.personaHint')),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  // Rebuilt once the list arrives: before that the saved id is
                  // not among the items, and a dropdown asserts on that.
                  child: DropdownButtonFormField<String>(
                    key: ValueKey(_providers.length),
                    initialValue: _providers.isEmpty ? '' : _providerId,
                    isExpanded: true,
                    decoration: InputDecoration(labelText: tr('ed.provider')),
                    items: [
                      DropdownMenuItem(
                        value: '',
                        child: Text(
                          _providers
                                  .where((p) => p.isDefault)
                                  .map((p) => tr('ed.defaultProviderNamed', {'name': p.name}))
                                  .firstOrNull ??
                              tr('ed.defaultProvider'),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      for (final p in _providers)
                        DropdownMenuItem(
                          value: p.id,
                          child: Text(p.name, overflow: TextOverflow.ellipsis),
                        ),
                    ],
                    onChanged: (v) {
                      setState(() => _providerId = v ?? '');
                      // The old model name almost never belongs to another upstream;
                      // switching back to the agent's own restores it.
                      final a = widget.agent;
                      _loadModels(_providerId, a != null && _providerId == a.providerId ? a.model : '');
                    },
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _modelsLoading
                      ? InputDecorator(
                          decoration: InputDecoration(labelText: tr('ed.model')),
                          child: Text(tr('ed.askingProvider'), style: const TextStyle(fontSize: 13, color: C.dim)),
                        )
                      : _models.isEmpty
                      ? TextField(
                          controller: _manualModel,
                          decoration: InputDecoration(labelText: tr('ed.model'), hintText: tr('ed.manualModelHint')),
                        )
                      : DropdownButtonFormField<String>(
                          // Rebuilt per list: a new upstream brings a new set of items.
                          key: ValueKey('$_providerId/${_models.length}'),
                          initialValue: _models.contains(_model) ? _model : null,
                          isExpanded: true,
                          decoration: InputDecoration(labelText: tr('ed.model')),
                          items: [
                            for (final m in _models)
                              DropdownMenuItem(
                                value: m,
                                child: Text(m, overflow: TextOverflow.ellipsis),
                              ),
                          ],
                          onChanged: (v) => setState(() => _model = v ?? ''),
                        ),
                ),
              ],
            ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: const TextStyle(fontSize: 12, color: C.code)),
            ],
          ],
        ),
      ),
      actions: [
        if (editing)
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(editing ? 'common.save' : 'ed.create'))),
      ],
    );
  }
}

class _GroupEditor extends StatefulWidget {
  const _GroupEditor({required this.bench, this.group});
  final Workbench bench;
  final Conversation? group;

  @override
  State<_GroupEditor> createState() => _GroupEditorState();
}

class _GroupEditorState extends State<_GroupEditor> {
  late final _name = TextEditingController(text: widget.group?.name ?? '');
  late final Set<String> _members = {...?widget.group?.members};
  late String _lead = widget.group?.lead ?? '';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final openId = await job();
      await widget.bench.reload(id: openId);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    // Say it here rather than round-trip for the server's 400: a one-member
    // group is a DM, and the form knows that as well as the server does.
    if (name.isEmpty || _members.length < 2) {
      setState(() => _error = tr('ed.groupNeeds'));
      return;
    }
    // Keep the Agents' own order, so the first speaker doesn't depend on
    // the order the boxes were ticked in.
    final ordered = [
      for (final a in widget.bench.agents)
        if (_members.contains(a.id)) a.id,
    ];
    final g = widget.group;
    await _run(() async {
      if (g == null) return widget.bench.api.createGroup(name, ordered, lead: _lead);
      await widget.bench.api.updateGroup(g.id, name, ordered, lead: _lead);
      return g.id;
    });
  }

  Future<void> _delete() async {
    final g = widget.group!;
    if (!await _confirm(context, tr('ed.disbandQ', {'name': g.name}), tr('ed.disbandBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteGroup(g.id);
      return null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.group != null;
    final agents = widget.bench.agents;
    return AlertDialog(
      title: Text(
        editing ? tr('ed.editTitle', {'name': widget.group!.name}) : tr('wb.newGroup'),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _name,
              autofocus: !editing,
              decoration: InputDecoration(hintText: tr('ed.groupNameHint')),
            ),
            const SizedBox(height: 14),
            Text(tr('ed.membersMin'), style: const TextStyle(fontSize: 12, color: C.dim)),
            const SizedBox(height: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: agents.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(tr('ed.noAgents'), style: const TextStyle(fontSize: 12.5, color: C.dim2)),
                    )
                  : ListView(
                      shrinkWrap: true,
                      children: [
                        for (final a in agents)
                          CheckboxListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            controlAffinity: ListTileControlAffinity.leading,
                            value: _members.contains(a.id),
                            onChanged: (v) => setState(() {
                              v == true ? _members.add(a.id) : _members.remove(a.id);
                              // The lead has to be in the group.
                              if (!_members.contains(_lead)) _lead = '';
                            }),
                            title: Text(a.name, style: const TextStyle(fontSize: 13)),
                            subtitle: a.description.isEmpty
                                ? null
                                : Text(
                                    a.description,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11, color: C.dim),
                                  ),
                          ),
                      ],
                    ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              // Rebuilt when the member set changes: its items change with it.
              key: ValueKey('lead-${_members.join(',')}'),
              initialValue: _members.contains(_lead) ? _lead : '',
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.lead')),
              items: [
                DropdownMenuItem(value: '', child: Text(tr('ed.noLead'))),
                for (final a in agents)
                  if (_members.contains(a.id)) DropdownMenuItem(value: a.id, child: Text(a.name)),
              ],
              onChanged: (v) => setState(() => _lead = v ?? ''),
            ),
            const SizedBox(height: 4),
            Text(tr('ed.leadHelp'), style: const TextStyle(fontSize: 11, color: C.dim2)),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: const TextStyle(fontSize: 12, color: C.code)),
            ],
          ],
        ),
      ),
      actions: [
        if (editing)
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('ed.disband')),
          ),
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(editing ? 'common.save' : 'ed.create'))),
      ],
    );
  }
}

Future<bool> _confirm(BuildContext context, String title, String body) async =>
    await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title, style: const TextStyle(fontSize: 15)),
        content: Text(body, style: const TextStyle(fontSize: 13, color: C.dim)),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.of(c).pop(true),
            style: FilledButton.styleFrom(backgroundColor: C.code),
            child: Text(tr('common.ok')),
          ),
        ],
      ),
    ) ??
    false;
