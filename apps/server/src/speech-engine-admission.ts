/** One-shot, expiring admission for IDs issued by the local conversation token API. */
export function createSpeechEngineAdmission({
  ttlMs = 5 * 60_000, maxEntries = 256, now = Date.now,
}: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Invalid Speech Engine admission limits.')
  }
  const entries = new Map<string, { expires: number; consumed: boolean }>()
  const prune = () => {
    for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id)
  }
  return {
    register(id: string) {
      prune()
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(id) || entries.has(id) || entries.size >= maxEntries) return false
      entries.set(id, { expires: now() + ttlMs, consumed: false })
      return true
    },
    consume(id: string) {
      prune()
      const entry = entries.get(id)
      if (!entry || entry.consumed) return false
      // Retain consumed entries until expiry so a duplicate issuance cannot reopen admission.
      entry.consumed = true
      return true
    },
    clear() { entries.clear() },
  }
}
