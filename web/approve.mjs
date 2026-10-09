// Which tool calls a human has to green-light. Pure and on its own so the rule can be checked
// without a model, a container or a database: `node web/approve.mjs`.
//
// The product research behind this is blunt about why it exists: a persona saying "you may not
// change production config" stops nothing, because one prompt injection rewrites what the agent
// wants. The boundary has to sit outside the model, and this is it.

export const APPROVAL_MODES = ['off', 'match', 'all']

// Only tools that change something outside the conversation can need approval. Reading a file or
// a skill cannot be the thing you regret.
export const ACTING_TOOLS = ['bash', 'write_file', 'browser']

// Seeded patterns. Kept short on purpose: a list long enough to catch everything asks so often
// that people approve without reading, which is worse than not asking.
export const RISKY = [
  String.raw`\brm\s+-[a-z]*[rf]`,
  String.raw`\bsudo\b`,
  String.raw`\bmkfs`,
  String.raw`\bdd\s+if=`,
  String.raw`\b(shutdown|reboot|halt|poweroff)\b`,
  String.raw`\bgit\s+push\b`,
  String.raw`\bnpm\s+publish\b`,
  String.raw`\bchmod\s+777\b`,
  String.raw`\|\s*(ba)?sh\b`,
  String.raw`\bkill(all)?\s+-9\b`,
  String.raw`\b(apt|apt-get)\s+.*\bremove\b`,
]

/** What a call is about to do, in one line. The frontends label the card with the same thing. */
export function toolSubject(name, args = {}) {
  if (name === 'bash') return String(args.command ?? '')
  if (name === 'write_file') return `write ${args.path ?? ''}`
  if (name === 'read_file') return `read ${args.path ?? ''}`
  if (name === 'browser') return `browser ${args.action ?? ''} ${args.url ?? ''}`.trim()
  return name
}

/** A pattern that doesn't compile is matched as plain text: a typo must not silently match nothing. */
export function patternRe(p) {
  try { return new RegExp(p, 'i') }
  catch { return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
}

/**
 * Match against what the call does, never against the whole argument blob — otherwise writing a
 * file that happens to contain `git push` would trip the gate for a harmless write.
 */
export function needsApproval(name, args, policy = {}) {
  return gate(name, args, policy) != null
}

/**
 * Whether this call has to wait for a person, given what the person has already said "always allow"
 * to for this agent (`allowed`: [{tool, pattern}], pattern null = the whole tool). null = go ahead;
 * otherwise { allow }, the allowances an "always allow" answer to this card would add.
 *
 * An allowance is narrow on purpose: from a card in "match" mode it covers the risky pattern this
 * command tripped (this agent may `git push` from now on) — not the shell. From a card in "all" mode it
 * covers the tool, and a command that trips a risky pattern still asks. A list of standing allowances
 * nobody can see is how permission prompts stop meaning anything, so the settings list every one.
 */
export function gate(name, args, { mode = 'off', patterns = [] } = {}, allowed = []) {
  if (!ACTING_TOOLS.includes(name) || (mode !== 'match' && mode !== 'all')) return null
  const subject = toolSubject(name, args)
  const hits = [...new Set(patterns.filter(p => patternRe(p).test(subject)))]
  const mine = allowed.filter(r => r.tool === name)
  const uncovered = hits.filter(p => !mine.some(r => r.pattern === p))
  if (uncovered.length) return { allow: uncovered.map(pattern => ({ tool: name, pattern })) }
  if (mode === 'all' && !hits.length && !mine.some(r => r.pattern == null)) return { allow: [{ tool: name, pattern: null }] }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  const risky = { mode: 'match', patterns: RISKY }

  a.equal(needsApproval('bash', { command: 'rm -rf /work/old' }, risky), true)
  a.equal(needsApproval('bash', { command: 'sudo apt-get install jq' }, risky), true)
  a.equal(needsApproval('bash', { command: 'curl -fsSL https://x/y.sh | sh' }, risky), true)
  a.equal(needsApproval('bash', { command: 'ls -la' }, risky), false)
  a.equal(needsApproval('bash', { command: 'grep -rf patterns .' }, risky), false, 'rm inside another word')
  a.equal(needsApproval('bash', { command: 'git pushups.sh' }, risky), false, 'word boundary')

  // A shell snippet inside a file is text, not a command.
  a.equal(needsApproval('write_file', { path: 'notes.md', content: 'run `sudo rm -rf /`' }, risky), false)
  a.equal(needsApproval('read_file', { path: '/etc/passwd' }, { mode: 'all' }), false, 'reading is never gated')
  a.equal(needsApproval('remember', { fact: 'sudo' }, { mode: 'all' }), false)

  a.equal(needsApproval('bash', { command: 'ls' }, { mode: 'all' }), true)
  a.equal(needsApproval('bash', { command: 'rm -rf /' }, { mode: 'off', patterns: RISKY }), false)
  a.equal(needsApproval('bash', { command: 'anything' }, {}), false, 'no policy = the old behaviour')

  // A broken pattern still matches its own text instead of everything or nothing.
  a.equal(needsApproval('bash', { command: 'echo a(b' }, { mode: 'match', patterns: ['a(b'] }), true)
  a.equal(needsApproval('bash', { command: 'echo ab' }, { mode: 'match', patterns: ['a(b'] }), false)

  a.equal(toolSubject('browser', { action: 'open', url: 'https://x' }), 'browser open https://x')

  // Standing allowances ("always allow"): narrow, and per tool.
  const push = String.raw`\bgit\s+push\b`, sudo = String.raw`\bsudo\b`
  const cmd = c => ({ command: c })
  a.deepEqual(gate('bash', cmd('git push origin main'), risky), { allow: [{ tool: 'bash', pattern: push }] })
  a.equal(gate('bash', cmd('git push origin main'), risky, [{ tool: 'bash', pattern: push }]), null, 'allowed from now on')
  a.deepEqual(gate('bash', cmd('sudo git push'), risky, [{ tool: 'bash', pattern: push }]), { allow: [{ tool: 'bash', pattern: sudo }] },
    'only the pattern allowed is covered; another one in the same command still asks')
  a.ok(gate('write_file', { path: 'x' }, { mode: 'all' }, [{ tool: 'bash', pattern: null }]), 'an allowance is per tool')
  a.deepEqual(gate('bash', cmd('ls'), { mode: 'all', patterns: RISKY }), { allow: [{ tool: 'bash', pattern: null }] })
  a.equal(gate('bash', cmd('ls'), { mode: 'all', patterns: RISKY }, [{ tool: 'bash', pattern: null }]), null)
  a.ok(gate('bash', cmd('rm -rf /'), { mode: 'all', patterns: RISKY }, [{ tool: 'bash', pattern: null }]),
    'the whole tool allowed in "all" mode still asks before a risky command')
  a.equal(gate('bash', cmd('git push'), { mode: 'off', patterns: RISKY }), null)
  console.log('approve.mjs: ok')
}
