import { PRIME_THINKING_LEVELS, type PrimeEffortSelector } from '../../../src/types/api'
import { rejectUnknownKeys, requireBoolean, requireId, requireRecord, requireString } from '../validation'
import { MAX_RPC_WRITE_FRAME_BYTES, rpcRequestFrameBytes } from './limits'
import type { RpcObject } from './types'

const SIMPLE_COMMANDS = new Set([
  'abort', 'new_session', 'get_state', 'cycle_model', 'get_available_models', 'cycle_thinking_level',
  'abort_retry', 'get_session_stats', 'get_fork_messages', 'get_last_assistant_text',
  'get_messages', 'get_commands', 'get_available_commands', 'get_subagents',
])
const THINKING_LEVELS: ReadonlySet<string> = new Set(['auto', ...PRIME_THINKING_LEVELS])

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
    // Only ids are exposed: OMP resolves them against this parent's registry.
    rejectUnknownKeys(command, ['type', 'subagentId', 'fromByte'], 'command')
    const subagentId = requireString(command.subagentId, 'subagentId', { min: 1, max: 256 })
    if (command.fromByte !== undefined && (!Number.isSafeInteger(command.fromByte) || Number(command.fromByte) < 0)) throw new TypeError('Invalid transcript offset')
    return { type, subagentId, ...(command.fromByte !== undefined ? { fromByte: command.fromByte } : {}) }
  }
  if (type === 'set_thinking_level') {
    rejectUnknownKeys(command, ['type', 'level'], 'command')
    const level = requireString(command.level, 'level', { max: 16 })
    if (!THINKING_LEVELS.has(level)) throw new TypeError('Invalid thinking level')
    return { type, level }
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
  if (type === 'compact') {
    rejectUnknownKeys(command, ['type', 'customInstructions'], 'command')
    return command.customInstructions === undefined ? { type } : { type, customInstructions: requireString(command.customInstructions, 'customInstructions', { max: 32_000 }) }
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
    rejectUnknownKeys(command, ['type', 'entryId'], 'command')
    return { type, entryId: requireId(command.entryId, 'entryId') }
  }
  if (type === 'set_session_name') {
    rejectUnknownKeys(command, ['type', 'name'], 'command')
    return { type, name: requireString(command.name, 'name', { min: 1, max: 200, trim: true }) }
  }
  if (type === 'extension_ui_response') {
    const id = requireId(command.id, 'id')
    if (command.cancelled === true) { rejectUnknownKeys(command, ['type', 'id', 'cancelled'], 'command'); return { type, id, cancelled: true } }
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
  throw new TypeError(`RPC command ${type} is not exposed to the renderer`)
}
