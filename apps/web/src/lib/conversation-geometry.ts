export const GEOMETRY_EPSILON = 0.75
export const JUMP_DISTANCE_PX = 80

export function sendAlignment(input: {
  userTop: number
  topInset: number
  scrollHeight: number
  clientHeight: number
  spacerPx: number
}) {
  const target = Math.max(0, input.userTop - input.topInset)
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight)
  const extra = Math.max(0, target - maxScroll)
  return { target, extra, spacerPx: input.spacerPx + extra }
}

export function consumeReplyGrowth(spacerPx: number, maxHeightSeen: number, measuredHeight: number) {
  const nextMaxHeight = Math.max(maxHeightSeen, measuredHeight)
  const growth = nextMaxHeight - maxHeightSeen
  return { spacerPx: Math.max(0, spacerPx - growth), maxHeightSeen: nextMaxHeight }
}

export function consumeUpwardScroll(spacerPx: number, previousTop: number, currentTop: number, programmatic = false) {
  return programmatic ? spacerPx : Math.max(0, spacerPx - Math.max(0, previousTop - currentTop))
}

export function distanceToRealEnd(realEnd: number, scrollTop: number, clientHeight: number) {
  return realEnd - (scrollTop + clientHeight)
}

export function jumpTarget(realEnd: number, clientHeight: number, scrollHeight: number, bottomInset = 16) {
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  return Math.min(maxScroll, Math.max(0, realEnd - clientHeight + bottomInset))
}
