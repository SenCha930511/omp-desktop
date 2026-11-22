import { memo, useSyncExternalStore } from 'react'
import type { TranscriptStore } from '@/app/transcript-store'
import { Transcript, type TranscriptProps } from './Transcript'

export type ConversationTranscriptProps = Omit<TranscriptProps, 'messages'> & { transcript: TranscriptStore }

// The store subscription already re-renders this shell on every streamed frame;
// the default shallow compare keeps an App re-render that changes nothing else
// (state, layout, git churn) from re-rendering it a second time. Every prop,
// including the `transcript` store, participates in the comparison.
export const ConversationTranscript = memo(function ConversationTranscript({ transcript, ...props }: ConversationTranscriptProps) {
  const messages = useSyncExternalStore(transcript.subscribe, transcript.getSnapshot)
  return <Transcript {...props} messages={messages} />
})
