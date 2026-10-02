/** SDP must include ICE candidates before it is exchanged with GPT-Live. */
export function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      peer.removeEventListener('icegatheringstatechange', check)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (peer.iceGatheringState === 'complete') finish()
    }
    const abort = () => finish(new DOMException('Connection canceled', 'AbortError'))
    const timeout = setTimeout(() => finish(new Error('Could not connect. Please try again.')), 10_000)
    peer.addEventListener('icegatheringstatechange', check)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else check()
  })
}
