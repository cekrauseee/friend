import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setupEnvironment, syncEnvironment } from '../scripts/setup.mjs'

async function project(t, example, current) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-setup-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, '.env.example'), example)
  if (current !== undefined) await writeFile(join(directory, '.env.local'), current, { mode: 0o600 })
  return directory
}

test('uses example order/comments/defaults without replacing existing values, including blanks', () => {
  const result = syncEnvironment('# Providers\nA=default\nB=new\nC=default\n', 'C=\nA="custom # value" # note\n')
  assert.equal(result.content, '# Providers\nA="custom # value" # note\nB=new\nC=\n')
  assert.equal(result.added, 1)
})

test('preserves multiline quotes, exports, expansions, duplicates and custom local entries', () => {
  const example = '# Current help\nTOKEN=\nURL=default\n'
  const current = '# Keep this note\nexport URL = ${HOST}/path # local\nTOKEN="first\nKEY=inside value\nlast"\nTOKEN=last-value\nCUSTOM=`two\nlines`\n'
  const result = syncEnvironment(example, current)
  assert.equal(result.content, '# Current help\nTOKEN="first\nKEY=inside value\nlast"\nTOKEN=last-value\nexport URL = ${HOST}/path # local\n\n# Additional local settings\n# Keep this note\nCUSTOM=`two\nlines`\n')
  assert.equal(result.added, 0)
  assert.deepEqual(syncEnvironment(example, result.content), result)
})

test('repeated setup is stable and retains CRLF for existing multiline values', () => {
  const example = '# Help\nA=default\nB=\n'
  const current = '# Help\r\nB=\r\nA="line one\r\nline two"\r\nEXTRA=yes\r\n'
  const first = syncEnvironment(example, current)
  assert.ok(first.content.includes('A="line one\r\nline two"'))
  assert.equal(syncEnvironment(example, first.content).content, first.content)
})

test('creates a private env file from the example and leaves it untouched on the next run', async t => {
  const directory = await project(t, 'A=default\nB=\n')
  assert.deepEqual(await setupEnvironment(directory), { status: 'created', added: 2 })
  const target = join(directory, '.env.local')
  assert.equal(await readFile(target, 'utf8'), 'A=default\nB=\n')
  const before = await stat(target)
  assert.equal(before.mode & 0o777, 0o600)
  assert.deepEqual(await setupEnvironment(directory), { status: 'unchanged', added: 0 })
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs)
})

test('updates an existing file without losing custom values or leaving temporary files', async t => {
  const directory = await project(t, 'B=new\nA=default\n', 'A=private-value\nLOCAL=keep\n')
  assert.deepEqual(await setupEnvironment(directory), { status: 'updated', added: 1 })
  assert.equal(await readFile(join(directory, '.env.local'), 'utf8'), 'B=new\nA=private-value\n\n# Additional local settings\nLOCAL=keep\n')
  assert.equal((await stat(join(directory, '.env.local'))).mode & 0o777, 0o600)
  assert.deepEqual((await readdir(directory)).sort(), ['.env.example', '.env.local'])
})

test('malformed quotes or duplicate template variables fail without modifying existing configuration', async t => {
  for (const example of ['A="unfinished\n', 'A=one\nA=two\n']) {
    const directory = await project(t, example, 'A=keep\n')
    await assert.rejects(setupEnvironment(directory))
    assert.equal(await readFile(join(directory, '.env.local'), 'utf8'), 'A=keep\n')
    assert.deepEqual((await readdir(directory)).sort(), ['.env.example', '.env.local'])
  }
  assert.throws(() => syncEnvironment('A=default\n', 'A="unfinished\n'), /unclosed quote/)
})

test('refuses a symlink without touching its destination', async t => {
  const directory = await project(t, 'A=new\n')
  const other = join(directory, 'existing.env')
  await writeFile(other, 'A=keep\n')
  await symlink(other, join(directory, '.env.local'))
  await assert.rejects(setupEnvironment(directory), /regular file/)
  assert.equal(await readFile(other, 'utf8'), 'A=keep\n')
})

test('CLI works outside project cwd and logs no values on success or failure', async t => {
  const directory = await project(t, 'TOKEN=default\nNEW=\n', 'TOKEN=private-marker\n')
  await mkdir(join(directory, 'scripts'))
  const script = join(directory, 'scripts/setup.mjs')
  await copyFile(new URL('../scripts/setup.mjs', import.meta.url), script)
  const first = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(first.status, 0)
  assert.match(first.stdout, /Updated .env.local. Added 1 variable/)
  assert.doesNotMatch(first.stdout + first.stderr, /private-marker|default/)
  const second = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(second.status, 0)
  assert.match(second.stdout, /up to date/)
  await writeFile(join(directory, '.env.local'), 'TOKEN="private-marker\n')
  const failure = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /unclosed quote/)
  assert.doesNotMatch(failure.stdout + failure.stderr, /private-marker/)
})


test('current template adds Speech Engine ingress settings while preserving retired local settings', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const current = 'ELEVENLABS_AGENT_ID=previous-agent\nELEVENLABS_API_KEY=private-marker\nDOT_TEXT_PROVIDER=codex\n'
  const result = syncEnvironment(example, current)
  assert.match(result.content, /^ELEVENLABS_SPEECH_ENGINE_ID=$/m)
  assert.match(result.content, /^DOT_SPEECH_ENGINE_HOST=127\.0\.0\.1$/m)
  assert.match(result.content, /^DOT_SPEECH_ENGINE_PORT=3001$/m)
  assert.match(result.content, /^ELEVENLABS_API_KEY=private-marker$/m)
  assert.match(result.content, /# Additional local settings\nELEVENLABS_AGENT_ID=previous-agent/)
  assert.doesNotMatch(example, /ELEVENLABS_AGENT_ID/)
  assert.equal(syncEnvironment(example, result.content).content, result.content)
})
