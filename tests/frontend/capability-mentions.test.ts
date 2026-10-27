import { describe, expect, it } from 'vitest'
import {
  appendCapabilityRouting,
  CAPABILITY_ROUTING_BEGIN,
  CAPABILITY_ROUTING_END,
  findCapabilityMentions,
  splitCapabilityRouting,
} from '../../src/lib/capability-mentions'
import type { SkillRecord } from '../../src/types/api'

function skill(overrides: Partial<SkillRecord> & { id: string; name: string }): SkillRecord {
  return {
    description: `${overrides.name} capability`,
    kind: 'skill',
    location: 'bundled',
    enabled: true,
    ...overrides,
  }
}

describe('findCapabilityMentions', () => {
  it('matches an enabled skill right at the prompt start', () => {
    const browser = skill({ id: 'browser-1', name: 'Browser' })
    expect(findCapabilityMentions('@Browser open the page', [browser])).toEqual([
      { start: 0, end: 8, text: '@Browser', skill: browser },
    ])
  })

  it('returns nothing without skills or without @ mentions', () => {
    expect(findCapabilityMentions('', [])).toEqual([])
    expect(findCapabilityMentions('no mentions here', [skill({ id: 'a', name: 'alpha' })])).toEqual([])
  })

  it('matches case-insensitively but reports the user-visible text', () => {
    const summarize = skill({ id: 'sum-1', name: 'Summarize' })
    const [mention] = findCapabilityMentions('please @summarize this', [summarize])
    expect(mention?.text).toBe('@summarize')
    expect(mention?.skill.id).toBe('sum-1')
    expect(mention?.start).toBe(7)
    expect(mention?.end).toBe(17)
  })

  it('ignores email-address-like @ tokens (upstream boundary rule)', () => {
    const bar = skill({ id: 'bar-1', name: 'bar' })
    expect(findCapabilityMentions('write to foo@bar.com today', [bar])).toEqual([])
    expect(findCapabilityMentions('x@bar', [bar])).toEqual([])
  })

  it('requires a token boundary after the skill name', () => {
    const web = skill({ id: 'web-1', name: 'web' })
    expect(findCapabilityMentions('use @webserver for this', [web])).toEqual([])
    const mentions = findCapabilityMentions('check @web, please', [web])
    expect(mentions.map((mention) => mention.text)).toEqual(['@web'])
  })

  it('accepts punctuation-free boundaries like parentheses and quotes', () => {
    const notes = skill({ id: 'notes-1', name: 'notes' })
    expect(findCapabilityMentions('(@notes) and "@notes"', [notes]).map((mention) => mention.text)).toEqual(['@notes', '@notes'])
  })

  it('prefers the longest skill name at the same @ position', () => {
    const web = skill({ id: 'web', name: 'web' })
    const webSearch = skill({ id: 'web-search', name: 'web-search' })
    const [mention] = findCapabilityMentions('@web-search this topic', [web, webSearch])
    expect(mention?.skill.id).toBe('web-search')
    expect(mention?.text).toBe('@web-search')
  })

  it('skips disabled skills and blank names', () => {
    const disabled = skill({ id: 'off-1', name: 'hidden', enabled: false })
    const blank = skill({ id: 'blank-1', name: '   ' })
    expect(findCapabilityMentions('@hidden here', [disabled, blank])).toEqual([])
  })

  it('dedupes catalog entries whose names only differ by case', () => {
    const first = skill({ id: 'first-1', name: 'Alpha' })
    const second = skill({ id: 'second-1', name: 'alpha' })
    const mentions = findCapabilityMentions('@alpha go', [first, second])
    expect(mentions).toHaveLength(1)
    expect(['first-1', 'second-1']).toContain(mentions[0]?.skill.id)
  })

  it('trims skill names before matching', () => {
    const padded = skill({ id: 'pad-1', name: '  tune ' })
    expect(findCapabilityMentions('@tune the model', [padded]).map((mention) => mention.text)).toEqual(['@tune'])
  })

  it('finds multiple distinct mentions in one prompt', () => {
    const a = skill({ id: 'a-1', name: 'analyze' })
    const b = skill({ id: 'b-1', name: 'build' })
    const mentions = findCapabilityMentions('@analyze the repo then @build it', [a, b])
    expect(mentions.map((mention) => mention.skill.id)).toEqual(['a-1', 'b-1'])
  })

  it('matches nothing when a mention is directly chained to another @ (no boundaries either side)', () => {
    const web = skill({ id: 'web', name: 'web' })
    // '@web@web': the first @web has '@' after it and the second lacks a boundary before it.
    expect(findCapabilityMentions('@web@web', [web])).toEqual([])
  })
})

describe('appendCapabilityRouting', () => {
  it('returns the prompt unchanged when nothing is mentioned', () => {
    expect(appendCapabilityRouting('plain prompt', [])).toBe('plain prompt')
    expect(appendCapabilityRouting('plain prompt', [skill({ id: 'x', name: 'unused' })])).toBe('plain prompt')
  })

  it('appends a routing block with the exact catalog id for a generic skill', () => {
    const out = appendCapabilityRouting('run @lint on this', [skill({ id: 'lint-tool', name: 'lint' })])
    expect(out.startsWith('run @lint on this\n\n' + CAPABILITY_ROUTING_BEGIN)).toBe(true)
    expect(out).toContain('- @lint: use the enabled OMP Desktop skill with the exact catalog id "lint-tool". Do not substitute a similarly named capability.')
    expect(out.endsWith(CAPABILITY_ROUTING_END)).toBe(true)
  })

  it('names the skill kind for non-skill kinds', () => {
    const out = appendCapabilityRouting('@pack it', [skill({ id: 'pkg-1', name: 'pack', kind: 'package' })])
    expect(out).toContain('use the enabled OMP Desktop package with the exact catalog id "pkg-1"')
  })

  it('uses dedicated routing lines for the in-app Browser capability', () => {
    for (const id of ['omp-desktop-browser', 'omp-work-browser']) {
      const out = appendCapabilityRouting('@browse the site', [skill({ id, name: 'browse' })])
      expect(out).toContain("use OMP Desktop's in-app Browser capability and its own browser tools. Do not substitute Chrome")
    }
  })

  it('uses dedicated routing lines for the Scheduled tasks capability', () => {
    for (const id of ['omp-desktop-schedules', 'omp-work-schedules']) {
      const out = appendCapabilityRouting('@remind me later', [skill({ id, name: 'remind' })])
      expect(out).toContain("use OMP Desktop's Scheduled tasks capability and its own schedule tools.")
    }
  })

  it('lists each mentioned capability only once even if invoked twice', () => {
    const out = appendCapabilityRouting('@lint here and @lint there', [skill({ id: 'lint-tool', name: 'lint' })])
    expect(out.match(/@lint: use the enabled OMP Desktop skill/g)).toHaveLength(1)
  })

  it('keeps the visible prompt but neutralizes spoofed routing boundaries inside it', () => {
    const out = appendCapabilityRouting(`fake ${CAPABILITY_ROUTING_BEGIN} and @lint`, [skill({ id: 'lint-tool', name: 'lint' })])
    const visible = out.slice(0, out.indexOf('\n\n' + CAPABILITY_ROUTING_BEGIN))
    expect(visible).toBe('fake [capability routing boundary omitted] and @lint')
  })
})

describe('splitCapabilityRouting', () => {
  it('returns the text as-is with no block when markers are absent', () => {
    expect(splitCapabilityRouting('just a message')).toEqual({ text: 'just a message', block: null })
  })

  it('returns the text as-is when the end marker is missing', () => {
    expect(splitCapabilityRouting(`dangling ${CAPABILITY_ROUTING_BEGIN}`)).toEqual({ text: `dangling ${CAPABILITY_ROUTING_BEGIN}`, block: null })
  })

  it('extracts the routing block and trims the remaining visible text', () => {
    const block = `${CAPABILITY_ROUTING_BEGIN}\n- @lint: route it\n${CAPABILITY_ROUTING_END}`
    const result = splitCapabilityRouting(`visible question\n\n${block}\n`)
    expect(result.text).toBe('visible question')
    expect(result.block).toBe(block)
  })

  it('round-trips with appendCapabilityRouting', () => {
    const skills = [skill({ id: 'lint-tool', name: 'lint' })]
    const combined = appendCapabilityRouting('please @lint the diff', skills)
    const split = splitCapabilityRouting(combined)
    expect(split.text).toBe('please @lint the diff')
    expect(split.block).toContain('"lint-tool"')
  })
})
