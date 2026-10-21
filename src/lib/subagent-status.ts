export function terminalSubagentPhase(status: string): 'failed' | 'cancelled' | 'completed' | undefined {
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'aborted' || status === 'cancelled' || status === 'stopped') return 'cancelled'
  if (status === 'completed') return 'completed'
  return undefined
}
