import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { LiveSession } from '../src/lib/live-session.ts'

let contexts, peers, players, frames, getUserMedia, fetchSession, savedGlobals, nextFrame
const sessions = []

function stream() {
  const track = { kind: 'audio', enabled: true, stopped: false, onended: null,
    stop() { this.stopped = true } }
  return { track, level: 0, getTracks: () => [track], getAudioTracks: () => [track] }
}

class Context {
  state = 'running'
  destination = {}
  analysers = []
  constructor() { contexts.push(this) }
  async resume() {}
  async close() { this.state = 'closed' }
  createAnalyser() {
    const analyser = {
      fftSize: 1024, frequencyBinCount: 512, stream: null,
      connect: mock.fn(), disconnect: mock.fn(),
      getFloatTimeDomainData(data) { data.fill(this.stream?.level ?? 0) },
      getByteFrequencyData(data) { data.fill(this.stream?.level ? 160 : 0) },
    }
    this.analysers.push(analyser)
    return analyser
  }
  createMediaStreamSource(source) {
    return { connect(analyser) { analyser.stream = source }, disconnect() {} }
  }
}

class Peer extends EventTarget {
  iceGatheringState = 'complete'
  connectionState = 'connected'
  receivers = []
  channel = { readyState: 'open', send: mock.fn(),
    close() { this.readyState = 'closed' } }
  constructor() { super(); peers.push(this) }
  addTrack() {}
  createDataChannel(label) { assert.equal(label, 'oai-events'); return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=browser' } }
  async setLocalDescription(offer) { this.localDescription = offer }
  async setRemoteDescription(answer) { this.remoteDescription = answer }
  getReceivers() { return this.receivers }
  close() { this.connectionState = 'closed' }
  event(event) { this.channel.onmessage?.({ data: JSON.stringify(event) }) }
}

class Player {
  paused = true
  srcObject = null
  play = mock.fn(async () => { this.paused = false })
  pause = mock.fn(() => {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  })
  constructor() { players.push(this) }
  setAttribute() {}
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function frame(time) {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(time))
}

function call() {
  const session = new LiveSession()
  sessions.push(session)
  return session
}

function answer() {
  return Response.json({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\no=openai' } }, { status: 201 })
}

beforeEach(() => {
  contexts = []; peers = []; players = []; frames = new Map(); nextFrame = 0
  getUserMedia = mock.fn(async () => stream())
  fetchSession = mock.fn(async () => answer())
  const globals = {
    window: { isSecureContext: true, AudioContext: Context, RTCPeerConnection: Peer, Audio: Player },
    navigator: { mediaDevices: { getUserMedia } },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; this.level = 0 } },
    fetch: fetchSession,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id) => { frames.delete(id) },
  }
  savedGlobals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
})

afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose())
  mock.restoreAll()
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

test('one call separates microphone visualization from played model audio and closes after acknowledgment', async () => {
  const session = call()
  assert.equal(getUserMedia.mock.callCount(), 0)
  await session.start()
  const peer = peers[0]
  assert.equal(session.getSnapshot().status, 'connecting')
  assert.equal(peer.channel.send.mock.callCount(), 0)
  assert.equal(fetchSession.mock.calls[0].arguments[0], '/api/session')
  peer.event({ type: 'session.started' })
  assert.equal(session.getSnapshot().status, 'connected')

  const mic = await getUserMedia.mock.calls[0].result
  mic.level = 0.1
  frame(40)
  assert.ok(session.getSnapshot().inputBands.some((value) => value > 0))
  assert.equal(session.getSnapshot().outputLevel, 0)
  assert.equal(contexts[0].analysers[0].connect.mock.callCount(), 0)

  const remote = stream().track
  peer.receivers.push({ track: remote })
  peer.ontrack({ track: remote, streams: [] })
  contexts[0].analysers[1].stream.level = 0.1
  frame(80)
  assert.ok(session.getSnapshot().outputLevel > 0)
  assert.equal(players[0].play.mock.callCount(), 1)
  assert.equal(players[0].srcObject.tracks[0], remote)
  assert.equal(contexts[0].analysers[1].connect.mock.callCount(), 0)
  assert.equal(getUserMedia.mock.callCount(), 1)

  session.end()
  assert.equal(session.getSnapshot().status, 'closing')
  assert.equal(mic.track.enabled, false)
  assert.equal(players[0].paused, true)
  assert.equal(peer.connectionState, 'connected')
  assert.deepEqual(JSON.parse(peer.channel.send.mock.calls[0].arguments[0]), { type: 'session.close' })
  peer.event({ type: 'session.closed', reason: 'close_requested' })
  assert.equal(session.getSnapshot().status, 'idle')
  assert.equal(mic.track.stopped, true)
  assert.equal(remote.stopped, true)
  assert.equal(contexts[0].state, 'closed')
  assert.equal(peer.connectionState, 'closed')
  assert.equal(frames.size, 0)
  assert.equal(players[0].srcObject, null)
})

test('blocked playback is reported and releases the call instead of remaining silently connected', async () => {
  const session = call()
  await session.start()
  peers[0].event({ type: 'session.started' })
  players[0].play.mock.mockImplementationOnce(async () => {
    throw new DOMException('Autoplay blocked', 'NotAllowedError')
  })
  peers[0].ontrack({ track: stream().track, streams: [] })
  await Promise.resolve()
  assert.equal(session.getSnapshot().status, 'error')
  assert.match(session.getSnapshot().error, /Allow audio playback/)
  assert.equal(contexts[0].state, 'closed')
  assert.equal(players[0].srcObject, null)
})

for (const event of ['error', 'pause', 'ended']) {
  test(`a player ${event} after playback starts ends the call instead of leaving it silently connected`, async () => {
    const session = call()
    await session.start()
    peers[0].event({ type: 'session.started' })
    peers[0].ontrack({ track: stream().track, streams: [] })
    await Promise.resolve()
    contexts[0].analysers[1].stream.level = 0.1
    frame(40)
    assert.ok(session.getSnapshot().outputLevel > 0)

    const player = players[0]
    if (event === 'pause') player.pause()
    else player[`on${event}`]?.()

    assert.equal(session.getSnapshot().status, 'error')
    assert.match(session.getSnapshot().error, /Audio playback/)
    assert.equal(session.getSnapshot().outputLevel, 0)
    assert.equal((await getUserMedia.mock.calls[0].result).track.stopped, true)
    assert.equal(peers[0].connectionState, 'closed')
    assert.equal(contexts[0].state, 'closed')
    assert.equal(player.srcObject, null)
    assert.equal(player.onerror, null)
    assert.equal(player.onpause, null)
    assert.equal(player.onended, null)
  })
}

test('microphone bars settle gradually after speech instead of disappearing at the silence threshold', async () => {
  const session = call()
  await session.start()
  peers[0].event({ type: 'session.started' })
  const mic = await getUserMedia.mock.calls[0].result
  mic.level = 0.1
  frame(40)
  const speaking = session.getSnapshot().inputBands[0]
  mic.level = 0
  frame(80)
  const release = session.getSnapshot().inputBands[0]
  assert.ok(release > 0 && release < speaking)
  frame(120)
  assert.ok(session.getSnapshot().inputBands[0] < release)
  frame(2000)
  assert.ok(session.getSnapshot().inputBands.every((value) => value === 0))
})

test('canceling permission stops a late microphone stream without creating a session', async () => {
  const permission = deferred()
  getUserMedia.mock.mockImplementationOnce(() => permission.promise)
  const session = call()
  const starting = session.start()
  session.end()
  const late = stream()
  permission.resolve(late)
  await starting
  assert.equal(late.track.stopped, true)
  assert.equal(fetchSession.mock.callCount(), 0)
  assert.equal(session.getSnapshot().status, 'idle')
  assert.equal(contexts[0].state, 'closed')
})

test('canceling setup aborts its request and ignores a late response', async () => {
  const response = deferred()
  const requested = deferred()
  fetchSession.mock.mockImplementationOnce(() => { requested.resolve(); return response.promise })
  const session = call()
  const starting = session.start()
  await requested.promise
  session.end()
  assert.equal(fetchSession.mock.calls[0].arguments[1].signal.aborted, true)
  response.resolve(answer())
  await starting
  assert.equal(session.getSnapshot().status, 'idle')
  assert.equal(peers[0].remoteDescription, undefined)
  assert.equal(peers[0].connectionState, 'closed')
})

test('a startup error releases audio resources and permits another attempt', async () => {
  fetchSession.mock.mockImplementationOnce(async () => Response.json({ error: 'Voice calls are not configured yet.' }, { status: 503 }))
  const session = call()
  await session.start()
  const mic = await getUserMedia.mock.calls[0].result
  assert.equal(session.getSnapshot().status, 'error')
  assert.equal(session.getSnapshot().error, 'Voice calls are not configured yet.')
  assert.equal(mic.track.stopped, true)
  assert.equal(contexts[0].state, 'closed')
  await session.start()
  peers[1].event({ type: 'session.started' })
  assert.equal(session.getSnapshot().status, 'connected')
})

test('an unexpected connection loss releases the active microphone and audio context', async () => {
  const session = call()
  await session.start()
  peers[0].event({ type: 'session.started' })
  peers[0].channel.onclose()
  assert.equal(session.getSnapshot().status, 'error')
  assert.equal((await getUserMedia.mock.calls[0].result).track.stopped, true)
  assert.equal(contexts[0].state, 'closed')
  assert.equal(frames.size, 0)
})
