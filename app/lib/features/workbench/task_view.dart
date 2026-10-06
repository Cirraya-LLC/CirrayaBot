/// Background tasks on screen: news cards in the transcript, and the list in
/// the right panel. A task still waiting on a person can be answered, or have
/// its command allowed, from either place.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';
import 'attachments.dart';

TextStyle get _mono => TextStyle(
  fontFamily: AppTheme.mono,
  fontFamilyFallback: AppTheme.monoFallback,
  fontSize: 11.5,
  height: 1.5,
  color: C.dim,
);

/// One piece of task news in the transcript.
class NewsCard extends StatelessWidget {
  const NewsCard({super.key, required this.bench, required this.news});

  final Workbench bench;
  final News news;

  @override
  Widget build(BuildContext context) {
    final n = news;
    final name = bench.agentById(n.agentId)?.name ?? n.agent;
    final v = {'id': n.task, 'name': name, 'title': n.title, 'by': n.by};
    final head = switch (n.kind) {
      'stopped' => tr(n.by.isEmpty ? 'ev.stopped' : 'ev.stoppedBy', v),
      'asked' || 'approval' || 'done' || 'failed' || 'answered' => tr('ev.${n.kind}', v),
      _ => '#${n.task}',
    };
    final edge = switch (n.kind) {
      'asked' || 'approval' => C.warn,
      'failed' => C.bad,
      'done' => C.ok,
      _ => C.line,
    };
    final x = bench.taskById(n.task);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: C.tool,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: C.line),
      ),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
        decoration: BoxDecoration(border: Border(left: BorderSide(color: edge, width: 3))),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: C.parse(bench.agentById(n.agentId)?.color ?? ''),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(head, style: TextStyle(fontSize: 12, color: C.dim, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            if (n.kind == 'asked') ...[
              const SizedBox(height: 6),
              // Only the newest question of a task still waiting can be answered here
              if (x != null && x.asking && x.question == n.text)
                ReplyBox(key: ValueKey('reply-card-${x.id}'), bench: bench, task: x, showLabel: false)
              else ...[
                SelectableText(n.text, style: TextStyle(fontSize: 13, color: C.ink, height: 1.5)),
                const SizedBox(height: 3),
                Text(tr('ev.over'), style: TextStyle(fontSize: 11, color: C.dim2)),
              ],
            ],
            if (n.kind == 'approval') ...[
              const SizedBox(height: 6),
              SelectableText(n.text, style: _mono.copyWith(color: C.warn)),
              if (x != null && x.status == 'waiting' && x.approvalId == n.approval) ...[
                const SizedBox(height: 6),
                _ApproveRow(bench: bench, task: x),
              ],
            ],
            if (n.kind == 'done' && n.files.isNotEmpty) ...[
              const SizedBox(height: 6),
              AttachmentList(api: bench.api, files: n.files),
            ],
            if ((n.kind == 'done' || n.kind == 'failed') && n.text.isNotEmpty) ...[
              const SizedBox(height: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 220),
                child: SingleChildScrollView(child: SelectableText(n.text, style: _mono)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ApproveRow extends StatelessWidget {
  const _ApproveRow({required this.bench, required this.task});
  final Workbench bench;
  final Task task;

  // The label on a line of its own and the buttons free to wrap: the side panel is only 290px wide.
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(tr('ap.asks'), style: TextStyle(fontSize: 11.5, color: C.warn)),
      const SizedBox(height: 4),
      Wrap(
        spacing: 6,
        runSpacing: 4,
        children: [
          TextButton(onPressed: () => bench.answerTaskApproval(task, false), child: Text(tr('ap.deny'))),
          FilledButton(onPressed: () => bench.answerTaskApproval(task, true), child: Text(tr('ap.approve'))),
        ],
      ),
    ],
  );
}

/// Answer a task's question. The answer goes to the task only — not into the
/// conversation, so a password stays out of everyone's context.
class ReplyBox extends StatefulWidget {
  const ReplyBox({super.key, required this.bench, required this.task, this.showLabel = true});

  final Workbench bench;
  final Task task;
  final bool showLabel;

  @override
  State<ReplyBox> createState() => _ReplyBoxState();
}

class _ReplyBoxState extends State<ReplyBox> {
  final _text = TextEditingController();
  bool _sending = false;
  String? _done;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final err = await widget.bench.answerTask(widget.task, text);
    if (!mounted) return;
    setState(() {
      _sending = false;
      _done = err ?? tr('tk.sent');
    });
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.bench.agentById(widget.task.agentId)?.name ?? '';
    if (_done != null) return Text(_done!, style: TextStyle(fontSize: 11.5, color: C.dim));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.showLabel) Text(tr('tk.asks', {'name': name}), style: TextStyle(fontSize: 11, color: C.dim)),
        SelectableText(widget.task.question, style: TextStyle(fontSize: 13, color: C.ink, height: 1.5)),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _text,
                enabled: !_sending,
                onSubmitted: (_) => _send(),
                style: const TextStyle(fontSize: 12.5),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: tr('tk.replyHint'),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
                ),
              ),
            ),
            const SizedBox(width: 6),
            FilledButton(onPressed: _sending ? null : _send, child: Text(tr('tk.send'))),
          ],
        ),
      ],
    );
  }
}

/// The right panel's list. A row expands to its brief, question, report, what
/// it ran (fetched when opened) and a Stop button.
class TaskList extends StatefulWidget {
  const TaskList({super.key, required this.bench});
  final Workbench bench;

  @override
  State<TaskList> createState() => _TaskListState();
}

class _TaskListState extends State<TaskList> {
  int? _open;
  final Map<int, List<TaskStep>> _trace = {};

  static (Color, Color) pill(String status) => switch (status) {
    'waiting' => (C.warn, C.warnBg),
    'failed' => (C.bad, C.badBg),
    'queued' || 'running' => (C.tintInk, C.tint),
    _ => (C.dim, C.selected),
  };

  @override
  Widget build(BuildContext context) {
    final bench = widget.bench;
    if (bench.tasks.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
        child: Text(tr('tk.none'), style: TextStyle(fontSize: 11.5, color: C.dim2, height: 1.45)),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final x in bench.tasks) _row(x)],
    );
  }

  Widget _row(Task x) {
    final bench = widget.bench;
    final (fg, bg) = pill(x.status);
    final open = _open == x.id;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: () => setState(() => _open = open ? null : x.id),
            child: Container(
              color: open ? C.hover : null,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(5)),
                        child: Text(tr('tk.st.${x.status}'), style: TextStyle(fontSize: 10.5, color: fg)),
                      ),
                      const SizedBox(width: 6),
                      Text('#${x.id}', style: TextStyle(fontSize: 12.5, color: C.dim2)),
                      const SizedBox(width: 5),
                      Expanded(
                        child: Text(x.title, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                      ),
                    ],
                  ),
                  Text(
                    bench.agentById(x.agentId)?.name ?? x.agentId,
                    style: TextStyle(fontSize: 11.5, color: C.dim2),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (open) _detail(x),
      ],
    );
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(top: 6, bottom: 3),
    child: Text(text, style: TextStyle(fontSize: 11, color: C.dim)),
  );

  Widget _box(String text) => Container(
    width: double.infinity,
    constraints: const BoxConstraints(maxHeight: 160),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    decoration: BoxDecoration(
      color: C.tool,
      borderRadius: BorderRadius.circular(7),
      border: Border.all(color: C.line),
    ),
    child: SingleChildScrollView(child: SelectableText(text, style: _mono)),
  );

  Widget _detail(Task x) {
    final bench = widget.bench;
    final by = x.byAgent.isNotEmpty && x.byAgent != x.agentId ? bench.agentById(x.byAgent)?.name : null;
    final steps = _trace[x.id];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (by != null) Text(tr('tk.by', {'name': by}), style: TextStyle(fontSize: 11.5, color: C.dim2)),
          if (x.brief.isNotEmpty) ...[_label(tr('tk.brief')), _box(x.brief)],
          if (x.asking) ...[
            const SizedBox(height: 6),
            ReplyBox(key: ValueKey('reply-row-${x.id}-${x.question}'), bench: bench, task: x),
          ],
          if (x.status == 'waiting' && x.approvalId != null) ...[
            _label(tr('tk.wantsRun', {'name': bench.agentById(x.agentId)?.name ?? ''})),
            SelectableText(x.approvalSubject, style: _mono.copyWith(color: C.warn)),
            _ApproveRow(bench: bench, task: x),
          ],
          if (x.result.isNotEmpty) ...[_label(tr('tk.result')), _box(x.result)],
          TextButton(
            style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 30)),
            onPressed: () async {
              final got = await bench.api.taskTrace(x.id).catchError((_) => <TaskStep>[]);
              if (mounted) setState(() => _trace[x.id] = got);
            },
            child: Text(
              steps == null ? tr('tk.trace') : tr('tk.traceN', {'n': steps.length}),
              style: const TextStyle(fontSize: 11.5),
            ),
          ),
          if (steps != null)
            for (final s in steps) ...[
              Text(s.name, style: _mono.copyWith(color: C.tintInk)),
              if (s.output.isNotEmpty) _box(s.output),
              const SizedBox(height: 4),
            ],
          if (x.open)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: OutlinedButton(onPressed: () => bench.stopTask(x), child: Text(tr('tk.stop'))),
            ),
        ],
      ),
    );
  }
}
