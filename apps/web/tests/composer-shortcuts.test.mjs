import assert from 'node:assert/strict'
import test from 'node:test'
import { composerKeyAction, composerEdit } from '../src/lib/composer-shortcuts.ts'

const key = (value, modifiers = {}) => composerKeyAction({ key: value, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false, ...modifiers })

test('text-entry and requested shortcuts route on both Control and Command', () => {
  assert.equal(key('a'), 'insert')
  assert.equal(key(' '), 'insert')
  assert.equal(key('é'), 'insert')
  assert.equal(key('😀'), 'insert')
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(key('A', { [modifier]: true }), 'select-all')
    assert.equal(key('v', { [modifier]: true }), 'paste')
    assert.equal(key('Backspace', { [modifier]: true }), modifier === 'metaKey' ? 'delete-line' : 'delete-word')
  }
})

test('browser navigation, composition and already-handled events remain intact', () => {
  for (const value of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'F1']) assert.equal(key(value), null)
  for (const value of ['f', 'l', 'r', 'c', 'z']) assert.equal(key(value, { metaKey: true }), null)
  assert.equal(key('x', { defaultPrevented: true }), null)
  assert.equal(key('x', { isComposing: true }), null)
  assert.equal(key('x', { altKey: true }), null)
  assert.equal(key('@', { ctrlKey: true, altKey: true, altGraph: true }), 'insert')
  assert.equal(key('Dead'), 'composition')
})

test('first text and pasted multiline text replace the existing composer selection', () => {
  assert.deepEqual(composerEdit('hello world', 6, 11, 'insert', 'dot'), { value: 'hello dot', caret: 9 })
  assert.deepEqual(composerEdit('hello', 5, 5, 'insert', '\nnext line'), { value: 'hello\nnext line', caret: 15 })
  assert.deepEqual(composerEdit('', 0, 0, 'insert', 'a'), { value: 'a', caret: 1 })
})

test('Control-Backspace deletes the previous word; Command-Backspace deletes the current line prefix', () => {
  assert.deepEqual(composerEdit('hello world', 11, 11, 'delete-word'), { value: 'hello ', caret: 6 })
  assert.deepEqual(composerEdit('hello world.  ', 14, 14, 'delete-word'), { value: 'hello ', caret: 6 })
  assert.deepEqual(composerEdit('first\nsecond line', 17, 17, 'delete-line'), { value: 'first\n', caret: 6 })
  assert.deepEqual(composerEdit('first\nsecond line', 12, 12, 'delete-line'), { value: 'first\n line', caret: 6 })
  assert.deepEqual(composerEdit('\ntext', 0, 0, 'delete-line'), { value: '\ntext', caret: 0 })
  assert.deepEqual(composerEdit('hello world', 6, 11, 'delete-line'), { value: 'hello ', caret: 6 })
})
