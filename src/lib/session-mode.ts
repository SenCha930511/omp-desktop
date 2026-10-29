/**
 * GUI 層的工作階段模式(規劃 / 目標)。
 *
 * omp 的 TUI 有原生 plan/goal 模式,但 RPC 只提供 goal 生命週期命令,沒有
 * plan 對應;GUI 因此以「送出時附加指令」實作,模型收到的是同一則使用者
 * 訊息加上模式前言(transcript 可見,不會暗中替換內容)。模式本身由
 * renderer 持有,切換/取消即時生效,不依賴 runtime 狀態。
 */
export type SessionMode = 'plan' | 'goal'

export const SESSION_MODE_DIRECTIVES: Record<SessionMode, string> = {
  plan: '[Plan mode] Work read-only: inspect the code and produce a concrete implementation plan (files, steps, risks). Do not edit files or run mutating commands until the plan is approved.',
  goal: '[Goal mode] Treat this message as the goal: keep working autonomously until it is fully achieved, track progress with todos, and only stop when the goal is done or you are blocked.',
}

/** 前綴模式指令;slash 指令與已帶前言的重送不重複加上。 */
export function withSessionModeDirective(mode: SessionMode | null, prompt: string): string {
  if (!mode) return prompt
  const directive = SESSION_MODE_DIRECTIVES[mode]
  if (prompt.startsWith(directive)) return prompt
  return `${directive}\n\n${prompt}`
}
