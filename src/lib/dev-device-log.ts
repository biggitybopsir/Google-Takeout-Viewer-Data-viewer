export function heapMegabytes(): number | undefined {
  const memory = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number } } | undefined)?.memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1_000_000) : undefined;
}

export function deviceLog(_event?: string, _data?: Record<string, unknown>): void {
  // Standalone build: intentionally no-op. Parsing stays entirely local.
}

export function deviceLogParsing(_running?: boolean): void {
  // Standalone build: intentionally no-op. Parsing stays entirely local.
}

export function installDeviceLog(): void {
  // Standalone build: intentionally no-op. Parsing stays entirely local.
}
