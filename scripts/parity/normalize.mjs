#!/usr/bin/env node
/**
 * Normalizer: turns a session .jsonl (or any JSON value) into a comparable,
 * deterministic semantic projection.
 *
 * Audit contract: 正規化隨機 ID、時間與測試路徑後比較。Dropped fields are
 * listed per entry type below; anything semantically meaningful (roles,
 * content text, model identity, entry order) is kept so a real behavioral
 * difference between the RPC and TUI paths shows up as a diff.
 *
 * Known limits (documented in README): entry id/parentId chains are dropped
 * (order is kept); usage/cost numbers are dropped; `system-prompt-digest`
 * data is dropped because the digest legitimately differs across UI surfaces
 * that embed different context; `session_exit` reasons differ by design
 * between the drivers (stdin-close dispose vs /exit) and are dropped.
 */
export function normalizeText(value, rootPath) {
  let text = String(value ?? '')
  if (rootPath) text = text.split(rootPath).join('<ROOT>')
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return text
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
}
// 表面層 bookkeeping：兩種 surface 對「啟動狀態列印」的持久化選擇不同
// （RPC 模式寫 service_tier_change、TUI 寫 model_change；兩個 surface 的
// system prompt 嵌入不同上下文 → digest 必異）。這些是已知的表面差異，
// 不屬於語意等價範圍——從核心投影排除；run.mjs 另以 surfaceNotes 呈現。
const SURFACE_BOOKKEEPING_TYPES = new Set(['model_change', 'service_tier_change', 'title'])
const SURFACE_BOOKKEEPING_CUSTOM = new Set(['system-prompt-digest'])


/** Normalizes one parsed .jsonl entry into its semantic projection. */
export function normalizeSessionEntry(entry, rootPath) {
  if (!entry || typeof entry !== 'object') return { type: 'malformed' }
  const out = { type: String(entry.type) }
  if (entry.type === 'session') {
    out.version = entry.version
  } else if (entry.type === 'model_change') {
    out.model = entry.model
    out.resolvedModelIsFallback = entry.resolvedModelIsFallback === true
  } else if (entry.type === 'thinking_level_change') {
    out.thinkingLevel = entry.thinkingLevel ?? null
    out.configured = entry.configured ?? null
  } else if (entry.type === 'message') {
    const message = entry.message || {}
    out.role = message.role
    out.text = normalizeText(contentText(message.content), rootPath)
    if (message.provider !== undefined) out.provider = message.provider
    if (message.model !== undefined) out.model = message.model
  } else if (entry.type === 'compaction') {
    // 原生 compaction 紀錄：摘要內容與 token 計數雙側必有微差（兩個
    // surface 的 system prompt 內嵌不同上下文），語意投影只保留
    // 「發生過 compaction」的事實，不比摘要細節。
    out.compacted = true
  } else if (entry.type === 'custom') {
    out.customType = entry.customType
    // 非 compaction 的 custom data 也保留 bounded dump：同 customType 但
    // payload 不同的差異必須可見。
    if (entry.customType === 'compaction') out.data = entry.data
    else {
      try { out.data = JSON.stringify(entry.data).slice(0, 2000) } catch { out.data = '<unstringifiable>' }
    }
  } else if (entry.type === 'title') {
    out.title = normalizeText(entry.title, rootPath)
  } else {
    // 未知 entry type：保留 bounded 的 JSON dump（與 unsupported content
    // part 同精神）——兩側同型但內容不同的未知 entry 必須被比較器看見，
    // 不能只比 type 名。
    try {
      out.data = JSON.stringify(entry).slice(0, 2000)
    } catch {
      out.data = '<unstringifiable>'
    }
  }
  return out
}

/** Reads raw .jsonl text and returns the normalized entry list. */
export function normalizeSessionJsonl(text, rootPath) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('.'))
    .map((line) => {
      try { return JSON.parse(line) } catch { return { type: 'unparseable-line' } }
    })
    .filter((entry) => {
      if (SURFACE_BOOKKEEPING_TYPES.has(entry.type)) return false
      if (entry.type === 'custom' && SURFACE_BOOKKEEPING_CUSTOM.has(entry.customType)) return false
      return true
    })
    .map((entry) => normalizeSessionEntry(entry, rootPath))
}

/** Normalizes a get_state data object into the parity-relevant projection. */
export function normalizeState(state) {
  if (!state || typeof state !== 'object') return null
  const out = {}
  if (typeof state.sessionFile === 'string') out.sessionFile = '<SESSION>'
  if (state.model && typeof state.model === 'object') {
    out.model = { provider: state.model.provider, modelId: state.model.id }
  } else if (typeof state.model === 'string') {
    out.model = state.model
  }
  if (Array.isArray(state.queue)) out.queueLength = state.queue.length
  if (typeof state.isStreaming === 'boolean') out.busy = state.isStreaming || state.isCompacting === true
  if (typeof state.cwd === 'string') out.cwd = '<CWD>'
  return out
}
