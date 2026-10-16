import { type MessageKey, translate } from '@/lib/i18n'

/** Translates a catalog key with interpolated values. */
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

/** English fallback shown when a settings update fails; localized at render time by DraftSettingField. */
export const DRAFT_SAVE_ERROR = 'The setting could not be saved.'

export interface DraftCommit {
  id: number
  value: string
  baseline: string
  revision: number
  sawDifferentSource: boolean
}

export interface DraftSettlement {
  value: string
  baseline: string
}

export interface DraftState {
  value: string
  source: string
  baseline: string
  dirty: boolean
  revision: number
  pending: DraftCommit | null
  settlement: DraftSettlement | null
  error: string
}

export type DraftAction =
  | { type: 'sync'; value: string }
  | { type: 'edit'; value: string; error: string }
  | { type: 'commit'; id: number; value: string }
  | { type: 'resolve'; id: number }
  | { type: 'reject'; id: number; error: string }

export function createDraftState(value: string): DraftState {
  return { value, source: value, baseline: value, dirty: false, revision: 0, pending: null, settlement: null, error: '' }
}

export function reduceDraftState(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'sync': {
      if (state.pending) {
        return {
          ...state,
          source: action.value,
          pending: {
            ...state.pending,
            sawDifferentSource: state.pending.sawDifferentSource || action.value !== state.pending.baseline,
          },
        }
      }
      if (state.settlement && action.value === state.settlement.baseline && state.settlement.value !== state.settlement.baseline) {
        return {
          ...state,
          source: action.value,
          baseline: action.value,
          dirty: state.value !== action.value,
          settlement: null,
          error: DRAFT_SAVE_ERROR,
        }
      }
      if (!state.dirty) return { ...state, value: action.value, source: action.value, baseline: action.value, settlement: null }
      if (action.value === state.value) {
        return { ...state, source: action.value, baseline: action.value, dirty: false, settlement: null }
      }
      return { ...state, source: action.value, baseline: action.value, dirty: true, settlement: null }
    }
    case 'edit': {
      const revision = state.revision + 1
      return {
        ...state,
        value: action.value,
        dirty: action.value !== state.baseline,
        revision,
        error: action.error,
      }
    }
    case 'commit':
      return {
        ...state,
        pending: { id: action.id, value: action.value, baseline: state.baseline, revision: state.revision, sawDifferentSource: false },
        settlement: null,
        error: '',
      }
    case 'resolve': {
      if (state.pending?.id !== action.id) return state
      const submitted = state.pending
      const rolledBack = submitted.sawDifferentSource && state.source === submitted.baseline && submitted.value !== submitted.baseline
      if (rolledBack) {
        return {
          ...state,
          baseline: submitted.baseline,
          dirty: state.value !== submitted.baseline,
          pending: null,
          settlement: null,
          error: state.revision === submitted.revision ? DRAFT_SAVE_ERROR : '',
        }
      }
      const committed = state.source !== submitted.baseline ? state.source : submitted.value
      const settlement = { value: committed, baseline: submitted.baseline }
      if (state.revision === submitted.revision) {
        return {
          ...state,
          value: committed,
          baseline: committed,
          dirty: false,
          pending: null,
          settlement,
          error: '',
        }
      }
      return {
        ...state,
        baseline: committed,
        dirty: state.value !== committed,
        pending: null,
        settlement,
        error: '',
      }
    }
    case 'reject': {
      if (state.pending?.id !== action.id) return state
      const isCurrentDraft = state.revision === state.pending.revision
      return {
        ...state,
        baseline: state.pending.baseline,
        dirty: state.value !== state.pending.baseline,
        pending: null,
        settlement: null,
        error: isCurrentDraft ? action.error : '',
      }
    }
  }
}

export function browserHomeValidation(value: string, t: Translate = (key, values) => translate('en', key, values)): string {
  if (value.trim().length === 0) return t('browserHome.urlRequired')
  if (value.trim().length > 8192) return t('browserHome.tooLong')
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return t('browserHome.invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return t('browserHome.protocol')
  if (parsed.username || parsed.password) return t('browserHome.credentials')
  return ''
}

export function normalizeBrowserHome(value: string): string {
  return new URL(value.trim()).toString()
}

export function terminalShellValidation(value: string, t: Translate = (key, values) => translate('en', key, values)): string {
  if (value.length === 0) return t('terminalShell.required')
  if (value.includes('\0')) return t('terminalShell.nul')
  if (value.length > 4096) return t('terminalShell.tooLong')
  if (!value.startsWith('/')) return t('terminalShell.absolute')
  return ''
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : DRAFT_SAVE_ERROR
}
