import { expect, it } from 'vitest'
import { commandOutputText } from '../../src/lib/command-output'

it('renders terminal output as inert text while preserving Unicode, tables and newlines', () => {
  expect(commandOutputText('\u001b[32m模型\u001b[0m\r\nA\tB\nabc\bD')).toBe('模型\nA\tB\nabD')
  expect(commandOutputText('\u001b]8;;https://example.com\u0007label\u001b]8;;\u001b\\')).toBe('label')
  expect(commandOutputText('\u001b]52;c;secret\u0007visible\u001bPpayload\u001b\\')).toBe('visible')
  expect(commandOutputText('\u009b31mtext\u009b0m\u0000\u0007')).toBe('text')
  expect(commandOutputText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
})
