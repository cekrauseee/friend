import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const source = await readFile(new URL('../src/hooks/use-composer-dictation.ts', import.meta.url), 'utf8')
let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
code = code.replace(/from ['"]react['"]/, `from ${JSON.stringify(dataModule(`
  export const useRef = (value) => { const f = globalThis.__dictation; const i = f.cursor++; return f.refs[i] ??= { current: value }; };
  export const useCallback = (fn) => fn;
  export const useEffect = (fn, deps) => globalThis.__dictation.effect(fn, deps);
  export const useLayoutEffect = useEffect;
`))}`).replace(/from ['"]@\/hooks\/use-audio-capture['"]/, `from ${JSON.stringify(dataModule('export const useAudioCapture = () => globalThis.__dictation.capture;'))}`)
const { useComposerDictation, appendTranscript } = await import(dataModule(code))

function fixture() {
  const previousWindow = globalThis.window
  const listeners = new Map()
  const f = { refs: [], cursor: 0, effects: [], effectCursor: 0, draft: 'Existing draft', enabled: true, sent: [], changes: [], uploads: [], starts: 0, canceled: 0, accepted: 'turn' }
  let complete
  f.capture = {
    status: 'idle', error: null, inputBands: [],
    start: async () => { f.starts++; f.capture.status = 'recording' },
    finalize: (intent) => { f.uploads.push(intent); f.capture.status = 'processing'; return new Promise((resolve) => { complete = (text) => { f.capture.status = 'idle'; resolve(text === null ? null : { text, intent }) } }) },
    cancel: () => { f.canceled++; f.capture.status = 'idle' },
  }
  f.effect = (fn, deps) => {
    const i = f.effectCursor++
    const previous = f.effects[i]
    // useCallback is mocked by identity, so compare the semantic enabled dependency only.
    const same = previous && deps.every((value, index) => typeof value === 'function' || value === previous.deps[index])
    if (same) return
    previous?.cleanup?.()
    f.effects[i] = { deps, cleanup: fn() }
  }
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) }
  globalThis.__dictation = f
  f.render = () => {
    f.cursor = 0; f.effectCursor = 0
    return useComposerDictation({ draft: f.draft, enabled: f.enabled,
      onDraftChange: (draft) => { f.draft = draft; f.changes.push(draft) },
      onSend: (text) => { f.sent.push(text); return f.accepted }, onOpen: () => {},
    })
  }
  f.complete = (text = 'spoken words') => complete(text)
  f.pagehide = () => listeners.get('pagehide')?.()
  f.restore = () => { f.effects.forEach((effect) => effect.cleanup?.()); globalThis.window = previousWindow; delete globalThis.__dictation }
  return f
}

test('transcripts append with sensible spacing while preserving existing formatting', () => {
  assert.equal(appendTranscript('Draft', ' words '), 'Draft words')
  assert.equal(appendTranscript('Draft\n', ' words '), 'Draft\nwords')
  assert.equal(appendTranscript('', ' words '), 'words')
  assert.equal(appendTranscript('Draft', '  '), 'Draft')
})

test('Stop inserts into the existing draft without sending and duplicate finishing actions do nothing', async () => {
  const f = fixture()
  try {
    f.render().start()
    const ui = f.render()
    const done = ui.finish('insert')
    await ui.finish('send')
    assert.deepEqual(f.uploads, ['insert'])
    f.complete()
    await done
    assert.equal(f.draft, 'Existing draft spoken words')
    assert.deepEqual(f.sent, [])
  } finally { f.restore() }
})

test('Check sends the same merged text and clears only an accepted draft', async () => {
  for (const accepted of ['turn', null]) {
    const f = fixture()
    try {
      f.accepted = accepted
      f.render().start()
      const done = f.render().finish('send')
      f.complete()
      await done
      assert.deepEqual(f.sent, ['Existing draft spoken words'])
      assert.equal(f.draft, accepted ? '' : 'Existing draft spoken words')
    } finally { f.restore() }
  }
})

test('cancel and failed transcription preserve the original draft without a send', async () => {
  for (const canceled of [false, true]) {
    const f = fixture()
    try {
      f.render().start()
      const ui = f.render()
      const done = ui.finish('send')
      if (canceled) ui.cancel()
      f.complete(canceled ? 'stale speech' : null)
      await done
      assert.equal(f.draft, 'Existing draft')
      assert.deepEqual(f.sent, [])
      assert.deepEqual(f.changes, [])
    } finally { f.restore() }
  }
})

test('cancel after promise resolution still blocks queued transcript application', async () => {
  const f = fixture()
  try {
    f.render().start()
    const ui = f.render()
    const done = ui.finish('send')
    f.complete()
    ui.cancel()
    await done
    assert.deepEqual(f.sent, [])
    assert.equal(f.draft, 'Existing draft')
  } finally { f.restore() }
})

test('mode/auth changes and page exit invalidate pending transcript and gate new recording', async () => {
  for (const pagehide of [false, true]) {
    const f = fixture()
    try {
      f.render().start()
      const done = f.render().finish('send')
      if (pagehide) f.pagehide()
      else { f.enabled = false; f.render().start() }
      f.complete()
      await done
      assert.equal(f.starts, 1)
      assert.deepEqual(f.sent, [])
      assert.equal(f.draft, 'Existing draft')
    } finally { f.restore() }
  }
})


test('callbacks retained through animated exits cannot start or finish in a later capture mode', async () => {
  const f = fixture()
  try {
    const idle = f.render()
    idle.start()
    idle.start()
    assert.equal(f.starts, 1)
    const recording = f.render()
    f.enabled = false
    f.render()
    recording.start()
    await recording.finish('send')
    assert.equal(f.starts, 1)
    assert.deepEqual(f.uploads, [])
  } finally { f.restore() }
})
