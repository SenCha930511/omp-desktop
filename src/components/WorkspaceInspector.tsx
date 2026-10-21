import { useSyncExternalStore } from 'react'
import type { TranscriptStore } from '@/app/transcript-store'
import type { TranscriptMessage } from '@/types/api'
import { Inspector, type InspectorProps } from './Inspector'

const EMPTY_MESSAGES: TranscriptMessage[] = []
const emptySnapshot = () => EMPTY_MESSAGES
const noSubscription = () => () => undefined

export function WorkspaceInspector({ transcript, ...props }: Omit<InspectorProps, 'messages'> & { transcript: TranscriptStore }) {
  const live = props.activeTab === 'summary'
  const messages = useSyncExternalStore(live ? transcript.subscribe : noSubscription, live ? transcript.getSnapshot : emptySnapshot)
  return <Inspector {...props} messages={messages} />
}
