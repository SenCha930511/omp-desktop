#!/usr/bin/env node
/**
 * Comparator: deep-compares normalized projections and produces PASS/DIFF
 * with bounded, redacted diff context. Pure functions, no IO.
 */

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const key of ak) {
    if (!deepEqual(a[key], b[key])) return false
  }
  return true
}

function describe(value) {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

/** Compares two normalized entry lists; returns { pass, diffs } with context. */
export function compareSessionProjections(rpcEntries, tuiEntries, { maxDiffs = 20 } = {}) {
  const diffs = []
  const push = (where, detail) => {
    if (diffs.length < maxDiffs) diffs.push({ where, detail })
  }
  if (rpcEntries.length !== tuiEntries.length) {
    push('entry-count', `rpc=${rpcEntries.length} tui=${tuiEntries.length}`)
  }
  const shared = Math.min(rpcEntries.length, tuiEntries.length)
  for (let index = 0; index < shared; index += 1) {
    if (!deepEqual(rpcEntries[index], tuiEntries[index])) {
      push('entry-' + index, `rpc=${describe(rpcEntries[index])} tui=${describe(tuiEntries[index])}`)
    }
  }
  if (rpcEntries.length > shared) {
    for (let index = shared; index < rpcEntries.length; index += 1) push('rpc-only-' + index, describe(rpcEntries[index]))
  }
  if (tuiEntries.length > shared) {
    for (let index = shared; index < tuiEntries.length; index += 1) push('tui-only-' + index, describe(tuiEntries[index]))
  }
  return { pass: diffs.length === 0, diffs }
}

/** Compares arbitrary normalized projections (state snapshots, message lists). */
export function compareProjections(label, left, right) {
  const diffs = []
  if (!deepEqual(left, right)) {
    diffs.push({ where: label, detail: `rpc=${describe(left)} tui=${describe(right)}` })
  }
  return { pass: diffs.length === 0, diffs }
}
