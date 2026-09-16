// Context budget: trim history to what the model can actually hold.
//
// Before this it was "keep the last 40 messages". 40 short messages waste 90% of the
// window, and 40 messages containing one 12,000-character bash output overflow it —
// and overflow shows up as an upstream 400 that looks like "the model is broken".
// A token budget is the right unit.

/**
 * Estimate tokens. CJK is roughly 1 token per character, English roughly 4 characters
 * per token, so weighting by character class is far steadier than dividing by 4 (which
 * underestimates pure Chinese threefold). An estimate, not a tokenizer — hence the
 * margin in fitContext's `reserve`.
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) if (ch.codePointAt(0) > 0x2e80) cjk++
  return Math.ceil(cjk + (s.length - cjk) / 3.6)
}

const msgTokens = m => estimateTokens(m.content ?? '') +
  estimateTokens(JSON.stringify(m.tool_calls ?? '')) + 8   // 8 ≈ role and separator overhead

/**
 * Keep messages from the end backwards while they fit.
 * - system (the first) is always kept: it is the persona and the rules; without it the Agent is someone else
 * - an assistant(tool_calls) + tool-result pair is never split: half a pair gets an upstream 400
 * @returns {{messages: Array, dropped: number}}
 */
export function fitContext(messages, contextTokens, reserve = 4096) {
  const budget = Math.max(2000, contextTokens - reserve)
  const [system, ...rest] = messages[0]?.role === 'system' ? messages : [null, ...messages]

  let used = system ? msgTokens(system) : 0
  const keep = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = msgTokens(rest[i])
    if (used + t > budget && keep.length) break
    used += t
    keep.unshift(rest[i])
  }
  // Can't start with an orphan tool result — its assistant(tool_calls) was trimmed away
  while (keep.length && keep[0].role === 'tool') keep.shift()

  return {
    messages: system ? [system, ...keep] : keep,
    dropped: rest.length - keep.length,
  }
}

// Model name → context window. Fallback only when the upstream's /models doesn't say.
// A number guessed from the name MUST be marked as a guess in the UI — a silently wrong
// window makes long conversations start failing with 400 one day and nobody knows why.
const KNOWN = [
  [/gpt-4\.1|gpt-5/, 400_000],
  [/gpt-4o|gpt-4-turbo/, 128_000],
  [/^o[1-9]/, 200_000],
  [/claude.*(sonnet|opus)-[45]/, 200_000],
  [/claude/, 200_000],
  [/gemini-(1\.5|2|3)/, 1_000_000],
  [/deepseek/, 128_000],
  [/qwen|glm|kimi|moonshot/, 131_072],
  [/grok-[45]/, 256_000],
  [/grok/, 131_072],
  [/llama-?3|mistral|mixtral/, 128_000],
]

export function guessContext(model) {
  const m = String(model ?? '').toLowerCase()
  for (const [re, n] of KNOWN) if (re.test(m)) return n
  return null
}

/** Ask the upstream's /models for the raw list. null when it can't be asked (not [] — "no models" and "couldn't ask" differ). */
async function fetchModelList({ base_url, api_key, protocol }) {
  try {
    const r = await fetch(`${base_url.replace(/\/+$/, '')}/models`, {
      // The Anthropic protocol's /models takes x-api-key, not Bearer
      headers: !api_key ? {} : protocol === 'messages'
        ? { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${api_key}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return null
    const list = (await r.json())?.data
    return Array.isArray(list) ? list : null
  } catch { return null }
}

/** The upstream's models (for the Agent editor's dropdown). */
export async function listModels(p) {
  const list = await fetchModelList(p)
  if (!list) return null
  return [...new Set(list.map(x => String(x?.id ?? '')).filter(Boolean))].sort()
}

/**
 * Ask the upstream for this model's context window.
 * OpenAI's own /models omits it, but OpenRouter / vLLM / ollama / most relay gateways
 * return it — so ask first, then guess from the name, and otherwise admit we don't know.
 */
export async function probeContext({ base_url, api_key, model, protocol }) {
  const list = await fetchModelList({ base_url, api_key, protocol })
  if (list) {
    const hit = list.find(x => x?.id === model) ?? list.find(x => String(x?.id ?? '').includes(model))
    const n = hit && (hit.context_length ?? hit.context_window ?? hit.max_context_length ??
                      hit.max_model_len ?? hit.top_provider?.context_length)
    if (Number(n) > 0) return { tokens: Number(n), source: 'upstream /models', exact: true }
  }
  const g = guessContext(model)
  if (g) return { tokens: g, source: 'guessed from the model name (may be wrong)', exact: false }
  return { tokens: null, source: 'unknown, please enter it manually', exact: false }
}

// Self-test: node web/model.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (c, m) => { if (!c) throw new Error('self-test failed: ' + m); }
  a(estimateTokens('\u4f60\u597d\u4e16\u754c') === 4, 'CJK counts per character')
  a(estimateTokens('hello world!') === 4, `English counts 3.6 chars per token, got ${estimateTokens('hello world!')}`)

  const sys = { role: 'system', content: 'S' }
  const many = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: 'this is a fairly long test message ' + i }))
  const fit = fitContext([sys, ...many], 3000, 500)
  a(fit.messages[0] === sys, 'system must be kept')
  a(fit.messages.length < 201 && fit.dropped > 0, 'must trim when over budget')
  a(fit.messages.every(m => m.role !== 'tool'), 'must not start with an orphan tool')

  const pair = [sys, { role: 'assistant', content: null, tool_calls: [{ id: '1' }] }, { role: 'tool', content: 'x' }]
  a(fitContext(pair, 100_000).messages.length === 3, 'leave it alone if it fits')
  a(fitContext([sys, { role: 'tool', content: 'x'.repeat(50_000) }], 3000).messages.length === 1, 'orphan tool is dropped')

  a(guessContext('claude-opus-5') === 200_000, 'claude fallback')
  a(guessContext('some-unknown-model') === null, 'unknown means null, never a wild guess')
  console.log('model.mjs self-test passed')
}
