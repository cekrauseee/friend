import type { ConversationTurn } from './text-conversation.ts'
import type { InterfaceSound } from './interface-sounds.ts'

export function conversationOutcomeSound(previous: ConversationTurn | undefined, current: ConversationTurn | undefined): InterfaceSound | null {
  if (!previous || !current || previous.id !== current.id || previous.status === current.status) return null
  if (previous.status !== 'waiting' && previous.status !== 'streaming') return null
  if (current.status === 'complete') return 'receive'
  if (current.status === 'failed' && current.error !== 'Reply canceled.') return 'error'
  return null
}
