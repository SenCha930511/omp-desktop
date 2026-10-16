import { join, win32 } from 'node:path'

import type { HarnessId } from '../../src/types/api'
/**
 * Static description of the OMP harness: how its executable is discovered
 * and where its agent state lives on disk. Discovery itself stays in
 * process-utils (`harnessExecutableCandidates`/`findHarnessExecutable`) so
 * discovery follows the same absolute-path and X_OK rules.
 */
export interface HarnessDescriptor {
  id: HarnessId
  productName: string
  agentName: string
  executableName: (platform: NodeJS.Platform) => string
  /** Environment override for the executable; only absolute paths are honored. */
  binaryEnvVar: string
  /** Directories under process.resourcesPath (as path segments) that may bundle the executable. */
  bundledResourceDirs: readonly (readonly string[])[]
  /** Harness-specific locations beyond the shared package-manager and system directories. */
  candidateDirs: (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => string[]
  agentDir: (home: string) => string
  sessionRoot: (home: string) => string
}

export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  omp: {
    id: 'omp',
    productName: 'OMP Desktop',
    agentName: 'OMP',
    executableName: (platform) => platform === 'win32' ? 'omp.exe' : 'omp',
    binaryEnvVar: 'OMP_BINARY',
    bundledResourceDirs: [],
    candidateDirs: (platform, _home, env) => {
      if (platform === 'win32') return env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'omp')] : []
      return env.PI_INSTALL_DIR ? [env.PI_INSTALL_DIR] : []
    },
    agentDir: (home) => join(home, '.omp', 'agent'),
    sessionRoot: (home) => join(home, '.omp', 'agent', 'sessions'),
  },
}
