import type { Conversation } from '@elevenlabs/client'

/** SDK owns WebRTC, microphone capture, playback and the audio analysers. */
export type ElevenLabsConversation = Pick<Conversation,
  'endSession' | 'setMicMuted' | 'setVolume' | 'getInputByteFrequencyData' | 'getInputVolume' | 'getOutputVolume'>

export interface ElevenLabsOptions {
  conversationToken: string
  connectionType: 'webrtc'
  onConversationCreated: (conversation: ElevenLabsConversation) => void
  onConnect: () => void
  onDisconnect: (details: { reason: 'error' | 'agent' | 'user' }) => void
  onError: () => void
  onModeChange: (event: { mode: 'speaking' | 'listening' }) => void
  onInterruption: () => void
}

export type StartElevenLabs = (options: ElevenLabsOptions) => Promise<ElevenLabsConversation>

export const startElevenLabs: StartElevenLabs = async (options) => {
  const { Conversation } = await import('@elevenlabs/client')
  return Conversation.startSession(options)
}
