import { createContext, type ReactNode, useContext, useMemo } from 'react'

export interface MarkdownWorkspaceValue {
  cwd?: string
  onOpenFile?: (path: string) => void
}

const MarkdownWorkspaceContext = createContext<MarkdownWorkspaceValue>({})

export function MarkdownWorkspaceProvider({
  cwd,
  onOpenFile,
  children,
}: MarkdownWorkspaceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ cwd, onOpenFile }), [cwd, onOpenFile])
  return <MarkdownWorkspaceContext.Provider value={value}>{children}</MarkdownWorkspaceContext.Provider>
}

export function useMarkdownWorkspace(): MarkdownWorkspaceValue {
  return useContext(MarkdownWorkspaceContext)
}

export function resolveWorkspaceFilePath(rawHref: string, cwd?: string): string {
  const trimmed = rawHref.trim()
  if (!trimmed || trimmed.startsWith('file://') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed
  }
  const clean = trimmed.split('#', 1)[0]?.split('?', 1)[0]?.replace(/^\.\//, '') ?? trimmed
  if (!cwd) return clean
  const sep = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\') ? '\\' : '/'
  const normalizedBase = cwd.replace(/[\\/]+$/, '')
  return `${normalizedBase}${sep}${clean}`
}
