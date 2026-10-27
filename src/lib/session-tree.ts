/**
 * 上游 get_tree 的回應與節點型別，加上 GUI 樹狀介面需要的純函式
 * （驗證、扁平化、節點描述）。全部為唯讀工具，不發出 RPC。
 *
 * Wire 型別（oh-my-pi v18.13.1, SessionTree／SessionManager.getTree）：
 *   { tree: SessionTreeNode[], leafId: string | null }
 *   SessionTreeNode = { entry: SessionEntry, children: SessionTreeNode[], label?: string }
 *   SessionEntry：{ id: string; parentId: string | null; type: string; timestamp: string; ... }，
 *   message 項目另帶 { message: { role, content } }。
 */

export interface SessionTreeEntry {
  id: string
  parentId: string | null
  type: string
  timestamp?: string
  [key: string]: unknown
}

export interface SessionTreeNode {
  entry: SessionTreeEntry
  children: SessionTreeNode[]
  label?: string
}

export interface SessionTreeData {
  roots: SessionTreeNode[]
  leafId: string | null
}

function asEntry(raw: unknown): SessionTreeEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null
  if (typeof candidate.type !== 'string' || candidate.type.length === 0) return null
  const parentId = candidate.parentId
  const entry: SessionTreeEntry = {
    ...candidate,
    id: candidate.id,
    type: candidate.type,
    parentId: typeof parentId === 'string' ? parentId : null,
  }
  if (typeof candidate.timestamp === 'string' && candidate.timestamp) entry.timestamp = candidate.timestamp
  else delete entry.timestamp
  return entry
}

function asNode(raw: unknown): SessionTreeNode | null {
  // 資料經 IPC 以 JSON 傳輸，不可能有循環參照，遞迴解析是安全的。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const entry = asEntry(candidate.entry)
  if (!entry) return null
  if (!Array.isArray(candidate.children)) return null
  const children: SessionTreeNode[] = []
  for (const value of candidate.children) {
    const child = asNode(value)
    if (!child) return null
    children.push(child)
  }
  return {
    entry,
    children,
    ...(typeof candidate.label === 'string' && candidate.label ? { label: candidate.label } : {}),
  }
}

/** 嚴格驗證 get_tree 的 data；任何節點形狀不符一律回傳 null，由呼叫端呈現可讀錯誤。 */
export function parseSessionTree(raw: unknown): SessionTreeData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (!Array.isArray(candidate.tree)) return null
  const roots: SessionTreeNode[] = []
  for (const value of candidate.tree) {
    const node = asNode(value)
    if (!node) return null
    roots.push(node)
  }
  return { roots, leafId: typeof candidate.leafId === 'string' && candidate.leafId ? candidate.leafId : null }
}

export interface SessionTreeRow {
  node: SessionTreeNode
  depth: number
  onActivePath: boolean
  isCurrentLeaf: boolean
  hasSiblings: boolean
}

/** 深度優先扁平化；標示自 leaf 回溯到 root 的目前分支路徑。 */
export function flattenSessionTree(tree: SessionTreeData): SessionTreeRow[] {
  const parents = new Map<string, string | null>()
  const stack = tree.roots.map((node) => ({ node, parentId: null as string | null }))
  while (stack.length) {
    const { node, parentId } = stack.pop()!
    parents.set(node.entry.id, parentId)
    for (const child of node.children) stack.push({ node: child, parentId: node.entry.id })
  }
  const active = new Set<string>()
  let cursor: string | null = tree.leafId
  while (cursor && !active.has(cursor)) {
    active.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  const rows: SessionTreeRow[] = []
  const visit = (node: SessionTreeNode, depth: number, siblingCount: number) => {
    rows.push({
      node,
      depth,
      onActivePath: active.has(node.entry.id),
      isCurrentLeaf: tree.leafId !== null && node.entry.id === tree.leafId,
      hasSiblings: siblingCount > 1,
    })
    for (const child of node.children) visit(child, depth + 1, node.children.length)
  }
  for (const root of tree.roots) visit(root, 0, tree.roots.length)
  return rows
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const candidate = block as Record<string, unknown>
      if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    }
  }
  return parts.join('\n')
}

function messageRole(entry: SessionTreeEntry): string | null {
  const message = entry.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const role = (message as Record<string, unknown>).role
    if (typeof role === 'string') return role
  }
  return null
}

export type SessionTreeDescription =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'compaction'; tokensBefore?: number }
  | { kind: 'label'; label: string }
  | { kind: 'modelChange'; model?: string }
  | { kind: 'titleChange'; title?: string }
  | { kind: 'summary'; summary?: string }
  | { kind: 'other'; entryType: string; detail?: string }

/** 節點的可顯示描述；UI 依 kind 套上對應的 i18n 標籤。 */
export function describeTreeEntry(entry: SessionTreeEntry): SessionTreeDescription {
  if (entry.type === 'message') {
    const role = messageRole(entry)
    const message = entry.message
    const content = message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>).content : undefined
    const text = messageText(content).replace(/\s+/g, ' ').trim()
    if (role === 'user') return { kind: 'user', text }
    return { kind: 'assistant', text }
  }
  if (entry.type === 'compaction') {
    const tokens = typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : undefined
    return { kind: 'compaction', ...(tokens !== undefined ? { tokensBefore: tokens } : {}) }
  }
  if (entry.type === 'label') return { kind: 'label', label: typeof entry.label === 'string' ? entry.label : '' }
  if (entry.type === 'model_change') return { kind: 'modelChange', model: typeof entry.model === 'string' ? entry.model : undefined }
  if (entry.type === 'title_change') return { kind: 'titleChange', title: typeof entry.title === 'string' ? entry.title : undefined }
  if (entry.type === 'branch_summary') return { kind: 'summary', summary: typeof entry.summary === 'string' ? entry.summary : undefined }
  // 其余類型（compaction 以外的 housekeeping：session_init、reset_boundary、
  // thinking_level_change、service_tier_change、mode_change、credential_pin…）
  // 只顯示類型名，不揣測欄位。
  return { kind: 'other', entryType: entry.type }
}

/** 上游 branch RPC 只接受 user message 項目；其餘節點顯示但不可作為分支點。 */
export function isBranchableEntry(entry: SessionTreeEntry): boolean {
  return entry.type === 'message' && messageRole(entry) === 'user'
}

export const TREE_PREVIEW_MAX = 160

export function treePreviewText(description: SessionTreeDescription): string {
  const raw = 'text' in description ? description.text : undefined
  const detailed = raw !== undefined ? raw
    : description.kind === 'label' ? description.label
    : description.kind === 'modelChange' ? description.model ?? ''
    : description.kind === 'titleChange' ? description.title ?? ''
    : description.kind === 'summary' ? description.summary ?? ''
    : ''
  const oneLine = detailed.replace(/\s+/g, ' ').trim()
  return oneLine.length > TREE_PREVIEW_MAX ? `${oneLine.slice(0, TREE_PREVIEW_MAX - 1)}…` : oneLine
}

export interface BranchResult {
  cancelled: boolean
  text?: string
}

/** 驗證 branch RPC 的 data（上游 BranchResult：{ text, cancelled }）。 */
export function parseBranchResult(raw: unknown): BranchResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  let cancelled: unknown
  let text: unknown
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'cancelled') cancelled = value
    else if (key === 'text') text = value
  }
  if (cancelled !== undefined && typeof cancelled !== 'boolean') return null
  if (text !== undefined && typeof text !== 'string') return null
  return { cancelled: cancelled === true, ...(typeof text === 'string' && text ? { text } : {}) }
}
