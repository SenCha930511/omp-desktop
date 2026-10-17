import { useCallback, useState } from 'react'

const MAX_OUTPUT_CHARS = 128 * 1024

/** Ephemeral results belong to the active workspace, never the chat transcript. */
export function useCommandOutput(owner: number) {
  const [state, setState] = useState({ owner, text: '' })
  const append = useCallback((text: string) => {
    setState((current) => ({ owner, text: [current.owner === owner ? current.text : '', text].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS) }))
  }, [owner])
  const dismiss = useCallback(() => setState({ owner, text: '' }), [owner])
  return { text: state.owner === owner ? state.text : '', append, dismiss }
}
