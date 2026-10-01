import { readFile, lstat, writeFile, rename, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/
const localHeading = '# Additional local settings'

/** Keep assignments as source text: parsing and re-encoding can change quotes or expansions. */
function entries(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const result = []
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(assignment)
    const entry = { key: match?.[1], lines: [lines[index]] }
    const value = match?.[2].trimStart()
    const quote = value?.[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      let remaining = value.slice(1)
      let closed = false
      while (!closed) {
        for (let offset = 0; offset < remaining.length; offset++) {
          if (remaining[offset] === '\\') offset++
          else if (remaining[offset] === quote) { closed = true; break }
        }
        if (!closed) {
          if (++index >= lines.length) throw new Error('An environment value has an unclosed quote. Fix it and run setup again.')
          entry.lines.push(lines[index])
          remaining = lines[index]
        }
      }
    }
    result.push(entry)
  }
  return result
}

/** Example comments/order are canonical; existing values and local additions survive each run. */
export function syncEnvironment(example, current = '') {
  const template = entries(example)
  const existing = entries(current)
  const values = new Map()
  for (const entry of existing) {
    if (entry.key) values.set(entry.key, [...(values.get(entry.key) ?? []), entry])
  }
  const templateKeys = new Set()
  const templateComments = new Set(template.filter(entry => !entry.key).map(entry => entry.lines[0].trim()))
  const output = []
  let added = 0
  for (const entry of template) {
    if (entry.key) {
      if (templateKeys.has(entry.key)) throw new Error('.env.example contains a repeated variable. Remove the duplicate and run setup again.')
      templateKeys.add(entry.key)
      const saved = values.get(entry.key)
      if (saved) {
        // Preserve repeated local assignments in order, including their last-value precedence.
        output.push(...saved.flatMap(item => item.lines))
        continue
      }
      added++
    }
    output.push(...entry.lines)
  }
  const additional = existing.filter(entry => entry.key
    ? !templateKeys.has(entry.key)
    : entry.lines[0].trim() && entry.lines[0].trim() !== localHeading
      && !templateComments.has(entry.lines[0].trim()))
  while (output.at(-1) === '') output.pop()
  if (additional.length) output.push('', localHeading, ...additional.flatMap(entry => entry.lines))
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  return { content: `${output.join(newline)}${newline}`, added }
}

export async function setupEnvironment(projectDirectory) {
  const target = join(projectDirectory, '.env.local')
  const example = await readFile(join(projectDirectory, '.env.example'), 'utf8')
  let current = ''
  let info
  try {
    info = await lstat(target)
    if (!info.isFile()) throw new Error('.env.local must be a regular file. Check its location and run setup again.')
    current = await readFile(target, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const { content, added } = syncEnvironment(example, current)
  if (info && current === content) return { status: 'unchanged', added }

  // Replace only after a complete write; failure must leave existing configuration intact.
  const temporary = join(projectDirectory, `.env.local.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return { status: info ? 'updated' : 'created', added }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { status, added } = await setupEnvironment(dirname(dirname(fileURLToPath(import.meta.url))))
    if (status === 'unchanged') console.log('.env.local is up to date.')
    else console.log(`${status === 'created' ? 'Created' : 'Updated'} .env.local. Added ${added} ${added === 1 ? 'variable' : 'variables'}. Existing values preserved.`)
    console.log('Review .env.local, then run pnpm dev.')
  } catch (error) {
    // Filesystem messages and malformed input may contain sensitive paths or source text.
    const message = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
      ? 'Check that .env.example exists and the project directory is writable.'
      : error.code ? 'Check the environment files and run setup again.' : error.message
    console.error(`Setup could not complete. ${message}`)
    process.exitCode = 1
  }
}
