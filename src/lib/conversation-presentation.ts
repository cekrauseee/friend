import type { CallStatus } from './live-session.ts'

export function conversationPresentation(
  turnCount: number,
  voiceStatus: CallStatus,
  requestedOpen: boolean,
  draft: string,
) {
  const calling = voiceStatus === 'connecting' || voiceStatus === 'connected' || voiceStatus === 'closing'
  return {
    calling,
    showLargeOrb: turnCount === 0,
    composerOpen: !calling && (turnCount > 0 || requestedOpen || Boolean(draft.trim())),
  }
}
