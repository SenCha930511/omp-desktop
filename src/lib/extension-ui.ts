export interface ExtensionUiQuestionnaireMeta {
  groupId: string
  index: number
  total: number
}

export interface ExtensionUiOptionDetail {
  description?: string
}

export interface ExtensionUiAskOption {
  label: string
  description?: string
  preview?: string
}

export interface ExtensionUiAskQuestion {
  id: string
  question: string
  header?: string
  options: ExtensionUiAskOption[]
  multi?: boolean
  recommended?: number
}

/** One entry of an `ask` response; upstream validates these strictly, so the app does too before sending. */
export interface ExtensionUiAskAnswer {
  id: string
  selectedOptions: string[]
  customInput?: string
}


export interface ExtensionUiQuestion {
  id: string
  title: string
  options: string[]
  index: number
}

export interface ExtensionUiQuestionnaireRequest {
  method: 'questionnaire'
  id: string
  title: string
  questions: ExtensionUiQuestion[]
  total: number
  complete: boolean
  timeout?: number
}

export type ExtensionUiRequest =
  | { method: 'select'; id: string; title: string; options: string[]; optionDetails?: ExtensionUiOptionDetail[]; timeout?: number; questionnaire?: ExtensionUiQuestionnaireMeta }
  | { method: 'confirm'; id: string; title: string; message: string; timeout?: number }
  | { method: 'input'; id: string; title: string; placeholder?: string; timeout?: number }
  | { method: 'editor'; id: string; title: string; prefill?: string }
  | ExtensionUiQuestionnaireRequest
  | { method: 'ask'; id: string; title: string; questions: ExtensionUiAskQuestion[]; timeout?: number }

/** OMP settles a dialog itself (abort or timeout) and tells the host to close it: `{ method: 'cancel', targetId }`. */
export interface ExtensionUiCancel {
  method: 'cancel'
  targetId: string
}

/** A dialog request that awaits a response but cannot be rendered by this app. */
export interface ExtensionUiRejection {
  id: string
  method: string
  reason: string
}

export type ExtensionUiFrame =
  | { status: 'ok'; request: ExtensionUiRequest }
  | { status: 'rejected'; rejection: ExtensionUiRejection }


/** Fire-and-forget presentation frames: derived runtime state, never answered. */
export type ExtensionUiPresentation =
  | { kind: 'status'; statusKey: string; statusText: string | undefined }
  | { kind: 'widget'; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: 'aboveEditor' | 'belowEditor' }
  | { kind: 'editorText'; text: string }
  | { kind: 'openUrl'; url: string; launchUrl?: string; instructions?: string }

export interface ExtensionUiPresentationRejection {
  method: string
  reason: string
}

// Upstream's approval fallback puts the whole multi-line prompt in a select
// title (header + details + folder listing + appendix). It must stay complete
// so the user can read the full approval, while still bounded against abuse.
const MAX_TITLE_LENGTH = 200_000
const MAX_OPTION_LENGTH = 500
const MAX_OPTIONS = 32
const MAX_OPTION_DETAIL_LENGTH = 4_000
const MAX_ASK_QUESTIONS = 25
const MAX_HEADER_LENGTH = 4_000
const MAX_PREVIEW_LENGTH = 32_000
const MAX_STATUS_LENGTH = 4_000
const MAX_WIDGET_LINES = 64
const MAX_EDITOR_TEXT_LENGTH = 32_000
const MAX_URL_LENGTH = 8_000
const MAX_EDITOR_PREFILL_LENGTH = 32_000
const ASK_USER_RPC_MARKER = '__prime_ask_user__'
export const ASK_USER_TIMEOUT_MS = 120_000

// Methods whose requests wait for an `extension_ui_response`. Presentation
// methods (notify, setStatus, setWidget, setTitle, set_editor_text, open_url)
// are fire-and-forget and must never be answered or reported as rejected.
const DIALOG_METHODS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor', 'ask'])

function stringValue(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined
}

function timeoutValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 * 60 * 1_000 ? value : undefined
}

function questionnaireMeta(value: string): ExtensionUiQuestionnaireMeta | undefined {
  if (!value.startsWith(ASK_USER_RPC_MARKER)) return undefined
  const parts = value.slice(ASK_USER_RPC_MARKER.length).split(':')
  if (parts.length !== 3) return undefined
  const [groupId, indexText, totalText] = parts
  const index = Number(indexText)
  const total = Number(totalText)
  if (!groupId || !/^[A-Za-z0-9_-]{1,80}$/.test(groupId)) return undefined
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || total > 5 || index >= total) return undefined
  return { groupId, index, total }
}

/** Positionally aligned select option descriptions; unusable arrays are dropped so the options stay actionable. */
function optionDetailsValue(value: unknown, optionCount: number): ExtensionUiOptionDetail[] | undefined {
  if (!Array.isArray(value) || value.length !== optionCount) return undefined
  const details: ExtensionUiOptionDetail[] = []
  let described = false
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const description = (item as Record<string, unknown>).description
    if (description === undefined) {
      details.push({})
      continue
    }
    if (typeof description !== 'string' || description.trim().length === 0 || description.length > MAX_OPTION_DETAIL_LENGTH) return undefined
    described = true
    details.push({ description })
  }
  return described ? details : undefined
}

type FieldResult = { value: string } | { reason: string }

function requiredString(value: unknown, max: number, label: string): FieldResult {
  if (typeof value !== 'string' || value.trim().length === 0) return { reason: `missing ${label}` }
  if (value.length > max) return { reason: `${label} exceeds ${max} characters` }
  return { value }
}

/** Strictly validated `ask` questions; a reason string means the frame must be answered cancelled. */
function askQuestionsValue(value: unknown): ExtensionUiAskQuestion[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASK_QUESTIONS) return 'missing or too many questions'
  const questions: ExtensionUiAskQuestion[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return 'invalid question'
    const record = item as Record<string, unknown>
    const id = stringValue(record.id, 200)
    const question = stringValue(record.question, MAX_TITLE_LENGTH)
    if (!id || !question) return 'missing question id or text'
    if (seenIds.has(id)) return `duplicate question id ${id}`
    seenIds.add(id)
    const header = record.header === undefined ? undefined : stringValue(record.header, MAX_HEADER_LENGTH)
    if (record.header !== undefined && header === undefined) return 'invalid question header'
    if (!Array.isArray(record.options) || record.options.length < 1 || record.options.length > MAX_OPTIONS) return 'missing or too many options'
    const options: ExtensionUiAskOption[] = []
    for (const option of record.options) {
      if (typeof option !== 'object' || option === null || Array.isArray(option)) return 'invalid option'
      const optionRecord = option as Record<string, unknown>
      const label = stringValue(optionRecord.label, MAX_OPTION_LENGTH)
      if (!label) return 'invalid option label'
      const description = optionRecord.description === undefined ? undefined : stringValue(optionRecord.description, MAX_OPTION_DETAIL_LENGTH)
      if (optionRecord.description !== undefined && description === undefined) return 'invalid option description'
      const preview = optionRecord.preview === undefined ? undefined : stringValue(optionRecord.preview, MAX_PREVIEW_LENGTH)
      if (optionRecord.preview !== undefined && preview === undefined) return 'invalid option preview'
      options.push({ label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) })
    }
    if (record.multi !== undefined && typeof record.multi !== 'boolean') return 'invalid multi flag'
    if (record.recommended !== undefined
      && (typeof record.recommended !== 'number' || !Number.isInteger(record.recommended) || record.recommended < 0 || record.recommended >= options.length)) return 'invalid recommended index'
    questions.push({
      id,
      question,
      ...(header ? { header } : {}),
      options,
      ...(record.multi === true ? { multi: true } : {}),
      ...(typeof record.recommended === 'number' ? { recommended: record.recommended } : {}),
    })
  }
  return questions
}


function dialogRequest(raw: Record<string, unknown>, method: string, id: string): ExtensionUiRequest | string {
  if (method === 'ask') {
    const questions = askQuestionsValue(raw.questions)
    if (typeof questions === 'string') return questions
    // Upstream sends no title for ask; synthesize one for the modal header.
    const first = questions[0]
    return { method: 'ask', id, title: first.header ?? first.question, questions, timeout: timeoutValue(raw.timeout) }
  }
  const title = requiredString(raw.title, MAX_TITLE_LENGTH, 'title')
  if ('reason' in title) return title.reason

  if (method === 'select') {
    if (!Array.isArray(raw.options) || raw.options.length < 1) return 'missing options'
    if (raw.options.length > MAX_OPTIONS) return `more than ${MAX_OPTIONS} options`
    const options = raw.options.map((option) => stringValue(option, MAX_OPTION_LENGTH))
    if (options.some((option): option is undefined => option === undefined)) return 'invalid or oversized option'
    const parsedOptions = options as string[]
    const questionnaire = questionnaireMeta(parsedOptions[0])
    const visibleOptions = questionnaire ? parsedOptions.slice(1) : parsedOptions
    if (visibleOptions.length < 1) return 'questionnaire marker with no visible options'
    const details = optionDetailsValue(raw.optionDetails, parsedOptions.length)
    const optionDetails = details && questionnaire ? details.slice(1) : details
    return {
      method: 'select',
      id,
      title: title.value,
      options: visibleOptions,
      timeout: timeoutValue(raw.timeout),
      ...(optionDetails ? { optionDetails } : {}),
      ...(questionnaire ? { questionnaire } : {}),
    }
  }
  if (method === 'confirm') {
    const message = requiredString(raw.message, MAX_TITLE_LENGTH, 'message')
    if ('reason' in message) return message.reason
    return { method: 'confirm', id, title: title.value, message: message.value, timeout: timeoutValue(raw.timeout) }
  }
  if (method === 'input') {
    if (raw.placeholder !== undefined) {
      const placeholder = requiredString(raw.placeholder, MAX_TITLE_LENGTH, 'placeholder')
      if ('reason' in placeholder) return placeholder.reason
      return { method: 'input', id, title: title.value, placeholder: placeholder.value, timeout: timeoutValue(raw.timeout) }
    }
    return { method: 'input', id, title: title.value, placeholder: undefined, timeout: timeoutValue(raw.timeout) }
  }
  if (method === 'editor') {
    if (raw.prefill === undefined) return { method: 'editor', id, title: title.value, prefill: undefined }
    if (typeof raw.prefill !== 'string' || raw.prefill.length > MAX_EDITOR_PREFILL_LENGTH) return 'invalid or oversized prefill'
    return { method: 'editor', id, title: title.value, prefill: raw.prefill }
  }
  return `unsupported dialog method ${method}`
}

/**
 * Parse one extension UI frame. Dialog requests that await a response but
 * cannot be rendered come back as `rejected` (with the request id) instead of
 * being silently dropped, so the caller can answer them cancelled.
 */
export function parseExtensionUiFrame(raw: Record<string, unknown>): ExtensionUiFrame | undefined {
  if (raw.type !== 'extension_ui_request') return undefined
  const method = raw.method
  if (typeof method !== 'string' || method === 'cancel') return undefined
  if (!DIALOG_METHODS.has(method)) return undefined
  const id = stringValue(raw.id, 200)
  if (!id) return undefined
  const request = dialogRequest(raw, method, id)
  if (typeof request === 'string') return { status: 'rejected', rejection: { id, method, reason: request } }
  return { status: 'ok', request }
}

export function parseExtensionUiRequest(raw: Record<string, unknown>): ExtensionUiRequest | undefined {
  const frame = parseExtensionUiFrame(raw)
  return frame?.status === 'ok' ? frame.request : undefined
}

export function parseExtensionUiRejection(raw: Record<string, unknown>): ExtensionUiRejection | undefined {
  const frame = parseExtensionUiFrame(raw)
  return frame?.status === 'rejected' ? frame.rejection : undefined
}

/** Parse an upstream cancel frame (`{ method: 'cancel', targetId }`) that settles a dialog on OMP's side. */
export function parseExtensionUiCancel(raw: Record<string, unknown>): ExtensionUiCancel | undefined {
  if (raw.type !== 'extension_ui_request' || raw.method !== 'cancel') return undefined
  const targetId = stringValue(raw.targetId, 200)
  return targetId ? { method: 'cancel', targetId } : undefined
}

const PRESENTATION_METHODS: ReadonlySet<string> = new Set(['setStatus', 'setWidget', 'set_editor_text', 'open_url'])

/** Only http(s) URLs may ever reach an external-link surface; anything else is rejected. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a fire-and-forget presentation frame. Frames whose method matches but
 * whose payload is unusable come back as `rejection` so the caller can surface
 * a visible error instead of silently dropping state updates.
 */
export function parseExtensionUiPresentation(raw: Record<string, unknown>):
  | { update: ExtensionUiPresentation }
  | { rejection: ExtensionUiPresentationRejection }
  | undefined {
  if (raw.type !== 'extension_ui_request') return undefined
  const method = raw.method
  if (typeof method !== 'string' || !PRESENTATION_METHODS.has(method)) return undefined

  if (method === 'setStatus') {
    const statusKey = stringValue(raw.statusKey, 200)
    if (!statusKey) return { rejection: { method, reason: 'missing status key' } }
    const statusText = raw.statusText === undefined ? undefined : stringValue(raw.statusText, MAX_STATUS_LENGTH)
    if (raw.statusText !== undefined && statusText === undefined) return { rejection: { method, reason: 'invalid status text' } }
    return { update: { kind: 'status', statusKey, statusText } }
  }
  if (method === 'setWidget') {
    const widgetKey = stringValue(raw.widgetKey, 200)
    if (!widgetKey) return { rejection: { method, reason: 'missing widget key' } }
    let widgetLines: string[] | undefined
    if (raw.widgetLines !== undefined) {
      if (!Array.isArray(raw.widgetLines) || raw.widgetLines.length > MAX_WIDGET_LINES) return { rejection: { method, reason: 'invalid widget lines' } }
      const lines = raw.widgetLines.map((line) => stringValue(line, MAX_STATUS_LENGTH))
      if (lines.some((line): line is undefined => line === undefined)) return { rejection: { method, reason: 'invalid widget line' } }
      widgetLines = lines as string[]
    }
    let widgetPlacement: 'aboveEditor' | 'belowEditor' | undefined
    if (raw.widgetPlacement !== undefined) {
      if (raw.widgetPlacement !== 'aboveEditor' && raw.widgetPlacement !== 'belowEditor') return { rejection: { method, reason: 'invalid widget placement' } }
      widgetPlacement = raw.widgetPlacement
    }
    return { update: { kind: 'widget', widgetKey, widgetLines, ...(widgetPlacement ? { widgetPlacement } : {}) } }
  }
  if (method === 'set_editor_text') {
    const text = stringValue(raw.text, MAX_EDITOR_TEXT_LENGTH)
    if (!text) return { rejection: { method, reason: 'missing or oversized editor text' } }
    return { update: { kind: 'editorText', text } }
  }

  const url = httpUrl(raw.url)
  if (!url) return { rejection: { method, reason: 'url must be http or https' } }
  const launchUrl = raw.launchUrl === undefined ? undefined : httpUrl(raw.launchUrl)
  if (raw.launchUrl !== undefined && launchUrl === undefined) return { rejection: { method, reason: 'launch url must be http or https' } }
  const instructions = raw.instructions === undefined ? undefined : stringValue(raw.instructions, MAX_STATUS_LENGTH)
  if (raw.instructions !== undefined && instructions === undefined) return { rejection: { method, reason: 'invalid instructions' } }
  return { update: { kind: 'openUrl', url, ...(launchUrl ? { launchUrl } : {}), ...(instructions ? { instructions } : {}) } }
}

/**
 * Mirror of upstream's strict `ask` response validation: a reason string means
 * the answers must never be sent (the dialog is answered cancelled instead).
 */
export function askAnswersViolation(questions: ExtensionUiAskQuestion[], answers: unknown): string | undefined {
  if (!Array.isArray(answers) || answers.length !== questions.length) return 'answers must list one entry per question in question order'
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]
    const answer = answers[index]
    if (typeof answer !== 'object' || answer === null) return `answer ${index} must be an object`
    const record = answer as Record<string, unknown>
    if (record.id !== question.id) return `answer ${index} must have id ${JSON.stringify(question.id)}`
    if (!Array.isArray(record.selectedOptions)) return `answer ${JSON.stringify(question.id)} must carry a selectedOptions array`
    const labels = question.options.map((option) => option.label)
    const selected: string[] = []
    for (const label of record.selectedOptions) {
      if (typeof label !== 'string' || !labels.includes(label)) return `answer ${JSON.stringify(question.id)} selected an unknown option`
      if (selected.includes(label)) return `answer ${JSON.stringify(question.id)} selected an option twice`
      selected.push(label)
    }
    if (record.customInput !== undefined && typeof record.customInput !== 'string') return `answer ${JSON.stringify(question.id)} customInput must be a string`
    const custom = typeof record.customInput === 'string' ? record.customInput.trim() : undefined
    if (!question.multi && (selected.length > 1 || (selected.length > 0 && custom))) return `answer ${JSON.stringify(question.id)} is single-select but carries more than one answer`
  }
  return undefined
}
