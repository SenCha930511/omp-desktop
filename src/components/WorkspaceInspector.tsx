import { useSyncExternalStore } from 'react'
import { EMPTY_TRANSCRIPT_SUMMARY, type TranscriptStore } from '@/app/transcript-store'
import { Inspector, type InspectorProps } from './Inspector'

const emptySummary = () => EMPTY_TRANSCRIPT_SUMMARY
const noSubscription = () => () => undefined

/** The Summary tab reads the store's summary snapshot; no other tab touches the transcript at all. */
export function WorkspaceInspector({ transcript, ...props }: Omit<InspectorProps, 'summary'> & { transcript: TranscriptStore }) {
  const live = props.activeTab === 'summary'
  const summary = useSyncExternalStore(live ? transcript.subscribeSummary : noSubscription, live ? transcript.getSummary : emptySummary)
  return <Inspector {...props} summary={summary} />
}
