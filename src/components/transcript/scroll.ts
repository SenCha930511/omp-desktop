import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { TranscriptMessage } from '@/types/api'

/** Grace window for the jump button's smooth ride; matches the snappiest browsers need. */
const SMOOTH_SCROLL_GUARD_MS = 750

export function useTranscriptScroll(messages: TranscriptMessage[], active = true, followKey?: string | null) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const previousStreamingRef = useRef(false)
  const previousMessagesRef = useRef(messages)
  const pinnedToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const manualScrollUntilRef = useRef(0)
  const smoothScrollUntilRef = useRef(0)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [windowEnd, setWindowEnd] = useState<number>()
  const [announcement, setAnnouncement] = useState('')
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const streaming = messages.some((message) => message.streaming)
  const followKeyRef = useRef(followKey)
  if (followKeyRef.current !== followKey) {
    // Switching sessions (or landing on a brand-new one) re-engages the same
    // rule as pressing jump-to-bottom: a fresh conversation always follows
    // its tail. Mutated during render so the effects below observe the reset.
    followKeyRef.current = followKey
    previousCountRef.current = 0
    previousStreamingRef.current = false
    pinnedToBottomRef.current = true
    lastScrollTopRef.current = 0
    manualScrollUntilRef.current = 0
    setVisibleLimit(250)
    setWindowEnd(undefined)
    setAwayFromBottom(false)
    setHasNewContent(false)
  }
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
        if (active && scroller && pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current && performance.now() >= smoothScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      })
      pinnedToBottomRef.current = true
    } else if (streaming && pinnedToBottomRef.current) {
      frame = requestAnimationFrame(() => {
        if (active && scroller && pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current && performance.now() >= smoothScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
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
    // Content SHRINKING (streaming placeholder removed, message replaced by a
    // shorter final version) makes the browser clamp scrollTop down — that
    // reads exactly like a user scroll-up but is only the engine reflowing.
    // Treat height-loss frames as reflow, never as intent to unfollow.
    const shrank = scroller.scrollHeight < lastScrollHeightRef.current
    if (movedUp && !shrank) manualScrollUntilRef.current = performance.now() + 150
    lastScrollTopRef.current = scroller.scrollTop
    lastScrollHeightRef.current = scroller.scrollHeight
    // Content growth alone never fires scroll events — scrollTop stays parked
    // while scrollHeight rises — so any observed move is user-driven.
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    if (!movedUp && performance.now() < smoothScrollUntilRef.current) {
      // Mid smooth ride started by the jump button: our own scroll events
      // arrive above the bottom, which must not read as "user scrolled away".
      // Landing at the bottom ends the window early.
      if (atBottom) smoothScrollUntilRef.current = 0
      else return
    }
    if ((movedUp || !atBottom) && !shrank) {
      // An explicit move away (wheel/trackpad up, scrollbar drag, keyboard)
      // breaks following; the jump button brings it back.
      pinnedToBottomRef.current = false
      setAwayFromBottom(true)
    } else {
      // Reaching the bottom — from the jump button or a deliberate scroll
      // down — re-engages following. When a search window masked the tail,
      // it collapses exactly like the button so the live tail shows.
      if (hiddenAfter) {
        setWindowEnd(undefined)
        setVisibleLimit(250)
      }
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
      // The wheel gate demands actual upward travel: an upward flick with the
      // scroller pinned at its top (or content too short to scroll at all)
      // can never fire scroll events, yet it used to flag awayFromBottom —
      // and with nothing to scroll, nothing ever cleared it, leaving the jump
      // button stuck over a transcript already at its bottom.
      if ((event instanceof WheelEvent && event.deltaY < 0 && scroller.scrollTop > 1) || (target instanceof Element && target.closest('summary,button[aria-expanded]'))) {
        pinnedToBottomRef.current = false
        manualScrollUntilRef.current = performance.now() + 150
        if (event instanceof WheelEvent) setAwayFromBottom(true)
      }
    }
    const observer = new ResizeObserver(() => {
      // Growth during the smooth ride yields to the ride instead of snapping.
      if (pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current && performance.now() >= smoothScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      else if (!pinnedToBottomRef.current && windowEnd === undefined && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40) {
        // Self-heal any stuck "away" state whose layout already proves the
        // bottom is visible: content shrinking back under the parked scroll
        // position fires no scroll events, so without this the jump button
        // lingered over a live transcript that had caught up with the reader.
        pinnedToBottomRef.current = true
        setAwayFromBottom(false)
        setHasNewContent(false)
      }
    })
    observer.observe(content)
    scroller.addEventListener('wheel', stopFollowing, { passive: true })
    scroller.addEventListener('click', stopFollowing, true)
    return () => { observer.disconnect(); scroller.removeEventListener('wheel', stopFollowing); scroller.removeEventListener('click', stopFollowing, true) }
  }, [active, windowEnd])

  const scrollToBottom = () => {
    if (windowEnd !== undefined) { setWindowEnd(undefined); setVisibleLimit(250) }
    const scroller = scrollRef.current
    // Smooth ride, guarded by the window above: without it the mid-flight
    // distance would read as "user scrolled away" and cancel the refollow.
    if (scroller && typeof scroller.scrollTo === 'function') {
      smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_GUARD_MS
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    }
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
