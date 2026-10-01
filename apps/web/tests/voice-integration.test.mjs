import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, mock, test } from 'node:test'
import ts from 'typescript'
import { VoiceSession } from '../src/lib/voice-session.ts'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const react = dataModule(`
  const fixture = () => globalThis.__voiceIntegration;
  export const useState = (initial) => {
    const f = fixture(), i = f.cursor++;
    if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? initial() : initial;
    return [f.values[i], (value) => { f.values[i] = typeof value === 'function' ? value(f.values[i]) : value; }];
  };
  export const useRef = (initial) => useState(() => ({ current: initial }))[0];
  export const useEffect = (effect, dependencies) => {
    const f = fixture(), i = f.cursor++, previous = f.effects[i];
    if (previous && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return;
    f.pending.push(() => { previous?.cleanup?.(); f.effects[i] = { dependencies, cleanup: effect() }; });
  };
  export const useLayoutEffect = useEffect;
  export const useCallback = (callback) => callback;
  export const useSyncExternalStore = (_, getSnapshot) => getSnapshot();
`)
const component = (name) => dataModule(`export const ${name} = '${name}';`)
async function load(path, imports) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/^import ['"].*\.css['"];?\n/gm, '')
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = name === 'react' ? react : imports[name] ?? import.meta.resolve(name)
    code = code.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`).replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  return dataModule(code)
}
const sessionModule = dataModule(`export class VoiceSession {
  constructor() { return globalThis.__voiceIntegration.session; }
}`)
const hookModule = await load('src/hooks/use-live-session.ts', { '@/lib/voice-session': sessionModule })
const { useLiveSession } = await import(hookModule)
const sounds = dataModule(`export const interfaceSounds = {
  setVoiceActive: (active) => globalThis.__voiceIntegration.soundActive.push(active),
  play: (name) => globalThis.__voiceIntegration.sounds.push(name),
  unlock: async () => {}, stop: () => globalThis.__voiceIntegration.stops++,
};`)
const appModule = await load('src/App.tsx', {
  'motion/react': component('AnimatePresence'),
  '@/components/text-conversation-view': component('TextConversationView'),
  '@/hooks/use-live-session': hookModule,
  '@/hooks/use-conversation-viewport': dataModule(`export const useConversationViewport = () => ({
    viewport: {}, acceptTurn: (id) => globalThis.__voiceIntegration.accepted.push(id), retryTurn: () => {},
  });`),
  '@/lib/text-conversation': dataModule(`export const useTextConversation = (select) => select(globalThis.__voiceIntegration.text);
    useTextConversation.getState = () => globalThis.__voiceIntegration.text;
    useTextConversation.subscribe = () => () => {};`),
  '@/lib/text-access': dataModule('export const createTextAccess = () => globalThis.__voiceIntegration.access;'),
  '@/components/global-loading': component('GlobalLoading'),
  '@/components/authentication-dialog': component('AuthenticationDialog'),
  '@/components/sound-toggle': component('SoundToggle'),
  '@/components/accent-picker': component('AccentPicker'),
  '@/lib/interface-sounds': sounds,
  '@/lib/conversation-sound': dataModule('export const conversationOutcomeSound = () => null;'),
})
const { default: App } = await import(appModule)
const viewModule = await load('src/components/text-conversation-view.tsx', {
  'motion/react': dataModule(`export const AnimatePresence = 'AnimatePresence';
    export const motion = new Proxy({ create: (component) => component }, { get: (value, key) => value[key] ?? key });
    export const useReducedMotion = () => false;`),
  '@/components/assistant-markdown': component('AssistantMarkdown'),
  '@/components/compact-agent-orb': component('CompactAgentOrb'),
  '@/components/conversation-composer': component('ConversationComposer'),
  '@/components/dot-orb': component('DotOrb'),
  '@/components/ui/bubble': dataModule(`export const Bubble = 'Bubble', BubbleContent = 'BubbleContent';`),
  '@/components/ui/button': component('Button'),
  '@/lib/composer-size': dataModule('export const composerMorph = {};'),
  '@/lib/conversation-presentation': import.meta.resolve('../src/lib/conversation-presentation.ts'),
  '@/hooks/use-conversation-scene': dataModule('export const useConversationScene = () => ({ footerHeight: 0, orbOffset: 0, composerOffset: 0 });'),
  '@/hooks/use-transient-error': dataModule('export const useTransientError = (error) => error;'),
  '@/components/ui/message-scroller': dataModule(`export const MessageScroller = 'MessageScroller', MessageScrollerProvider = 'MessageScrollerProvider',
    MessageScrollerViewport = 'MessageScrollerViewport', MessageScrollerContent = 'MessageScrollerContent',
    MessageScrollerItem = 'MessageScrollerItem', MessageScrollerButton = 'MessageScrollerButton';`),
  'lucide-react': component('Ellipsis'),
  '@/lib/interface-sounds': sounds,
  '@/hooks/use-composer-shortcuts': dataModule('export const useComposerShortcuts = (options) => { globalThis.__voiceIntegration.shortcuts = options; };'),
  '@/hooks/use-composer-dictation': dataModule('export const useComposerDictation = (options) => { const f = globalThis.__voiceIntegration; f.dictationOptions = options; return f.dictation; };'),
  '@/lib/surface-motion': dataModule('export const surfaceHidden = {}, surfaceVisible = {}, surfaceExit = {}, surfaceSpring = {}, surfaceFade = {};'),
})
const { TextConversationView } = await import(viewModule)
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function find(element, type) {
  if (!element || typeof element !== 'object') return null
  if (element.type === type) return element
  for (const child of [element.props?.children].flat(Infinity)) {
    const result = find(child, type)
    if (result) return result
  }
  return null
}
let f, saved
beforeEach(() => {
  f = {
    cursor: 0, values: [], effects: [], pending: [], soundActive: [], sounds: [], stops: 0, accepted: [],
    text: { turns: [], activeTurnId: null, cancelActive: mock.fn(), sendText: mock.fn(() => 'turn'), retryTurn: mock.fn(() => true) },
    accessSnapshot: { checking: false, authenticated: true, message: null },
    dictation: { active: false, status: 'idle', cancel: mock.fn() },
    sdk: mock.fn(async (options) => { f.sdkOptions = options; return f.conversation }),
    conversation: { endSession: mock.fn(async () => {}), setMicMuted: mock.fn(), setVolume: mock.fn(),
      getInputByteFrequencyData: () => new Uint8Array(32), getInputVolume: () => 0, getOutputVolume: () => 0 },
    render(component) { this.cursor = 0; const result = component(); this.pending.splice(0).forEach((effect) => effect()); return result },
    unmount() { this.effects.forEach((effect) => effect.cleanup?.()); this.effects = [] },
  }
  f.access = { subscribe: () => () => {}, getSnapshot: () => f.accessSnapshot, check: mock.fn(async () => {}), cancel: mock.fn() }
  const window = new EventTarget()
  Object.assign(window, { isSecureContext: true, RTCPeerConnection: class {}, AudioContext: class {
    resume = async () => {}; close = async () => {}
  } })
  const globals = {
    window, navigator: { mediaDevices: { getUserMedia: mock.fn() } }, __voiceIntegration: f,
    fetch: mock.fn(async (path) => Response.json(path === '/api/voice-provider' ? { provider: 'elevenlabs' }
      : { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'test-token' })),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  }
  saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.entries(globals).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }))
  f.session = new VoiceSession({ startElevenLabs: f.sdk })
})
afterEach(() => {
  f.unmount(); f.session.dispose(); mock.restoreAll()
  saved.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key])
})
const view = (snapshot, overrides = {}) => f.render(() => TextConversationView({
  ready: true, turns: [], activeTurnId: null, onSend: () => null, onRetry: () => false,
  onToggleCall: f.toggleCall ??= mock.fn(), voiceStatus: snapshot.status, voiceError: snapshot.error,
  inputBands: snapshot.inputBands, outputLevel: snapshot.outputLevel, ...overrides,
}))

test('the live hook observes the selected session and releases it on page exit and unmount', async () => {
  const initial = f.render(useLiveSession)
  assert.equal(initial.status, 'idle')
  assert.equal(f.sdk.mock.callCount(), 0)
  await f.session.start()
  assert.equal(f.render(useLiveSession).status, 'connected')
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(f.conversation.endSession.mock.callCount(), 1)
  assert.equal(f.render(useLiveSession).status, 'idle')
  f.conversation = { ...f.conversation, endSession: mock.fn(async () => {}) }
  await f.session.start()
  f.unmount()
  assert.equal(f.conversation.endSession.mock.callCount(), 1)
  f.conversation = { ...f.conversation, endSession: mock.fn(async () => {}) }
  await f.session.start()
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(f.session.getSnapshot().status, 'connected', 'unmount removes its pagehide listener')
})

test('authenticated call/text transitions retain shared state, sound suppression and voice cleanup', async () => {
  let tree = f.render(App)
  assert.equal(f.access.check.mock.callCount(), 1)
  find(tree, 'TextConversationView').props.onToggleCall()
  assert.equal(f.text.cancelActive.mock.callCount(), 1)
  while (['checking', 'connecting'].includes(f.session.getSnapshot().status)) await Promise.resolve()
  tree = f.render(App)
  assert.equal(find(tree, 'TextConversationView').props.voiceStatus, 'connected')
  assert.equal(f.soundActive.at(-1), true)
  assert.equal(find(tree, 'TextConversationView').props.onSend('Hello'), 'turn')
  assert.equal(f.conversation.endSession.mock.callCount(), 1)
  assert.deepEqual(f.text.sendText.mock.calls[0].arguments, ['Hello'])
  assert.deepEqual(f.accepted, ['turn'])
  assert.equal(f.soundActive.at(-1), false)
  assert.equal(f.sounds.at(-1), 'send')
  f.accessSnapshot.authenticated = false
  tree = f.render(App)
  assert.equal(find(tree, 'TextConversationView').props.ready, false)
  assert.equal(find(tree, 'TextConversationView').props.onSend('Blocked'), null)
  assert.equal(find(tree, 'TextConversationView').props.onRetry('turn'), false)
  assert.equal(f.text.sendText.mock.callCount(), 1)
  assert.equal(f.text.retryTurn.mock.callCount(), 0)
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(f.access.cancel.mock.callCount(), 1)
  assert.equal(f.stops, 1)
})

test('canceling SDK startup keeps dictation and keyboard input excluded until late microphone cleanup', async () => {
  const startup = deferred(), began = deferred(), closed = deferred()
  f.sdk.mock.mockImplementation((options) => { f.sdkOptions = options; began.resolve(); return startup.promise })
  f.conversation.endSession.mock.mockImplementation(() => closed.promise)
  const starting = f.session.start()
  await began.promise
  f.session.end()
  let tree = view(f.session.getSnapshot())
  assert.equal(find(tree, 'ConversationComposer').props.voiceStatus, 'closing')
  assert.equal(find(tree, 'ConversationComposer').props.open, false)
  assert.equal(f.dictationOptions.enabled, false)
  assert.equal(f.shortcuts.enabled, false)
  f.sdkOptions.onConversationCreated(f.conversation)
  startup.resolve(f.conversation)
  await Promise.resolve()
  tree = view(f.session.getSnapshot())
  assert.equal(find(tree, 'ConversationComposer').props.voiceStatus, 'closing')
  assert.equal(f.dictationOptions.enabled, false)
  closed.resolve()
  await starting
  view(f.session.getSnapshot())
  assert.equal(f.dictationOptions.enabled, true)
  assert.equal(f.shortcuts.enabled, true)
  assert.equal(f.conversation.endSession.mock.callCount(), 1)
})

test('call handlers retained by animations cannot overlap dictation or restart after messages', () => {
  let tree = view(f.session.getSnapshot())
  const oldToggle = find(tree, 'ConversationComposer').props.onToggleCall
  f.dictation.active = true
  view(f.session.getSnapshot())
  oldToggle()
  assert.equal(f.toggleCall.mock.callCount(), 0)
  assert.equal(f.shortcuts.enabled, false)
  f.dictation.active = false
  tree = view(f.session.getSnapshot(), { turns: [{ id: 'one', userText: 'Hello', assistantText: 'Hi', status: 'complete', error: null }] })
  assert.equal(find(tree, 'ConversationComposer').props.showCall, false)
  oldToggle()
  assert.equal(f.toggleCall.mock.callCount(), 0)
  view(f.session.getSnapshot())
  oldToggle()
  assert.equal(f.toggleCall.mock.callCount(), 1)
  assert.equal(f.dictation.cancel.mock.callCount(), 1)
})

for (const [name, draft, hasMessages, expectedOpen] of [
  ['empty initial screen', '', false, false],
  ['initial screen with a draft', 'Keep this draft', false, true],
  ['existing conversation with an empty draft', '', true, true],
]) {
  test(`canceling dictation restores the correct composer state on ${name}`, () => {
    const turns = hasMessages ? [{ id: 'one', userText: 'Hello', assistantText: 'Hi', status: 'complete', error: null }] : []
    let tree = view(f.session.getSnapshot(), { turns })
    find(tree, 'ConversationComposer').props.onOpen()
    f.dictationOptions.onDraftChange(draft)
    f.dictation.active = true
    tree = view(f.session.getSnapshot(), { turns })
    find(tree, 'ConversationComposer').props.dictation.cancel()
    f.dictation.active = false
    tree = view(f.session.getSnapshot(), { turns })
    const composer = find(tree, 'ConversationComposer').props
    assert.equal(composer.open, expectedOpen)
    assert.equal(composer.draft, draft)
    assert.equal(f.dictation.cancel.mock.callCount(), 1)
  })
}
