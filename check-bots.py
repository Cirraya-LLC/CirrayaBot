#!/usr/bin/env python3
"""Check every Bot definition under bots/. Don't commit if it fails.

It checks things that break silently, not style:
  - the two ways dsh marks a preset `broken` (unparseable YAML / not named plugin rows)
    — a broken preset shows up in the picker with a reason instead of raising an error
  - persona with complete: true — it makes the Bot's persona the only system prompt
    section, pushing out the approval / sandbox runtime context, i.e. a Bot's persona
    could delete the platform guardrails (CLAUDE.md 2.9)
  - duplicate toolName within one preset — dsh requires distinct toolNames per loaded instance
"""
import re, sys, pathlib, yaml

# dsh's loader understands !!js, pyyaml doesn't; this is only a syntax check, so treat it as an opaque scalar
yaml.SafeLoader.add_multi_constructor('!', lambda l, s, n: None)

ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]*$')
BOTS = pathlib.Path(__file__).parent / 'bots'
fails = []


def check(bot: pathlib.Path) -> None:
    def bad(msg): fails.append(f'{bot.name}: {msg}')

    if not ID_RE.match(bot.name):
        bad(f'directory name is not a valid preset id ({ID_RE.pattern}) — dsh skips it silently')

    meta_path, comp_path = bot / 'preset.yml', bot / 'agent.cordis.yml'
    if not comp_path.exists():
        return bad('missing agent.cordis.yml')

    if meta_path.exists():
        meta = yaml.safe_load(meta_path.read_text(encoding='utf-8'))
        if not isinstance(meta, dict) or not meta.get('name'):
            bad('preset.yml has no name — the picker would show only a directory name')
        elif not meta.get('description'):
            bad('preset.yml has no description — that is the Bot\'s Job, which whoever assigns work picks by')

    try:
        rows = yaml.safe_load(comp_path.read_text(encoding='utf-8'))
    except yaml.YAMLError as e:
        return bad(f'agent.cordis.yml failed to parse; dsh will list it as broken: {e}')

    if not isinstance(rows, list) or not rows:
        return bad('agent.cordis.yml top level must be a non-empty list of plugin rows')

    tool_names = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict) or 'id' not in row:
            bad(f'row {i + 1} is not a plugin row with an id')
            continue
        if 'name' not in row and not row.get('group'):
            bad(f"row {row['id']} has neither a name nor a group")

        cfg = row.get('config') or {}
        if not isinstance(cfg, dict):
            continue
        if str(row.get('name', '')).endswith('dsh-persona') and cfg.get('complete') is True:
            bad(f"row {row['id']}: persona sets complete: true — "
                'it pushes out the approval / sandbox runtime context; guardrails must come after the persona')
        if 'toolName' in cfg:
            tool_names.append(cfg['toolName'])

    dupes = {n for n in tool_names if tool_names.count(n) > 1}
    if dupes:
        bad(f'duplicate toolName: {sorted(dupes)} — dsh requires distinct toolNames per instance')


def main() -> int:
    bots = sorted(p for p in BOTS.iterdir() if p.is_dir()) if BOTS.is_dir() else []
    if not bots:
        print('no Bots under bots/', file=sys.stderr)
        return 1
    for bot in bots:
        check(bot)
    if fails:
        print('\n'.join(f'  ✗ {f}' for f in fails), file=sys.stderr)
        return 1
    print(f'all {len(bots)} Bots passed: {", ".join(b.name for b in bots)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
