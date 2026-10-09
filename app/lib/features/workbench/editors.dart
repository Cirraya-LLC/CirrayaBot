/// Create / edit / delete Agents and groups — the same things the web page
/// does, over the same endpoints.
library;

import 'dart:io';

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

/// Reasoning effort: the stored value and the string that names it. '' = send nothing.
const _effortLevels = <MapEntry<String, String>>[
  MapEntry('', 'ed.effortDefault'),
  MapEntry('low', 'ed.effortLow'),
  MapEntry('medium', 'ed.effortMedium'),
  MapEntry('high', 'ed.effortHigh'),
];

/// When this one has to ask a person first. '' = whatever the platform says.
/// How far it goes on its own. '' = follow the platform setting.
const _autonomyModes = <MapEntry<String, String>>[
  MapEntry('', 'ed.autonomyDefault'),
  MapEntry('auto', 'ed.autonomyAuto'),
  MapEntry('manual', 'ed.autonomyManual'),
];

const _approvalModes = <MapEntry<String, String>>[
  MapEntry('', 'ed.approvalDefault'),
  MapEntry('off', 'ed.approvalOff'),
  MapEntry('match', 'ed.approvalMatch'),
  MapEntry('all', 'ed.approvalAll'),
];

/// One backup model being edited: an upstream, and a model from its list (or typed, when the
/// upstream gives no list), with its own loading state.
class _FallbackPick {
  _FallbackPick(this.providerId, this.model) : manual = TextEditingController(text: model);
  String providerId;
  String model;
  final TextEditingController manual;
  final key = UniqueKey();
  List<String> models = const [];
  bool loading = true;
  int seq = 0;

  String get chosen => (models.isEmpty ? manual.text : model).trim();
}

const _maxFallbacks = 3;

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

  /// Daily spend cap, in dollars as typed. Empty = the platform default.
  late final _cap = TextEditingController(text: dollarsText(widget.agent?.dailyCapMicro));
  late final _voiceName = TextEditingController(text: widget.agent?.voice ?? '');
  late String _providerId = widget.agent?.providerId ?? '';

  /// '' = send nothing, which is what every model got before this setting existed.
  late String _effort = const ['low', 'medium', 'high'].contains(widget.agent?.effort) ? widget.agent!.effort : '';
  late String _approval = const ['off', 'match', 'all'].contains(widget.agent?.approval) ? widget.agent!.approval : '';
  late String _autonomy = const ['auto', 'manual'].contains(widget.agent?.autonomy) ? widget.agent!.autonomy : '';
  List<Provider> _providers = const [];
  List<String> _models = const [];
  String _model = '';
  bool _modelsLoading = true;
  int _modelsSeq = 0;
  String _error = '';
  bool _busy = false;
  late final List<_FallbackPick> _fallbacks = [
    for (final f in widget.agent?.fallbacks ?? const <Fallback>[]) _FallbackPick(f.providerId, f.model),
  ];

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
        for (final f in _fallbacks) {
          if (!list.any((p) => p.id == f.providerId)) f.providerId = '';
        }
      });
    }, onError: (_) {}).whenComplete(() {
      // Whether or not the upstream list came: the model fields must stop "asking" either way —
      // with no answer they fall back to typing the name, instead of spinning forever.
      if (!mounted) return;
      _loadModels(_providerId, widget.agent?.model ?? '');
      for (final f in _fallbacks) {
        _loadFallback(f, f.model);
      }
    });
  }

  /// A backup row's model list. Unlike the main pick, nothing is preselected for a new row: the
  /// list's first entry is most likely the main model, and a backup that is the main model would
  /// only fail twice.
  Future<void> _loadFallback(_FallbackPick f, String current) async {
    final seq = ++f.seq;
    setState(() => f.loading = true);
    var models = const <String>[];
    try {
      models = (await widget.bench.api.models(f.providerId)).models;
    } on ApiException {
      // falls through to typing the name
    }
    if (!mounted || seq != f.seq || !_fallbacks.contains(f)) return;
    setState(() {
      f.loading = false;
      f.models = current.isNotEmpty && models.isNotEmpty && !models.contains(current) ? [current, ...models] : models;
      f.model = current;
      f.manual.text = current;
    });
  }

  Widget _fallbackRow(_FallbackPick f) => Padding(
    key: f.key,
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: DropdownButtonFormField<String>(
            key: ValueKey('${f.key}/${_providers.length}'),
            initialValue: _providers.isEmpty ? '' : f.providerId,
            isExpanded: true,
            decoration: InputDecoration(labelText: tr('ed.provider')),
            items: _providerItems(),
            onChanged: (v) {
              setState(() => f.providerId = v ?? '');
              final old = widget.agent?.fallbacks.where((x) => x.providerId == f.providerId).firstOrNull;
              _loadFallback(f, old?.model ?? '');
            },
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: f.loading
              ? InputDecorator(
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  child: Text(tr('ed.askingProvider'), style: TextStyle(fontSize: 13, color: C.dim)),
                )
              : f.models.isEmpty
              ? TextField(
                  controller: f.manual,
                  decoration: InputDecoration(labelText: tr('ed.model'), hintText: tr('ed.manualModelHint')),
                )
              : DropdownButtonFormField<String>(
                  key: ValueKey('${f.key}/${f.providerId}/${f.models.length}'),
                  initialValue: f.models.contains(f.model) ? f.model : null,
                  isExpanded: true,
                  hint: Text(tr('ed.fallbackPick'), overflow: TextOverflow.ellipsis),
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  items: [
                    for (final m in f.models)
                      DropdownMenuItem(value: m, child: Text(m, overflow: TextOverflow.ellipsis)),
                  ],
                  onChanged: (v) => setState(() => f.model = v ?? ''),
                ),
        ),
        IconButton(
          tooltip: tr('ed.fallbackRemove'),
          icon: const Icon(Icons.close, size: 18),
          onPressed: () => setState(() {
            _fallbacks.remove(f);
            f.manual.dispose();
          }),
        ),
      ],
    ),
  );

  List<DropdownMenuItem<String>> _providerItems() => [
    DropdownMenuItem(
      value: '',
      child: Text(
        _providers.where((p) => p.isDefault).map((p) => tr('ed.defaultProviderNamed', {'name': p.name})).firstOrNull ??
            tr('ed.defaultProvider'),
        overflow: TextOverflow.ellipsis,
      ),
    ),
    for (final p in _providers)
      DropdownMenuItem(
        value: p.id,
        child: Text(p.name, overflow: TextOverflow.ellipsis),
      ),
  ];

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

  /// The upstream in force for this agent has no prices, so a cap cannot bite.
  bool get _capUseless {
    final chosen = _providerId.isEmpty
        ? _providers.where((p) => p.isDefault).firstOrNull ?? _providers.firstOrNull
        : _providers.where((p) => p.id == _providerId).firstOrNull;
    return chosen != null && !chosen.priced;
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _persona.dispose();
    _manualModel.dispose();
    _cap.dispose();
    _voiceName.dispose();
    for (final f in _fallbacks) {
      f.manual.dispose();
    }
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
    final cap = parseDollars(_cap.text);
    if (!cap.ok) {
      setState(() => _error = tr('ed.badCap'));
      return;
    }
    final a = widget.agent;
    final body = <String, Object?>{
      'name': name,
      'description': desc,
      'persona': persona,
      'provider_id': _providerId,
      'model': _chosenModel,
      'effort': _effort,
      'approval': _approval,
      'autonomy': _autonomy,
      'daily_cap_micro': cap.value,
      'voice': _voiceName.text.trim(),
      // A row left without a model is not a backup; it is dropped rather than refused.
      'fallbacks': [
        for (final f in _fallbacks)
          if (f.chosen.isNotEmpty) {'provider_id': f.providerId, 'model': f.chosen},
      ],
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
      // The form is taller than a phone (and than a short laptop window): it scrolls, title and all.
      scrollable: true,
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
                    items: _providerItems(),
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
                          child: Text(tr('ed.askingProvider'), style: TextStyle(fontSize: 13, color: C.dim)),
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
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _effort,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.effort')),
              items: [
                for (final e in _effortLevels)
                  DropdownMenuItem(value: e.key, child: Text(tr(e.value))),
              ],
              onChanged: (v) => setState(() => _effort = v ?? ''),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(tr('ed.effortHint'), style: TextStyle(fontSize: 11, color: C.dim)),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(child: Text(tr('ed.fallbacks'), style: TextStyle(fontSize: 13, color: C.dim))),
                if (_fallbacks.length < _maxFallbacks)
                  TextButton.icon(
                    onPressed: () {
                      final f = _FallbackPick('', '');
                      setState(() => _fallbacks.add(f));
                      _loadFallback(f, '');
                    },
                    icon: const Icon(Icons.add, size: 16),
                    label: Text(tr('ed.fallbackAdd')),
                  ),
              ],
            ),
            for (final f in _fallbacks) _fallbackRow(f),
            Text(tr('ed.fallbackHint'), style: TextStyle(fontSize: 11, color: C.dim)),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _approval,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.approval')),
              items: [
                for (final m in _approvalModes)
                  DropdownMenuItem(value: m.key, child: Text(tr(m.value))),
              ],
              onChanged: (v) => setState(() => _approval = v ?? ''),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _autonomy,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.autonomy')),
              items: [
                for (final m in _autonomyModes)
                  DropdownMenuItem(value: m.key, child: Text(tr(m.value))),
              ],
              onChanged: (v) => setState(() => _autonomy = v ?? ''),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _cap,
              decoration: InputDecoration(labelText: tr('ed.dailyCap'), hintText: tr('ed.dailyCapHint')),
            ),
            // A cap only means something when the upstream has prices — saying so
            // beats letting someone think a number here is guarding them.
            if (_capUseless)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(tr('wb.unpriced'), style: TextStyle(fontSize: 11, color: C.warn)),
              ),
            const SizedBox(height: 10),
            TextField(
              controller: _voiceName,
              autocorrect: false,
              decoration: InputDecoration(labelText: tr('vo.agentVoice')),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(tr('vo.agentVoiceHint'), style: TextStyle(fontSize: 11, color: C.dim2)),
            ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
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
            Text(tr('ed.membersMin'), style: TextStyle(fontSize: 12, color: C.dim)),
            const SizedBox(height: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: agents.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(tr('ed.noAgents'), style: TextStyle(fontSize: 12.5, color: C.dim2)),
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
                                    style: TextStyle(fontSize: 11, color: C.dim),
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
            Text(tr('ed.leadHelp'), style: TextStyle(fontSize: 11, color: C.dim2)),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
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
        content: Text(body, style: TextStyle(fontSize: 13, color: C.dim)),
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

// ── scheduled tasks ──────────────────────────────────────────────────────

/// The machine's IANA time zone, which Dart does not expose. macOS and Linux
/// keep it as the target of /etc/localtime; elsewhere (Windows) fall back to a
/// fixed-offset zone — right until the next daylight-saving switch, which is
/// why an existing task keeps the zone it was created with.
String localTimeZone() {
  try {
    final target = File('/etc/localtime').resolveSymbolicLinksSync();
    final i = target.indexOf('zoneinfo/');
    if (i >= 0) return target.substring(i + 'zoneinfo/'.length);
  } catch (_) {}
  final off = DateTime.now().timeZoneOffset;
  if (off.inMinutes % 60 == 0) {
    final h = off.inHours;
    // Etc/GMT signs are inverted: UTC+8 is Etc/GMT-8.
    return h == 0 ? 'UTC' : 'Etc/GMT${h > 0 ? '-' : '+'}${h.abs()}';
  }
  return 'UTC';
}

String _two(int n) => n.toString().padLeft(2, '0');

String _clock(DateTime d) => '${_two(d.hour)}:${_two(d.minute)}';

/// "Weekdays 09:00", "Every 2 h", "9/21 09:00, once" — the same wording as the web page.
String scheduleText(Routine r) {
  final tz = r.tz.isNotEmpty && r.tz != localTimeZone() ? tr('ed.tzSuffix', {'tz': r.tz}) : '';
  if (r.kind == 'interval') {
    return r.everyMinutes % 60 == 0
        ? tr('ed.everyHours', {'n': r.everyMinutes ~/ 60})
        : tr('ed.everyMinutes', {'n': r.everyMinutes});
  }
  if (r.kind == 'once') {
    final d = DateTime.fromMillisecondsSinceEpoch(r.runAt ?? 0);
    return tr('ed.onceAt', {'date': '${d.month}/${d.day}', 'time': _clock(d)});
  }
  final w = r.weekdays.join(',');
  final days = r.weekdays.isEmpty
      ? tr('ed.everyDay')
      : w == '1,2,3,4,5'
      ? tr('ed.weekdays')
      : w == '0,6'
      ? tr('ed.weekends')
      : tr('ed.everyWeek', {'days': r.weekdays.map((d) => tr('ed.wd$d')).join(tr('wb.listSep'))});
  return '$days ${r.atTime}$tz';
}

/// When it runs next, in local time: "Today 09:00", "Mon 09:00", "9/30 09:00".
String nextRunText(Routine r) {
  if (!r.enabled || r.nextRunAt == null) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(r.nextRunAt!);
  final now = DateTime.now();
  final days = DateTime(d.year, d.month, d.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  final day = days == 0
      ? tr('ed.today')
      : days == 1
      ? tr('ed.tomorrow')
      : days < 7
      ? tr('wb.wd${d.weekday % 7}')
      : '${d.month}/${d.day}';
  return tr('ed.next', {'when': '$day ${_clock(d)}'});
}

/// [routine] null = create one for [target].
Future<void> showRoutineEditor(BuildContext context, Workbench bench, Conversation target, {Routine? routine}) =>
    showDialog<void>(
      context: context,
      builder: (_) => _RoutineEditor(bench: bench, target: target, routine: routine),
    );

class _RoutineEditor extends StatefulWidget {
  const _RoutineEditor({required this.bench, required this.target, this.routine});
  final Workbench bench;
  final Conversation target;
  final Routine? routine;

  @override
  State<_RoutineEditor> createState() => _RoutineEditorState();
}

class _RoutineEditorState extends State<_RoutineEditor> {
  late final _name = TextEditingController(text: widget.routine?.name ?? '');
  late final _prompt = TextEditingController(text: widget.routine?.prompt ?? '');
  late final _every = TextEditingController(text: '${widget.routine?.everyMinutes ?? 60}');
  late String _kind = widget.routine?.kind ?? 'daily';
  late TimeOfDay _time = _parseTime(widget.routine?.atTime);
  late final Set<int> _weekdays = {...?widget.routine?.weekdays};
  late DateTime _at = widget.routine?.runAt != null
      ? DateTime.fromMillisecondsSinceEpoch(widget.routine!.runAt!)
      : DateTime.now().add(const Duration(hours: 1));
  late bool _enabled = widget.routine?.enabled ?? true;
  String _error = '';
  bool _busy = false;

  static TimeOfDay _parseTime(String? s) {
    final m = RegExp(r'^(\d\d):(\d\d)$').firstMatch(s ?? '');
    return m == null
        ? const TimeOfDay(hour: 9, minute: 0)
        : TimeOfDay(hour: int.parse(m[1]!), minute: int.parse(m[2]!));
  }

  @override
  void dispose() {
    _name.dispose();
    _prompt.dispose();
    _every.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await job();
      await widget.bench.loadRoutines();
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() {
    final r = widget.routine;
    final body = <String, Object?>{
      'name': _name.text.trim(),
      'prompt': _prompt.text.trim(),
      'target_kind': widget.target.kind,
      'target_id': widget.target.id,
      'kind': _kind,
      'at_time': '${_two(_time.hour)}:${_two(_time.minute)}',
      'weekdays': (_weekdays.toList()..sort()),
      'every_minutes': int.tryParse(_every.text.trim()) ?? 0,
      'run_at': _at.millisecondsSinceEpoch,
      'tz': (r?.tz.isNotEmpty ?? false) ? r!.tz : localTimeZone(),
      'enabled': _enabled,
    };
    return _run(() => widget.bench.api.saveRoutine(body, id: r?.id));
  }

  Future<void> _delete() async {
    final r = widget.routine!;
    if (!await _confirm(context, tr('ed.deleteRoutineQ', {'name': r.name}), tr('ed.deleteRoutineBody'))) return;
    await _run(() => widget.bench.api.deleteRoutine(r.id));
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: _time);
    if (t != null) setState(() => _time = t);
  }

  Future<void> _pickMoment() async {
    final day = await showDatePicker(
      context: context,
      initialDate: _at,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 366)),
    );
    if (day == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_at));
    if (t == null) return;
    setState(() => _at = DateTime(day.year, day.month, day.day, t.hour, t.minute));
  }

  Widget _schedule() => switch (_kind) {
    'interval' => Row(
      children: [
        SizedBox(
          width: 120,
          child: TextField(
            controller: _every,
            decoration: InputDecoration(labelText: tr('ed.intervalLabel')),
          ),
        ),
        const SizedBox(width: 10),
        Text(tr('ed.min5'), style: TextStyle(fontSize: 12, color: C.dim)),
      ],
    ),
    'once' => Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        onPressed: _pickMoment,
        icon: const Icon(Icons.event_outlined, size: 16),
        label: Text('${_at.year}/${_at.month}/${_at.day} ${_clock(_at)}'),
      ),
    ),
    _ => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: _pickTime,
          icon: const Icon(Icons.schedule, size: 16),
          label: Text('${_two(_time.hour)}:${_two(_time.minute)}'),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final d in const [1, 2, 3, 4, 5, 6, 0])
              FilterChip(
                label: Text(tr('wb.wd$d'), style: const TextStyle(fontSize: 12)),
                selected: _weekdays.contains(d),
                // The checkmark widens the chip, the row re-wraps and the buttons
                // below jump away from the pointer.
                showCheckmark: false,
                onSelected: (on) => setState(() => on ? _weekdays.add(d) : _weekdays.remove(d)),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text(tr('ed.noneEveryDay'), style: TextStyle(fontSize: 11, color: C.dim2)),
      ],
    ),
  };

  @override
  Widget build(BuildContext context) {
    final r = widget.routine;
    final last = r?.lastRunAt == null
        ? (r == null ? '' : tr('ed.neverRun'))
        : tr('ed.lastRun', {
            'at': DateTime.fromMillisecondsSinceEpoch(r!.lastRunAt!).toString().substring(0, 16),
            'result': r.lastStatus == 'failed' ? tr('ed.failed', {'err': r.lastError}) : tr('ed.succeeded'),
          });
    return AlertDialog(
      title: Text(
        r == null ? tr('wb.newRoutine') : tr('ed.editTitle', {'name': r.name}),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                autofocus: r == null,
                decoration: InputDecoration(hintText: tr('ed.routineNameHint')),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _prompt,
                minLines: 4,
                maxLines: 10,
                decoration: InputDecoration(hintText: tr('ed.promptHint')),
              ),
              const SizedBox(height: 6),
              Text(
                tr('ed.firesInto', {'name': widget.target.name}) +
                    (widget.target.isGroup ? tr('ed.firesGroup') : '') +
                    tr('ed.costs'),
                style: TextStyle(fontSize: 11.5, color: C.dim2),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: [
                  for (final (v, k) in const [
                    ('daily', 'ed.kindDaily'),
                    ('interval', 'ed.kindInterval'),
                    ('once', 'ed.kindOnce'),
                  ])
                    ButtonSegment(
                      value: v,
                      label: Text(tr(k), style: const TextStyle(fontSize: 12)),
                    ),
                ],
                selected: {_kind},
                showSelectedIcon: false,
                onSelectionChanged: (v) => setState(() => _kind = v.first),
              ),
              const SizedBox(height: 12),
              _schedule(),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(tr('ed.enabled'), style: const TextStyle(fontSize: 13)),
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
              ),
              if (last.isNotEmpty) Text(last, style: TextStyle(fontSize: 11.5, color: C.dim)),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (r != null) ...[
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
          TextButton(
            onPressed: _busy || r.running ? null : () => _run(() => widget.bench.api.runRoutine(r.id)),
            child: Text(tr('ed.runNow')),
          ),
        ],
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(r == null ? 'ed.create' : 'common.save'))),
      ],
    );
  }
}

/// Give an agent a secret by hand. The value goes in once and is never shown again.
Future<void> showSecretEditor(BuildContext context, Workbench bench, String agentId) =>
    showDialog<void>(context: context, builder: (_) => _SecretEditor(bench: bench, agentId: agentId));

class _SecretEditor extends StatefulWidget {
  const _SecretEditor({required this.bench, required this.agentId});
  final Workbench bench;
  final String agentId;

  @override
  State<_SecretEditor> createState() => _SecretEditorState();
}

class _SecretEditorState extends State<_SecretEditor> {
  final _name = TextEditingController();
  final _origin = TextEditingController();
  final _header = TextEditingController();
  final _format = TextEditingController();
  final _value = TextEditingController();
  String _kind = 'header';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _origin, _header, _format, _value]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.bench.api.addSecret(widget.agentId, {
        'name': _name.text.trim(),
        'kind': _kind,
        'origin': _origin.text.trim(),
        'header': _header.text.trim(),
        'format': _format.text,
        'value': _value.text,
      });
      _value.clear();
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    scrollable: true,
    title: Text(tr('sec.addTitle'), style: const TextStyle(fontSize: 16)),
    content: SizedBox(
      width: 420,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(controller: _name, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.namePh'))),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: _kind,
            isExpanded: true,
            items: [
              DropdownMenuItem(value: 'header', child: Text(tr('sec.kindHeader'), overflow: TextOverflow.ellipsis)),
              DropdownMenuItem(value: 'login', child: Text(tr('sec.kindLogin'), overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _kind = v ?? 'header'),
          ),
          const SizedBox(height: 10),
          TextField(controller: _origin, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.originPh'))),
          if (_kind == 'header') ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: TextField(controller: _header, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.headerPh')))),
                const SizedBox(width: 10),
                Expanded(child: TextField(controller: _format, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.formatPh')))),
              ],
            ),
          ],
          const SizedBox(height: 10),
          TextField(
            controller: _value,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(hintText: tr('sec.valuePh')),
          ),
          const SizedBox(height: 8),
          Text(tr('sec.hint'), style: TextStyle(fontSize: 11.5, color: C.dim2)),
          if (_error.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
          ],
        ],
      ),
    ),
    actions: [
      TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
      FilledButton(onPressed: _busy ? null : _save, child: Text(tr('common.save'))),
    ],
  );
}
