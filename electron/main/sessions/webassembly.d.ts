declare namespace WebAssembly {
  function instantiate(bytes: Uint8Array, imports?: Record<string, unknown>): Promise<{ instance: { exports: Record<string, unknown> } }>
}
