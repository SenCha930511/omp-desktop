import type { SkillRecord } from '@/types/api'

export interface CapabilityMention {
  start: number
  end: number
  text: string
  skill: SkillRecord
}

export const CAPABILITY_ROUTING_BEGIN = '===== BEGIN GOOEYPI CAPABILITY ROUTING ====='
export const CAPABILITY_ROUTING_END = '===== END GOOEYPI CAPABILITY ROUTING ====='

const boundaryBefore = (value: string | undefined): boolean => value === undefined || /[\s([{"'`]/.test(value)
const boundaryAfter = (value: string | undefined): boolean => value === undefined || /[\s.,!?;:()[\]{}"'`]/.test(value)

function mentionCandidates(skills: readonly SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>()
  return skills
    .filter((skill) => skill.enabled && skill.name.trim())
    .sort((left, right) => right.name.length - left.name.length)
    .filter((skill) => {
      const key = skill.name.trim().toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Resolves visible @ mentions against the enabled catalog without treating email addresses as capabilities. */
export function findCapabilityMentions(value: string, skills: readonly SkillRecord[]): CapabilityMention[] {
  const candidates = mentionCandidates(skills)
  const lowerValue = value.toLocaleLowerCase()
  const mentions: CapabilityMention[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '@' || !boundaryBefore(value[index - 1])) continue
    const skill = candidates.find((candidate) => {
      const token = `@${candidate.name.trim()}`.toLocaleLowerCase()
      return lowerValue.startsWith(token, index) && boundaryAfter(value[index + token.length])
    })
    if (!skill) continue
    const end = index + skill.name.trim().length + 1
    mentions.push({ start: index, end, text: value.slice(index, end), skill })
    index = end - 1
  }
  return mentions
}

function routingInstruction(mention: CapabilityMention): string {
  const token = mention.text
  if (mention.skill.id === 'omp-desktop-browser' || mention.skill.id === 'omp-work-browser') {
    return `${token}: use OMP Desktop's in-app Browser capability and its own browser tools. Do not substitute Chrome, an external browser, or another connected browser tool.`
  }
  if (mention.skill.id === 'omp-desktop-schedules' || mention.skill.id === 'omp-work-schedules') {
    return `${token}: use OMP Desktop's Scheduled tasks capability and its own schedule tools.`
  }
  return `${token}: use the enabled OMP Desktop ${mention.skill.kind} with the exact catalog id ${JSON.stringify(mention.skill.id)}. Do not substitute a similarly named capability.`
}

/** Adds explicit routing semantics while keeping the user's visible prompt unchanged. */
export function appendCapabilityRouting(prompt: string, skills: readonly SkillRecord[]): string {
  const mentions = findCapabilityMentions(prompt, skills)
  const unique = mentions.filter((mention, index) => mentions.findIndex((candidate) => candidate.skill.id === mention.skill.id) === index)
  if (!unique.length) return prompt
  const visiblePrompt = prompt
    .replaceAll(CAPABILITY_ROUTING_BEGIN, '[capability routing boundary omitted]')
    .replaceAll(CAPABILITY_ROUTING_END, '[capability routing boundary omitted]')
  return `${visiblePrompt}\n\n${CAPABILITY_ROUTING_BEGIN}\nThe user explicitly invoked the following @ capabilities. Follow this routing for the request:\n${unique.map((mention) => `- ${routingInstruction(mention)}`).join('\n')}\n${CAPABILITY_ROUTING_END}`
}

export function splitCapabilityRouting(text: string): { text: string; block: string | null } {
  const begin = text.indexOf(CAPABILITY_ROUTING_BEGIN)
  if (begin === -1) return { text, block: null }
  const end = text.indexOf(CAPABILITY_ROUTING_END, begin)
  if (end === -1) return { text, block: null }
  const block = text.slice(begin, end + CAPABILITY_ROUTING_END.length)
  return { text: `${text.slice(0, begin)}${text.slice(end + CAPABILITY_ROUTING_END.length)}`.trim(), block }
}
