declare module 'js-yaml' {
  export const FAILSAFE_SCHEMA: unknown;
  export const JSON_SCHEMA: unknown;
  export function load(source: string, options?: { schema?: unknown; json?: boolean }): unknown;
}
