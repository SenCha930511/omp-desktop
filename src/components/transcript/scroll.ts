import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { newestWindow } from '@/lib/render-bounds'
import type { TranscriptMessage } from '@/types/api'

export function useTranscriptScroll(messages: TranscriptMessage[]) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const previousStreamingRef = useRef(false)
  const pinnedToBottomRef = useRef(true)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [announcement, setAnnouncement] = useState('')
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const streaming = messages.some((message) => message.streaming)
  const visibleMessages = useMemo(() => newestWindow(messages, visibleLimit), [messages, visibleLimit])
  const hiddenCount = messages.length - visibleMessages.length

  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    const scroller = scrollRef.current
    let frame: number | undefined
    if (firstLoadedTranscript) {
      frame = requestAnimationFrame(() => scroller && typeof scroller.scrollTo === 'function' && scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
      pinnedToBottomRef.current = true
    } else if (streaming && pinnedToBottomRef.current) {
      frame = requestAnimationFrame(() => scroller && typeof scroller.scrollTo === 'function' && scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
    }
    if (previousStreamingRef.current && !streaming) setAnnouncement(t('transcript.announcement.complete'))
    else if (!previousStreamingRef.current && streaming) setAnnouncement(t('transcript.announcement.working'))
    previousStreamingRef.current = streaming
    previousCountRef.current = messages.length
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [messages, streaming, t])

  const updatePinnedState = () => {
    const scroller = scrollRef.current
    if (!scroller) return
    const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
    pinnedToBottomRef.current = pinned
    // Same-value updates bail out in React, so streaming scroll events stay cheap.
    setAwayFromBottom((away) => (away === !pinned ? away : !pinned))
  }

  const scrollToBottom = () => {
    const scroller = scrollRef.current
    if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    pinnedToBottomRef.current = true
    setAwayFromBottom(false)
  }

  const showEarlier = () => setVisibleLimit((limit) => Math.min(messages.length, limit + 250))

  return { announcement, awayFromBottom, hiddenCount, scrollRef, scrollToBottom, showEarlier, updatePinnedState, visibleMessages }
}
