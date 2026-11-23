export const MAX_PREDICTION_TEXT_CHARS = 128 * 1024
export const MAX_PREDICTION_SUFFIX_CHARS = 4 * 1024

export type PredictWordRequest = Readonly<{
  type: 'predict_word'
  text: string
  cursor: number
}>

export type PredictWordFeedbackRequest = Readonly<{
  type: 'predict_word_feedback'
  text: string
  cursor: number
  suggestion: string
  accepted: boolean
}>

export type PredictWordResponse = Readonly<{
  id?: string
  type: 'response'
  command: 'predict_word'
  success: true
  data: Readonly<{ suffix: string | null }>
}>

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknown) throw new TypeError(`${label}.${unknown} is not supported`)
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('text must be a string')
  if (value.length > MAX_PREDICTION_TEXT_CHARS) throw new TypeError('text is too long')
  return value
}

function requireCursor(text: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > text.length) {
    throw new TypeError('cursor must be an integer UTF-16 offset within text')
  }
  return value
}

function requireSuggestion(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('suggestion must be a string')
  if (value.length === 0) throw new TypeError('suggestion is too short')
  if (value.length > MAX_PREDICTION_SUFFIX_CHARS) throw new TypeError('suggestion is too long')
  return value
}

export function parsePredictWordRequest(raw: unknown): PredictWordRequest {
  const request = requireObject(raw, 'command')
  rejectUnknownKeys(request, ['type', 'text', 'cursor'], 'command')
  if (request.type !== 'predict_word') throw new TypeError('command.type must be predict_word')
  const text = requireText(request.text)
  return { type: 'predict_word', text, cursor: requireCursor(text, request.cursor) }
}

export function parsePredictWordFeedbackRequest(raw: unknown): PredictWordFeedbackRequest {
  const request = requireObject(raw, 'command')
  rejectUnknownKeys(request, ['type', 'text', 'cursor', 'suggestion', 'accepted'], 'command')
  if (request.type !== 'predict_word_feedback') throw new TypeError('command.type must be predict_word_feedback')
  const text = requireText(request.text)
  const suggestion = requireSuggestion(request.suggestion)
  if (typeof request.accepted !== 'boolean') throw new TypeError('accepted must be a boolean')
  return {
    type: 'predict_word_feedback',
    text,
    cursor: requireCursor(text, request.cursor),
    suggestion,
    accepted: request.accepted,
  }
}

export function parsePredictWordResponse(raw: unknown): PredictWordResponse {
  const response = requireObject(raw, 'predict_word response')
  rejectUnknownKeys(response, ['id', 'type', 'command', 'success', 'data'], 'predict_word response')
  if (response.type !== 'response' || response.command !== 'predict_word' || response.success !== true) {
    throw new TypeError('Invalid predict_word response envelope')
  }
  if (response.id !== undefined && typeof response.id !== 'string') throw new TypeError('predict_word response.id must be a string')
  const data = requireObject(response.data, 'predict_word response.data')
  rejectUnknownKeys(data, ['suffix'], 'predict_word response.data')
  if (data.suffix !== null && typeof data.suffix !== 'string') throw new TypeError('predict_word response.data.suffix must be a string or null')
  if (typeof data.suffix === 'string' && data.suffix.length > MAX_PREDICTION_SUFFIX_CHARS) {
    throw new TypeError('predict_word response.data.suffix is too long')
  }
  return {
    ...(response.id === undefined ? {} : { id: response.id }),
    type: 'response',
    command: 'predict_word',
    success: true,
    data: { suffix: data.suffix || null },
  }
}
