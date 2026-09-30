import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationPresentation } from '../src/lib/conversation-presentation.ts'

test('idle starts with an orb and compact controls; an empty closed field can reopen', () => {
  assert.deepEqual(conversationPresentation(0, 'idle', false, ''), {
    calling: false, showLargeOrb: true, composerOpen: false,
  })
  assert.equal(conversationPresentation(0, 'idle', true, '').composerOpen, true)
  assert.equal(conversationPresentation(0, 'idle', false, 'draft').composerOpen, true)
})

test('messages remove the large orb and keep the composer open regardless of blur or errors', () => {
  for (const status of ['idle', 'error']) {
    assert.deepEqual(conversationPresentation(2, status, false, ''), {
      calling: false, showLargeOrb: false, composerOpen: true,
    })
  }
})

test('every active call phase hides chat, and finishing restores the existing conversation', () => {
  for (const status of ['connecting', 'connected', 'closing']) {
    assert.equal(conversationPresentation(1, status, true, 'draft').calling, true)
    assert.equal(conversationPresentation(1, status, true, 'draft').composerOpen, false)
  }
  assert.equal(conversationPresentation(1, 'idle', false, '').composerOpen, true)
})
