import { describe, expect, it } from 'vitest'
import {
  formatQueuedItemsForRestore,
  isContinueShorthand,
  MANUAL_CONTINUE_PROMPT,
  parseQueueShorthandInput,
} from '../../src/lib/input-shorthands'

describe('isContinueShorthand', () => {
  it('accepts exactly `.` or `c` (caller passes an already-trimmed draft)', () => {
    expect(isContinueShorthand('.')).toBe(true)
    expect(isContinueShorthand('c')).toBe(true)
  })

  it('rejects near misses', () => {
    expect(isContinueShorthand('')).toBe(false)
    expect(isContinueShorthand('C')).toBe(false)
    expect(isContinueShorthand('cc')).toBe(false)
    expect(isContinueShorthand('..')).toBe(false)
    expect(isContinueShorthand(' continue')).toBe(false)
  })
})

describe('MANUAL_CONTINUE_PROMPT', () => {
  it('is the upstream synthetic continue notice, not a slash command', () => {
    expect(MANUAL_CONTINUE_PROMPT).toContain('<system-notice>')
    expect(MANUAL_CONTINUE_PROMPT).toContain('MUST resume most recent intent')
    expect(MANUAL_CONTINUE_PROMPT).toContain('</system-notice>')
  })
})

describe('parseQueueShorthandInput', () => {
  it('returns null when the input has no queue prefix', () => {
    expect(parseQueueShorthandInput('hello')).toBeNull()
    expect(parseQueueShorthandInput('a -> later arrow is prose')).toBeNull()
    expect(parseQueueShorthandInput(' -> leading whitespace keeps the arrow off the start')).toBeNull()
    expect(parseQueueShorthandInput('')).toBeNull()
  })

  it('parses both `->` and `=>` single-message forms', () => {
    expect(parseQueueShorthandInput('-> fix the test')).toEqual({ items: ['fix the test'] })
    expect(parseQueueShorthandInput('=> fix the test')).toEqual({ items: ['fix the test'] })
    expect(parseQueueShorthandInput('=>   padded message  ')).toEqual({ items: ['padded message'] })
  })

  it('returns empty items when only the prefix is typed (caller shows Usage hint)', () => {
    expect(parseQueueShorthandInput('->')).toEqual({ items: [] })
    expect(parseQueueShorthandInput('=>')).toEqual({ items: [] })
    expect(parseQueueShorthandInput('=>   ')).toEqual({ items: [] })
  })

  it('splits a numbered counted list into separate queued items', () => {
    expect(parseQueueShorthandInput('=>\n1. first\n2. second\n3. third')).toEqual({ items: ['first', 'second', 'third'] })
    expect(parseQueueShorthandInput('->\n1) alpha\n2) beta')).toEqual({ items: ['alpha', 'beta'] })
  })

  it('counts unnumbered shorthand body lines as one message even with blank-line noise', () => {
    // Empty items in the middle of a counted list are invalid — fall back to one body message.
    expect(parseQueueShorthandInput('=>\n1. \n2. b')).toEqual({ items: ['1. \n2. b'] })
  })

  it('keeps a continuation line with its numbered item', () => {
    expect(parseQueueShorthandInput('=>\n1. run tests\n   then report\n2. file the issue')).toEqual({
      items: ['run tests\n   then report', 'file the issue'],
    })
  })

  it('accepts roman-numeral and alphabetic sequences in one consistent case', () => {
    expect(parseQueueShorthandInput('=>\nI. uno\nII. dos\nIII. tres')).toEqual({ items: ['uno', 'dos', 'tres'] })
    expect(parseQueueShorthandInput('=>\ni. one\nii. two')).toEqual({ items: ['one', 'two'] })
    expect(parseQueueShorthandInput('=>\na. first\nb. second\nc. third')).toEqual({ items: ['first', 'second', 'third'] })
    expect(parseQueueShorthandInput('=>\nZ. last letter\nAA. double letter')).toEqual({ items: ['last letter', 'double letter'] })
  })

  it('rejects lists that are not counted lists — the body stays one message', () => {
    // Non-sequential numbers.
    expect(parseQueueShorthandInput('=>\n1. a\n3. b')).toEqual({ items: ['1. a\n3. b'] })
    // Mixed marker punctuation.
    expect(parseQueueShorthandInput('=>\n1) a\n2. b')).toEqual({ items: ['1) a\n2. b'] })
    // Mixed marker case.
    expect(parseQueueShorthandInput('=>\nA. one\nb. two')).toEqual({ items: ['A. one\nb. two'] })
    // Deeper-indent second item does not join the top-level list.
    expect(parseQueueShorthandInput('=>\n1. top\n  2. nested')).toEqual({ items: ['1. top\n  2. nested'] })
    // Markers that are not roman/alpha/arabic sequences.
    expect(parseQueueShorthandInput('=>\ncs. x\nee. y')).toEqual({ items: ['cs. x\nee. y'] })
  })

  it('keeps indented multi-line content inside one trimmed message when no list is counted', () => {
    expect(parseQueueShorthandInput('=>  line one\n  line two  ')).toEqual({ items: ['line one\n  line two'] })
  })

  it('drops a trailing empty numbered item (TUI behavior for a stray trailing marker)', () => {
    expect(parseQueueShorthandInput('=>\n1. kept\n2. ')).toEqual({ items: ['kept'] })
  })
})

describe('formatQueuedItemsForRestore', () => {
  it('restores a single item as `=> text`', () => {
    expect(formatQueuedItemsForRestore(['finish the refactor'])).toBe('=> finish the refactor')
  })

  it('restores multiple items as a `=>` numbered list', () => {
    expect(formatQueuedItemsForRestore(['first', 'second'])).toBe('=>\n1. first\n2. second')
  })

  it('indents continuation lines so multi-line items survive one list item each', () => {
    expect(formatQueuedItemsForRestore(['one\ntwo', 'three'])).toBe('=>\n1. one\n   two\n2. three')
  })

  it('restores an empty remainder as a bare prefix line', () => {
    expect(formatQueuedItemsForRestore([])).toBe('=>\n')
  })

  it('round-trips through parseQueueShorthandInput for single-line items', () => {
    const items = ['plan the work', 'run the tests', 'open the PR']
    expect(parseQueueShorthandInput(formatQueuedItemsForRestore(items))).toEqual({ items })
  })
})
