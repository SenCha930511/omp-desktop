import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { TranscriptMessage } from '@/types/api'

/** Grace window for the jump button's smooth ride; matches the snappiest browsers need. */
const SMOOTH_SCROLL_GUARD_MS = 750

/** How long an expanding disclosure holds following: the accordion animates
 *  for 200ms, and trackpad momentum decaying from the fling that preceded the
 *  click must not read as a deliberate scroll while it still runs. */
const EXPAND_HOLD_MS = 250

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
  /** Set while the reader expanded a work record: the accordion's growth
   *  must never re-engage the tail snap (see stopFollowing) — following only
   *  resumes via a deliberate scroll, the jump button, or a session switch. */
  const readerExpandedRef = useRef(false)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [windowEnd, setWindowEnd] = useState<number>()
  const [announcement, setAnnouncement] = useState('')
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [scrolled, setScrolled] = useState(false)
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
    readerExpandedRef.current = false
    setVisibleLimit(250)
    setWindowEnd(undefined)
    setAwayFromBottom(false)
    setHasNewContent(false)
    setScrolled(false)
  }
  const end = Math.min(messages.length, windowEnd ?? messages.length)
  const visibleMessages = useMemo(() => messages.slice(Math.max(0, end - visibleLimit), end), [messages, visibleLimit, end])
  const hiddenCount = end - visibleMessages.length
  const hiddenAfter = messages.length - end

  useLayoutEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = pinnedToBottomRef.current ? scrollRef.current.scrollHeight : lastScrollTopRef.current
      // Mirrors updatePinnedState: the top fade (see base.css) is a class
      // toggle, never a scroll()-driven animation on the scroller itself.
      setScrolled(scrollRef.current.scrollTop > 8)
    }
  }, [active, windowEnd])

  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    // A reader message landing at the tail — a send, a steer, or a queued
    // follow-up flushing now that the agent finished. Sending expresses
    // intent to watch the reply, even from deep in scrolled-up history, so
    // the view re-anchors to the live tail instead of parking on stale
    // context until the jump button is noticed. Batches can already carry
    // the first streaming assistant turn behind the user message, so every
    // appended message counts, not just the last.
    const sentByReader = previousCountRef.current > 0 && messages.length > previousCountRef.current && messages.slice(previousCountRef.current).some((message) => message.role === 'user')
    if (!pinnedToBottomRef.current && !sentByReader && messages.length > 0 && previousMessagesRef.current !== messages) setHasNewContent(true)
    previousMessagesRef.current = messages
    const scroller = scrollRef.current
    let frame: number | undefined
    if (firstLoadedTranscript) {
      frame = requestAnimationFrame(() => {
        if (active && scroller && pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current && performance.now() >= smoothScrollUntilRef.current) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      })
      pinnedToBottomRef.current = true
    } else if (sentByReader) {
      // No manual/smooth guards here: a send is a keyboard or button action,
      // never a scroll gesture, so nothing user-driven can be mid-flight.
      // Collapsing a masked search window re-keys the layout effect below,
      // which snaps the scroller; the rAF covers the already-live-tail case.
      pinnedToBottomRef.current = true
      readerExpandedRef.current = false
      setAwayFromBottom(false)
      setHasNewContent(false)
      if (windowEnd !== undefined) {
        setWindowEnd(undefined)
        setVisibleLimit(250)
      }
      frame = requestAnimationFrame(() => {
        if (active && scroller) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
      })
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
  }, [messages, streaming, t, active, windowEnd])

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
    setScrolled(scroller.scrollTop > 8)
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
    // A scroll event resolves an expanded work record's hold once the click's
    // manual window has passed — earlier events are only trackpad momentum
    // decaying from the fling that carried the cursor to the toggle, never a
    // fresh reading position.
    if (readerExpandedRef.current && performance.now() >= manualScrollUntilRef.current) readerExpandedRef.current = false
    if ((movedUp || !atBottom) && !shrank) {
      // An explicit move away (wheel/trackpad up, scrollbar drag, keyboard)
      // breaks following; the jump button brings it back.
      pinnedToBottomRef.current = false
      setAwayFromBottom(true)
    } else if (!readerExpandedRef.current) {
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
        // Expanding a work record must not drag the reader to the live tail:
        // the accordion keeps resizing for ~200ms after the click — past the
        // manual window — so the observer's near-bottom self-heal re-engaged
        // following mid-animation and the next frame snapped to the bottom,
        // burying the text the reader just opened. Expands therefore hold
        // following until the reader's next deliberate scroll; collapses and
        // wheel flicks keep the plain timed window so closing a record over
        // the tail resumes following right away. Capture phase still sees
        // aria-expanded before React toggles it, so "false" means opening.
        const expanding = !(event instanceof WheelEvent) && target instanceof Element && !!target.closest('button[aria-expanded="false"]')
        readerExpandedRef.current = expanding
        pinnedToBottomRef.current = false
        manualScrollUntilRef.current = performance.now() + (expanding ? EXPAND_HOLD_MS : 150)
        if (event instanceof WheelEvent) setAwayFromBottom(true)
        if (expanding && target instanceof Element) {
          // An expanded disclosure must not open under the composer: once
          // the accordion settles, pan the transcript by the overshoot so
          // the whole section — header, thinking rows, and tool output — is
          // readable. Sections taller than the viewport clamp at the tail;
          // the sticky status row keeps their title in view while scrolling.
          const section = target.closest('.activity-line') ?? target.closest('.work-disclosure')
          if (section) {
            window.setTimeout(() => {
              const rect = section.getBoundingClientRect()
              const scrollerRect = scroller.getBoundingClientRect()
              const reserved = parseFloat(getComputedStyle(scroller).paddingBottom) || 0
              const visibleBottom = scrollerRect.bottom - reserved
              const overshoot = rect.bottom - visibleBottom
              if (overshoot <= 0) return
              const maxScroll = scroller.scrollHeight - scroller.clientHeight
              const next = Math.min(scroller.scrollTop + overshoot, maxScroll)
              if (next <= scroller.scrollTop) return
              smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_GUARD_MS
              manualScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_GUARD_MS
              scroller.scrollTo?.({ top: next, behavior: 'smooth' })
            }, EXPAND_HOLD_MS)
          }
        }
      }
    }
    const observer = new ResizeObserver(() => {
      // Growth during the smooth ride yields to the ride instead of snapping.
      if (pinnedToBottomRef.current && performance.now() >= manualScrollUntilRef.current && performance.now() >= smoothScrollUntilRef.current) {
        // The compositor can already have moved the scroller for a wheel
        // gesture while this callback waits behind a busy main thread — the
        // wheel event that clears the pin has not run yet. A follower parked
        // at the tail never sits below its last observed scrollTop, so a
        // lower position means the reader moved: hold the snap and let the
        // pending input resolve the pin instead of dragging the first
        // gesture back to the bottom.
        if (scroller.scrollTop >= lastScrollTopRef.current - 1) scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'auto' })
        else manualScrollUntilRef.current = performance.now() + 150
      } else if (!pinnedToBottomRef.current && !readerExpandedRef.current && windowEnd === undefined && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40) {
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
    // A scroll sequence that ends resting at the bottom is a deliberate
    // landing: the last scroll event can read as "away" (micro-jitter near
    // the end, or an expand hold whose manual window had not expired when
    // the final event fired) and static content never resizes to self-heal,
    // so the jump button used to linger over a transcript already at its
    // bottom. scrollend fires once the gesture — momentum included — has
    // truly stopped, which no residual fling can fake; only an expand
    // click's own hold still wins, keeping the accordion's growth from
    // re-engaging the tail snap mid-animation.
    const settleAtBottom = () => {
      if (readerExpandedRef.current && performance.now() < manualScrollUntilRef.current) return
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 40) return
      readerExpandedRef.current = false
      if (!pinnedToBottomRef.current) {
        pinnedToBottomRef.current = true
        setAwayFromBottom(false)
        setHasNewContent(false)
      }
    }
    scroller.addEventListener('scrollend', settleAtBottom)
    scroller.addEventListener('wheel', stopFollowing, { passive: true })
    scroller.addEventListener('click', stopFollowing, true)
    return () => { observer.disconnect(); scroller.removeEventListener('scrollend', settleAtBottom); scroller.removeEventListener('wheel', stopFollowing); scroller.removeEventListener('click', stopFollowing, true) }
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
    readerExpandedRef.current = false
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

  return { announcement, awayFromBottom, hasNewContent, hiddenCount, hiddenAfter, scrollRef, scrollToBottom, scrolled, showEarlier, showNewer, revealIndex, updatePinnedState, visibleMessages }
}
