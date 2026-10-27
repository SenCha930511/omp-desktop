import { describe, expect, it } from 'vitest'
import { parseBashShorthandInput, parsePythonShorthandInput } from '../../src/lib/input-shorthands'

describe('parseBashShorthandInput', () => {
  it('parses a single-bang shell command', () => {
    expect(parseBashShorthandInput('!ls -la')).toEqual({ command: 'ls -la', excludeFromContext: false })
    expect(parseBashShorthandInput('!  git status  ')).toEqual({ command: 'git status', excludeFromContext: false })
    expect(parseBashShorthandInput('  !pwd')).toEqual({ command: 'pwd', excludeFromContext: false })
  })

  it('marks double-bang as exclude-from-context (RPC gap — caller must refuse)', () => {
    expect(parseBashShorthandInput('!!secret-scan')).toEqual({ command: 'secret-scan', excludeFromContext: true })
    expect(parseBashShorthandInput('!!  make test')).toEqual({ command: 'make test', excludeFromContext: true })
    // `!!` alone with no command falls through to normal prompt handling.
    expect(parseBashShorthandInput('!!')).toBeNull()
    expect(parseBashShorthandInput('!')).toBeNull()
  })

  it('leaves non-shortcut text alone', () => {
    expect(parseBashShorthandInput('hello!')).toBeNull()
    expect(parseBashShorthandInput('factorial of 5! is 120')).toBeNull()
    expect(parseBashShorthandInput('/compact')).toBeNull()
    expect(parseBashShorthandInput('')).toBeNull()
  })
})

describe('parsePythonShorthandInput', () => {
  it('parses `$ code` and marks `$$ code` as excluded', () => {
    expect(parsePythonShorthandInput('$ x = 1')).toEqual({ code: 'x = 1', excludeFromContext: false })
    expect(parsePythonShorthandInput('$$ x = 1')).toEqual({ code: 'x = 1', excludeFromContext: true })
    expect(parsePythonShorthandInput('$\tprint(1)')).toEqual({ code: 'print(1)', excludeFromContext: false })
    expect(parsePythonShorthandInput('$\nprint(1)')).toEqual({ code: 'print(1)', excludeFromContext: false })
  })

  it('does not hijack shell-style variables in prose (upstream #2944)', () => {
    expect(parsePythonShorthandInput('$HOME is where the heart is')).toBeNull()
    expect(parsePythonShorthandInput('$$5 off coupon')).toBeNull()
    expect(parsePythonShorthandInput('$')).toBeNull()
  })

  it('does not treat a pasted shell transcript as Python', () => {
    expect(parsePythonShorthandInput('$ git status && npm test')).toBeNull()
    expect(parsePythonShorthandInput('$ cd /tmp && ls')).toBeNull()
    expect(parsePythonShorthandInput('$ make build')).toBeNull()
    expect(parsePythonShorthandInput('$ ls -la | head')).toBeNull()
    expect(parsePythonShorthandInput('$ in: 10 out: 20 t: 1s tok/s: 5')).toBeNull()
  })
})
