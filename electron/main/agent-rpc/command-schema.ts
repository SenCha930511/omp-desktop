import { PRIME_THINKING_LEVELS, type PrimeEffortSelector } from '../../../src/types/api'
import { rejectUnknownKeys, requireBoolean, requireId, requireRecord, requireString } from '../validation'
import { MAX_RPC_WRITE_FRAME_BYTES, rpcRequestFrameBytes } from './limits'
import type { RpcObject } from './types'

const SIMPLE_COMMANDS = new Set([
  'abort', 'abort_and_restore_queue', 'new_session', 'get_state', 'cycle_model', 'get_available_models', 'cycle_thinking_level',
  'abort_retry', 'get_session_stats', 'get_branch_messages', 'get_tree', 'get_last_assistant_text',
  'get_messages', 'get_commands', 'get_available_commands', 'get_subagents',
  // abort_bash takes no parameters (upstream wire/commands.ts); it cancels the
  // shell command the user launched through the `bash` command below.
  'abort_bash',
  // get_login_providers is parameter-free (upstream rpc-types.ts); it lists
  // OAuth providers with availability/authentication flags and never carries
  // any credential material.
  'get_login_providers',
])
// `!` 捷徑指令上限:direct bash 是使用者主動送出(對應 TUI `!`),64 KiB 足以
// 涵蓋合理的單行/多行腳本,同時擋掉貼錯整份檔案或惡意撐大 frame 的輸入。
const MAX_BASH_COMMAND_CHARS = 64 * 1024
const THINKING_LEVELS: ReadonlySet<string> = new Set(['auto', ...PRIME_THINKING_LEVELS])
// 上游 live voice 名冊(v18.12.6 packages/coding-agent/src/live/voices.ts

function validateImageData(data: string, mimeType: string): void {
  if (data.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/i.test(data)) throw new TypeError('Image data must be canonical base64')
  const decoded = Buffer.from(data, 'base64')
  if (!decoded.length || decoded.toString('base64') !== data) throw new TypeError('Image data must be canonical base64')
  const matches = mimeType.toLowerCase() === 'image/png'
    ? decoded.length >= 8 && decoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType.toLowerCase() === 'image/jpeg'
      ? decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff
      : mimeType.toLowerCase() === 'image/gif'
        ? decoded.length >= 6 && (decoded.subarray(0, 6).toString('ascii') === 'GIF87a' || decoded.subarray(0, 6).toString('ascii') === 'GIF89a')
        : decoded.length >= 12 && decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!matches) throw new TypeError('Image data does not match its MIME type')
}

export function isThinkingLevel(value: string): value is PrimeEffortSelector { return THINKING_LEVELS.has(value) }

/** 上游 OAuth provider 識別字元集(參考上游註冊 id:anthropic、openai-codex、github-copilot、google-antigravity 等)。 */
function validateProviderId(value: unknown): string {
  const providerId = requireString(value, 'providerId', { min: 1, max: 128, trim: true })
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) throw new TypeError('providerId may only contain letters, digits, dot, dash and underscore')
  return providerId
}

function validateImages(value: unknown): Array<{ type: 'image'; data: string; mimeType: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('images must be an array with at most 8 items')
  return value.map((raw, index) => {
    const image = requireRecord(raw, `images[${index}]`)
    rejectUnknownKeys(image, ['type', 'data', 'mimeType'], `images[${index}]`)
    if (image.type !== 'image') throw new TypeError(`images[${index}].type must be image`)
    const mimeType = requireString(image.mimeType, `images[${index}].mimeType`, { min: 1, max: 100 })
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) throw new TypeError('Unsupported image type')
    const data = requireString(image.data, `images[${index}].data`, { min: 1, max: MAX_RPC_WRITE_FRAME_BYTES })
    validateImageData(data, mimeType)
    return { type: 'image' as const, data, mimeType }
  })
}

export async function validateRpcCommand(raw: unknown, validateSessionPath: (path: string) => Promise<string>): Promise<RpcObject> {
  const command = requireRecord(raw, 'command')
  if (rpcRequestFrameBytes(command) > MAX_RPC_WRITE_FRAME_BYTES) throw new TypeError('command is too large for the RPC transport')
  const type = requireString(command.type, 'command.type', { min: 1, max: 64 })
  if (SIMPLE_COMMANDS.has(type)) {
    rejectUnknownKeys(command, type === 'new_session' ? ['type', 'parentSession'] : ['type'], 'command')
    if (type === 'new_session' && command.parentSession !== undefined) {
      return { type, parentSession: await validateSessionPath(requireString(command.parentSession, 'parentSession', { max: 4096 })) }
    }
    return { type }
  }
  if (type === 'prompt' || type === 'steer' || type === 'follow_up') {
    rejectUnknownKeys(command, ['type', 'message', 'images', 'streamingBehavior'], 'command')
    const result: RpcObject = { type, message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }) }
    const images = validateImages(command.images)
    if (images) result.images = images
    if (type === 'prompt' && command.streamingBehavior !== undefined) {
      if (command.streamingBehavior !== 'steer' && command.streamingBehavior !== 'followUp') throw new TypeError('Invalid streamingBehavior')
      result.streamingBehavior = command.streamingBehavior
    } else if (command.streamingBehavior !== undefined) throw new TypeError('streamingBehavior is only valid for prompt')
    return result
  }
  if (type === 'set_model') {
    rejectUnknownKeys(command, ['type', 'provider', 'modelId'], 'command')
    return { type, provider: requireString(command.provider, 'provider', { min: 1, max: 128 }), modelId: requireString(command.modelId, 'modelId', { min: 1, max: 256 }) }
  }
  if (type === 'set_subagent_subscription') {
    rejectUnknownKeys(command, ['type', 'level'], 'command')
    if (!['off', 'progress', 'events'].includes(String(command.level))) throw new TypeError('Invalid subagent subscription level')
    return { type, level: command.level }
  }
  if (type === 'get_subagent_messages') {
    // Only ids/remembered transcript files are exposed: OMP resolves both
    // against this parent's registry and rejects anything it never saw
    // (upstream rpc-subagents.ts resolveSessionFile whitelists session files
    // this session's subagent frames announced), so the schema stays
    // structural and never touches the filesystem.
    rejectUnknownKeys(command, ['type', 'subagentId', 'sessionFile', 'fromByte'], 'command')
    const result: RpcObject = { type }
    if (command.subagentId !== undefined) result.subagentId = requireString(command.subagentId, 'subagentId', { min: 1, max: 256 })
    if (command.sessionFile !== undefined) result.sessionFile = requireString(command.sessionFile, 'sessionFile', { min: 1, max: 4096 })
    if (result.subagentId === undefined && result.sessionFile === undefined) throw new TypeError('get_subagent_messages requires subagentId or sessionFile')
    if (command.fromByte !== undefined && (!Number.isSafeInteger(command.fromByte) || Number(command.fromByte) < 0)) throw new TypeError('Invalid transcript offset')
    if (command.fromByte !== undefined) result.fromByte = command.fromByte
    return result
  }
  if (type === 'cancel_subagent' || type === 'steer_subagent') {
    // 上游 rpc-types.ts L73-74:cancel_subagent {subagentId} 硬殺一個執行中的
    // 子代理(成功回 {cancelled:boolean},false 表示已不在執行,由 renderer 如實顯示);
    // steer_subagent {subagentId, message} 以使用者身分注入訊息,目標不在執行時
    // 上游回 error。是否可作用由上游的 live registry 判定,schema 只做結構驗證。
    rejectUnknownKeys(command, type === 'cancel_subagent' ? ['type', 'subagentId'] : ['type', 'subagentId', 'message'], 'command')
    const result: RpcObject = { type, subagentId: requireString(command.subagentId, 'subagentId', { min: 1, max: 256 }) }
    if (type === 'steer_subagent') result.message = requireString(command.message, 'message', { min: 1, max: 32_000 })
    return result
  }
  if (type === 'set_thinking_level') {
    rejectUnknownKeys(command, ['type', 'level'], 'command')
    const level = requireString(command.level, 'level', { max: 16 })
    if (!THINKING_LEVELS.has(level)) throw new TypeError('Invalid thinking level')
    return { type, level }
  }
  if (type === 'set_slow_mode') {
    // 上游 set_slow_mode:切換目前模型的 `/slow`(flex/low-priority lane),
    // 只接受 boolean enabled,回傳 { enabled }。
    rejectUnknownKeys(command, ['type', 'enabled'], 'command')
    if (typeof command.enabled !== 'boolean') throw new TypeError('set_slow_mode requires boolean enabled')
    return { type, enabled: command.enabled }
  }
  if (type === 'set_service_tier') {
    rejectUnknownKeys(command, ['type', 'serviceTier'], 'command')
    if (command.serviceTier !== 'default' && command.serviceTier !== 'priority') throw new TypeError('Invalid service tier')
    return { type, serviceTier: command.serviceTier }
  }
  if (type === 'set_steering_mode' || type === 'set_follow_up_mode') {
    rejectUnknownKeys(command, ['type', 'mode'], 'command')
    if (command.mode !== 'all' && command.mode !== 'one-at-a-time') throw new TypeError('Invalid queue mode')
    return { type, mode: command.mode }
  }
  if (type === 'set_interrupt_mode') {
    // 上游 wire(18.13 實測):{mode:'immediate'|'wait'},session 範圍。
    rejectUnknownKeys(command, ['type', 'mode'], 'command')
    if (command.mode !== 'immediate' && command.mode !== 'wait') throw new TypeError('Invalid interrupt mode')
    return { type, mode: command.mode }
  }
  if (type === 'set_cache_warming') {
    // 上游 wire(18.13 實測):{mode:'off'|'streaming'|'idle'},僅本 session
    // 覆寫(不寫全域 config);成功回應的 data.mode 是生效值。
    rejectUnknownKeys(command, ['type', 'mode'], 'command')
    if (command.mode !== 'off' && command.mode !== 'streaming' && command.mode !== 'idle') throw new TypeError('Invalid cache warming mode')
    return { type, mode: command.mode }
  }
  if (type === 'compact') {
    // 上游 RPC 命令表:compact 只接 customInstructions。模式(soft/remote/
    // snapcompact)不在 RPC 承載——由 renderer 原樣交給上游 slash dispatcher
    // (prompt 路徑);不要在這裡新增 mode 欄位,上游會拒絕未知鍵。
    rejectUnknownKeys(command, ['type', 'customInstructions'], 'command')
    return command.customInstructions === undefined ? { type } : { type, customInstructions: requireString(command.customInstructions, 'customInstructions', { max: 32_000 }) }
  }
  if (type === 'bash') {
    // 使用者驅動的 direct shell 執行(對應 TUI 的 `!` 捷徑,上游 rpc-mode
    // `case "bash"` → session.executeBash)。安全邊界見 docs/security.md:
    // renderer 本來就能透過 prompt/工具核准讓 agent 執行任意 shell;這裡開放
    // 的是同一台機器、同一使用者權限下的「明確使用者指令」通道,不經過模型
    // 也不經過工具核准,因此 schema 只做結構驗證(型別、非空、長度上限),
    // 指令內容原樣轉送——不嘗試過濾 shell 語法(上游以使用者 shell 執行,
    // 任何過濾都只是假安全感)。上游 wire 沒有 excludeFromContext 參數,
    // `!!`(排除出 context)在 renderer 層拒絕,不在此放行語意不符的欄位。
    rejectUnknownKeys(command, ['type', 'command'], 'command')
    return { type, command: requireString(command.command, 'command', { min: 1, max: MAX_BASH_COMMAND_CHARS }) }
  }
  if (type === 'set_auto_compaction' || type === 'set_auto_retry') {
    rejectUnknownKeys(command, ['type', 'enabled'], 'command')
    return { type, enabled: requireBoolean(command.enabled, 'enabled') }
  }
  if (type === 'switch_session') {
    rejectUnknownKeys(command, ['type', 'sessionPath'], 'command')
    return { type, sessionPath: await validateSessionPath(requireString(command.sessionPath, 'sessionPath', { max: 4096 })) }
  }
  if (type === 'fork') {
    // Native fork: whole history when entryId is omitted (upstream v18.12.6).
    rejectUnknownKeys(command, ['type', 'entryId'], 'command')
    return command.entryId === undefined ? { type } : { type, entryId: requireId(command.entryId, 'entryId') }
  }
  if (type === 'branch') {
    rejectUnknownKeys(command, ['type', 'entryId'], 'command')
    return { type, entryId: requireId(command.entryId, 'entryId') }
  }
  if (type === 'remove_queued_message') {
    // The message is the queue-chip text omp's own state reports; the queue
    // names which of the two queues holds it.
    rejectUnknownKeys(command, ['type', 'message', 'queue'], 'command')
    if (command.queue !== 'steering' && command.queue !== 'followUp') throw new TypeError('queue must be steering or followUp')
    return { type, message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }), queue: command.queue }
  }
  if (type === 'promote_queued_message') {
    rejectUnknownKeys(command, ['type', 'message'], 'command')
    return { type, message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }) }
  }
  if (type === 'set_session_name') {
    rejectUnknownKeys(command, ['type', 'name'], 'command')
    return { type, name: requireString(command.name, 'name', { min: 1, max: 200, trim: true }) }
  }
  if (type === 'extension_ui_response') {
    const id = requireId(command.id, 'id')
    if (command.cancelled === true) {
      // `timedOut` marks a cancellation the harness itself caused by timeout;
      // it only ever rides a cancellation (upstream parseAskDialogResponse).
      rejectUnknownKeys(command, ['type', 'id', 'cancelled', 'timedOut'], 'command')
      const cancelled: RpcObject = { type, id, cancelled: true }
      if (command.timedOut !== undefined) cancelled.timedOut = requireBoolean(command.timedOut, 'timedOut')
      return cancelled
    }
    if (command.timedOut !== undefined && command.cancelled !== true) throw new TypeError('command.timedOut is not supported')
    if (command.answers !== undefined) {
      // Native ask dialogs answer every question in order: one id, the
      // selected option labels, and optional custom input. Strict shapes
      // only — the harness validates ids and labels against its questions
      // and throws on mismatch instead of guessing.
      rejectUnknownKeys(command, ['type', 'id', 'answers'], 'command')
      if (!Array.isArray(command.answers)) throw new TypeError('answers must be an array')
      return {
        type,
        id,
        answers: command.answers.map((raw, index) => {
          const answer = requireRecord(raw, `answers[${index}]`)
          rejectUnknownKeys(answer, ['id', 'selectedOptions', 'customInput'], `answers[${index}]`)
          if (!Array.isArray(answer.selectedOptions)) throw new TypeError(`answers[${index}].selectedOptions must be an array`)
          answer.selectedOptions.forEach((option, optionIndex) => {
            // 與 customInput 同量級的 per-item 上限：沒有它，單一選項可攜
            // 近 2MiB（僅受 frame 上限約束）直達上游。
            if (typeof option !== 'string') throw new TypeError(`answers[${index}].selectedOptions[${optionIndex}] must be a string`)
            if (option.length > 64 * 1024) throw new TypeError(`answers[${index}].selectedOptions[${optionIndex}] exceeds 64 KiB`)
          })
          const validated: RpcObject = {
            id: requireString(answer.id, `answers[${index}].id`, { min: 1, max: 1024 }),
            selectedOptions: answer.selectedOptions,
          }
          if (answer.customInput !== undefined) validated.customInput = requireString(answer.customInput, `answers[${index}].customInput`, { max: 1024 * 1024 })
          return validated
        }),
      }
    }
    if (typeof command.confirmed === 'boolean') { rejectUnknownKeys(command, ['type', 'id', 'confirmed'], 'command'); return { type, id, confirmed: command.confirmed } }
    rejectUnknownKeys(command, ['type', 'id', 'value'], 'command')
    return { type, id, value: requireString(command.value, 'value', { max: 1024 * 1024 }) }
  }
  // Side questions (harness /btw): one-off questions beside the live session's
  // main turn. App vocabulary; the adapter translates to the harness names.
  if (type === 'side_question') {
    rejectUnknownKeys(command, ['type', 'question', 'topicId'], 'command')
    const result: RpcObject = { type, question: requireString(command.question, 'question', { min: 1, max: 64 * 1024, trim: true }) }
    if (command.topicId !== undefined) result.topicId = requireId(command.topicId, 'topicId')
    return result
  }
  if (type === 'side_question_cancel') {
    rejectUnknownKeys(command, ['type', 'topicId'], 'command')
    const result: RpcObject = { type }
    if (command.topicId !== undefined) result.topicId = requireId(command.topicId, 'topicId')
    return result
  }
  if (type === 'side_question_history') {
    rejectUnknownKeys(command, ['type'], 'command')
    return { type }
  }
  if (type === 'goal') {
    // 上游 v18.12.6 rpc-goal.handle:op 必填,支援 get|create|resume|pause|drop;
    // objective 只在 create 有意義且必須非空(trim 後),token_budget 隨 create
    // 提供且必須正整數。其餘 op 拒收 objective/token_budget,避免 renderer
    // 送出上游會靜默忽略的欄位而造成語意落差。
    const op = requireString(command.op, 'op', { max: 16 })
    if (op !== 'get' && op !== 'create' && op !== 'resume' && op !== 'pause' && op !== 'drop') throw new TypeError('Invalid goal op')
    if (op !== 'create') {
      rejectUnknownKeys(command, ['type', 'op'], 'command')
      return { type, op }
    }
    rejectUnknownKeys(command, ['type', 'op', 'objective', 'token_budget'], 'command')
    const result: RpcObject = { type, op, objective: requireString(command.objective, 'objective', { min: 1, trim: true }) }
    if (command.token_budget !== undefined) {
      if (!Number.isSafeInteger(command.token_budget) || (command.token_budget as number) <= 0) throw new TypeError('token_budget must be a positive integer')
      result.token_budget = command.token_budget
    }
    return result
  }
  // OAuth 認證流程(對應 TUI /login /logout)。憑證歸屬屬於 OMP custody:
  // token/refresh 存 OMP 自己的 auth storage(~/.omp),GUI 只當驅動殼——
  // 流程由既有 extension_ui 的 open_url(開瀏覽器)與 input(dialog 收授權
  // 碼)事件驅動;上游對 secret: true 的提示一律以失敗回應拒絕(RPC mode
  // 不協商 secret 支援),因此沒有任何祕密欄位會到達 renderer,schema 也不
  // 放行祕密回傳通道。
  // providerId:上游 provider 註冊識別(例:anthropic、openai-codex、
  // github-copilot),限白名單字元集,最大 128。
  if (type === 'login' || type === 'get_logout_accounts') {
    rejectUnknownKeys(command, ['type', 'providerId'], 'command')
    return { type, providerId: validateProviderId(command.providerId) }
  }
  if (type === 'logout') {
    rejectUnknownKeys(command, ['type', 'providerId', 'credentialId'], 'command')
    // credentialId 對應 OMP auth storage 的儲存列編號,必須是正整數;
    // 憑證不存在時上游失敗(不移除他物)。
    if (!Number.isSafeInteger(command.credentialId) || (command.credentialId as number) <= 0) throw new TypeError('credentialId must be a positive integer')
    return { type, providerId: validateProviderId(command.providerId), credentialId: command.credentialId }
  }
  throw new TypeError(`RPC command ${type} is not exposed to the renderer`)
}
