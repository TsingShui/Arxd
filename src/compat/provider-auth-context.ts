// Native-JS counterpart of pi-ai 1.3's documented browser auth context.
// Metro cannot parse its optional variable import of node:fs. App credentials
// must be supplied explicitly; an Android JS host has no Node filesystem.
export function defaultProviderAuthContext() {
  return {
    async env(name: string) {
      const value = process.env?.[name];
      return typeof value === 'string' && value.trim() ? value : undefined;
    },
    async fileExists() { return false; },
  };
}
