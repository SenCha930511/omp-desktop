import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FolderKanban,
  Gauge,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat2,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, Modal, Segmented } from '@/components/ui'
import { formatRelative } from '@/lib/data'
import { errorMessage } from '@/lib/errors'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { type MessageKey, useI18n } from '@/lib/i18n'
import type {
  AutomationScheduleRecord,
  HarnessId,
  PrimeModelDescriptor,
  PrimeThinkingLevel,
  ProjectRecord,
  ScheduleExecution,
  ScheduleInput,
  SchedulePatch,
  SchedulePreview,
  ScheduleRunRecord,
  ScheduleTarget,
  ScheduleTiming,
  SessionRecord,
} from '@/types/api'
import { PRIME_THINKING_LEVELS } from '@/types/api'

type ScheduleFilter = 'active' | 'paused' | 'attention' | 'all'
type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced'
type EditorMode = 'create' | 'edit'

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string
type ScheduleForm = {
  title: string
  prompt: string
  targetKind: 'project' | 'session'
  projectId: string
  sessionId: string
  timingKind: 'once' | 'recurring'
  date: string
  time: string
  timeZone: string
  frequency: Frequency
  interval: string
  weekdays: string[]
  advancedRrule: string
  model: string
  thinking: 'auto' | PrimeThinkingLevel
  fast: boolean
}

interface ScheduledPageProps {
  harness: HarnessId
  schedules: AutomationScheduleRecord[]
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  models: PrimeModelDescriptor[]
  lastSelectedModel: string
  error?: string
  initialProjectId?: string
  initialSessionId?: string
  selectedScheduleId?: string | null
  onCreate(input: ScheduleInput): Promise<void>
  onUpdate(id: string, patch: SchedulePatch): Promise<void>
  onPause(id: string): Promise<void>
  onResume(id: string): Promise<void>
  onDelete(id: string): Promise<void>
  onRunNow(id: string): Promise<void>
  onPreview(timing: ScheduleTiming): Promise<SchedulePreview>
  onOpenSession(sessionFile: string): void
}

const DEVICE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const WEEKDAYS = [
  { value: 'MO', label: 'scheduled.weekdayShort.monday', long: 'scheduled.weekday.monday' },
  { value: 'TU', label: 'scheduled.weekdayShort.tuesday', long: 'scheduled.weekday.tuesday' },
  { value: 'WE', label: 'scheduled.weekdayShort.wednesday', long: 'scheduled.weekday.wednesday' },
  { value: 'TH', label: 'scheduled.weekdayShort.thursday', long: 'scheduled.weekday.thursday' },
  { value: 'FR', label: 'scheduled.weekdayShort.friday', long: 'scheduled.weekday.friday' },
  { value: 'SA', label: 'scheduled.weekdayShort.saturday', long: 'scheduled.weekday.saturday' },
  { value: 'SU', label: 'scheduled.weekdayShort.sunday', long: 'scheduled.weekday.sunday' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey; long: MessageKey }>
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const THINKING_LEVELS: readonly PrimeThinkingLevel[] = PRIME_THINKING_LEVELS
const FREQUENCIES: Array<{ value: Frequency; label: MessageKey }> = [
  { value: 'hourly', label: 'scheduled.frequency.hourly' },
  { value: 'daily', label: 'scheduled.frequency.daily' },
  { value: 'weekly', label: 'scheduled.frequency.weekly' },
  { value: 'monthly', label: 'scheduled.frequency.monthly' },
  { value: 'advanced', label: 'scheduled.frequency.advanced' },
]

const pad = (value: number) => String(value).padStart(2, '0')

function localParts(value: Date) {
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  }
}

function defaultStart() {
  const value = new Date(Date.now() + 60 * 60 * 1000)
  value.setMinutes(0, 0, 0)
  return localParts(value)
}

function isAuthorized(project: ProjectRecord) {
  return !project.inferred
}

function projectForSession(session: SessionRecord, projects: ProjectRecord[]) {
  return projects.find((project) => sessionBelongsToProject(session, project))
}

function sessionBelongsToProject(session: SessionRecord, project: ProjectRecord) {
  return session.projectPath === project.path || project.folders.includes(session.projectPath)
}

function defaultScheduleModel(models: PrimeModelDescriptor[], lastSelectedModel: string): string {
  return models.find((model) => model.key === lastSelectedModel && model.available)?.key ?? models.find((model) => model.available)?.key ?? ''
}

function defaultForm(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  models: PrimeModelDescriptor[],
  lastSelectedModel: string,
  initialProjectId?: string,
  initialSessionId?: string,
): ScheduleForm {
  const authorizedProjects = projects.filter(isAuthorized)
  const initialSession = sessions.find((session) => session.id === initialSessionId && !session.archived)
  const sessionProject = initialSession ? projectForSession(initialSession, authorizedProjects) : undefined
  const selectedProject = sessionProject ?? authorizedProjects.find((project) => project.id === initialProjectId) ?? authorizedProjects[0]
  const start = defaultStart()
  return {
    title: '',
    prompt: '',
    targetKind: initialSession && sessionProject ? 'session' : 'project',
    projectId: selectedProject?.id ?? '',
    sessionId: initialSession && sessionProject ? initialSession.id : '',
    timingKind: 'recurring',
    date: start.date,
    time: start.time,
    timeZone: DEVICE_TIME_ZONE,
    frequency: 'daily',
    interval: '1',
    weekdays: [DAY_CODES[new Date().getDay()]],
    advancedRrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    model: defaultScheduleModel(models, lastSelectedModel),
    thinking: 'auto',
    fast: false,
  }
}

function rruleParts(rrule: string) {
  return new Map(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((part) => {
        const [key, ...value] = part.split('=')
        return [key.toUpperCase(), value.join('=')]
      }),
  )
}

function formFromSchedule(item: AutomationScheduleRecord, models: PrimeModelDescriptor[], lastSelectedModel: string): ScheduleForm {
  const start = item.timing.kind === 'once' ? localParts(new Date(item.timing.at)) : { date: item.timing.dtstartLocal.slice(0, 10), time: item.timing.dtstartLocal.slice(11, 16) }
  const parts = item.timing.kind === 'rrule' ? rruleParts(item.timing.rrule) : new Map<string, string>()
  const rawFrequency = parts.get('FREQ')?.toLowerCase()
  const frequency = rawFrequency === 'hourly' || rawFrequency === 'daily' || rawFrequency === 'weekly' || rawFrequency === 'monthly' ? rawFrequency : 'advanced'
  return {
    title: item.title,
    prompt: item.prompt,
    targetKind: item.target.kind,
    projectId: item.target.projectId,
    sessionId: item.target.kind === 'session' ? item.target.sessionId : '',
    timingKind: item.timing.kind === 'once' ? 'once' : 'recurring',
    date: start.date,
    time: start.time,
    timeZone: item.timing.kind === 'rrule' ? item.timing.timeZone : DEVICE_TIME_ZONE,
    frequency,
    interval: parts.get('INTERVAL') ?? '1',
    weekdays: parts.get('BYDAY')?.split(',').filter(Boolean) ?? [DAY_CODES[new Date().getDay()]],
    advancedRrule: item.timing.kind === 'rrule' ? item.timing.rrule : 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    model: item.execution.model === 'auto' ? defaultScheduleModel(models, lastSelectedModel) : item.execution.model,
    thinking: item.execution.thinking,
    fast: item.execution.speed === 'fast',
  }
}

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).format()
    return true
  } catch {
    return false
  }
}

function timingFromForm(form: ScheduleForm): ScheduleTiming | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !/^\d{2}:\d{2}$/.test(form.time)) return null
  if (form.timingKind === 'once') {
    const at = new Date(`${form.date}T${form.time}:00`)
    return Number.isNaN(at.getTime()) ? null : { kind: 'once', at: at.toISOString() }
  }
  if (!validTimeZone(form.timeZone.trim())) return null
  let rrule = form.advancedRrule.trim().replace(/^RRULE:/i, '')
  if (form.frequency !== 'advanced') {
    const interval = Math.max(1, Number.parseInt(form.interval, 10) || 1)
    rrule = `FREQ=${form.frequency.toUpperCase()};INTERVAL=${interval}`
    if (form.frequency === 'weekly') {
      if (!form.weekdays.length) return null
      rrule += `;BYDAY=${form.weekdays.join(',')}`
    }
  }
  if (!/(^|;)FREQ=[A-Z]+/i.test(rrule)) return null
  return {
    kind: 'rrule',
    dtstartLocal: `${form.date}T${form.time}:00`,
    timeZone: form.timeZone.trim(),
    rrule,
  }
}

function targetFromForm(form: ScheduleForm): ScheduleTarget {
  return form.targetKind === 'session' ? { kind: 'session', projectId: form.projectId, sessionId: form.sessionId } : { kind: 'project', projectId: form.projectId }
}

function executionFromForm(form: ScheduleForm): ScheduleExecution {
  return { model: form.model, thinking: form.thinking, speed: form.fast ? 'fast' : 'normal' }
}

function formatDateTime(t: Translator, value?: string) {
  if (!value) return t('scheduled.notScheduled')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatRunDate(t: Translator, value?: string) {
  if (!value) return t('scheduled.pending')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date)
}

function timingLabel(t: Translator, timing: ScheduleTiming) {
  if (timing.kind === 'once') return t('scheduled.timingOnce', { time: formatDateTime(t, timing.at) })
  const parts = rruleParts(timing.rrule)
  const frequency = parts.get('FREQ')?.toLowerCase()
  const interval = Number(parts.get('INTERVAL') ?? '1')
  const unit = t(
    frequency === 'daily'
      ? 'scheduled.unit.day'
      : frequency === 'weekly'
        ? 'scheduled.unit.week'
        : frequency === 'monthly'
          ? 'scheduled.unit.month'
          : frequency === 'hourly'
            ? 'scheduled.unit.hour'
            : 'scheduled.unit.cycle',
  )
  const cadence = interval > 1 ? t('scheduled.everyInterval', { interval, unit }) : t('scheduled.everyUnit', { unit })
  const days = parts.get('BYDAY')
  const values = { cadence, time: timing.dtstartLocal.slice(11, 16), timeZone: timing.timeZone }
  return days ? t('scheduled.timingRecurringDays', { ...values, days }) : t('scheduled.timingRecurring', values)
}

function needsAttention(item: AutomationScheduleRecord) {
  const latest = item.runs.at(-1)
  return item.status === 'blocked' || latest?.status === 'failed' || latest?.status === 'interrupted'
}

function statusLabel(t: Translator, item: AutomationScheduleRecord) {
  return needsAttention(item) ? t('scheduled.needsAttention') : item.status
}

function statusIcon(item: AutomationScheduleRecord, size = 16) {
  if (needsAttention(item)) return <AlertTriangle size={size} />
  if (item.status === 'paused') return <Pause size={size} />
  if (item.status === 'completed') return <Check size={size} />
  return <RotateCw size={size} />
}

function runIcon(status: ScheduleRunRecord['status']) {
  if (status === 'failed' || status === 'interrupted') return <AlertTriangle size={14} />
  if (status === 'succeeded') return <CheckCircle2 size={14} />
  if (status === 'running') return <RotateCw size={14} />
  if (status === 'queued') return <Clock3 size={14} />
  return <CircleDot size={14} />
}

export function ScheduledPage({
  harness,
  schedules,
  projects,
  sessions,
  models,
  lastSelectedModel,
  error,
  initialProjectId,
  initialSessionId,
  selectedScheduleId,
  onCreate,
  onUpdate,
  onPause,
  onResume,
  onDelete,
  onRunNow,
  onPreview,
  onOpenSession,
}: ScheduledPageProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<ScheduleFilter>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: EditorMode; scheduleId?: string } | null>(null)
  const [form, setForm] = useState<ScheduleForm>(() => defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId))
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const previewRequest = useRef(0)

  const authorizedProjects = useMemo(() => projects.filter(isAuthorized), [projects])
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const sessionMap = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const selected = schedules.find((item) => item.id === selectedId) ?? null
  useEffect(() => {
    if (selectedScheduleId && schedules.some((item) => item.id === selectedScheduleId)) setSelectedId(selectedScheduleId)
  }, [schedules, selectedScheduleId])
  const editingSchedule = editor?.mode === 'edit' ? schedules.find((item) => item.id === editor.scheduleId) : undefined
  const selectedProject = projectMap.get(form.projectId)
  const eligibleSessions = useMemo(() => {
    const project = projects.find((item) => item.id === form.projectId)
    return project ? sessions.filter((session) => sessionBelongsToProject(session, project) && !session.archived) : []
  }, [form.projectId, projects, sessions])
  const selectedModel = models.find((model) => model.key === form.model)
  const availableModels = models.filter((model) => model.available)
  const currentTiming = useMemo(() => timingFromForm(form), [form.timingKind, form.date, form.time, form.timeZone, form.frequency, form.interval, form.weekdays, form.advancedRrule])
  const visible = schedules.filter((item) => filter === 'all' || (filter === 'attention' ? needsAttention(item) : item.status === filter))
  const counts = schedules.reduce(
    (result, item) => {
      if (item.status === 'active') result.active += 1
      if (item.status === 'paused') result.paused += 1
      if (needsAttention(item)) result.attention += 1
      return result
    },
    { active: 0, paused: 0, attention: 0 },
  )

  useEffect(() => {
    if (!editor || !currentTiming) {
      setPreview(null)
      setPreviewError('')
      setPreviewing(false)
      return
    }
    const request = ++previewRequest.current
    setPreviewing(true)
    setPreviewError('')
    const timer = window.setTimeout(() => {
      void onPreview(currentTiming)
        .then((result) => {
          if (previewRequest.current === request) {
            setPreview(result)
            setPreviewing(false)
          }
        })
        .catch((reason) => {
          if (previewRequest.current === request) {
            setPreview(null)
            setPreviewError(errorMessage(reason))
            setPreviewing(false)
          }
        })
    }, 350)
    return () => {
      // Invalidate any in-flight preview so it cannot repopulate state after
      // the editor resets, the timing changes, or the page unmounts.
      previewRequest.current += 1
      window.clearTimeout(timer)
    }
  }, [currentTiming, editor, onPreview])

  const openCreate = () => {
    const next = defaultForm(projects, sessions, models, lastSelectedModel, initialProjectId, initialSessionId)
    setForm(next)
    setBaseline(JSON.stringify(next))
    setFormError('')
    setPreview(null)
    setEditor({ mode: 'create' })
  }
  const openEdit = (item: AutomationScheduleRecord) => {
    const next = formFromSchedule(item, models, lastSelectedModel)
    setForm(next)
    setBaseline(JSON.stringify(next))
    setFormError('')
    setPreview(null)
    setEditor({ mode: 'edit', scheduleId: item.id })
  }
  const closeEditor = () => {
    if (saving) return
    if (JSON.stringify(form) !== baseline && !window.confirm(t('scheduled.confirmDiscard'))) return
    setEditor(null)
    setFormError('')
  }
  const setProject = (projectId: string) => {
    const project = projectMap.get(projectId)
    const firstSession = project ? sessions.find((session) => sessionBelongsToProject(session, project) && !session.archived) : undefined
    setForm((current) => ({ ...current, projectId, sessionId: firstSession?.id ?? '' }))
  }
  const selectModel = (modelKey: string) => {
    const model = models.find((item) => item.key === modelKey)
    setForm((current) => ({
      ...current,
      model: modelKey,
      thinking: model && current.thinking !== 'auto' && !model.availableThinkingLevels.includes(current.thinking) ? 'auto' : current.thinking,
      fast: model && !model.fastModeSupported ? false : current.fast,
    }))
  }
  const validate = () => {
    if (!form.title.trim()) return t('scheduled.errorTitle')
    if (!form.prompt.trim()) return t('scheduled.errorPrompt', { harness: HARNESS_SHORT_NAMES[harness] })
    if (!form.model || !availableModels.some((model) => model.key === form.model)) return t('scheduled.errorModel')
    if (!form.projectId || !authorizedProjects.some((project) => project.id === form.projectId)) return t('scheduled.errorProject')
    if (form.targetKind === 'session' && !eligibleSessions.some((session) => session.id === form.sessionId)) return t('scheduled.errorSession')
    if (!currentTiming) {
      if (form.timingKind === 'recurring' && !validTimeZone(form.timeZone.trim())) return t('scheduled.errorTimezone')
      if (form.frequency === 'weekly' && !form.weekdays.length) return t('scheduled.errorWeekday')
      return form.frequency === 'advanced' ? t('scheduled.errorRrule') : t('scheduled.errorDateTime')
    }
    return ''
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const validationError = validate()
    if (validationError || !currentTiming) {
      setFormError(validationError)
      return
    }
    setSaving(true)
    setFormError('')
    const values = {
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      target: targetFromForm(form),
      timing: currentTiming,
      execution: executionFromForm(form),
    }
    try {
      if (editor?.mode === 'edit' && editingSchedule) await onUpdate(editingSchedule.id, { revision: editingSchedule.revision, ...values })
      else await onCreate(values)
      setEditor(null)
    } catch (reason) {
      setFormError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }
  const perform = async (key: string, work: () => Promise<void>, success: string, after?: () => void) => {
    if (action) return
    setAction(key)
    setActionError('')
    setActionNotice('')
    try {
      await work()
      setActionNotice(success)
      after?.()
    } catch (reason) {
      setActionError(errorMessage(reason))
    } finally {
      setAction(null)
    }
  }
  const deleteSchedule = (item: AutomationScheduleRecord) => {
    if (!window.confirm(t('scheduled.confirmDelete', { name: item.title }))) return
    void perform(
      `delete:${item.id}`,
      () => onDelete(item.id),
      t('scheduled.noticeDeleted'),
      () => setSelectedId(null),
    )
  }

  const editorModal = editor ? (
    <Modal
      title={editor.mode === 'create' ? t('scheduled.createSchedule') : t('scheduled.editSchedule')}
      onClose={closeEditor}
      footer={
        <>
          <span className="schedule-editor__save-status" aria-live="polite">
            {saving ? t('scheduled.savingDraft') : ''}
          </span>
          <button type="button" className="button" disabled={saving} onClick={closeEditor}>
            {t('scheduled.cancel')}
          </button>
          <button type="submit" form="schedule-editor-form" className="button button--primary" disabled={saving}>
            {saving ? t('scheduled.saving') : editor.mode === 'create' ? t('scheduled.createSchedule') : t('scheduled.saveChanges')}
          </button>
        </>
      }
    >
      <form id="schedule-editor-form" className="schedule-editor" onSubmit={(event) => void save(event)}>
        <div className="schedule-editor__lead">
          <Sparkles size={15} />
          <p>{t('scheduled.editorLead', { harness: HARNESS_SHORT_NAMES[harness] })}</p>
        </div>
        <div className="schedule-editor__copy">
          <label className="field">
            <span>{t('scheduled.fieldTitle')}</span>
            <input
              autoFocus
              required
              value={form.title}
              disabled={saving}
              placeholder={t('scheduled.titlePlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t('scheduled.fieldPrompt')}</span>
            <textarea
              required
              rows={4}
              value={form.prompt}
              disabled={saving}
              placeholder={t('scheduled.promptPlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
            />
          </label>
        </div>
        <div className="schedule-editor__grid">
          <fieldset className="schedule-fieldset">
            <legend>
              <FolderKanban size={14} /> {t('scheduled.destination')}
            </legend>
            <div className="schedule-radio-grid">
              <label className={form.targetKind === 'project' ? 'is-selected' : ''}>
                <input type="radio" name="target" checked={form.targetKind === 'project'} onChange={() => setForm((current) => ({ ...current, targetKind: 'project' }))} />
                <span>
                  <strong>{t('scheduled.newSession')}</strong>
                  <small>{t('scheduled.newSessionDetail')}</small>
                </span>
              </label>
              <label className={form.targetKind === 'session' ? 'is-selected' : ''}>
                <input type="radio" name="target" checked={form.targetKind === 'session'} onChange={() => setForm((current) => ({ ...current, targetKind: 'session' }))} />
                <span>
                  <strong>{t('scheduled.existingSession')}</strong>
                  <small>{t('scheduled.existingSessionDetail')}</small>
                </span>
              </label>
            </div>
            <label className="field">
              <span>{t('scheduled.authorizedProject')}</span>
              <select value={form.projectId} disabled={saving || !authorizedProjects.length} onChange={(event) => setProject(event.target.value)}>
                <option value="">{t('scheduled.chooseProject')}</option>
                {authorizedProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {form.targetKind === 'session' ? (
              <label className="field">
                <span>{t('scheduled.fieldSession')}</span>
                <select value={form.sessionId} disabled={saving || !eligibleSessions.length} onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}>
                  <option value="">{t('scheduled.chooseSession')}</option>
                  {eligibleSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!authorizedProjects.length ? (
              <p className="schedule-field-note schedule-field-note--warning">
                <AlertTriangle size={13} /> {t('scheduled.noProjectsNote')}
              </p>
            ) : (
              <p className="schedule-field-note">{selectedProject?.primaryFolder}</p>
            )}
          </fieldset>

          <fieldset className="schedule-fieldset">
            <legend>
              <CalendarClock size={14} /> {t('scheduled.timing')}
            </legend>
            <div className="schedule-radio-grid schedule-radio-grid--timing">
              <label className={form.timingKind === 'once' ? 'is-selected' : ''}>
                <input type="radio" name="timing" checked={form.timingKind === 'once'} onChange={() => setForm((current) => ({ ...current, timingKind: 'once' }))} />
                <span>
                  <strong>{t('scheduled.once')}</strong>
                  <small>{t('scheduled.onceDetail')}</small>
                </span>
              </label>
              <label className={form.timingKind === 'recurring' ? 'is-selected' : ''}>
                <input type="radio" name="timing" checked={form.timingKind === 'recurring'} onChange={() => setForm((current) => ({ ...current, timingKind: 'recurring' }))} />
                <span>
                  <strong>{t('scheduled.recurring')}</strong>
                  <small>{t('scheduled.recurringDetail')}</small>
                </span>
              </label>
            </div>
            {form.timingKind === 'recurring' ? (
              <>
                <div className="schedule-frequency" role="group" aria-label={t('scheduled.frequencyLabel')}>
                  {FREQUENCIES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={form.frequency === option.value ? 'is-active' : ''}
                      aria-pressed={form.frequency === option.value}
                      onClick={() => setForm((current) => ({ ...current, frequency: option.value }))}
                    >
                      {t(option.label)}
                    </button>
                  ))}
                </div>
                {form.frequency !== 'advanced' ? (
                  <div className="schedule-inline-fields">
                    <label className="field">
                      <span>{t('scheduled.every')}</span>
                      <input type="number" min="1" max="999" value={form.interval} onChange={(event) => setForm((current) => ({ ...current, interval: event.target.value }))} />
                    </label>
                    <span>
                      {t(
                        form.frequency === 'hourly'
                          ? 'scheduled.intervalHour'
                          : form.frequency === 'daily'
                            ? 'scheduled.intervalDay'
                            : form.frequency === 'weekly'
                              ? 'scheduled.intervalWeek'
                              : 'scheduled.intervalMonth',
                      )}
                    </span>
                  </div>
                ) : (
                  <label className="field">
                    <span>RRULE</span>
                    <textarea
                      className="schedule-rrule"
                      rows={3}
                      spellCheck={false}
                      value={form.advancedRrule}
                      placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                      onChange={(event) => setForm((current) => ({ ...current, advancedRrule: event.target.value }))}
                    />
                  </label>
                )}
                {form.frequency === 'weekly' ? (
                  <fieldset className="weekday-fieldset">
                    <legend>{t('scheduled.onDays')}</legend>
                    <div className="weekday-chips">
                      {WEEKDAYS.map((day) => {
                        const active = form.weekdays.includes(day.value)
                        return (
                          <label key={day.value} className={active ? 'is-active' : ''} title={t(day.long)}>
                            <input
                              type="checkbox"
                              checked={active}
                              onChange={() => setForm((current) => ({ ...current, weekdays: active ? current.weekdays.filter((value) => value !== day.value) : [...current.weekdays, day.value] }))}
                            />
                            <span>{t(day.label)}</span>
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                ) : null}
              </>
            ) : null}
            <div className="schedule-date-fields">
              <label className="field">
                <span>{form.timingKind === 'once' ? t('scheduled.fieldDate') : t('scheduled.fieldStarts')}</span>
                <input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} />
              </label>
              <label className="field">
                <span>{t('scheduled.localTime')}</span>
                <input type="time" value={form.time} onChange={(event) => setForm((current) => ({ ...current, time: event.target.value }))} />
              </label>
            </div>
            {form.timingKind === 'recurring' ? (
              <label className="field">
                <span>{t('scheduled.ianaTimezone')}</span>
                <input list="schedule-time-zones" value={form.timeZone} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} />
                <datalist id="schedule-time-zones">
                  <option value={DEVICE_TIME_ZONE} />
                  <option value="UTC" />
                  <option value="America/Los_Angeles" />
                  <option value="America/New_York" />
                  <option value="Europe/London" />
                  <option value="Asia/Tokyo" />
                </datalist>
              </label>
            ) : (
              <p className="schedule-field-note">{t('scheduled.deviceTimezone', { timezone: DEVICE_TIME_ZONE })}</p>
            )}
          </fieldset>
        </div>

        <fieldset className="schedule-fieldset schedule-fieldset--execution">
          <legend>
            <Gauge size={14} /> {t('scheduled.execution')}
          </legend>
          <div className="schedule-execution-grid">
            <label className="field">
              <span>{t('scheduled.fieldModel')}</span>
              <select value={form.model} onChange={(event) => selectModel(event.target.value)}>
                {!form.model ? (
                  <option value="" disabled>
                    {t('scheduled.noModel')}
                  </option>
                ) : null}
                {form.model && !models.some((model) => model.key === form.model && model.available) ? (
                  <option value={form.model}>{t('scheduled.modelUnavailable', { model: form.model })}</option>
                ) : null}
                {availableModels.map((model) => (
                  <option key={model.key} value={model.key}>
                    {model.name} · {model.provider}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('scheduled.fieldReasoning')}</span>
              <select value={form.thinking} onChange={(event) => setForm((current) => ({ ...current, thinking: event.target.value as ScheduleForm['thinking'] }))}>
                <option value="auto">{t('scheduled.auto')}</option>
                {THINKING_LEVELS.filter((level) => !selectedModel || selectedModel.availableThinkingLevels.includes(level) || level === form.thinking).map((level) => (
                  <option key={level} value={level}>
                    {level === 'xhigh' ? t('scheduled.extraHigh') : level[0].toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className={`schedule-fast-toggle ${selectedModel && !selectedModel.fastModeSupported ? 'is-disabled' : ''}`}>
              <input
                type="checkbox"
                checked={form.fast}
                disabled={Boolean(selectedModel && !selectedModel.fastModeSupported)}
                onChange={(event) => setForm((current) => ({ ...current, fast: event.target.checked }))}
              />
              <span>
                <Play size={13} />
                <strong>{t('scheduled.fast')}</strong>
                <small>{selectedModel && !selectedModel.fastModeSupported ? t('scheduled.fastUnavailable') : t('scheduled.fastDetail')}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <section className="schedule-preview" aria-live="polite" aria-label={t('scheduled.previewLabel')}>
          <div>
            <span>
              <Clock3 size={14} /> {t('scheduled.nextOccurrences')}
            </span>
            {previewing ? <small>{t('scheduled.checkingServer')}</small> : null}
          </div>
          {previewError ? (
            <p className="schedule-preview__error">{t('scheduled.previewUnavailable', { error: previewError })}</p>
          ) : preview?.occurrences.length ? (
            <ol>
              {preview.occurrences.slice(0, 5).map((occurrence) => (
                <li key={occurrence}>
                  <i />
                  <span>{formatDateTime(t, occurrence)}</span>
                  <small>{formatRelative(occurrence)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p>{currentTiming ? t('scheduled.noOccurrences') : t('scheduled.completeTiming')}</p>
          )}
        </section>
        {formError ? (
          <p className="page-inline-error" role="alert">
            {formError}
          </p>
        ) : null}
      </form>
    </Modal>
  ) : null

  if (selected) {
    const project = projectMap.get(selected.target.projectId)
    const targetSession = selected.target.kind === 'session' ? sessionMap.get(selected.target.sessionId) : undefined
    const recentRuns = [...selected.runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 8)
    const busy = Boolean(action)
    return (
      <div className="page scroll-area">
        <div className="page-container schedule-page schedule-page--detail">
          <button
            type="button"
            className="schedule-back"
            onClick={() => {
              setSelectedId(null)
              setActionError('')
              setActionNotice('')
            }}
          >
            <ArrowLeft size={15} /> {t('scheduled.allSchedules')}
          </button>
          <header className="schedule-detail__header">
            <div className={`schedule-detail__mark schedule-detail__mark--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusIcon(selected, 18)}</div>
            <div>
              <span className={`schedule-state schedule-state--${needsAttention(selected) ? 'attention' : selected.status}`}>{statusLabel(t, selected)}</span>
              <h1>{selected.title}</h1>
              <p>{t('scheduled.revisionUpdated', { revision: selected.revision, time: formatRelative(selected.updatedAt) })}</p>
            </div>
          </header>
          <div className="schedule-detail__actions" aria-label={t('scheduled.actionsLabel')}>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || selected.status === 'completed'}
              onClick={() => void perform(`run:${selected.id}`, () => onRunNow(selected.id), t('scheduled.noticeRunQueued'))}
            >
              <Play size={13} />
              {action === `run:${selected.id}` ? t('scheduled.queuing') : t('scheduled.runNow')}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => openEdit(selected)}>
              <Pencil size={13} /> {t('scheduled.edit')}
            </button>
            {selected.status === 'active' || selected.status === 'blocked' ? (
              <button type="button" className="button" disabled={busy} onClick={() => void perform(`pause:${selected.id}`, () => onPause(selected.id), t('scheduled.noticePaused'))}>
                <Pause size={13} />
                {action === `pause:${selected.id}` ? t('scheduled.pausing') : t('scheduled.pause')}
              </button>
            ) : selected.status === 'paused' ? (
              <button type="button" className="button" disabled={busy} onClick={() => void perform(`resume:${selected.id}`, () => onResume(selected.id), t('scheduled.noticeResumed'))}>
                <RotateCw size={13} />
                {action === `resume:${selected.id}` ? t('scheduled.resuming') : t('scheduled.resume')}
              </button>
            ) : null}
            <button type="button" className="button schedule-delete" disabled={busy} onClick={() => deleteSchedule(selected)}>
              <Trash2 size={13} /> {t('scheduled.delete')}
            </button>
          </div>
          {error ? (
            <p className="page-inline-error" role="alert">
              {t('scheduled.catalogUnavailable', { error })}
            </p>
          ) : null}
          {actionError ? (
            <p className="page-inline-error" role="alert">
              {actionError}
            </p>
          ) : null}
          {actionNotice ? (
            <p className="schedule-action-notice" role="status">
              <CheckCircle2 size={14} />
              {actionNotice}
            </p>
          ) : null}
          {selected.blockedReason ? (
            <div className="schedule-blocked" role="status">
              <AlertTriangle size={16} />
              <div>
                <strong>{t('scheduled.needsAttentionTitle')}</strong>
                <p>{selected.blockedReason}</p>
              </div>
            </div>
          ) : null}

          <div className="schedule-detail__grid">
            <section className="schedule-detail__card schedule-detail__card--prompt">
              <span className="schedule-detail__eyebrow">{t('scheduled.instruction')}</span>
              <p>{selected.prompt}</p>
            </section>
            <section className="schedule-detail__card">
              <span className="schedule-detail__eyebrow">{t('scheduled.delivery')}</span>
              <dl>
                <div>
                  <dt>{t('scheduled.targetLabel')}</dt>
                  <dd>{targetSession?.title ?? project?.name ?? t('scheduled.unavailableTarget')}</dd>
                </div>
                <div>
                  <dt>{t('scheduled.mode')}</dt>
                  <dd>{selected.target.kind === 'session' ? t('scheduled.existingSession') : t('scheduled.newSession')}</dd>
                </div>
                <div>
                  <dt>{t('scheduled.createdBy')}</dt>
                  <dd>{selected.createdBy}</dd>
                </div>
              </dl>
            </section>
            <section className="schedule-detail__card">
              <span className="schedule-detail__eyebrow">{t('scheduled.cadence')}</span>
              <dl>
                <div>
                  <dt>{t('scheduled.timing')}</dt>
                  <dd>{timingLabel(t, selected.timing)}</dd>
                </div>
                <div>
                  <dt>{t('scheduled.nextRun')}</dt>
                  <dd>{selected.nextRunAt ? `${formatDateTime(t, selected.nextRunAt)} · ${formatRelative(selected.nextRunAt)}` : t('scheduled.noneScheduled')}</dd>
                </div>
                {selected.timing.kind === 'rrule' ? (
                  <div>
                    <dt>{t('scheduled.rule')}</dt>
                    <dd>
                      <code>{selected.timing.rrule}</code>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
            <section className="schedule-detail__card">
              <span className="schedule-detail__eyebrow">{t('scheduled.execution')}</span>
              <dl>
                <div>
                  <dt>{t('scheduled.fieldModel')}</dt>
                  <dd>{models.find((model) => model.key === selected.execution.model)?.name ?? selected.execution.model}</dd>
                </div>
                <div>
                  <dt>{t('scheduled.fieldReasoning')}</dt>
                  <dd>{selected.execution.thinking}</dd>
                </div>
                <div>
                  <dt>{t('scheduled.speed')}</dt>
                  <dd>{selected.execution.speed}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section className="schedule-history">
            <header>
              <div>
                <History size={15} />
                <h2>{t('scheduled.runHistory')}</h2>
              </div>
              <span>{t('scheduled.runsTotal', { count: selected.runs.length })}</span>
            </header>
            {recentRuns.length ? (
              <div className="schedule-history__list">
                {recentRuns.map((run) => {
                  const runSession = run.sessionId ? sessionMap.get(run.sessionId) : undefined
                  return (
                    <article key={run.id} className={`schedule-run schedule-run--${run.status}`}>
                      <div className="schedule-run__icon">{runIcon(run.status)}</div>
                      <div className="schedule-run__main">
                        <div>
                          <strong>{run.status}</strong>
                          <span>{run.trigger}</span>
                        </div>
                        <p>{run.error ?? t('scheduled.scheduledFor', { time: formatRunDate(t, run.scheduledFor) })}</p>
                      </div>
                      <time dateTime={run.queuedAt}>{formatRunDate(t, run.finishedAt ?? run.startedAt ?? run.queuedAt)}</time>
                      {run.sessionFile ? (
                        <button type="button" className="schedule-session-link" onClick={() => onOpenSession(run.sessionFile!)}>
                          {runSession ? t('scheduled.openSession', { name: runSession.title }) : t('scheduled.openSessionFallback')} <ChevronRight size={13} />
                        </button>
                      ) : (
                        <span className="schedule-run__no-session">{t('scheduled.noSession')}</span>
                      )}
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="schedule-history__empty">
                <History size={20} />
                <p>{t('scheduled.noRuns')}</p>
              </div>
            )}
          </section>
          {editorModal}
        </div>
      </div>
    )
  }

  return (
    <div className="page scroll-area">
      <div className="page-container schedule-page">
        <header className="page-header schedule-page__header">
          <div>
            <span className="schedule-page__kicker">
              <span /> {t('scheduled.kicker')}
            </span>
            <h1>{t('scheduled.title')}</h1>
            <p>{t('scheduled.subtitle', { harness: HARNESS_SHORT_NAMES[harness] })}</p>
          </div>
          <button type="button" className="button button--primary" onClick={openCreate}>
            <Plus size={14} /> {t('scheduled.newSchedule')}
          </button>
        </header>
        <div className="schedule-ledger-summary" aria-label={t('scheduled.summaryLabel')}>
          <span>
            <i className="is-active" /> <strong>{counts.active}</strong> {t('scheduled.active')}
          </span>
          <span>
            <i className="is-paused" /> <strong>{counts.paused}</strong> {t('scheduled.paused')}
          </span>
          <span>
            <i className="is-attention" /> <strong>{counts.attention}</strong> {t('scheduled.needAttention')}
          </span>
        </div>
        <div className="page-tools schedule-tools">
          <Segmented
            value={filter}
            label={t('scheduled.filterLabel')}
            onChange={(value) => setFilter(value as ScheduleFilter)}
            options={[
              { value: 'active', label: t('scheduled.filterActive') },
              { value: 'paused', label: t('scheduled.filterPaused') },
              { value: 'attention', label: t('scheduled.filterAttention') },
              { value: 'all', label: t('scheduled.filterAll') },
            ]}
          />
          <span>{t('scheduled.count', { count: visible.length })}</span>
        </div>
        {error ? (
          <p className="page-inline-error" role="alert">
            {t('scheduled.catalogUnavailable', { error })}
          </p>
        ) : null}
        {actionError ? (
          <p className="page-inline-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {visible.length ? (
          <div className="schedule-ledger">
            {visible.map((item) => {
              const project = projectMap.get(item.target.projectId)
              const targetSession = item.target.kind === 'session' ? sessionMap.get(item.target.sessionId) : undefined
              return (
                <button
                  type="button"
                  key={item.id}
                  className="schedule-row"
                  onClick={() => {
                    setSelectedId(item.id)
                    setActionError('')
                    setActionNotice('')
                  }}
                  aria-label={t('scheduled.openSchedule', { name: item.title })}
                >
                  <span className={`schedule-row__status schedule-row__status--${needsAttention(item) ? 'attention' : item.status}`}>{statusIcon(item)}</span>
                  <span className="schedule-row__main">
                    <span>
                      <strong>{item.title}</strong>
                      <i className={`schedule-state schedule-state--${needsAttention(item) ? 'attention' : item.status}`}>{statusLabel(t, item)}</i>
                    </span>
                    <small>{item.prompt}</small>
                    <span className="schedule-row__tags">
                      <span>
                        <FolderKanban size={11} />
                        {targetSession?.title ?? project?.name ?? t('scheduled.unavailableTarget')}
                      </span>
                      <span>
                        <Repeat2 size={11} />
                        {timingLabel(t, item.timing)}
                      </span>
                      <span>
                        <Gauge size={11} />
                        {models.find((model) => model.key === item.execution.model)?.name ?? item.execution.model}
                      </span>
                    </span>
                  </span>
                  <span className="schedule-row__next">
                    <small>{t('scheduled.next')}</small>
                    <strong>{item.nextRunAt ? formatDateTime(t, item.nextRunAt) : '—'}</strong>
                    <span>{item.nextRunAt ? formatRelative(item.nextRunAt) : t('scheduled.noFutureRun')}</span>
                  </span>
                  <ChevronRight className="schedule-row__chevron" size={16} />
                </button>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={<CalendarClock size={24} />}
            title={
              filter === 'all'
                ? t('scheduled.emptyTitle')
                : filter === 'attention'
                  ? t('scheduled.emptyAttentionTitle')
                  : t(filter === 'paused' ? 'scheduled.emptyPausedTitle' : 'scheduled.emptyActiveTitle')
            }
            action={
              schedules.length ? undefined : (
                <button type="button" className="button button--primary" onClick={openCreate}>
                  <Plus size={13} /> {t('scheduled.createSchedule')}
                </button>
              )
            }
          >
            {' '}
            {schedules.length ? t('scheduled.emptyFilteredBody') : t('scheduled.emptyBody', { harness: HARNESS_SHORT_NAMES[harness] })}
          </EmptyState>
        )}
        {editorModal}
      </div>
    </div>
  )
}
