// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearComposerDraft,
  composerDraftStorageKey,
  moveComposerDraft,
  readComposerDraft,
  saveComposerDraft,
  saveComposerDraftFromDom,
  takeComposerDraft,
} from '../../src/lib/composer-draft'

afterEach(() => {
  window.sessionStorage.clear()
})

describe('composer draft storage', () => {
  it('saves a crash snapshot only to the visible composer scope', () => {
    const composer = document.createElement('div')
    composer.className = 'composer'
    const textarea = document.createElement('textarea')
    textarea.dataset.draftScope = 'A'
    textarea.value = 'crash recovery'
    composer.append(textarea)
    document.body.append(composer)
    saveComposerDraftFromDom()
    composer.remove()
    expect(readComposerDraft('A')?.text).toBe('crash recovery')
    expect(readComposerDraft('B')).toBeNull()
  })

  it('round-trips text and model selection for a workspace scope', () => {
    saveComposerDraft('project:new', { text: 'Ship the sidebar', model: 'openai:gpt-5.2', effort: 'high', fast: true })
    expect(readComposerDraft('project:new')).toEqual({
      text: 'Ship the sidebar',
      model: 'openai:gpt-5.2',
      effort: 'high',
      fast: true,
    })
    expect(window.sessionStorage.getItem(composerDraftStorageKey('other'))).toBeNull()
  })

  it('clears a sent draft without leaking another workspace', () => {
    saveComposerDraft('project:new', { text: 'keep me', model: 'openai:gpt-5.2' })
    saveComposerDraft('project:session', { text: 'other' })
    clearComposerDraft('project:new')
    expect(readComposerDraft('project:new')).toBeNull()
    expect(readComposerDraft('project:session')).toEqual({ text: 'other' })
  })

  it('claims the legacy crash snapshot for only one scope', () => {
    window.sessionStorage.setItem('omp-desktop.composer-draft', 'recovered after crash')
    expect(readComposerDraft('project:new')).toEqual({ text: 'recovered after crash' })
    expect(readComposerDraft('another:session')).toBeNull()
    expect(readComposerDraft('project:new')).toEqual({ text: 'recovered after crash' })
    expect(takeComposerDraft()).toBe('')
  })

  it('carries the draft typed before a draft session adopts its id', () => {
    saveComposerDraft('project:new', { text: '/context ', model: 'anthropic/x', effort: 'high' })
    moveComposerDraft('project:new', 'project:session-1')
    expect(readComposerDraft('project:session-1')).toMatchObject({ text: '/context ', model: 'anthropic/x', effort: 'high' })
  })

  it('never overwrites a draft that already exists at the adopted scope', () => {
    saveComposerDraft('project:new', { text: 'from draft' })
    saveComposerDraft('project:session-1', { text: 'already typed' })
    moveComposerDraft('project:new', 'project:session-1')
    expect(readComposerDraft('project:session-1')).toEqual({ text: 'already typed' })
  })

  it('ignores empty drafts and identical scopes', () => {
    moveComposerDraft('project:new', 'project:session-1')
    expect(readComposerDraft('project:session-1')).toBeNull()
    saveComposerDraft('project:new', { text: 'kept' })
    moveComposerDraft('project:new', 'project:new')
    expect(readComposerDraft('project:new')).toEqual({ text: 'kept' })
  })
})
