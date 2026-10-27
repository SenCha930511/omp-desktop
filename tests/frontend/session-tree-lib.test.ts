// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { describeTreeEntry, flattenSessionTree, isBranchableEntry, parseSessionTree, treePreviewText, type SessionTreeNode } from '../../src/lib/session-tree'

function messageNode(id: string, parentId: string | null, role: string, text: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    entry: { id, parentId, type: 'message', timestamp: '2026-10-27T09:00:00Z', message: { role, content: [{ type: 'text', text }] } },
    children,
  }
}

describe('parseSessionTree', () => {
  it('parses a valid get_tree response, normalizing nodes and leafId', () => {
    const parsed = parseSessionTree({
      tree: [
        {
          entry: { id: 'a', parentId: null, type: 'session_init', timestamp: '2026-10-27T08:00:00Z' },
          label: 'main',
          children: [{ entry: { id: 'b', parentId: 'a', type: 'message', message: { role: 'user', content: 'hi' } }, children: [] }],
        },
      ],
      leafId: 'b',
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.leafId).toBe('b')
    expect(parsed!.roots).toHaveLength(1)
    expect(parsed!.roots[0].label).toBe('main')
    expect(parsed!.roots[0].children[0].entry.id).toBe('b')
  })

  it('treats a missing or null leafId as no active leaf', () => {
    expect(parseSessionTree({ tree: [], leafId: null })).toEqual({ roots: [], leafId: null })
    expect(parseSessionTree({ tree: [] })).toEqual({ roots: [], leafId: null })
  })

  for (const raw of [null, 'tree', 7, {}, { tree: 'no' }, { tree: [{ entry: { type: 'message' }, children: [] }] }, { tree: [{ entry: { id: 'a', type: 'message' }, children: [{}] }] }]) {
    it('rejects a malformed response shape instead of guessing', () => {
      expect(parseSessionTree(raw)).toBeNull()
    })
  }
})

describe('flattenSessionTree', () => {
  it('orders depth-first and marks the active path up to the current leaf', () => {
    const branch = messageNode('b1', 'a', 'user', 'first try')
    const trunk = messageNode('a', null, 'assistant', 'hello', [
      branch,
      messageNode('b2', 'a', 'user', 'second try', [messageNode('c', 'b2', 'assistant', 'done')]),
    ])
    const rows = flattenSessionTree({ roots: [trunk], leafId: 'c' })
    expect(rows.map((row) => row.node.entry.id)).toEqual(['a', 'b1', 'b2', 'c'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2])
    const active = Object.fromEntries(rows.map((row) => [row.node.entry.id, row.onActivePath]))
    expect(active).toEqual({ a: true, b1: false, b2: true, c: true })
    expect(rows.find((row) => row.node.entry.id === 'c')?.isCurrentLeaf).toBe(true)
    expect(rows.find((row) => row.node.entry.id === 'b1')?.isCurrentLeaf).toBe(false)
  })

  it('handles a dangling leafId without marking any path', () => {
    const rows = flattenSessionTree({ roots: [messageNode('a', null, 'user', 'hi')], leafId: 'missing' })
    expect(rows).toHaveLength(1)
    expect(rows[0].onActivePath).toBe(false)
    expect(rows[0].isCurrentLeaf).toBe(false)
  })
})

describe('describeTreeEntry / treePreviewText', () => {
  it('describes message entries by role with a joined single-line preview', () => {
    const user = messageNode('u', null, 'user', 'line one\nline two')
    const description = describeTreeEntry(user.entry)
    expect(description.kind).toBe('user')
    expect(treePreviewText(description)).toBe('line one line two')
    expect(isBranchableEntry(user.entry)).toBe(true)
    const assistant = messageNode('m', 'u', 'assistant', 'reply')
    expect(describeTreeEntry(assistant.entry).kind).toBe('assistant')
    expect(isBranchableEntry(assistant.entry)).toBe(false)
  })

  it('describes bookkeeping entries without guessing their fields', () => {
    expect(describeTreeEntry({ id: 'c', parentId: null, type: 'compaction', tokensBefore: 1234 })).toEqual({ kind: 'compaction', tokensBefore: 1234 })
    expect(describeTreeEntry({ id: 'l', parentId: null, type: 'label', label: 'experiment' })).toEqual({ kind: 'label', label: 'experiment' })
    expect(describeTreeEntry({ id: 'm', parentId: null, type: 'model_change', model: 'gpt-5' })).toEqual({ kind: 'modelChange', model: 'gpt-5' })
    const other = describeTreeEntry({ id: 'o', parentId: null, type: 'reset_boundary' })
    expect(other).toEqual({ kind: 'other', entryType: 'reset_boundary' })
    expect(treePreviewText(other)).toBe('')
    expect(isBranchableEntry({ id: 'o', parentId: null, type: 'reset_boundary' })).toBe(false)
  })
})
