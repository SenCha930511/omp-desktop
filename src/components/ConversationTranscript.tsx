import { useSyncExternalStore, type ComponentProps } from 'react'
import type { TranscriptStore } from '@/app/transcript-store'
import { Transcript } from './Transcript'

export function ConversationTranscript({ transcript, ...props }: Omit<ComponentProps<typeof Transcript>, 'messages'> & { transcript: TranscriptStore }) {
  const messages = useSyncExternalStore(transcript.subscribe, transcript.getSnapshot)
  return <Transcript {...props} messages={messages} />
}
