import { ArrowUp, AtSign, Check, ChevronDown, Clock3, Command, Edit3, Hourglass, ImageIcon, LoaderCircle, MessageCirclePlus, Mic, Paperclip, Plus, RotateCcw, Shield, ShieldAlert, ShieldCheck, ShieldQuestionMark, Square, SquareTerminal, Trash2, X, Zap } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useComposerImages } from '@/hooks/useComposerImages'
import { useDictation } from '@/hooks/useDictation'
import { appendAnnotationsToPrompt } from '@/lib/browser-annotations'
import { appendCapabilityRouting } from '@/lib/capability-mentions'
import { readComposerDraft, saveComposerDraft, takeComposerDraft } from '@/lib/composer-draft'
import { getTurnMetrics, subscribeTurnMetrics } from '@/lib/events/turn-metrics'
import { contextDialLabel, formatSessionCost, PRICING_UNAVAILABLE } from '@/lib/format-cost'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { formatQueuedItemsForRestore, isContinueShorthand, MANUAL_CONTINUE_PROMPT, parseQueueShorthandInput } from '@/lib/input-shorthands'
import { isImeComposing, isImeComposingOrGuarded, messageActionForKey, splitAttachmentFileName } from '@/lib/message-shortcuts'
import { appendSessionRouting, findSessionMentions } from '@/lib/session-mentions'
import { appendTerminalContextToPrompt } from '@/lib/terminal-context'
import { INITIAL_SLASH_COMMANDS, slashCommandAcceptsImages, slashSuggestions, type SlashCommand } from '@/lib/slash-commands'
import { desktopSlashCommands } from '@/lib/slash-command-ui'
import type {
  BrowserAnnotation,
  CheckoutAction,
  CheckoutCatalog,
  DesktopApi,
  MessageEnterAction,
  MessagePart,
  OmpApprovalMode,
  PrimeContextUsage,
  PrimeModelDescriptor,
  PrimeProviderDescriptor,
  PrimeEffortSelector,
  PrimeModelPresetRecord,
  UsageLimitState,
  PromptDeliveryIntent,
  PromptImage,
  QueuedPrompt,
  SessionRecord,
  SessionUsage,
  SkillRecord,
  TerminalPromptContext,
  TerminalSelectionContext,
  ProjectRecord,
  VoiceTranscriptionProvider,
} from '@/types/api'
import { CheckoutPicker } from './CheckoutPicker'
import { ExecutingModelChip, type ExecutingModelChipProps } from './ExecutingModelChip'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'
import { ProjectPicker } from './ProjectPicker'
import { IconButton } from './ui'
import './composer-queue.css'
export { splitAttachmentFileName } from '@/lib/message-shortcuts'

/** One message omp admitted, tagged with the engine queue holding it. */
export interface HarnessQueuedPreview {
  message: string
  queue: 'steering' | 'followUp'
}

/** `remove_queued_message` reply as the runtime hook surfaces it. */
export interface HarnessQueuedRemovalOutcome {
  removed: boolean
  images?: MessagePart[]
  /** omp dropped images it could not return; the loss must stay visible. */
  imagesDropped?: boolean
}
interface ComposerProps {
  availableCommands?: SlashCommand[]
  busy: boolean
  submitting?: boolean
  /** The in-flight submission is a compact, so the placeholder says so. */
  submittingKind?: 'prompt' | 'compact'
  loading?: boolean
  disabled?: boolean
  model: string
  effort: PrimeEffortSelector
  /** Concrete level the runtime resolved while `effort` stays auto. */
  resolvedAutoEffort?: PrimeEffortSelector
  /** Harness-saved model presets; the picker switches or saves them. */
  presets?: PrimeModelPresetRecord[]
  onSwitchPreset?(preset: PrimeModelPresetRecord): void
  onSavePreset?(name: string): void
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  reasoningLevels: PrimeEffortSelector[]
  fast: boolean
  fastSupported: boolean
  fastAvailable: boolean
  /** 帳號限流狀態(low_priority/wrap_up);顯示之避免誤把降速當 app bug。 */
  usageLimit?: UsageLimitState
  /** App-level OMP approval mode shown as a compact pill with an inline mode menu. */
  approvalMode?: OmpApprovalMode
  onApprovalModeChange?(mode: OmpApprovalMode): void
  /** Active harness agent name for tooltips ("OMP"). */
  agentName?: string
  /** Active harness short name for inline copy ("OMP"). */
  shortName?: string
  imageInputSupported: boolean
  /** Primary action for Enter; Ctrl/Cmd+Enter selects the opposite action. */
  messageEnterAction?: MessageEnterAction
  contextUsage?: PrimeContextUsage
  executingModel?: ExecutingModelChipProps['executingModel']
  sessionUsage?: SessionUsage
  /** 查詢回合指標(TTFT/TPS)的 runtime;切換後自然回到 —。 */
  runtimeId?: string | null
  /** Harness-reported output rate of the last turn; preferred over the local estimate. */
  harnessTokensPerSecond?: number
  voice?: DesktopApi['voice'] | null
  transcriptionProvider?: VoiceTranscriptionProvider
  skills: SkillRecord[]
  /** Other sidebar sessions in the active project, available as @title references. */
  sessions?: SessionRecord[]
  /** Browser annotations auto-attach as a composer attachment while any exist. */
  annotations?: BrowserAnnotation[]
  /** The active terminal is visible as context; selected text expands this attachment. */
  terminalSelection?: TerminalSelectionContext
  /** Reads the active xterm buffer only at submit time, avoiding output-driven renderer updates. */
  getTerminalContext?(): TerminalPromptContext | undefined
  /** Messages accepted by OMP but waiting for a turn boundary. */
  queuedMessages?: QueuedPrompt[]
  /** Messages held inside the harness when it exposes only a count, not previews. */
  harnessQueuedMessageCount?: number
  /** Harness-held message previews omp admitted, in engine order (steering rows first). */
  harnessQueuedPreviews?: HarnessQueuedPreview[]
  /** Runtime id that owns the harness queue; a change invalidates in-flight queue RPCs. */
  queueRuntimeId?: string
  onRemoveHarnessQueuedMessage?(message: string, queue: 'steering' | 'followUp'): Promise<HarnessQueuedRemovalOutcome | null>
  onPromoteHarnessQueuedMessage?(message: string): Promise<{ promoted: boolean } | null>
  /** Receives a reclaimed message the draft could not take because it is occupied. */
  onReclaimHarnessQueuedMessage?(message: string, queue: 'steering' | 'followUp', images: MessagePart[], imagesDropped?: boolean): void
  onDeleteQueuedMessage?(message: QueuedPrompt): void
  onEditQueuedMessage?(message: QueuedPrompt): void
  onSendQueuedMessage?(message: QueuedPrompt): Promise<void>
  /** Each bump submits the current draft immediately (Ctrl/Cmd+Enter from the annotation popover). */
  sendSignal?: number
  restoreRequest?: { id: number; text: string }
  onRestoreHandled?(): void
  onModelChange(value: string): void
  onEffortChange(value: PrimeEffortSelector): void
  onFastChange(value: boolean): void
  checkoutCatalog?: CheckoutCatalog
  /** Branch/worktree name shown before or without the linked-worktree catalog. */
  checkoutLabel?: string
  checkoutsLoading?: boolean
  onExecuteCheckout?(action: CheckoutAction): Promise<void> | void
  /** Every addable project for the composer folder picker. */
  projects?: readonly ProjectRecord[]
  activeProjectId?: string
  /** Switches the working folder; App decides between continuing and starting fresh. */
  onSelectProject?(project: ProjectRecord): void
  /** Opens the native folder picker and activates the granted folder. */
  onAddProjectFolder?(): void
  onSend(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent): Promise<void> | void
  onStop(): Promise<void> | void
  /** True right after the user stopped the turn: the send button becomes a retry affordance until the draft has content. */
  retryStoppedTurn?: boolean
  onRetryStoppedTurn?(): void
  onRemoveAnnotation?(id: string): void
  /** Called after a send that included the annotations, and by the attachment's remove control. */
  onClearAnnotations?(): void
  onClearTerminalSelection?(): void
  /** Stable per-workspace key; without it the composer keeps no draft of its own. */
  draftKey?: string
  /**
   * Session 設定控制器(useSessionSettings):值透傳 runtime 快照(RPC 真相),
   * 切換即送上游 RPC。缺席時 context popover 不顯示該區塊。
   */
  /** Shown where the session-settings block used to live: points at Settings. */
}

const approvalModeMeta = {
  inherit: { icon: Shield, labelKey: 'composer.approval.inherit', settingsKey: 'agent.approval.inherit', yolo: false },
  'always-ask': { icon: ShieldQuestionMark, labelKey: 'composer.approval.alwaysAsk', settingsKey: 'agent.approval.alwaysAsk', yolo: false },
  write: { icon: ShieldCheck, labelKey: 'composer.approval.write', settingsKey: 'agent.approval.write', yolo: false },
  yolo: { icon: ShieldAlert, labelKey: 'composer.approval.yolo', settingsKey: 'agent.approval.yolo', yolo: true },
} as const satisfies Record<OmpApprovalMode, { icon: typeof Shield; labelKey: MessageKey; settingsKey: MessageKey; yolo: boolean }>

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = []
const noop = () => undefined

// 上游 source 欄位的呈現分組順序:內建 → 擴充 → 技能 → 自訂 → 檔案範本 →
// MCP prompt → 其他。
function slashSourceOrder(source?: string): number {
  if (source === 'extension') return 1
  if (source === 'skill') return 2
  if (source === 'custom') return 3
  if (source === 'file') return 4
  if (source === 'mcp_prompt') return 5
  if (source && source !== 'builtin') return 6
  return 0
}

export const Composer = memo(function Composer({
  availableCommands = INITIAL_SLASH_COMMANDS,
  busy,
  submitting = false,
  submittingKind = 'prompt',
  loading = false,
  disabled,
  model,
  effort,
  modelsByProvider,
  providers,
  reasoningLevels,
  resolvedAutoEffort,
  presets,
  onSwitchPreset,
  onSavePreset,
  fast,
  fastSupported,
  fastAvailable,
  usageLimit,
  approvalMode = 'inherit',
  onApprovalModeChange,
  agentName = 'OMP',
  shortName = 'OMP',

  imageInputSupported,
  messageEnterAction = 'queue',
  contextUsage,
  executingModel,
  sessionUsage,
  runtimeId,
  harnessTokensPerSecond,
  voice,
  transcriptionProvider = 'openai-live',
  skills,
  sessions = [],
  annotations = EMPTY_ANNOTATIONS,
  terminalSelection,
  getTerminalContext,
  queuedMessages = [],
  harnessQueuedMessageCount = 0,
  harnessQueuedPreviews = [],
  queueRuntimeId,
  onRemoveHarnessQueuedMessage,
  onPromoteHarnessQueuedMessage,
  onReclaimHarnessQueuedMessage,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onSendQueuedMessage,
  sendSignal = 0,
  restoreRequest,
  onRestoreHandled,
  onModelChange,
  onEffortChange,
  onFastChange,
  checkoutCatalog,
  checkoutLabel,
  checkoutsLoading = false,
  projects,
  activeProjectId,
  onSelectProject,
  onAddProjectFolder,
  onExecuteCheckout,
  onSend,
  onStop,
  retryStoppedTurn,
  onRetryStoppedTurn,
  onRemoveAnnotation = noop,
  onClearAnnotations = noop,
  onClearTerminalSelection = noop,
  draftKey,
}: ComposerProps) {
  const { t } = useI18n()
  // 限流徽章 tooltip:完整原因與重置時間放在 title,徽章本身保持單行精簡。
  const usageLimitTitle = useMemo(() => {
    if (!usageLimit) return undefined
    const resetAt = (seconds: number | undefined) => seconds === undefined ? t('composer.usageResetUnknown') : new Date(seconds * 1000).toLocaleString()
    if (usageLimit.stage === 'low_priority') {
      const lines = [t('composer.usageLowPriorityTitle', { time: resetAt(usageLimit.resetsAtSec) })]
      if (usageLimit.allowanceLeftPercent !== undefined) lines.push(t('composer.usageLowPriorityAllowance', { percent: usageLimit.allowanceLeftPercent }))
      return lines.join('\n')
    }
    const lines = [t('composer.usageWrapUpTitle')]
    if (usageLimit.resetsAtSec !== undefined) lines.push(t('composer.usageWrapUpReset', { time: resetAt(usageLimit.resetsAtSec) }))
    if (usageLimit.extraUsage) lines.push(t('composer.usageWrapUpExtra'))
    return lines.join('\n')
  }, [usageLimit, t])
  const [value, setValue] = useState(() => draftKey ? readComposerDraft(draftKey)?.text ?? '' : takeComposerDraft())
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null)
  const queuedSendsRef = useRef(new Set<string>())
  // Draft text mirrored for post-await reads: a reclaim resolution must see
  // what the user typed while the RPC was in flight, not the click-time copy.
  const draftValueRef = useRef(value)
  draftValueRef.current = value
  const harnessQueuedPreviewsRef = useRef(harnessQueuedPreviews)
  harnessQueuedPreviewsRef.current = harnessQueuedPreviews
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey
  const queueRuntimeIdRef = useRef(queueRuntimeId)
  queueRuntimeIdRef.current = queueRuntimeId
  const harnessRpcInFlightRef = useRef(new Set<string>())
  const [harnessItemStatus, setHarnessItemStatus] = useState<Record<string, { kind: 'removeUnconfirmed' | 'removeUnavailable' | 'promoteFailed'; snapshot: unknown }>>({})
  useEffect(() => {
    setHarnessItemStatus((current) => {
      const live = new Set(harnessQueuedPreviews.slice(0, harnessQueuedMessageCount).map((preview) => `${preview.queue}:${preview.message}`))
      let changed = false
      const next: typeof current = {}
      for (const [key, entry] of Object.entries(current)) {
        // A snapshot newer than the one a notice was raised against is a
        // refresh: it re-arms the controls and lets the authoritative rows
        // speak for themselves. Rows the snapshot no longer lists drop their
        // notices with them.
        if (live.has(key) && entry.snapshot === harnessQueuedPreviews) next[key] = entry
        else changed = true
      }
      return changed ? next : current
    })
  }, [harnessQueuedPreviews, harnessQueuedMessageCount])
  useEffect(() => {
    if (!restoreRequest) return
    setValue((current) => current.trim() === restoreRequest.text.trim() ? current : current.trim() ? `${current}\n\n${restoreRequest.text}` : restoreRequest.text)
    requestAnimationFrame(() => textareaRef.current?.focus())
    onRestoreHandled?.()
  }, [restoreRequest?.id])
  const [menu, setMenu] = useState<'add' | 'mention' | 'command' | null>(null)
  const [sessionReferenceIds, setSessionReferenceIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [terminalSelectionOpen, setTerminalSelectionOpen] = useState(false)
  const imageAttachments = useComposerImages({ shortName, draftKey })
  const { images, imagesRef, unsupportedFiles, unsupportedFilesRef, error: attachmentError, setError: setAttachmentError, processing: processingImages, persistDropped } = imageAttachments
  const dictation = useDictation(voice, transcriptionProvider, setAttachmentError)
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const lastCompositionEndAtRef = useRef<number | null>(null)
  const acceptedMentionRef = useRef<{ start: number; text: string } | null>(null)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageStatusId = useId()
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const mountedRef = useRef(true)
  const restoredDraftRef = useRef(false)
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills])

  useEffect(() => {
    if (!draftKey || restoredDraftRef.current) return
    restoredDraftRef.current = true
    const draft = readComposerDraft(draftKey)
    if (!draft) return
    if (draft.model && draft.model !== model) onModelChange(draft.model)
    if (draft.effort && draft.effort !== effort) onEffortChange(draft.effort as PrimeEffortSelector)
    if (draft.fast !== undefined && draft.fast !== fast) onFastChange(draft.fast)
  }, [draftKey, effort, fast, model, onEffortChange, onFastChange, onModelChange])

  useEffect(() => {
    if (draftKey) saveComposerDraft(draftKey, { text: value, model, effort, fast })
  }, [draftKey, effort, fast, model, value])

  useEffect(() => {
    const mentionMatch = /(?:^|\s)@([^@\n]*)$/.exec(value)
    const mentionStart = mentionMatch ? value.length - mentionMatch[1].length - 1 : -1
    const acceptedMention = acceptedMentionRef.current
    const suppressAcceptedMention = Boolean(
      mentionMatch && acceptedMention && mentionStart === acceptedMention.start && value.slice(acceptedMention.start, acceptedMention.start + acceptedMention.text.length) === acceptedMention.text,
    )
    if (acceptedMention && !suppressAcceptedMention) acceptedMentionRef.current = null
    setMenu(value.startsWith('/') && !value.includes('\n') ? 'command' : mentionMatch && !suppressAcceptedMention ? 'mention' : null)
  }, [value])
  useEffect(() => {
    setSessionReferenceIds((current) => {
      if (!current.size) return current
      const mentionedTitles = new Set(findSessionMentions(value, sessions, current).map(({ session }) => session.title.trim().toLocaleLowerCase()))
      const next = new Map([...current].filter(([title]) => mentionedTitles.has(title)))
      return next.size === current.size ? current : next
    })
  }, [sessions, value])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (annotations.length === 0) setAnnotationsOpen(false)
  }, [annotations.length])
  useEffect(() => {
    if (!terminalSelection?.text) setTerminalSelectionOpen(false)
  }, [terminalSelection?.text])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node) || menuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-composer-menu-trigger]')) return
      setMenu(null)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeComposingOrGuarded(event, composingRef.current, lastCompositionEndAtRef.current)) setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menu])

  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!approvalMenuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node) || approvalMenuRef.current?.contains(target)) return
      setApprovalMenuOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeComposingOrGuarded(event, composingRef.current, lastCompositionEndAtRef.current)) setApprovalMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [approvalMenuOpen])

  // Ctrl/Cmd+Enter in the annotation popover bumps sendSignal to submit the
  // draft (with the just-saved annotation) without switching focus here.
  const lastSendSignalRef = useRef(sendSignal)
  useEffect(() => {
    if (sendSignal === lastSendSignalRef.current) return
    lastSendSignalRef.current = sendSignal
    void submit()
  }, [sendSignal])

  const submit = async (intent: PromptDeliveryIntent = messageEnterAction, valueOverride?: string) => {
    const currentImages = imagesRef.current
    const currentUnsupportedFiles = unsupportedFilesRef.current
    const currentAnnotations = annotationsRef.current
    const currentTerminalContext = terminalSelection?.text ? getTerminalContext?.() : undefined
    const hasTerminalSelection = Boolean(currentTerminalContext?.text)
    const draftValue = valueOverride ?? value
    const trimmedDraft = draftValue.trim()

    // 2.7 繼續速寫:TUI 把剛好是 `.` 或 `c` 的輸入視為合成「繼續」指令
    // (manual-continue prompt),不送字面文字;附件保持暫留,只清掉指令本身。
    // 只適用主要 Enter 動作:TUI 的 Ctrl+Enter(follow-up)路徑不特殊處理 `.`,
    // trigger 由 intent === messageEnterAction 區分(Ctrl/Cmd+Enter 永遠是反向動作)。
    if (intent === messageEnterAction && isContinueShorthand(trimmedDraft)) {
      if (loading || disabled) return
      setValue('')
      if (draftKey) saveComposerDraft(draftKey, { text: '', model, effort, fast })
      setMenu(null)
      try {
        await onSend(MANUAL_CONTINUE_PROMPT, [], intent)
      } catch {
        if (draftKey) saveComposerDraft(draftKey, { text: draftValue, model, effort, fast })
        if (mountedRef.current) setValue(draftValue)
      } finally {
        if (mountedRef.current) textareaRef.current?.focus()
      }
      return
    }

    // 2.7 佇列速寫:`->`/`=>` 開頭的輸入不論 Enter 設定一律進 follow_up 佇列語意;
    // 連號清單逐項拆送,圖片只附在第一則。失敗時把未送出的項目還原成 `=>` 清單。
    // 同樣只適用主要 Enter 動作,Ctrl+Enter 維持字面 follow-up(TUI 一致)。
    const queueShorthand = intent === messageEnterAction ? parseQueueShorthandInput(trimmedDraft) : null
    if (queueShorthand) {
      if (loading || disabled) return
      if (imageAttachments.hasPending()) {
        setAttachmentError(t('composer.error.pendingFiles'))
        return
      }
      if (currentUnsupportedFiles.length > 0) {
        const first = currentUnsupportedFiles[0]
        const remainder = currentUnsupportedFiles.length - 1
        setAttachmentError(remainder === 0 ? t('composer.error.unsupportedSingle', { name: first.name }) : t('composer.error.unsupportedMore', { name: first.name, count: remainder }))
        return
      }
      if (currentImages.length > 0 && !imageInputSupported) {
        setAttachmentError(t('composer.error.noImages'))
        return
      }
      const queueItems = queueShorthand.items.length > 0
        ? queueShorthand.items
        : currentImages.length > 0
          ? [currentImages.length === 1 ? '[Attached image]' : '[Attached images]']
          : []
      if (queueItems.length === 0) {
        // 只打了前綴又沒有附件:對齊 TUI 的「Usage: /queue <message>」提示,保留草稿。
        setAttachmentError(t('composer.error.queueShorthandEmpty'))
        return
      }
      const queueShorthandImages = currentImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      const queueShorthandComposerImages = currentImages
      submittingRef.current = true
      setValue('')
      if (draftKey) saveComposerDraft(draftKey, { text: '', model, effort, fast })
      imageAttachments.clear()
      setAttachmentError('')
      setMenu(null)
      let sent = 0
      try {
        for (const item of queueItems) {
          await onSend(item, sent === 0 ? queueShorthandImages : [], 'queue')
          sent += 1
        }
      } catch {
        const restoredText = sent === 0 ? draftValue : formatQueuedItemsForRestore(queueItems.slice(sent))
        if (draftKey) saveComposerDraft(draftKey, { text: restoredText, model, effort, fast })
        if (mountedRef.current) {
          setValue(restoredText)
          if (sent === 0) {
            // 第一則就失敗:圖片跟著還原,不讓受控檔案在失敗後憑空消失。
            imageAttachments.restoreWithinLimits(queueShorthandComposerImages)
            setAttachmentError(queueShorthandComposerImages.length > 0 ? t('composer.error.notSentRestoredImages') : t('composer.error.notSentRestored'))
          } else {
            setAttachmentError(t('composer.error.queueNotSentPartial', { sent, total: queueItems.length }))
          }
        } else if (sent === 0) {
          imageAttachments.restoreAfterUnmount(queueShorthandComposerImages)
        }
      } finally {
        submittingRef.current = false
        if (mountedRef.current) textareaRef.current?.focus()
      }
      return
    }

    const prompt =
      draftValue.trim() ||
      (currentImages.length > 0
        ? currentImages.length === 1
          ? '[Attached image]'
          : '[Attached images]'
        : currentUnsupportedFiles.length > 0
          ? currentUnsupportedFiles.length === 1
            ? '[Attached file]'
            : '[Attached files]'
          : currentAnnotations.length > 0
            ? '[Page annotations]'
            : '[Terminal selection]')
    if (
      (!draftValue.trim() && currentImages.length === 0 && currentUnsupportedFiles.length === 0 && currentAnnotations.length === 0 && !hasTerminalSelection) ||
      loading ||
      disabled ||
      (intent !== 'steer' && !busy && (submitting || submittingRef.current))
    )
      return
    if (imageAttachments.hasPending()) {
      setAttachmentError(t('composer.error.pendingFiles'))
      return
    }
    if (currentUnsupportedFiles.length > 0) {
      const first = currentUnsupportedFiles[0]
      const remainder = currentUnsupportedFiles.length - 1
      setAttachmentError(remainder === 0 ? t('composer.error.unsupportedSingle', { name: first.name }) : t('composer.error.unsupportedMore', { name: first.name, count: remainder }))
      return
    }
    if (currentImages.length > 0 && !imageInputSupported) {
      setAttachmentError(t('composer.error.noImages'))
      return
    }
    const isSlashCommand = /^\/\S+/.test(prompt)
    // 依命令能力驗證附件:skill / 模板展開型命令上游會併入圖片;其餘 slash
    // (含 /compact)上游本地消化、圖片會被靜默丟棄,提前拒絕。
    if (isSlashCommand && currentImages.length && !slashCommandAcceptsImages(prompt, commandCatalog)) {
      setAttachmentError(t('slash.error.images'))
      return
    }
    const submittedImages = currentImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    // Recognized @ mentions carry explicit routing semantics; annotations then
    // ride along inside the prompt as their own delimited plain-text block.
    const referencedSessions = findSessionMentions(prompt, sessions, sessionReferenceIds)
    const sessionTitles = new Set(referencedSessions.map(({ session }) => session.title.trim().toLocaleLowerCase()))
    const promptWithSessions = appendSessionRouting(prompt, sessions, sessionReferenceIds)
    // If a session and capability share a display name, the session chosen
    // from the combined menu wins instead of silently routing both.
    const promptWithCapabilities = appendCapabilityRouting(
      promptWithSessions,
      enabledSkills.filter((skill) => !sessionTitles.has(skill.name.trim().toLocaleLowerCase())),
    )
    const promptWithAnnotations = appendAnnotationsToPrompt(promptWithCapabilities, currentAnnotations)
    const promptWithContext = isSlashCommand ? prompt : appendTerminalContextToPrompt(promptWithAnnotations, currentTerminalContext)
    submittingRef.current = true
    const submittedValue = draftValue
    const submittedComposerImages = currentImages
    setValue('')
    if (draftKey) saveComposerDraft(draftKey, { text: '', model, effort, fast })
    imageAttachments.clear()
    setAttachmentError('')
    setMenu(null)
    try {
      await onSend(promptWithContext, submittedImages, intent)
      // The annotations were delivered: clear the attachment and page markers.
      if (currentAnnotations.length > 0 && !isSlashCommand) onClearAnnotations()
    } catch {
      const mergeFailedDraft = (current: string) => current === submittedValue ? current : current ? `${submittedValue}\n\n${current}` : submittedValue
      const restoredText = mergeFailedDraft(draftKey ? readComposerDraft(draftKey)?.text ?? '' : textareaRef.current?.value ?? '')
      if (draftKey) saveComposerDraft(draftKey, { text: restoredText, model, effort, fast })
      if (mountedRef.current) {
        setValue(restoredText)
        const restoration = imageAttachments.restoreWithinLimits(submittedComposerImages)
        if (restoration.omitted > 0) {
          const restoredImages = restoration.restored > 0 ? t('composer.error.restoredAlong', { count: restoration.restored }) : ''
          setAttachmentError(t('composer.error.notSentPartial', { restored: restoredImages, count: restoration.omitted }))
        } else if (submittedComposerImages.length > 0) {
          setAttachmentError(t('composer.error.notSentRestoredImages'))
        } else {
          setAttachmentError(t('composer.error.notSentRestored'))
        }
      } else imageAttachments.restoreAfterUnmount(submittedComposerImages)
    } finally {
      submittingRef.current = false
      if (mountedRef.current) textareaRef.current?.focus()
    }
  }

  const finishDictation = async (send: boolean) => {
    const transcript = await dictation.finish()
    if (!transcript) return
    const next = value.trimEnd() ? `${value.trimEnd()} ${transcript}` : transcript
    setValue(next)
    if (send) await submit('queue', next)
    else requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const insertAtCaret = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? textarea.value.length
    textarea.setRangeText(text, start, end, 'end')
    setValue(textarea.value)
  }
  const insert = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) insertAtCaret(textarea, text)
    else setValue((current) => `${current}${text}`)
    setMenu(null)
    textarea?.focus()
  }
  const insertMention = (label: string, session?: SessionRecord) => {
    const textarea = textareaRef.current
    const match = /(?:^|\s)@([^@\n]*)$/.exec(value)
    if (!match) {
      insert(`@${label} `)
      return
    }
    const query = match[1]
    const start = value.length - query.length
    const mentionStart = start - 1
    const acceptedText = `@${label} `
    if (textarea) {
      textarea.setRangeText(`${label} `, start, value.length, 'end')
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(textarea.value)
    } else {
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(`${value.slice(0, start)}${label} `)
    }
    if (session) {
      const key = session.title.trim().toLocaleLowerCase()
      setSessionReferenceIds((current) => new Map(current).set(key, session.id))
    }
    setMenu(null)
    textarea?.focus()
  }

  const mentionQuery = /(?:^|\s)@([^@\n]*)$/.exec(value)?.[1]?.toLocaleLowerCase().trim() ?? ''

  // 上游 live catalog 是權威來源;無 bridge / 離線 / catalog 為空時降級為
  // 寫死的啟始命令清單,兩者經過同一個 desktopSlashCommands 過濾器。
  const commandCatalog = useMemo(
    () => desktopSlashCommands(availableCommands.length > 0 ? availableCommands : INITIAL_SLASH_COMMANDS, t),
    [availableCommands, t],
  )
  const catalogByName = useMemo(() => {
    const map = new Map<string, SlashCommand>()
    for (const command of commandCatalog) {
      map.set(command.name, command)
      for (const alias of command.aliases ?? []) if (!map.has(alias)) map.set(alias, command)
    }
    return map
  }, [commandCatalog])
  const suggestions =
    menu === 'command'
      ? slashSuggestions(commandCatalog, value.startsWith('/') ? value : '/')
          .map((item) => ({
            key: item.command,
            label: item.command,
            detail: item.detail,
            // get_available_commands 的 source 欄位(builtin/skill/extension/custom/
            // mcp_prompt/file);subcommand 建議沿用主命令的 source。
            source: catalogByName.get(item.command.replace(/^\//, '').split(/\s+/)[0])?.source,
            icon: <Command size={14} />,
            choose: () => {
              setValue(`${item.command} ${value.startsWith('/') ? '' : value}`)
              setMenu(null)
              textareaRef.current?.focus()
            },
          }))
          // 依來源分組排序,讓視覺分組與鍵盤導覽順序一致(stable sort 保留
          // 同組內既有順序)。
          .sort((left, right) => slashSourceOrder(left.source) - slashSourceOrder(right.source))
      : menu === 'mention'
        ? [
            ...sessions
              .filter((session) => session.title.toLocaleLowerCase().includes(mentionQuery))
              .slice(0, 6)
              .map((session) => ({
                key: `session:${session.harness}:${session.id}`,
                label: `@${session.title}`,
                detail: `${session.harness.toUpperCase()} session · ${session.status}`,
                source: undefined,
                icon: <MessageCirclePlus size={14} />,
                choose: () => insertMention(session.title, session),
              })),
            ...enabledSkills
              .filter((skill) => skill.name.toLocaleLowerCase().includes(mentionQuery))
              .slice(0, 6)
              .map((skill) => ({
                key: `skill:${skill.id}`,
                label: `@${skill.name}`,
                detail: skill.description,
                source: undefined,
                icon: <AtSign size={14} />,
                choose: () => insertMention(skill.name),
              })),
          ].slice(0, 8)
        : menu === 'add'
          ? [
              {
                key: 'files',
                label: t('composer.addFiles'),
                detail: t('composer.addFilesDetail'),
                source: undefined,
                icon: <Paperclip size={14} />,
                choose: () => {
                  setMenu(null)
                  fileInputRef.current?.click()
                },
              },
              { key: 'commands', label: t('slash.menu.label'), detail: t('slash.menu.detail'), source: undefined, icon: <Command size={14} />, choose: () => { if (!value) setValue('/'); setMenu('command'); textareaRef.current?.focus() } },
            ]
          : []

  useEffect(() => {
    setActiveSuggestion(0)
  }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? null : Math.min(100, Math.max(0, contextUsage.percent))
  const contextLabel = contextDialLabel(contextUsage, sessionUsage)
  const contextDisplayPercent = contextPercent === null ? null : Math.min(99, Math.round(contextPercent))
  const contextStyle = { '--context-percent': `${contextPercent ?? 0}%` } as CSSProperties
  const sessionCost = formatSessionCost(sessionUsage)
  // 回合指標快照只在值變時替換,訂閱不會因 delta 事件連發而重渲染。
  const turnMetrics = useSyncExternalStore(subscribeTurnMetrics, () => getTurnMetrics(runtimeId))
  const outputTokensPerSecond = harnessTokensPerSecond ?? turnMetrics.tokensPerSecond
  /** Click target for the context dial's popover; closes on outside click/Escape. */
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!contextMenuOpen) return
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      setContextMenuOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeComposingOrGuarded(event, composingRef.current, lastCompositionEndAtRef.current)) setContextMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [contextMenuOpen])
  const sendQueuedMessageImmediately = async (queued: QueuedPrompt) => {
    if (queuedSendsRef.current.has(queued.id)) return
    queuedSendsRef.current.add(queued.id)
    try {
      if (onSendQueuedMessage) await onSendQueuedMessage(queued)
      else {
        await onSend(queued.text, [], 'steer')
        onDeleteQueuedMessage?.(queued)
      }
    } catch {
      // Keep the original queue entry available for retry after failed admission.
    } finally {
      queuedSendsRef.current.delete(queued.id)
    }
  }

  // Harness-held rows act through omp's own queue commands; the display
  // stays prop-driven so the refreshed runtime snapshot remains the authority.
  const removeHarnessQueuedPreview = async (preview: HarnessQueuedPreview, mode: 'remove' | 'reclaim') => {
    if (!onRemoveHarnessQueuedMessage) return
    const key = `${preview.queue}:${preview.message}`
    if (harnessRpcInFlightRef.current.has(key)) return
    // No blind retry: an unconfirmed outcome stays inert until a refreshed
    // snapshot clears the notice.
    if (harnessItemStatus[key]?.kind === 'removeUnconfirmed' || harnessItemStatus[key]?.kind === 'removeUnavailable') return
    harnessRpcInFlightRef.current.add(key)
    const draftKeyAtRequest = draftKey
    const runtimeIdAtRequest = queueRuntimeId
    setHarnessItemStatus((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    let outcome: HarnessQueuedRemovalOutcome | null = null
    try {
      outcome = await onRemoveHarnessQueuedMessage(preview.message, preview.queue)
    } catch {
      outcome = null
    } finally {
      harnessRpcInFlightRef.current.delete(key)
    }
    // A session or runtime switch mid-RPC makes the resolution stale: it must
    // not touch the new draft or fabricate queue state for another owner.
    if (!mountedRef.current || draftKeyRef.current !== draftKeyAtRequest || queueRuntimeIdRef.current !== runtimeIdAtRequest) return
    if (!outcome?.removed) {
      const kind = outcome ? 'removeUnavailable' : 'removeUnconfirmed'
      const snapshot = harnessQueuedPreviewsRef.current
      setHarnessItemStatus((current) => ({ ...current, [key]: { kind, snapshot } }))
      return
    }
    if (mode === 'remove') return
    if (draftValueRef.current.trim()) {
      // The draft is occupied: hand the content to the owner as an unaccepted
      // local item instead of overwriting what the user is writing.
      if (outcome.imagesDropped === true) onReclaimHarnessQueuedMessage?.(preview.message, preview.queue, outcome.images ?? [], true)
      else onReclaimHarnessQueuedMessage?.(preview.message, preview.queue, outcome.images ?? [])
      return
    }
    setValue(preview.message)
    const returnedImages = outcome.images ?? []
    let rendererDropped = 0
    if (returnedImages.length > 0) {
      if (imageInputSupported) {
        const attachable = returnedImages.flatMap((part, index) => part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string'
          ? [{ id: crypto.randomUUID(), name: `Reclaimed image ${index + 1}`, size: part.data.length, type: 'image' as const, mimeType: part.mimeType, data: part.data }]
          : [])
        rendererDropped = returnedImages.length - imageAttachments.restoreWithinLimits(attachable).restored
      } else rendererDropped = returnedImages.length
    }
    // Lost images must stay visible; they never come back as plain text.
    if (rendererDropped > 0) setAttachmentError(t('composer.queue.reclaimImagesDropped', { name: shortName, count: rendererDropped }))
    else if (outcome.imagesDropped === true) setAttachmentError(t('composer.queue.reclaimImagesUnavailable', { name: shortName }))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const promoteHarnessQueuedPreview = async (preview: HarnessQueuedPreview) => {
    if (!onPromoteHarnessQueuedMessage || preview.queue !== 'followUp') return
    const key = `${preview.queue}:${preview.message}`
    if (harnessRpcInFlightRef.current.has(key)) return
    if (harnessItemStatus[key]?.kind === 'promoteFailed') return
    harnessRpcInFlightRef.current.add(key)
    const draftKeyAtRequest = draftKey
    const runtimeIdAtRequest = queueRuntimeId
    let outcome: { promoted: boolean } | null = null
    try {
      outcome = await onPromoteHarnessQueuedMessage(preview.message)
    } catch {
      outcome = null
    } finally {
      harnessRpcInFlightRef.current.delete(key)
    }
    if (!mountedRef.current || draftKeyRef.current !== draftKeyAtRequest || queueRuntimeIdRef.current !== runtimeIdAtRequest) return
    if (!outcome?.promoted) {
      const snapshot = harnessQueuedPreviewsRef.current
      setHarnessItemStatus((current) => ({ ...current, [key]: { kind: 'promoteFailed', snapshot } }))
    }
  }

  const harnessStatusText = (kind: 'removeUnconfirmed' | 'removeUnavailable' | 'promoteFailed') =>
    kind === 'removeUnconfirmed' ? t('composer.queue.harnessRemoveUnconfirmed')
      : kind === 'removeUnavailable' ? t('composer.queue.harnessRemoveUnavailable')
        : t('composer.queue.harnessPromoteFailed', { name: agentName })

  const approvalMeta = approvalModeMeta[approvalMode]
  const ApprovalIcon = approvalMeta.icon
  const approvalTitle = t('composer.approval.title', { mode: t(approvalMeta.settingsKey) })

  return (
    <div className="composer-wrap">
      {queuedMessages.length || harnessQueuedMessageCount ? (
        <section className="composer-queue" aria-label={t('composer.queue.aria')} aria-live="polite">
          <div className="composer-queue__header">
            <span>
              <Clock3 size={13} />
              {t('composer.queue.title')}
            </span>
            <strong>{queuedMessages.length + harnessQueuedMessageCount}</strong>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((queued) => (
              <div className="composer-queue__item" key={queued.id}>
                {queueEdit?.id === queued.id ? (
                  <div className="composer-queue__text composer-queue__editor">
                    <textarea aria-label={t('composer.queue.edit')} value={queueEdit.text} onChange={(event) => setQueueEdit({ id: queued.id, text: event.target.value })} />
                    <button type="button" aria-label={t('draft.save')} disabled={!queueEdit.text.trim()} onClick={() => { onEditQueuedMessage?.({ ...queued, text: queueEdit.text }); setQueueEdit(null) }}><Check size={13} /></button>
                    <button type="button" aria-label={t('extensionUi.cancel')} onClick={() => setQueueEdit(null)}><X size={13} /></button>
                  </div>
                ) : <span className="composer-queue__text">{queued.text}{queued.flushAttemptFailed ? <small role="status">{t('composer.queue.failed')}</small> : null}</span>}
                <span className="composer-queue__actions">
                  <button
                    type="button"
                    className="composer-queue__action"
                    aria-label={t('composer.queue.sendAria', { message: queued.text })}
                    title={t('composer.queue.send')}
                    disabled={queued.deliveryPending}
                    onClick={() => {
                      void sendQueuedMessageImmediately(queued)
                    }}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="composer-queue__action"
                    aria-label={t('composer.queue.editAria', { message: queued.text })}
                    title={t('composer.queue.edit')}
                    disabled={queued.deliveryPending}
                    onClick={() => {
                      setQueueEdit({ id: queued.id, text: queued.text })
                    }}
                  >
                    <Edit3 size={13} />
                  </button>
                  <button
                    type="button"
                    className="composer-queue__action composer-queue__action--delete"
                    aria-label={t('composer.queue.deleteAria', { message: queued.text })}
                    title={t('composer.queue.delete')}
                    disabled={queued.deliveryPending}
                    onClick={() => onDeleteQueuedMessage?.(queued)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            ))}
            {harnessQueuedMessageCount ? (
              <>
                {harnessQueuedPreviews.slice(0, harnessQueuedMessageCount).map((preview, index) => {
                  const status = harnessItemStatus[`${preview.queue}:${preview.message}`]
                  const removeDisabled = status?.kind === 'removeUnconfirmed' || status?.kind === 'removeUnavailable'
                  return (
                    <div className="composer-queue__item composer-queue__item--harness" key={`${index}-${preview.message}`}>
                      <span className="composer-queue__text">
                        {preview.message}
                        {status ? <small role="status">{harnessStatusText(status.kind)}</small> : null}
                      </span>
                      {onRemoveHarnessQueuedMessage || (preview.queue === 'followUp' && onPromoteHarnessQueuedMessage) ? (
                        <span className="composer-queue__actions">
                          {onRemoveHarnessQueuedMessage ? (
                            <button
                              type="button"
                              className="composer-queue__action"
                              aria-label={t('composer.queue.reclaimAria', { message: preview.message })}
                              title={t('composer.queue.reclaim')}
                              disabled={removeDisabled}
                              onClick={() => {
                                void removeHarnessQueuedPreview(preview, 'reclaim')
                              }}
                            >
                              <Edit3 size={13} />
                            </button>
                          ) : null}
                          {preview.queue === 'followUp' && onPromoteHarnessQueuedMessage ? (
                            <button
                              type="button"
                              className="composer-queue__action"
                              aria-label={t('composer.queue.promoteAria', { message: preview.message })}
                              title={t('composer.queue.promote')}
                              disabled={status?.kind === 'promoteFailed'}
                              onClick={() => {
                                void promoteHarnessQueuedPreview(preview)
                              }}
                            >
                              <MessageCirclePlus size={13} />
                            </button>
                          ) : null}
                          {onRemoveHarnessQueuedMessage ? (
                            <button
                              type="button"
                              className="composer-queue__action composer-queue__action--delete"
                              aria-label={t('composer.queue.deleteAria', { message: preview.message })}
                              title={t('composer.queue.delete')}
                              disabled={removeDisabled}
                              onClick={() => {
                                void removeHarnessQueuedPreview(preview, 'remove')
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
                {harnessQueuedMessageCount > harnessQueuedPreviews.length ? (
                  <div className="composer-queue__item composer-queue__item--harness">
                    <span className="composer-queue__text">{t('composer.queue.harnessHeld', { name: agentName, count: harnessQueuedMessageCount - harnessQueuedPreviews.length })}</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      ) : null}
      <div className={`composer ${busy || submitting ? 'composer--busy' : ''} ${imageAttachments.dragging ? 'composer--image-dragging' : ''}`} {...imageAttachments.dragHandlers}>
        {imageAttachments.dragging ? (
          <div className="composer-drop-feedback" aria-hidden="true">
            <Paperclip size={18} />
            {t('composer.dropFiles')}
          </div>
        ) : null}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            data-draft-scope={draftKey}
            value={value}
            disabled={disabled || loading}
            rows={2}
            placeholder={
              disabled
                ? t('composer.placeholderDisabled')
                : loading
                  ? t('composer.placeholderLoading')
                  : submitting
                    ? submittingKind === 'compact'
                      ? t('composer.placeholderCompacting')
                      : t('composer.placeholderSubmitting', { name: shortName })
                    : t('composer.placeholder', { name: shortName })
            }
            aria-label={t('composer.ariaLabel', { name: shortName })}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(menu && suggestions.length)}
            aria-controls={menu ? menuId : undefined}
            aria-activedescendant={menu && suggestions.length ? `${menuId}-option-${activeSuggestion}` : undefined}
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.items]
                .filter((item) => item.kind === 'file')
                .flatMap((item) => {
                  const file = item.getAsFile()
                  return file ? [file] : []
                })
              if (!files.length) return
              const pastedText = event.clipboardData.getData('text/plain')
              event.preventDefault()
              if (pastedText) insertAtCaret(event.currentTarget, pastedText)
              void imageAttachments.ingest(files)
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false
              lastCompositionEndAtRef.current = event.nativeEvent.timeStamp
            }}
            onKeyDown={(event) => {
              if (isImeComposingOrGuarded(event.nativeEvent, composingRef.current, lastCompositionEndAtRef.current)) {
                // A swallowed Enter must die here: without preventDefault the
                // textarea's default inserts a newline, which reads to the
                // reader as "Enter stopped sending". Live composition keys
                // still belong to the IME, so their default stays untouched.
                if (event.key === 'Enter' && !isImeComposing(event.nativeEvent, composingRef.current)) event.preventDefault()
                return
              }
              // TUI 預設鍵對齊(2.6/2.7):
              // - tui.input.newLine:shift+enter(textarea 原生)與 ctrl+j(此處補上)。
              if (event.ctrlKey && event.key.toLowerCase() === 'j') {
                event.preventDefault()
                insertAtCaret(event.currentTarget, '\n')
                return
              }
              // - app.message.dequeue:alt+up 取回最後一則佇列訊息回編輯器
              //   (shift+up 在 GUI textarea 是選取文字,不對齊)。
              if (event.altKey && event.key === 'ArrowUp') {
                const harnessLast = harnessQueuedPreviews[Math.min(harnessQueuedPreviews.length, harnessQueuedMessageCount) - 1]
                if (harnessLast && onRemoveHarnessQueuedMessage) {
                  event.preventDefault()
                  void removeHarnessQueuedPreview(harnessLast, 'reclaim')
                  return
                }
                const localLast = queuedMessages[queuedMessages.length - 1]
                if (localLast) {
                  event.preventDefault()
                  const draftTail = localLast.text
                  setValue((current) => (current.trim() ? `${current}\n\n${draftTail}` : draftTail))
                  onDeleteQueuedMessage?.(localLast)
                  return
                }
              }
              // - app.retry:f5 / alt+r 重試停止的回合(僅在有可重試狀態時接管)。
              if (retryStoppedTurn && (event.key === 'F5' || (event.altKey && event.key.toLowerCase() === 'r'))) {
                event.preventDefault()
                onRetryStoppedTurn?.()
                return
              }
              if (event.key === 'Backspace') acceptedMentionRef.current = null
              if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setActiveSuggestion((current) => (event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length))
                return
              }
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && menu && suggestions.length) {
                // Fully typed commands without arguments submit on the first
                // Enter instead of only re-selecting their own suggestion;
                // anything with a subcommand continuation still completes.
                const activeItem = suggestions[activeSuggestion]
                const topName = menu === 'command' && activeItem ? activeItem.key.replace(/^\//, '').split(/\s+/)[0] : undefined
                const commandMeta = topName ? commandCatalog.find((command) => command.name === topName || command.aliases?.includes(topName)) : undefined
                const exactNoArgs = menu === 'command' && activeItem !== undefined && value.trim() === activeItem.key && !commandMeta?.subcommands?.length
                if (!exactNoArgs) {
                  event.preventDefault()
                  chooseSuggestion(activeSuggestion)
                  return
                }
                setMenu(null)
              }
              const intent = messageActionForKey(
                {
                  key: event.key,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  altKey: event.altKey,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                messageEnterAction,
              )
              if (intent) {
                event.preventDefault()
                // 空白 Enter(2.7):TUI 在執行中以「使用者中斷」abort 並排空待處理輸入;
                // GUI 由 onStop 承接 abort_and_restore_queue。閒置時不送出,preventDefault
                // 也避免 textarea 插入空白換行,看起來像「按 Enter 沒反應」。
                const hasDraftContent = Boolean(value.trim()) || images.length > 0 || unsupportedFiles.length > 0 || annotations.length > 0 || Boolean(terminalSelection?.text)
                if (!hasDraftContent) {
                  if (busy && !loading && !disabled) void onStop()
                  return
                }
                void submit(intent)
              }
              if (event.key === 'Escape') {
                if (menu) {
                  event.preventDefault()
                  setMenu(null)
                  return
                }
                // Esc(2.7):忙碌時對齊 TUI「中止並取回佇列」,由 onStop 執行
                // abort_and_restore_queue;其他浮層(approval/context popover)開啟時
                // Esc 歸它們的事件監聽器處理,不重複觸發 stop。
                // TUI 的「雙 Esc」(閒置且輸入框為空、500ms 內按兩次)會開啟 rewind/tree
                // 選擇器;GUI 尚無 rewind 介面(階段一),雙 Esc 先不接功能,單次 Esc
                // 在閒置時保持 no-op(不清草稿,與 TUI 一致)。
                if (busy && !loading && !disabled && !approvalMenuOpen && !contextMenuOpen) {
                  event.preventDefault()
                  void onStop()
                }
              }
            }}
          />
        </div>
        {menu && suggestions.length ? (
          <div
            ref={menuRef}
            id={menuId}
            className="composer-menu"
            role="listbox"
            aria-label={menu === 'command' ? t('composer.menu.commands') : menu === 'mention' ? t('composer.menu.mentions') : t('composer.menu.add')}
          >
            {(() => {
              // 依上游 source 欄位分組呈現(get_available_commands);
              // suggestions 已在計算時按同一次序排序,鍵盤導覽與視覺一致。
              // 只有一種來源時不加標題,保持降級目錄的精簡外觀。
              const labelFor = (source?: string): MessageKey => {
                if (source === 'extension') return 'slash.source.extension'
                if (source === 'skill') return 'slash.source.skill'
                if (source === 'custom') return 'slash.source.custom'
                if (source === 'file') return 'slash.source.file'
                if (source === 'mcp_prompt') return 'slash.source.mcpPrompt'
                if (source && source !== 'builtin') return 'slash.source.other'
                return 'slash.source.builtin'
              }
              const indexed = suggestions.map((suggestion, index) => ({
                suggestion,
                index,
                source: suggestion.source,
              }))
              const distinct = new Set(indexed.map((entry) => slashSourceOrder(entry.source)))
              let lastOrder = -1
              return indexed.map(({ suggestion, index, source }) => {
                const order = slashSourceOrder(source)
                const header = menu === 'command' && distinct.size > 1 && order !== lastOrder
                  ? (
                      <div className="composer-menu__group-label" role="presentation" key={`group-${order}`}>
                        {t(labelFor(source))}
                      </div>
                    )
                  : null
                lastOrder = order
                return (
                  <Fragment key={suggestion.key}>
                    {header}
                    <button
                      id={`${menuId}-option-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={activeSuggestion === index}
                      className={activeSuggestion === index ? 'is-active' : ''}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      onClick={suggestion.choose}
                    >
                      {suggestion.icon}
                      <span>
                        <strong>{suggestion.label}</strong>
                        <small>{suggestion.detail}</small>
                      </span>
                    </button>
                  </Fragment>
                )
              })
            })()}
          </div>
        ) : null}
        {annotationsOpen && annotations.length ? (
          <div className="composer-annotations" role="region" aria-label={t('composer.annotations.aria')}>
            {annotations.map((annotation, index) => {
              return (
                <div className="composer-annotation" key={annotation.id}>
                  <span className="composer-annotation__badge" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="composer-annotation__body">
                    <p>{annotation.comment}</p>
                    {annotation.stale ? <small>{t('composer.annotationStale')}</small> : null}
                  </div>
                  <button type="button" aria-label={t('composer.removeAnnotation', { index: index + 1 })} onClick={() => onRemoveAnnotation(annotation.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {terminalSelectionOpen && terminalSelection?.text ? (
          <div className="composer-terminal-selection" role="region" aria-label={t('composer.terminalSelection.aria')}>
            <div>
              <SquareTerminal size={14} aria-hidden="true" />
              <strong>{terminalSelection.label}</strong>
              {terminalSelection.truncated ? <small>{t('composer.terminalTruncated')}</small> : null}
            </div>
            <pre>{terminalSelection.text}</pre>
          </div>
        ) : null}
        {images.length || unsupportedFiles.length || annotations.length || terminalSelection?.text ? (
          <div className="composer-attachments" aria-label={t('composer.attachments.aria')}>
            {annotations.length ? (
              <div className="composer-attachment composer-attachment--annotations" title={t('composer.annotationCount', { count: annotations.length })}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={annotationsOpen}
                  aria-label={t('composer.inspectAnnotations', { count: annotations.length })}
                  onClick={() => setAnnotationsOpen((open) => !open)}
                >
                  <MessageCirclePlus size={13} />
                  <span>{annotations.length}</span>
                  <ChevronDown size={11} className={annotationsOpen ? 'is-open' : ''} />
                </button>
                <button
                  type="button"
                  className="composer-attachment__clear"
                  aria-label={t('composer.removeAnnotations')}
                  onClick={() => {
                    setAnnotationsOpen(false)
                    onClearAnnotations()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {terminalSelection?.text ? (
              <div className="composer-attachment composer-attachment--terminal has-selection" title={t('composer.terminalTitle', { label: terminalSelection.label })}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={terminalSelectionOpen}
                  aria-label={t('composer.inspectTerminal', { label: terminalSelection.label })}
                  onClick={() => setTerminalSelectionOpen((open) => !open)}
                >
                  <SquareTerminal size={13} />
                  <span>{terminalSelection.label}</span>
                  <small>{t('composer.terminalSelected')}</small>
                  <ChevronDown size={11} className={terminalSelectionOpen ? 'is-open' : ''} />
                </button>
                <button type="button" className="composer-attachment__clear" aria-label={t('composer.clearTerminalSelection')} onClick={onClearTerminalSelection}>
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {images.map((image) => {
              const { stem, ext } = splitAttachmentFileName(image.name)
              return (
                <div className="composer-attachment" key={image.id} title={image.name}>
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                  <span className="composer-attachment__name">
                    <ImageIcon size={12} />
                    <span className="composer-attachment__stem">{stem}</span>
                    {ext ? <span className="composer-attachment__ext">{ext}</span> : null}
                  </span>
                  <button type="button" aria-label={t('composer.removeAttachment', { name: image.name })} onClick={() => imageAttachments.remove(image.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
            {unsupportedFiles.map((file) => {
              const { stem, ext } = splitAttachmentFileName(file.name)
              return (
                <div className="composer-attachment" key={file.id} title={file.name}>
                  <span className="composer-attachment__name">
                    <Paperclip size={12} />
                    <span className="composer-attachment__stem">{stem}</span>
                    {ext ? <span className="composer-attachment__ext">{ext}</span> : null}
                  </span>
                  <button type="button" aria-label={t('composer.removeAttachment', { name: file.name })} onClick={() => imageAttachments.remove(file.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {attachmentError ? (
          <p className="composer-attachment-error" role="alert">
            {attachmentError}
          </p>
        ) : null}
        {persistDropped > 0 ? (
          <p className="composer-attachment-error" role="alert">
            {t('composer.attachments.persistDropped', { count: persistDropped })}
          </p>
        ) : null}
        <p id={imageStatusId} className="sr-only" role="status" aria-live="polite">
          {imageAttachments.dragging
            ? t('composer.dropFilesStatus')
            : processingImages
              ? t('composer.addingFiles')
              : images.length + unsupportedFiles.length
                ? t('composer.filesAttached', { count: images.length + unsupportedFiles.length })
                : ''}
        </p>
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton
              className="composer-add"
              label={t('composer.menu.add')}
              data-composer-menu-trigger
              aria-expanded={menu === 'add'}
              aria-controls={menu === 'add' ? menuId : undefined}
              onClick={() => {
                setMenu((current) => (current === 'add' ? null : 'add'))
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            >
              <Plus size={17} />
            </IconButton>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              tabIndex={-1}
              aria-label={t('composer.chooseFiles')}
              aria-describedby={imageStatusId}
              disabled={disabled || loading || submitting}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                void imageAttachments.ingest(files)
              }}
            />
            <ModelPicker value={model} modelsByProvider={modelsByProvider} providers={providers} onChange={onModelChange} presets={presets} onSwitchPreset={onSwitchPreset} onSavePreset={onSavePreset} />
            <ExecutingModelChip executingModel={executingModel} />
            <EffortPicker value={effort} levels={reasoningLevels} resolvedAutoEffort={resolvedAutoEffort} onChange={onEffortChange} />
            {fastSupported ? (
              <button
                type="button"
                className={`fast-mode-toggle ${fast ? 'is-active' : ''}`}
                aria-pressed={fast}
                disabled={!fastAvailable}
                title={fastAvailable ? t('composer.fastTitle', { name: agentName }) : t('composer.fastUnavailable', { name: agentName })}
                onClick={() => onFastChange(!fast)}
              >
                <Zap size={12} fill={fast ? 'currentColor' : 'none'} /> <span className="fast-mode-toggle__label">{t('composer.fast')}</span>
              </button>
            ) : null}
            {usageLimit && usageLimitTitle ? (
              <span className="usage-limit-badge" title={usageLimitTitle} role="status">
                <Hourglass size={11} /> {t(usageLimit.stage === 'low_priority' ? 'composer.usageLowPriority' : 'composer.usageWrapUp')}
              </span>
            ) : null}
            {projects && onAddProjectFolder ? (
              <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelectProject={onSelectProject} onAddFolder={onAddProjectFolder} />
            ) : null}
            {checkoutCatalog && onExecuteCheckout && (checkoutCatalog.checkouts.length > 0 || (checkoutCatalog.strategy ?? 'worktree') === 'branch') ? (
              <CheckoutPicker catalog={checkoutCatalog} fallbackLabel={checkoutLabel} loading={checkoutsLoading} onExecute={onExecuteCheckout} />
            ) : null}
            <div className="approval-mode" ref={approvalMenuRef}>
              <button
                type="button"
                className={`approval-mode-toggle ${approvalMeta.yolo ? 'is-yolo' : ''}`}
                aria-label={approvalTitle}
                title={approvalTitle}
                aria-haspopup="menu"
                aria-expanded={approvalMenuOpen}
                onClick={() => setApprovalMenuOpen((open) => !open)}
              >
                <ApprovalIcon size={12} /> <span className="approval-mode-toggle__label">{t(approvalMeta.labelKey)}</span>
              </button>
              {approvalMenuOpen ? (
                <div className="approval-mode__menu" role="menu" aria-label={t('composer.approval.menu')}>
                  {(Object.keys(approvalModeMeta) as OmpApprovalMode[]).map((mode) => {
                    const meta = approvalModeMeta[mode]
                    const ModeIcon = meta.icon
                    return (
                      <button
                        type="button"
                        key={mode}
                        role="menuitemradio"
                        aria-checked={mode === approvalMode}
                        className={`approval-mode__option ${mode === approvalMode ? 'is-active' : ''}`}
                        onClick={() => {
                          setApprovalMenuOpen(false)
                          onApprovalModeChange?.(mode)
                        }}
                      >
                        <ModeIcon size={13} />
                        <span>{t(meta.labelKey)}</span>
                        {mode === approvalMode ? <Check size={13} className="approval-mode__check" /> : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
          <div className="composer__actions">
            {dictation.state === 'connecting' || dictation.state === 'recording' ? (
              <button
                type="button"
                className="context-usage-dial context-usage-dial--cancel"
                aria-label={t('composer.cancelDictation')}
                title={t('composer.cancelDictation')}
                onClick={dictation.cancel}
              >
                <X size={14} />
              </button>
            ) : (
              <div className="composer-context" ref={contextMenuRef}>
                <button
                  type="button"
                  className={`context-usage-dial ${contextPercent === null ? 'is-unavailable' : contextPercent >= 95 ? 'is-critical' : contextPercent >= 80 ? 'is-warning' : ''}`}
                  aria-label={t('composer.contextUsage')}
                  aria-haspopup="dialog"
                  aria-expanded={contextMenuOpen}
                  title={contextLabel}
                  data-tooltip={contextLabel}
                  style={contextStyle}
                  onClick={() => setContextMenuOpen((open) => !open)}
                >
                  <span>{contextDisplayPercent ?? '—'}</span>
                </button>
                {contextMenuOpen ? (
                  <div className="context-popover" role="dialog" aria-label={t('composer.contextUsage')}>
                    {contextUsage && contextUsage.tokens !== null ? (
                      <dl>
                        <div>
                          <dt>{t('composer.context.tokens')}</dt>
                          <dd>{contextUsage.tokens.toLocaleString('en-US')} / {contextUsage.contextWindow.toLocaleString('en-US')}</dd>
                        </div>
                        {sessionCost && sessionCost !== PRICING_UNAVAILABLE ? (
                          <div>
                            <dt>{t('composer.context.cost')}</dt>
                            <dd>{sessionCost}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>{t('composer.context.ttft')}</dt>
                          <dd>{turnMetrics.ttftMs === null ? '—' : `${(turnMetrics.ttftMs / 1000).toFixed(2)}s`}</dd>
                        </div>
                        <div>
                          <dt>{t('composer.context.tps')}</dt>
                          <dd>{outputTokensPerSecond === null ? '—' : `${outputTokensPerSecond.toFixed(1)} tok/s`}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="context-popover__empty">{t('composer.context.unavailable')}</p>
                    )}
                    <button
                      type="button"
                      className="context-popover__compact"
                      disabled={busy || submitting || disabled}
                      onClick={() => {
                        setContextMenuOpen(false)
                        void onSend('/compact', [], 'queue')
                      }}
                    >
                      {t('composer.context.compact')}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
            <button
              type="button"
              className={`dictation-button ${dictation.state === 'recording' ? 'is-recording' : ''}`}
              aria-label={
                dictation.state === 'recording'
                  ? t('composer.dictation.stop')
                  : dictation.state === 'connecting'
                    ? t('composer.dictation.connecting')
                    : dictation.state === 'transcribing'
                      ? t('composer.dictation.transcribing')
                      : t('composer.dictation.start')
              }
              disabled={!voice || loading || disabled || submitting || dictation.state === 'connecting' || dictation.state === 'transcribing'}
              onClick={() => {
                if (dictation.state === 'recording') void finishDictation(false)
                else void dictation.start()
              }}
            >
              {dictation.state === 'recording' ? (
                <>
                  <span className="dictation-waveform" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <Square size={10} fill="currentColor" />
                </>
              ) : dictation.state === 'connecting' || dictation.state === 'transcribing' ? (
                <LoaderCircle className="is-spinning" size={15} />
              ) : (
                <Mic size={15} />
              )}
            </button>
            {dictation.state === 'recording' ? (
              <button type="button" className="send-button" aria-label={t('composer.transcribeAndSend')} onClick={() => void finishDictation(true)}>
                <ArrowUp size={17} />
              </button>
            ) : busy ? (
              value.trim() || images.length > 0 || unsupportedFiles.length > 0 || annotations.length > 0 || terminalSelection?.text ? (
                // Typing while the model works flips the action surface to a
                // queue-send in the same style as the idle send button; it
                // stands in for the stop control until the draft empties.
                <button
                  type="button"
                  className="send-button"
                  aria-label={t('composer.send')}
                  title={messageEnterAction === 'queue' ? t('composer.send.queued') : t('composer.send.steer')}
                  disabled={processingImages || submitting || loading || disabled}
                  onClick={() => void submit()}
                >
                  <ArrowUp size={17} />
                </button>
              ) : (
                <button type="button" className="send-button send-button--stop" aria-label={t('composer.stop')} onClick={() => void onStop()}>
                  <Square size={10} fill="currentColor" aria-hidden="true" />
                </button>
              )
            ) : retryStoppedTurn && !value.trim() && images.length === 0 && unsupportedFiles.length === 0 && annotations.length === 0 && !terminalSelection?.text ? (
              // A user stop leaves the turn recoverable: the empty composer
              // shows a retry affordance in the send slot — the same
              // always-available shape the stop button uses while streaming.
              <button type="button" className="send-button send-button--retry" aria-label={t('composer.retry')} title={t('composer.retry')} onClick={() => onRetryStoppedTurn?.()}>
                <RotateCcw size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                aria-label={t('composer.send')}
                disabled={
                  (!value.trim() && images.length === 0 && unsupportedFiles.length === 0 && annotations.length === 0 && !terminalSelection?.text) ||
                  processingImages ||
                  submitting ||
                  loading ||
                  disabled
                }
                onClick={() => void submit()}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-note">{t('composer.note', { name: shortName })}</p>
    </div>
  )
})
