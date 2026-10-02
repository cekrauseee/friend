import { useSyncExternalStore } from 'react'
import { accentPreference } from '../lib/accent-preference.ts'

export function useAccentPreference() {
  return useSyncExternalStore(accentPreference.subscribe, accentPreference.getSnapshot, accentPreference.getServerSnapshot)
}
