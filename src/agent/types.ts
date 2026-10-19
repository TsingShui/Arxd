export type LiveConnection = { getKey?(): Promise<string | undefined>; fetch?: typeof globalThis.fetch };
