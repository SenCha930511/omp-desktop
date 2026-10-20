import { useCallback, useRef, useState } from 'react'
import { commandOutputText } from '@/lib/command-output'

const MAX_OUTPUT_CHARS = 128 * 1024

const MAX_RESULTS = 5
export interface CommandResult { id: number; text: string; command?: string; status?: 'running' | 'completed' | 'failed' }
interface OutputState { owner: number; entries: CommandResult[]; activeId?: number; selectedId?: number; visible: boolean }

/** Late frames update the active command, never a selected older result. */
export function useCommandOutput(owner: number) {
  const [state, setState] = useState<OutputState>({ owner, entries: [], visible: false })
  const sequence = useRef(0)
  const begin = useCallback((command: string) => {
    const id = ++sequence.current
    const entry: CommandResult = { id, command, status: 'running', text: '' }
    setState((current) => ({ owner, entries: [entry, ...(current.owner === owner ? current.entries : [])].slice(0, MAX_RESULTS), activeId: id, selectedId: id, visible: true }))
  }, [owner])
  const finish = useCallback((failure?: string, agentInvoked = false) => setState((current) => {
    if (current.owner !== owner) return current
    const active = current.entries.find((entry) => entry.id === current.activeId)
    if (!active) return current
    if (agentInvoked && !active.text) return { ...current, entries: current.entries.filter((entry) => entry.id !== active.id), activeId: undefined, visible: current.selectedId === active.id ? false : current.visible }
    return { ...current, entries: current.entries.map((entry) => entry.id !== active.id ? entry : {
      ...entry, status: failure || entry.status === 'failed' ? 'failed' : 'completed',
      text: failure ? [entry.text, commandOutputText(failure)].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS) : entry.text,
    }) }
  }), [owner])
  const append = useCallback((text: string, failed = false) => {
    const cleaned = commandOutputText(text)
    if (!cleaned.trim()) return
    const id = ++sequence.current
    setState((current) => {
      const entries = current.owner === owner ? current.entries : []
      const activeId = current.owner === owner && entries.some((entry) => entry.id === current.activeId) ? current.activeId : id
      const active = entries.find((entry) => entry.id === activeId)
      const next: CommandResult = { ...(active ?? { id: activeId ?? id, text: '' }), ...(failed ? { status: 'failed' as const } : {}), text: [active?.text, cleaned].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS) }
      return { owner, entries: (active ? entries.map((entry) => entry.id === activeId ? next : entry) : [next, ...entries]).slice(0, MAX_RESULTS), activeId, selectedId: current.owner === owner ? current.selectedId ?? activeId : activeId, visible: active ? current.visible : true }
    })
  }, [owner])
  const dismiss = useCallback(() => setState((current) => current.owner === owner ? { ...current, visible: false } : current), [owner])
  const clear = useCallback(() => setState((current) => current.owner === owner ? { owner, entries: [], visible: false } : current), [owner])
  const select = useCallback((id: number) => setState((current) => current.owner === owner && current.entries.some((entry) => entry.id === id) ? { ...current, selectedId: id, visible: true } : current), [owner])
  const history = state.owner === owner ? state.entries : []
  const selected = history.find((entry) => entry.id === state.selectedId) ?? history[0]
  const visible = state.owner === owner && state.visible
  return { text: visible ? selected?.text ?? '' : '', command: visible ? selected?.command : undefined, status: visible ? selected?.status : undefined,
    history, selectedId: selected?.id, visible, begin, finish, append, dismiss, clear, select }
}

export type CommandOutputView = ReturnType<typeof useCommandOutput>
