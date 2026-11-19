let queuedOpenPaths: string[] = []
let queuedSavePath: string | undefined

export function setNextOpenDialogPaths(paths: string[]): void {
  queuedOpenPaths = [...paths]
}

export function setNextSaveDialogPath(path: string | undefined): void {
  queuedSavePath = path
}

export const dialog = {
  async showOpenDialog(_windowOrOptions?: unknown, _maybeOptions?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    const filePaths = queuedOpenPaths
    queuedOpenPaths = []
    if (filePaths.length === 0) return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths }
  },
  async showSaveDialog(_windowOrOptions?: unknown, _maybeOptions?: unknown): Promise<{ canceled: boolean; filePath?: string }> {
    const filePath = queuedSavePath
    queuedSavePath = undefined
    if (!filePath) return { canceled: true }
    return { canceled: false, filePath }
  },
}

const createSessionStub = () => ({
  clearStorageData: async () => undefined,
  clearCache: async () => undefined,
  clearAuthCache: async () => undefined,
})

export const session = {
  fromPartition: () => createSessionStub(),
  defaultSession: createSessionStub(),
}

export const app = {
  getVersion: () => '0.0.0-conformance',
}
