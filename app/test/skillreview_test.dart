import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/settings/skills_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
// The server is stood in for; the server side has its own e2e test (test/e2e/skillreview.test.mjs).
Skill _skill(String id, String name, {int uses = 0, bool archived = false}) => Skill.fromJson({
  'id': id, 'name': name, 'description': 'When $name', 'body': 'b', 'agents': ['kim'], 'source': 'human', 'uses': uses,
  'used_at': uses > 0 ? DateTime.now().subtract(const Duration(days: 2)).toUtc().toIso8601String() : null,
  'archived_at': archived ? '2026-11-01T00:00:00Z' : null,
});

final _merge = SkillSuggestion.fromJson({
  'id': 'sg1', 'kind': 'merge', 'agent_name': 'Kim', 'why': 'The same steps twice',
  'skills': [{'id': 'k1', 'name': 'Deploy'}, {'id': 'k2', 'name': 'Release'}],
  'draft': {'name': 'Deploy', 'description': 'When deploying or releasing', 'body': '1. Build'},
});
final _archive = SkillSuggestion.fromJson({
  'id': 'sg2', 'kind': 'archive', 'agent_name': 'Kim', 'why': 'Never used, added 40 days ago', 'skills': [{'id': 'k3', 'name': 'Old habit'}],
});

class _FakeApi extends Api {
  _FakeApi() : super(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
  var skillRows = [_skill('k1', 'Deploy', uses: 3), _skill('k2', 'Release'), _skill('k3', 'Old habit')];
  var open = <SkillSuggestion>[];
  final answered = <String>[];
  bool? weekly;
  String? reviewed;

  @override
  Future<List<Skill>> skills() async => skillRows;
  @override
  Future<({List<AgentTemplate> agents, List<SkillTemplate> skills})> templates() async => (agents: <AgentTemplate>[], skills: <SkillTemplate>[]);
  @override
  Future<List<SkillSuggestion>> skillSuggestions() async => open;
  @override
  Future<bool> skillReviewWeekly() async => false;
  @override
  Future<void> setSkillReviewWeekly(bool on) async => weekly = on;
  @override
  Future<({int added, String problem, List<SkillSuggestion> suggestions})> reviewSkills(String agentId) async {
    reviewed = agentId;
    open = [_merge, _archive];
    return (added: 2, problem: '', suggestions: open);
  }

  @override
  Future<({List<SkillSuggestion> suggestions, List<Skill> skills})> answerSuggestion(String id, String action) async {
    answered.add('$id:$action');
    open = open.where((x) => x.id != id).toList();
    if (id == 'sg1' && action == 'apply') skillRows = [_skill('k1', 'Deploy', uses: 3), _skill('k2', 'Release', archived: true), _skill('k3', 'Old habit')];
    return (suggestions: open, skills: skillRows);
  }
}

const _kim = Agent(id: 'kim', name: 'Kim', description: '', persona: 'p', color: '#4f8cff');

void main() {
  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 700), 1.3)]) {
    testWidgets('review, apply, dismiss, archived section at ${size.width.toInt()} ×$scale', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final api = _FakeApi();
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: SkillsPage(api: api, agents: const [_kim], preselect: const ['kim']),
      ));
      await tester.pumpAndSettle();
      expect(find.textContaining(tr('skills.never')), findsNWidgets(2));
      expect(find.textContaining('used 3×'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('skills-review')));
      await tester.pumpAndSettle();
      expect(api.reviewed, 'kim');
      expect(find.byKey(const ValueKey('suggestion-sg1')), findsOneWidget);
      expect(find.text('Never used, added 40 days ago'), findsOneWidget);
      expect(find.textContaining('2 new suggestion'), findsOneWidget);

      final apply = find.descendant(of: find.byKey(const ValueKey('suggestion-sg1')), matching: find.text(tr('skills.apply')));
      await tester.ensureVisible(apply);
      await tester.tap(apply);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('suggestion-sg1')), findsNothing);
      expect(find.text(tr('skills.archived')), findsOneWidget, reason: 'Release went to the archived section');

      await tester.ensureVisible(find.descendant(of: find.byKey(const ValueKey('suggestion-sg2')), matching: find.text(tr('skills.dismiss'))));
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('suggestion-sg2')), matching: find.text(tr('skills.dismiss'))));
      await tester.pumpAndSettle();
      expect(api.answered, ['sg1:apply', 'sg2:dismiss']);

      await tester.ensureVisible(find.byKey(const ValueKey('skills-weekly')));
      await tester.tap(find.byKey(const ValueKey('skills-weekly')));
      await tester.pumpAndSettle();
      expect(api.weekly, true);

      await tester.ensureVisible(find.text('Release'));
      await tester.tap(find.text('Release'));
      await tester.pumpAndSettle();
      expect(find.text(tr('skills.restore')), findsOneWidget);
      expect(find.textContaining(tr('skills.archivedNote')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
