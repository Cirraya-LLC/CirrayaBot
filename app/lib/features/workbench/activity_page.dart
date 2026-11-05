/// Activity: what every Agent is doing, what waits for the person (answerable here), what is coming
/// up, which machines are awake, and what was run lately — across every conversation.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';

class ActivityPage extends StatefulWidget {
  const ActivityPage({super.key, required this.bench, this.debugLoad});
  final Workbench bench;

  /// Tests: where the data comes from instead of the server.
  final Future<Map<String, Object?>> Function()? debugLoad;

  @override
  State<ActivityPage> createState() => _ActivityPageState();
}

class _ActivityPageState extends State<ActivityPage> {
  Map<String, Object?>? _a;
  String _error = '';
  Timer? _poll;
  final _answers = <int, TextEditingController>{};

  Api get _api => widget.bench.api;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    for (final c in _answers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final a = await (widget.debugLoad ?? _api.activity)();
      if (mounted) {
        setState(() {
          _a = a;
          _error = '';
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _do(Future<void> Function() job) async {
    try {
      await job();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(e.message)));
    }
    await _load();
  }

  void _open(String kind, String id, [String? session]) {
    Navigator.of(context).pop();
    unawaited(widget.bench.openAt(kind, id, session));
  }

  List<Map<String, Object?>> _list(String k) => [
    for (final x in (_a?[k] as List?) ?? const [])
      if (x is Map<String, Object?>) x,
  ];

  String _ago(Object? ms) {
    final t = (ms as num?)?.toInt();
    if (t == null) return '';
    final m = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(t)).inMinutes;
    if (m < 1) return tr('act.justNow');
    if (m < 60) return tr('act.minAgo', {'n': m});
    return _time(t);
  }

  String _time(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  String _date(Object? iso) {
    final d = DateTime.tryParse('$iso')?.toLocal();
    if (d == null) return '';
    return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  Widget _section(String title, List<Widget> rows, String empty) => Padding(
    padding: const EdgeInsets.only(top: 14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: C.dim)),
        const SizedBox(height: 6),
        if (rows.isEmpty) Text(empty, style: TextStyle(fontSize: 12, color: C.dim2)) else ...rows,
      ],
    ),
  );

  Widget _card({required Widget body, List<Widget> actions = const [], bool ask = false, Key? key}) => Container(
    key: key,
    margin: const EdgeInsets.only(bottom: 6),
    padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
    decoration: BoxDecoration(
      border: Border.all(color: ask ? C.warn : C.line),
      borderRadius: BorderRadius.circular(9),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        body,
        if (actions.isNotEmpty) Wrap(alignment: WrapAlignment.end, spacing: 4, children: actions),
      ],
    ),
  );

  Widget _line(String who, String rest, {String? second, bool mono = false}) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text.rich(TextSpan(children: [
        TextSpan(text: who, style: const TextStyle(fontWeight: FontWeight.w600)),
        if (rest.isNotEmpty) TextSpan(text: ' · $rest', style: TextStyle(color: C.dim2, fontSize: 11.5)),
      ]), style: const TextStyle(fontSize: 12.5)),
      if (second != null && second.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Text(second, style: TextStyle(fontSize: 12, fontFamily: mono ? 'monospace' : null)),
        ),
    ],
  );

  String _where(Map<String, Object?> x) {
    final who = '${x['who'] ?? ''}', conv = '${x['conv_name'] ?? ''}';
    return who.isNotEmpty && who != conv ? conv : '';
  }

  String _join(List<String> parts) => parts.where((p) => p.isNotEmpty).join(' · ');

  @override
  Widget build(BuildContext context) {
    final a = _a;
    final asks = _list('asks'), runs = _list('runs'), tasks = _list('tasks'), routines = _list('routines'),
        checkins = _list('checkins'), machines = _list('machines').where((m) => m['state'] != 'none').toList(),
        actions = _list('actions');
    final questions = tasks.where((t) => t['status'] == 'waiting' && '${t['question'] ?? ''}'.isNotEmpty && t['approval'] == null);
    final working = tasks.where((t) => t['status'] == 'queued' || t['status'] == 'running');
    return Scaffold(
      appBar: AppBar(backgroundColor: C.side, title: Text(tr('act.title'), style: const TextStyle(fontSize: 15))),
      body: a == null
          ? Center(child: _error.isNotEmpty ? Text(_error, style: TextStyle(color: C.dim)) : CircularProgressIndicator(strokeWidth: 2, color: C.dim))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 24),
                children: [
                  _section(tr('act.asks'), [
                    for (final x in asks)
                      _card(
                        key: ValueKey('ask-${x['id']}'),
                        ask: true,
                        body: _line('${x['who']}', _join([_where(x), if (x['task'] != null) '#${x['task']}', _ago(x['at'])]),
                            second: '${x['subject']}', mono: true),
                        actions: [
                          TextButton(onPressed: () => _do(() => _api.answerApproval('${x['id']}', false)), child: Text(tr('ap.deny'))),
                          FilledButton(onPressed: () => _do(() => _api.answerApproval('${x['id']}', true)), child: Text(tr('ap.approve'))),
                          TextButton(
                            onPressed: () => _open('${x['kind']}', '${x['conv']}', x['session'] as String?),
                            child: Text(tr('act.open')),
                          ),
                        ],
                      ),
                    for (final x in questions)
                      _card(
                        ask: true,
                        body: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _line('${x['who']}', _join([_where(x), '#${x['id']} ${x['title']}']), second: '${x['question']}'),
                            TextField(
                              controller: _answers.putIfAbsent((x['id'] as num).toInt(), TextEditingController.new),
                              minLines: 1,
                              maxLines: 4,
                              decoration: InputDecoration(hintText: tr('act.replyHint'), isDense: true),
                              style: const TextStyle(fontSize: 12.5),
                            ),
                          ],
                        ),
                        actions: [
                          FilledButton(
                            onPressed: () {
                              final id = (x['id'] as num).toInt();
                              final text = _answers[id]?.text.trim() ?? '';
                              if (text.isEmpty) return;
                              _do(() async {
                                await _api.answerTask(id, text);
                                _answers.remove(id)?.dispose();
                              });
                            },
                            child: Text(tr('act.send')),
                          ),
                          TextButton(
                            onPressed: () => _open('${x['kind']}', '${x['conv']}', x['session'] as String?),
                            child: Text(tr('act.open')),
                          ),
                        ],
                      ),
                  ], tr('act.noAsks')),
                  _section(tr('act.working'), [
                    for (final x in runs)
                      _card(
                        body: _line(
                          '${(x['who'] as String?)?.isNotEmpty == true ? x['who'] : x['conv_name']}',
                          _join([_where(x), tr('act.since', {'ago': _ago(x['started_at'])}), if (x['detached'] == true) tr('act.background')]),
                        ),
                        actions: [
                          TextButton(onPressed: () => _do(() => _api.stopSession('${x['session']}')), child: Text(tr('act.stop'))),
                          TextButton(
                            onPressed: () => _open('${x['kind']}', '${x['id']}', x['session'] as String?),
                            child: Text(tr('act.open')),
                          ),
                        ],
                      ),
                    for (final x in working)
                      _card(
                        body: _line('${x['who']}', _join([_where(x), '#${x['id']}']), second: '${x['title']}'),
                        actions: [
                          TextButton(onPressed: () => _do(() => _api.stopTask((x['id'] as num).toInt())), child: Text(tr('act.stop'))),
                          TextButton(
                            onPressed: () => _open('${x['kind']}', '${x['conv']}', x['session'] as String?),
                            child: Text(tr('act.open')),
                          ),
                        ],
                      ),
                  ], tr('act.noWork')),
                  _section(tr('act.coming'), [
                    for (final x in routines.take(12))
                      _card(
                        body: _line('${x['name']}', _join(['${x['conv_name']}', x['running'] == true ? tr('act.runningNow') : _date(x['next_run_at'])])),
                        actions: [TextButton(onPressed: () => _open('${x['kind']}', '${x['conv']}'), child: Text(tr('act.open')))],
                      ),
                    for (final x in checkins)
                      _card(
                        body: _line('${x['who']}', _join([tr('act.checkin'), _date(x['next_at'])])),
                        actions: [TextButton(onPressed: () => _open('agent', '${x['agent_id']}'), child: Text(tr('act.open')))],
                      ),
                  ], tr('act.noComing')),
                  if (machines.isNotEmpty)
                    _section(tr('act.machines'), [
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final m in machines)
                            Chip(
                              visualDensity: VisualDensity.compact,
                              label: Text(
                                '${widget.bench.agents.where((b) => b.id == m['agent_id']).firstOrNull?.name ?? m['agent_id']} · ${tr('act.m.${m['state']}')}',
                                style: TextStyle(fontSize: 11.5, color: m['state'] == 'awake' ? C.accent : C.dim),
                              ),
                            ),
                        ],
                      ),
                    ], ''),
                  _section(tr('act.recent'), [
                    for (final x in actions.take(60))
                      InkWell(
                        onTap: () => _open('${x['kind']}', '${x['conv']}', x['session'] as String?),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SizedBox(
                                width: 42,
                                child: Text(_time((x['at'] as num?)?.toInt() ?? 0), style: TextStyle(fontSize: 11.5, color: C.dim2)),
                              ),
                              ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 110),
                                child: Text(
                                  '${x['who']}${x['task'] != null ? ' #${x['task']}' : ''}',
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(fontSize: 11.5, color: C.dim),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  '${(x['subject'] as String?)?.isNotEmpty == true ? x['subject'] : x['name']}',
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace'),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ], tr('act.noRecent')),
                ],
              ),
            ),
    );
  }
}
