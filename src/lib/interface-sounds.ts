import { createUISFX, type CueName, type PlayOptions, type UISFXPlayer } from 'uisfx'
import { createAgentTyping, agentTypingRhythm } from './agent-typing.ts'

// Values are per-cue gains beneath a quiet master gain of 0.5.
export const interfaceSoundCues = {
  openComposer: { cue: 'open', volume: 0.10 },
  composerTyping: { cue: 'typing', volume: 0.16, cooldownMs: 0, retrigger: 'restart' },
  agentTyping: { cue: 'typing', volume: 0.10, cooldownMs: agentTypingRhythm.minimumMs, retrigger: 'restart' },
  send: { cue: 'send', volume: 0.22 },
  receive: { cue: 'receive', volume: 0.18 },
  retry: { cue: 'retry', volume: 0.15 },
  error: { cue: 'error', volume: 0.22 },
  authenticated: { cue: 'success', volume: 0.16 },
  callEnded: { cue: 'disconnect', volume: 0.15 },
} satisfies Record<string, { cue: CueName } & PlayOptions>

export type InterfaceSound = Exclude<keyof typeof interfaceSoundCues, 'agentTyping'>

export function createInterfaceSounds(
  player: UISFXPlayer | null,
  visible: () => boolean = () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  typingFactory: () => ReturnType<typeof createAgentTyping> = () => createAgentTyping(),
) {
  const listeners = new Set<() => void>()
  let unlocked = false
  let unlocking: Promise<boolean> | null = null
  let voiceActive = false
  let generation = 0
  let typingId: string | null = null
  let typing: ReturnType<typeof createAgentTyping> | null = null
  const resetAgentTyping = (id?: string) => {
    if (id !== undefined && id !== typingId) return
    typingId = null
    typing = null
  }
  const enabled = () => player?.isEnabled() ?? false
  const unlock = () => {
    if (!player || !enabled() || !visible()) return Promise.resolve(false)
    if (unlocked) return Promise.resolve(true)
    if (unlocking) return unlocking
    const attempt = generation
    try {
      unlocking = player.unlock().catch(() => false).then((ready) => {
        if (attempt === generation) { unlocked = ready; unlocking = null }
        return ready
      })
      return unlocking
    } catch { return Promise.resolve(false) }
  }
  const stop = () => {
    generation++
    unlocked = false
    unlocking = null
    resetAgentTyping()
    player?.stopAll()
  }
  const emit = (sound: keyof typeof interfaceSoundCues, interaction = false, variation: PlayOptions = {}) => {
    if (!player || !enabled() || !visible() || voiceActive) return
    if (interaction) void unlock()
    else if (!unlocked) return
    const { cue, ...options } = interfaceSoundCues[sound]
    // An unavailable audio device must never interrupt the interaction.
    try { player.play(cue, { ...options, ...variation }) } catch { /* Keep the visible feedback. */ }
  }
  const play = (sound: InterfaceSound, interaction = false) => {
    if (sound === 'receive' || sound === 'error') resetAgentTyping()
    emit(sound, interaction)
  }
  return {
    unlock, play, stop, resetAgentTyping,
    playAgentTyping(id: string, text: string, accelerated = false) {
      if (!player || !enabled() || !visible() || voiceActive || !unlocked) return
      if (id !== typingId) { typingId = id; typing = typingFactory() }
      const variation = typing?.select(text, accelerated)
      if (variation) emit('agentTyping', false, variation)
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: enabled,
    getServerSnapshot: () => false,
    setEnabled(value: boolean) {
      if (!player) return
      if (!value) stop()
      player.setEnabled(value)
      listeners.forEach((listener) => listener())
      if (value) void unlock()
    },
    setVoiceActive(value: boolean) {
      if (value && !voiceActive) { player?.stopAll(); resetAgentTyping() }
      voiceActive = value
    },
    async dispose() { stop(); await player?.destroy() },
  }
}

export function migrateSoundPreference(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  if (storage.getItem('dot:interface-sounds') !== null) return
  const previous = storage.getItem('friend:interface-sounds')
  if (previous !== null) storage.setItem('dot:interface-sounds', previous)
}

function createDotSoundPlayer() {
  if (typeof window === 'undefined') return null
  try { migrateSoundPreference(window.localStorage) } catch { /* Storage may be unavailable. */ }
  return createUISFX({ pack: 'zen', volume: 0.5, maxVoices: 3, preferences: { key: 'dot:interface-sounds' } })
}

// One player survives React remounts. UISFX creates AudioContext only on intent.
export const interfaceSounds = createInterfaceSounds(createDotSoundPlayer())

if (import.meta.hot) import.meta.hot.dispose(() => { void interfaceSounds.dispose() })
