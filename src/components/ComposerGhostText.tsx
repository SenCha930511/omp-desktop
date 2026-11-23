import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

interface ComposerGhostTextProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  text: string
  cursor: number
  suggestion: string
}

export function ComposerGhostText({ textareaRef, text, cursor, suggestion }: ComposerGhostTextProps) {
  const mirrorRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return
    const syncStyle = () => {
      const source = window.getComputedStyle(textarea)
      const style = mirror.style
      if (textarea.clientWidth > 0) style.width = `${textarea.clientWidth}px`
      if (textarea.clientHeight > 0) style.height = `${textarea.clientHeight}px`
      style.padding = source.padding
      style.borderStyle = source.borderStyle
      style.borderWidth = '0'
      style.borderRadius = source.borderRadius
      style.boxSizing = source.boxSizing
      style.font = source.font
      style.fontFamily = source.fontFamily
      style.fontSize = source.fontSize
      style.fontWeight = source.fontWeight
      style.fontStyle = source.fontStyle
      style.fontStretch = source.fontStretch
      style.fontVariant = source.fontVariant
      style.lineHeight = source.lineHeight
      style.letterSpacing = source.letterSpacing
      style.wordSpacing = source.wordSpacing
      style.textAlign = source.textAlign
      style.textIndent = source.textIndent
      style.textTransform = source.textTransform
      style.whiteSpace = source.whiteSpace
      style.overflowWrap = source.overflowWrap
      style.wordBreak = source.wordBreak
      style.tabSize = source.tabSize
    }
    const syncScroll = () => {
      mirror.scrollTop = textarea.scrollTop
      mirror.scrollLeft = textarea.scrollLeft
    }
    const resizeObserver = new ResizeObserver(() => {
      syncStyle()
      syncScroll()
    })
    syncStyle()
    syncScroll()
    resizeObserver.observe(textarea)
    textarea.addEventListener('scroll', syncScroll)
    return () => {
      resizeObserver.disconnect()
      textarea.removeEventListener('scroll', syncScroll)
    }
  }, [textareaRef, text, cursor, suggestion])

  return (
    <div ref={mirrorRef} className="composer-ghost-text" aria-hidden="true">
      <span className="composer-ghost-text__existing">{text.slice(0, cursor)}</span>
      <span className="composer-ghost-text__suffix">{suggestion}</span>
      <span className="composer-ghost-text__existing">{text.slice(cursor)}</span>
    </div>
  )
}
