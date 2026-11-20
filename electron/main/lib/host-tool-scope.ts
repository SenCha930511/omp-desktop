import type { HostToolScope } from '../agent-rpc/manager'

/**
 * Combines per-capability host tool scopes into the single scope one runtime is
 * advertised. Tool arrays concatenate and handler maps merge in argument order,
 * so each handler stays bound to the bridge that built it; a scope with no
 * tools means the runtime gets no host tools at all.
 */
export function mergeHostToolScopes(...scopes: Array<HostToolScope | undefined>): HostToolScope | undefined {
  const tools: HostToolScope['tools'] = []
  const handlers: HostToolScope['handlers'] = new Map()
  for (const scope of scopes) {
    if (!scope) continue
    tools.push(...scope.tools)
    for (const [name, handler] of scope.handlers) handlers.set(name, handler)
  }
  return tools.length === 0 ? undefined : { tools, handlers }
}
