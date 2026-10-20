import { ArrowDown, ArrowUp, ChevronDown, Search, X } from 'lucide-react'
import { createContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isOverlayOpen } from '@/lib/app-shortcuts'
import { useI18n } from '@/lib/i18n'
import { searchTranscript, type SearchScope } from '@/lib/transcript-search'
import type { TranscriptMessage } from '@/types/api'
import './conversation-controls.css'

export const SearchRevealContext = createContext(false)

export function SearchMessage({ id, reveal, children }: { id: string; reveal: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!reveal || !ref.current) return
    const closed = [...ref.current.querySelectorAll('details')].filter((element) => !element.open)
    for (const element of closed) element.open = true
    return () => { for (const element of closed) element.open = false }
  }, [reveal])
  return <SearchRevealContext.Provider value={reveal}><div ref={ref} className={`search-message ${reveal ? 'is-search-match' : ''}`} data-message-id={id}>{children}</div></SearchRevealContext.Provider>
}

function highlightResult(element: HTMLElement, query: string): Highlight | undefined {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) { if (node instanceof Text && !node.parentElement?.closest('[aria-hidden="true"]')) nodes.push(node); node = walker.nextNode() }
  const raw = nodes.map((item) => item.data).join('')
  const text = raw.toLocaleLowerCase()
  if (text.length !== raw.length) return
  const needle = query.trim().toLocaleLowerCase()
  const ranges: Range[] = []
  for (let start = text.indexOf(needle); start >= 0 && needle && ranges.length < 1000; start = text.indexOf(needle, start + needle.length)) {
    const range = new Range()
    let offset = 0
    for (const item of nodes) {
      if (start >= offset && start < offset + item.length) range.setStart(item, start - offset)
      const end = start + needle.length
      if (end > offset && end <= offset + item.length) { range.setEnd(item, end - offset); break }
      offset += item.length
    }
    ranges.push(range)
  }
  return new Highlight(...ranges)
}

export function useTranscriptSearch(messages: TranscriptMessage[], root: RefObject<HTMLDivElement | null>, revealIndex: (index: number) => void, active = true) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const results = useMemo(() => searchTranscript(messages, query, scope), [messages, query, scope])
  const matchId = open && query.trim() ? results[index % Math.max(1, results.length)] : undefined
  const revealRef = useRef(revealIndex)
  revealRef.current = revealIndex
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  useEffect(() => {
    if (!active) return
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !isOverlayOpen()) {
        if (!open && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement
        event.preventDefault(); setOpen(true); inputRef.current?.focus(); inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, open])
  useEffect(() => { if (open && active) inputRef.current?.focus() }, [open, active])
  useEffect(() => {
    if (!active || !matchId) return
    revealRef.current(messagesRef.current.findIndex((message) => message.id === matchId))
    const frame = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(matchId)}"]`)?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [matchId, active, root, query, scope])
  useEffect(() => {
    if (!active || !matchId || !root.current) return
    let highlight: Highlight | undefined
    const frame = requestAnimationFrame(() => {
      const element = root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(matchId)}"]`)
      if (element) { highlight = highlightResult(element, query); if (highlight) CSS.highlights.set('conversation-search', highlight) }
    })
    return () => {
      cancelAnimationFrame(frame)
      if (highlight && CSS.highlights.get('conversation-search') === highlight) CSS.highlights.delete('conversation-search')
    }
  }, [active, matchId, messages, query, root])
  return { open, query, scope, index: results.length ? index % results.length : 0, total: results.length, matchId, inputRef,
    show: () => { if (document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement; setOpen(true) },
    close: () => { setOpen(false); if (previousFocus.current?.isConnected) previousFocus.current.focus(); else root.current?.focus() },
    changeQuery: (value: string) => { setQuery(value); setIndex(0) }, changeScope: (value: SearchScope) => { setScope(value); setIndex(0) },
    move: (direction: number) => setIndex((current) => (current + direction + Math.max(1, results.length)) % Math.max(1, results.length)) }
}

export function TranscriptSearchBar({ state }: { state: ReturnType<typeof useTranscriptSearch> }) {
  const { t } = useI18n()
  const id = useId()
  if (!state.open) return <button type="button" className="conversation-search-trigger" onClick={state.show} aria-label={t('conversation.search.open')} title={t('conversation.search.open')}><Search size={15} /></button>
  const hasMatches = state.total > 0
  return <section className={`conversation-search ${hasMatches ? 'has-matches' : ''}`} aria-label={t('conversation.search.open')} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.close() }
    if (event.key === 'Enter' && event.target === state.inputRef.current) { event.preventDefault(); state.move(event.shiftKey ? -1 : 1) }
  }}>
    <Search className="conversation-search__icon" size={14} aria-hidden="true" />
    <input ref={state.inputRef} id={id} aria-label={t('conversation.search.query')} placeholder={t('conversation.search.query')} value={state.query} onChange={(event) => state.changeQuery(event.target.value)} />
    <span className="conversation-search__divider" aria-hidden="true" />
    <label className="conversation-search__scope">
      <select aria-label={t('conversation.search.scope')} value={state.scope} onChange={(event) => { const value = event.target.value; if (value === 'all' || value === 'messages' || value === 'tools' || value === 'thinking') state.changeScope(value) }}>
        {(['all', 'messages', 'tools', 'thinking'] as const).map((scope) => <option key={scope} value={scope}>{t(`conversation.search.${scope}`)}</option>)}
      </select>
      <ChevronDown size={11} aria-hidden="true" />
    </label>
    <span className={`conversation-search__count ${hasMatches ? 'is-active' : ''}`} role="status">{state.total ? `${state.index + 1}/${state.total}` : state.query.trim() ? t('conversation.search.none') : '0/0'}</span>
    <span className="conversation-search__divider" aria-hidden="true" />
    <div className="conversation-search__nav">
      <button type="button" disabled={!state.total} aria-label={t('conversation.search.previous')} title={t('conversation.search.previous')} onClick={() => state.move(-1)}><ArrowUp size={13} /></button>
      <button type="button" disabled={!state.total} aria-label={t('conversation.search.next')} title={t('conversation.search.next')} onClick={() => state.move(1)}><ArrowDown size={13} /></button>
      <button type="button" className="conversation-search__close" aria-label={t('conversation.search.close')} title={t('conversation.search.close')} onClick={state.close}><X size={13} /></button>
    </div>
  </section>
}
