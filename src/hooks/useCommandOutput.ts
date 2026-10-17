import { useCallback, useState } from 'react'
import { commandOutputText } from '@/lib/command-output'

const MAX_OUTPUT_CHARS = 128 * 1024

/** Ephemeral results belong to the active workspace, never the chat transcript. */
export function useCommandOutput(owner: number) {
  const [state, setState] = useState<{ owner: number; text: string; command?: string; status?: 'running' | 'completed' | 'failed' }>({ owner, text: '' })
  const begin = useCallback((command: string) => setState({ owner, command, status: 'running', text: '' }), [owner])
  const finish = useCallback((failure?: string, agentInvoked = false) => setState((current) => current.owner !== owner ? current : agentInvoked && !current.text ? { owner, text: '' } : {
    ...current, status: failure || current.status === 'failed' ? 'failed' : 'completed', text: failure ? [current.text, commandOutputText(failure)].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS) : current.text,
  }), [owner])
  const append = useCallback((text: string, failed = false) => {
    const cleaned = commandOutputText(text)
    if (!cleaned.trim()) return
    setState((current) => ({ ...(current.owner === owner ? current : { owner }), ...(failed ? { status: 'failed' as const } : {}), text: [current.owner === owner ? current.text : '', cleaned].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS) }))
  }, [owner])
  const dismiss = useCallback(() => setState({ owner, text: '' }), [owner])
  return { text: state.owner === owner ? state.text : '', command: state.owner === owner ? state.command : undefined,
    status: state.owner === owner ? state.status : undefined, begin, finish, append, dismiss }
}
