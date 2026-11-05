/// Teaching by demonstration: after a person records what they did in an agent's browser, the steps are shown,
/// mistakes can be removed, a sentence says what it was for, and the agent's model drafts a skill — which opens in
/// the skill library for the person to read and save. Nothing here saves a skill.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../theme/app_theme.dart';
import '../settings/skills_page.dart';

/// The steps dialog. Resolves to the draft, or null when the person discarded it.
Future<SkillDraft?> showTeachDialog(
  BuildContext context, {
  required Api api,
  required String agentId,
  required String name,
  required Recording recording,
}) => showDialog<SkillDraft>(
  context: context,
  barrierDismissible: false,
  builder: (_) =>
      TeachDialog(api: api, agentId: agentId, name: name, recording: recording),
);

/// The draft in the skill library, ticked for the agent it was drafted for.
Future<void> openDraft(BuildContext context, Api api, SkillDraft draft) async {
  List<Agent> agents = const [];
  try {
    agents = await api.agents();
  } on ApiException {
    // The editor still works; the agent's tick shows its id until the list loads next time.
  }
  if (!context.mounted) return;
  await Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => SkillsPage(
        api: api,
        agents: agents,
        preselect: draft.agents,
        draft: draft,
      ),
    ),
  );
}

class TeachDialog extends StatefulWidget {
  const TeachDialog({
    super.key,
    required this.api,
    required this.agentId,
    required this.name,
    required this.recording,
  });
  final Api api;
  final String agentId, name;
  final Recording recording;

  @override
  State<TeachDialog> createState() => _TeachDialogState();
}

class _TeachDialogState extends State<TeachDialog> {
  late final List<Map<String, Object?>> _steps = [...widget.recording.steps];
  late final List<String> _lines = [...widget.recording.lines];
  final _goal = TextEditingController();
  bool _busy = false;
  String _msg = '';
  bool _bad = false;

  @override
  void dispose() {
    _goal.dispose();
    super.dispose();
  }

  void _remove(int i) => setState(() {
    _lines.removeAt(i);
    if (i < _steps.length) _steps.removeAt(i);
  });

  Future<void> _draft() async {
    setState(() {
      _busy = true;
      _bad = false;
      _msg = tr('teach.drafting', {'name': widget.name});
    });
    try {
      final d = await widget.api.draftSkill(
        widget.agentId,
        goal: _goal.text.trim(),
        steps: _steps,
      );
      if (mounted) Navigator.of(context).pop(d);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _bad = true;
          _msg = e.message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // Scrollable as a whole: on a phone the hint, the list and the goal field don't fit together.
    return AlertDialog(
      scrollable: true,
      title: Text(
        tr('teach.title', {'name': widget.name}),
        style: const TextStyle(fontSize: 15),
      ),
      content: SizedBox(
        width: 560,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              tr('teach.hint', {'name': widget.name}),
              style: TextStyle(fontSize: 12, color: C.dim),
            ),
            const SizedBox(height: 10),
            // A plain column, not a list view: a scrollable dialog measures its content, which a lazy list can't do.
            for (var i = 0; i < _lines.length; i++)
              Row(
                key: ValueKey('step-$i-${_lines[i]}'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 26,
                    child: Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        '${i + 1}.',
                        style: TextStyle(fontSize: 13, color: C.dim),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        _lines[i],
                        style: const TextStyle(fontSize: 13, height: 1.4),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: tr('teach.remove'),
                    visualDensity: VisualDensity.compact,
                    onPressed: _busy ? null : () => _remove(i),
                    icon: Icon(Icons.close, size: 15, color: C.dim2),
                  ),
                ],
              ),
            const SizedBox(height: 10),
            TextField(
              key: const ValueKey('teach-goal'),
              controller: _goal,
              minLines: 2,
              maxLines: 4,
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                hintText: tr('teach.goalHint'),
                hintMaxLines: 3,
              ),
            ),
            if (_msg.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                _msg,
                style: TextStyle(fontSize: 12, color: _bad ? C.code : C.dim),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(tr('teach.discard')),
        ),
        FilledButton(
          onPressed: _busy || _lines.isEmpty ? null : _draft,
          child: Text(tr('teach.draft')),
        ),
      ],
    );
  }
}
