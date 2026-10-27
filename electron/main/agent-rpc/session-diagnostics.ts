import { createHash } from 'node:crypto'
import type { RuntimeInfo } from '../../../src/types/api'

/** Log identity transitions without recording paths, message content or credentials.
 * leafId 只在呼叫者已向 OMP 查得權威值（get_tree）時傳入；未提供代表
 * 明確未知（leafKnown: false，不猜測、不寫 sentinel）。raw leafId 永不
 * 寫入日誌——比照 sessionId，只記 24 字 SHA256 hash。
 */
export function recordSessionDiagnostic(
  phase: 'compact-requested' | 'compact-synchronized' | 'compact-sync-pending' | 'compaction-start' | 'compaction-end' | 'persistence-notice',
  state: RuntimeInfo,
  noticeLevel?: 'info' | 'warning' | 'error',
  leafId?: string,
): void {
  const identity: Record<string, string | boolean> = {
    timestamp: new Date().toISOString(),
    phase,
    runtimeId: state.runtimeId,
    leafKnown: leafId !== undefined && leafId.length > 0,
  }
  if (state.sessionId) identity.sessionIdHash = createHash('sha256').update(state.sessionId).digest('hex').slice(0, 24)
  if (state.sessionFile) identity.sessionPathHash = createHash('sha256').update(state.sessionFile).digest('hex').slice(0, 24)
  if (noticeLevel) identity.noticeLevel = noticeLevel
  if (leafId) identity.leafIdHash = createHash('sha256').update(leafId).digest('hex').slice(0, 24)
  console.info('[session-diagnostic]', JSON.stringify(identity))
}
