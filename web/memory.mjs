// An agent's self-notes: the one memory it writes itself, with the `remember` tool.
//
// Kept apart from the memory a human writes for it (settings key `memory:agent:<id>` vs
// `memory:agent:<id>:self`). An agent can only ever write its own notes — never the human's
// memory, never a group's, never another agent's.
//
// Self-test: node web/memory.mjs

export const NOTES_MAX_CHARS = 4000
export const NOTES_MAX_LINES = 40
export const NOTE_MAX_CHARS = 500

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Append one fact to the notes. Pure.
 *
 * Returns `{ text, duplicate, dropped, empty, tooLong }`:
 *   duplicate — the same line was already there (trimmed, case-insensitive); nothing changed
 *   dropped   — oldest lines thrown out to stay under the cap. The caller MUST pass these on to
 *               the agent: an agent that silently forgot something is worse than one that never
 *               remembered it.
 */
export function addNote(current, fact) {
  const lines = String(current ?? '').split('\n').map(s => s.trim()).filter(Boolean)
  const line = String(fact ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return { text: lines.join('\n'), empty: true, dropped: [] }
  if (line.length > NOTE_MAX_CHARS) return { text: lines.join('\n'), tooLong: true, dropped: [] }
  if (lines.some(l => same(l, line))) return { text: lines.join('\n'), duplicate: true, dropped: [] }

  lines.push(line)
  const dropped = []
  while (lines.length > NOTES_MAX_LINES || lines.join('\n').length > NOTES_MAX_CHARS) dropped.push(lines.shift())
  return { text: lines.join('\n'), dropped }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = (c, m) => { if (!c) throw new Error(`self-test: ${m}`) }

  let r = addNote('', '  Deploys go through   ./start.sh ')
  ok(r.text === 'Deploys go through ./start.sh', 'first note is trimmed and whitespace-collapsed')

  r = addNote('a\nb', 'c')
  ok(r.text === 'a\nb\nc' && !r.dropped.length, 'appends at the end')

  r = addNote('Deploys go through ./start.sh', 'deploys GO through ./start.sh')
  ok(r.duplicate && r.text === 'Deploys go through ./start.sh', 'duplicates are not stored twice')

  r = addNote('a\nb', '   ')
  ok(r.empty && r.text === 'a\nb', 'an empty fact changes nothing')

  r = addNote('a', 'x'.repeat(NOTE_MAX_CHARS + 1))
  ok(r.tooLong && r.text === 'a', 'one over-long fact is refused, not truncated')

  // Line cap: oldest first
  const many = Array.from({ length: NOTES_MAX_LINES }, (_, i) => `note ${i}`).join('\n')
  r = addNote(many, 'the newest one')
  ok(r.dropped.length === 1 && r.dropped[0] === 'note 0', 'over the line cap the oldest goes')
  ok(r.text.split('\n').length === NOTES_MAX_LINES && r.text.endsWith('the newest one'), 'stays at the line cap')

  // Character cap: several old lines may have to go for one long new one
  const fat = Array.from({ length: 12 }, (_, i) => `${i} ${'y'.repeat(380)}`).join('\n')
  r = addNote(fat, 'z'.repeat(NOTE_MAX_CHARS))
  ok(r.text.length <= NOTES_MAX_CHARS, 'stays under the character cap')
  ok(r.dropped.length > 1 && r.dropped[0].startsWith('0 '), 'drops as many old lines as it takes, oldest first')
  ok(r.text.endsWith('z'.repeat(NOTE_MAX_CHARS)), 'the new note survives the trim')

  // A human may paste something huge into the box; appending must still terminate and stay capped
  r = addNote('q'.repeat(9000), 'short one')
  ok(r.text === 'short one' && r.dropped.length === 1, 'an oversized existing note is dropped, not looped on')

  console.log('memory.mjs self-test passed')
}
