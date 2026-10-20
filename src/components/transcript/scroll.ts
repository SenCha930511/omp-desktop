import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { TranscriptMessage } from '@/types/api'

export function useTranscriptScroll(messages: TranscriptMessage[], active = true) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const previousStreamingRef = useRef(false)
  const previousMessagesRef = useRef(messages)
  const pinnedToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const manualScrollUntilRef = useRef(0)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [windowEnd, setWindowEnd] = useState<number>()
  const [announcement, setAnnouncement] = useState('')
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const streaming = messages.some((message) => message.streaming)
  const end = Math.min(messages.length, windowEnd ?? messages.length)
  const visibleMessages = useMemo(() => messages.slice(Math.max(0, end - visibleLimit), end), [messages, visibleLimit, end])
  const hiddenCount = end - visibleMessages.length
  const hiddenAfter = messages.length - end

  useLayoutEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = pinnedToBottomRef.current ? scrollRef.current.scrollHeight : lastScrollTopRef.current
  }, [active, windowEnd])

  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    if (!pinnedToBottomRef.current && messages.length > 0 && previousMessagesRef.current !== messages) setHasNewContent(true)
    previousMessagesRef.current = messages
    const scroller = scrollRef.current
    let frame: number | undefined
    if (firstLoadedTranscript) {
      frame = requestAnimationFrame(() => {
        if (active && scroller && pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      })
      pinnedToBottomRef.current = true
    } else if (streaming && pinnedToBottomRef.current) {
      frame = requestAnimationFrame(() => {
        if (active && scroller && pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      })
    }
    if (previousStreamingRef.current && !streaming) setAnnouncement(t('transcript.announcement.complete'))
    else if (!previousStreamingRef.current && streaming) setAnnouncement(t('transcript.announcement.working'))
    previousStreamingRef.current = streaming
    previousCountRef.current = messages.length
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [messages, streaming, t, active])

  const updatePinnedState = () => {
    if (!active) return
    const scroller = scrollRef.current
    if (!scroller) return
    const movedUp = scroller.scrollTop < lastScrollTopRef.current - 1
    if (movedUp) manualScrollUntilRef.current = performance.now() + 150
    lastScrollTopRef.current = scroller.scrollTop
    // Content growth alone never fires scroll events — scrollTop stays parked
    // while scrollHeight rises — so any observed move is user-driven.
    const atBottom = !hiddenAfter && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    if (movedUp || !atBottom) {
      // An explicit move away (wheel/trackpad up, scrollbar drag, keyboard)
      // breaks following; the jump button brings it back.
      pinnedToBottomRef.current = false
      setAwayFromBottom(true)
    } else {
      // Reaching the bottom — from the jump button or a deliberate scroll
      // down — re-engages following, so the view tracks live output again.
      if (!pinnedToBottomRef.current) setHasNewContent(false)
      pinnedToBottomRef.current = true
      setAwayFromBottom(false)
    }
  }

  useEffect(() => {
    const scroller = scrollRef.current
    const content = scroller?.querySelector('.transcript__inner')
    if (!active || !scroller || !content) return
    const stopFollowing = (event: Event) => {
      const target = event.target
      if ((event instanceof WheelEvent && event.deltaY < 0) || (target instanceof Element && target.closest('summary,button[aria-expanded]'))) {
        pinnedToBottomRef.current = false
        manualScrollUntilRef.current = performance.now() + 150
        if (event instanceof WheelEvent) setAwayFromBottom(true)
      }
    }
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
    })
    observer.observe(content)
    scroller.addEventListener('wheel', stopFollowing, { passive: true })
    scroller.addEventListener('click', stopFollowing, true)
    return () => { observer.disconnect(); scroller.removeEventListener('wheel', stopFollowing); scroller.removeEventListener('click', stopFollowing, true) }
  }, [active])

  const scrollToBottom = () => {
    if (windowEnd !== undefined) { setWindowEnd(undefined); setVisibleLimit(250) }
    const scroller = scrollRef.current
    // An instant snap, not a smooth ride: mid-flight distance would read as
    // "user scrolled away" in the events above and cancel the refollow.
    if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' })
    pinnedToBottomRef.current = true
    setHasNewContent(false)
    setAwayFromBottom(false)
  }

  const showEarlier = () => setVisibleLimit((limit) => Math.min(messages.length, limit + 250))
  const showNewer = () => { setWindowEnd(Math.min(messages.length, end + 250)); setVisibleLimit(250) }
  const revealIndex = (index: number) => {
    if (index < 0) return
    pinnedToBottomRef.current = false
    manualScrollUntilRef.current = performance.now() + 150
    setAwayFromBottom(true)
    // Searching a distant match moves a bounded window instead of mounting every
    // message between the match and the latest reply.
    if (index < end - visibleMessages.length || index >= end) {
      setWindowEnd(Math.min(messages.length, Math.max(250, index + 125)))
      setVisibleLimit(250)
    }
  }

  return { announcement, awayFromBottom, hasNewContent, hiddenCount, hiddenAfter, scrollRef, scrollToBottom, showEarlier, showNewer, revealIndex, updatePinnedState, visibleMessages }
}
