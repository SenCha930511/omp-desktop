import type { AutomationScheduleRecord, HarnessId, ScheduleInput, SchedulePatch, ScheduleTarget } from '../../../src/types/api'
import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import { requireRecord, requireString } from '../validation'
import type { AutomationService } from './service'

interface AgentScheduleScope {
  projectId: string
  sessionId?: string
}

export interface AgentScheduleBridgeOptions {
  service: AutomationService
  harness: HarnessId
  skillPath: string
  resolveScope(input: { cwd: string; sessionPath?: string }): Promise<AgentScheduleScope>
}

function taskInScope(task: AutomationScheduleRecord, scope: AgentScheduleScope, harness: HarnessId): boolean {
  return task.harness === harness && task.target.projectId === scope.projectId && (task.target.kind === 'project' || task.target.sessionId === scope.sessionId)
}

export class AgentScheduleBridge extends CapabilityBridge {
  protected readonly rateLimit = 60
  protected readonly rateLimitError = 'Schedule API rate limit exceeded'

  constructor(private readonly options: AgentScheduleBridgeOptions) { super() }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      OMP_DESKTOP_SCHEDULE_URL: url,
      OMP_DESKTOP_SCHEDULE_TOKEN: token,
      OMP_DESKTOP_SCHEDULE_SKILL_PATH: this.options.skillPath,
    }
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    const scope = await this.options.resolveScope({ cwd: claim.cwd, sessionPath: claim.sessionPath })
    return this.call(method, params, scope)
  }

  private async call(method: string, params: Record<string, unknown>, scope: AgentScheduleScope): Promise<unknown> {
    if (method === 'list') return this.options.service.list(this.options.harness).filter((task) => taskInScope(task, scope, this.options.harness))
    if (method === 'create') {
      const raw = requireRecord(params.input, 'input')
      const targetName = requireString(params.target, 'target', { min: 1, max: 32, trim: true })
      let target: ScheduleTarget
      if (targetName === 'current_project') target = { kind: 'project', projectId: scope.projectId }
      else if (targetName === 'current_session' && scope.sessionId) target = { kind: 'session', projectId: scope.projectId, sessionId: scope.sessionId }
      else throw new TypeError('target must be current_project or an available current_session')
      const input: ScheduleInput = {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        prompt: raw.prompt as string,
        timing: raw.timing as ScheduleInput['timing'],
        execution: raw.execution as ScheduleInput['execution'],
        target,
      }
      return this.options.service.create(input, 'agent', this.options.harness)
    }
    const id = requireString(params.id, 'id', { min: 1, max: 256, trim: true })
    const task = this.options.service.get(id)
    if (!taskInScope(task, scope, this.options.harness)) throw new Error('Scheduled task is outside this agent capability')
    if (method === 'pause') return this.options.service.pause(id)
    if (method === 'resume') return this.options.service.resume(id)
    if (method === 'delete') return this.options.service.delete(id)
    if (method === 'run_now') return this.options.service.runNow(id)
    if (method === 'update') {
      const rawPatch = requireRecord(params.patch, 'patch')
      if (rawPatch.target !== undefined) throw new TypeError('Agents cannot retarget an existing scheduled task')
      const patch: SchedulePatch = { ...rawPatch, revision: task.revision }
      return this.options.service.update(id, patch)
    }
    throw new TypeError(`Unsupported schedule method ${method}`)
  }
}
