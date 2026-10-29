import { expect, it } from 'vitest'
import { SESSION_MODE_DIRECTIVES, withSessionModeDirective } from '../../src/lib/session-mode'

it('leaves prompts untouched without a mode', () => {
  expect(withSessionModeDirective(null, 'fix the bug')).toBe('fix the bug')
})

it('prefixes plan and goal directives and stays idempotent', () => {
  const plan = withSessionModeDirective('plan', 'add tests')
  expect(plan.startsWith(SESSION_MODE_DIRECTIVES.plan)).toBe(true)
  expect(plan.endsWith('add tests')).toBe(true)
  expect(withSessionModeDirective('plan', plan)).toBe(plan)

  const goal = withSessionModeDirective('goal', 'ship v1')
  expect(goal.startsWith(SESSION_MODE_DIRECTIVES.goal)).toBe(true)
  expect(goal).toContain('ship v1')
})
