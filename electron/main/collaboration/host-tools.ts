import type { RpcObject } from '../agent-rpc/types'

/**
 * OMP v19 host-tool surface for app-owned session collaboration. These
 * definitions and handlers used to live in
 * `assets/extensions/omp-work-collaboration.ts`; that extension no longer
 * registers tools, and the session tools are advertised per runtime through
 * `set_host_tools` so their calls stay in the main process.
 *
 * Names, labels, descriptions, and parameter shapes are copied verbatim from
 * the extension so the model sees the same contract. Every handler is bound to
 * one `call` function that resolves the calling runtime's session claim, which
 * is what keeps two threads' collaboration scopes apart.
 */
export type CollaborationHostToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>
export type CollaborationHostToolCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

export interface CollaborationHostToolScope {
  tools: RpcObject[]
  handlers: Map<string, CollaborationHostToolHandler>
}

/**
 * The manager kills any host tool call after 30 seconds, so a wait must finish
 * with margin to spare or a legitimate wait would be reported as a timeout.
 * The broker itself still accepts up to 30 seconds from non-host callers.
 */
export const COLLABORATION_HOST_WAIT_MAX_MS = 25_000

const TARGET_SESSION_ID_DESCRIPTION = 'Exact session UUID from an @session reference, Copy session UUID, gooeypi_session_list, or from_session_id in an incoming GooeyPi agent message'
const TARGET_SESSION_ID_PARAMETER = { type: 'string', description: TARGET_SESSION_ID_DESCRIPTION }

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const stringSchema = (description?: string, constraints: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'string',
  ...constraints,
  ...(description === undefined ? {} : { description }),
})

const numberSchema = (description?: string, constraints: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'number',
  ...constraints,
  ...(description === undefined ? {} : { description }),
})

const booleanSchema = (description?: string): Record<string, unknown> =>
  description === undefined ? { type: 'boolean' } : { type: 'boolean', description }

export const COLLABORATION_HOST_TOOLS: RpcObject[] = [
  {
    name: 'gooeypi_session_list',
    label: 'List sessions',
    description: 'List other GooeyPi sessions in this working directory. Results include title, UUID, harness, status, and whether the session is live. Use an exact UUID with the other session tools.',
    parameters: objectSchema({}),
  },
  {
    name: 'gooeypi_session_models',
    label: 'List session models',
    description: 'List models available for new GooeyPi sessions in this harness from providers currently active in the GUI. Results include exact model keys and supported reasoning levels. Use an approximate query when a model was requested by name.',
    parameters: objectSchema({
      query: stringSchema('Optional approximate model name, provider, family, or spoken model wording', { maxLength: 256 }),
    }),
  },
  {
    name: 'gooeypi_session_create',
    label: 'Create session',
    description: 'Create and immediately start a new readable top-level GooeyPi session in this same harness and working directory. Use gooeypi_session_models when selecting a model. Model and reasoning wording may be approximate; GooeyPi resolves and revalidates them against active GUI providers before launch. Set fast true to request fast/priority mode when the selected model and harness support it. The result includes the exact session UUID for gooeypi_session_read, gooeypi_session_send, and gooeypi_session_wait.',
    parameters: objectSchema({
      prompt: stringSchema('The self-contained initial task for the new session', { minLength: 1, maxLength: 1_000_000 }),
      title: stringSchema('Optional concise session title', { minLength: 1, maxLength: 200 }),
      model: stringSchema('Optional exact key from gooeypi_session_models or approximate model wording', { minLength: 1, maxLength: 512 }),
      reasoning: stringSchema('Optional reasoning intensity; the closest level supported by the selected or default model is used', { minLength: 1, maxLength: 64 }),
      fast: booleanSchema('Request fast/priority mode; unsupported models still start normally and report fast mode as unavailable'),
    }, ['prompt']),
  },
  {
    name: 'gooeypi_session_read',
    label: 'Read session',
    description: 'Read bounded recent conversational context from another GooeyPi session in this working directory without modifying its transcript. Includes user, assistant, agent, and thinking text; omits tool calls, tool results, and internal compaction data. Results are capped at 30,000 estimated tokens and report whether truncation occurred.',
    parameters: objectSchema({ target_session_id: TARGET_SESSION_ID_PARAMETER }, ['target_session_id']),
  },
  {
    name: 'gooeypi_session_send',
    label: 'Message session',
    description: 'Send an attributed background message to another GooeyPi session in this working directory. For an incoming agent message, reply directly to its from_session_id; its signed reply_with field names this tool, so no session listing is needed. GooeyPi safely wakes an idle saved session when needed. This returns after delivery; call gooeypi_session_wait with cursor_before to wait for its response. Never busy-wait or create mutual waits.',
    parameters: objectSchema({
      target_session_id: TARGET_SESSION_ID_PARAMETER,
      message: stringSchema('The concise message or coordination request to send', { minLength: 1, maxLength: 64 * 1024 }),
    }, ['target_session_id', 'message']),
  },
  {
    name: 'gooeypi_session_wait',
    label: 'Wait for session',
    description: 'Wait briefly for another GooeyPi session to become idle and produce context after a cursor. Returns a bounded snapshot and timed_out; call again only when continued waiting is useful.',
    parameters: objectSchema({
      target_session_id: TARGET_SESSION_ID_PARAMETER,
      after_cursor: stringSchema('cursor_before returned by gooeypi_session_send, or cursor returned by gooeypi_session_read/gooeypi_session_wait'),
      timeout_ms: numberSchema(`Maximum wait, default 15000 and hard-capped at ${COLLABORATION_HOST_WAIT_MAX_MS}`, { minimum: 0, maximum: COLLABORATION_HOST_WAIT_MAX_MS }),
    }, ['target_session_id']),
  },
]

function textContent(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] }
}

function textResult(value: unknown): Record<string, unknown> {
  return textContent(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}

/** Drops absent parameters so the bridge sees the same argument set the extension sent. */
function cleaned(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) result[key] = value
  }
  return result
}

/** Keeps a wait inside the host tool timeout budget while leaving validation to the bridge. */
function boundedTimeout(value: unknown): unknown {
  return typeof value === 'number' ? Math.min(value, COLLABORATION_HOST_WAIT_MAX_MS) : value
}

export function collaborationHostToolScope(call: CollaborationHostToolCall): CollaborationHostToolScope {
  const handlers = new Map<string, CollaborationHostToolHandler>()

  handlers.set('gooeypi_session_list', async () => textResult(await call('list', {})))

  handlers.set('gooeypi_session_models', async (args) =>
    textResult(await call('models', cleaned({ query: args.query }))))

  handlers.set('gooeypi_session_create', async (args) => textResult(await call('create', cleaned({
    prompt: args.prompt,
    title: args.title,
    model: args.model,
    reasoning: args.reasoning,
    fast: args.fast,
  }))))

  handlers.set('gooeypi_session_read', async (args) =>
    textResult(await call('read', cleaned({ target_session_id: args.target_session_id }))))

  handlers.set('gooeypi_session_send', async (args) => textResult(await call('send', cleaned({
    target_session_id: args.target_session_id,
    message: args.message,
  }))))

  handlers.set('gooeypi_session_wait', async (args) => textResult(await call('wait', cleaned({
    target_session_id: args.target_session_id,
    after_cursor: args.after_cursor,
    timeout_ms: boundedTimeout(args.timeout_ms),
  }))))

  return { tools: COLLABORATION_HOST_TOOLS, handlers }
}
