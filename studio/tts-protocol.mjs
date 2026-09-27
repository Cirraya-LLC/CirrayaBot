// Preserve the explicitly configured offline Kokoro service alongside upstream MiniMax.
// No automatic cloud fallback: a failed local request stays a failure.
export function localSpeech(cfg) {
  if (cfg?.model === 'kokoro-local') return true
  try { return new URL(cfg?.base).hostname === 'local-tts' } catch { return false }
}
