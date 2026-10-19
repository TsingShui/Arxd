import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSmallContext } from '../src/compat/pi-small-context.cjs';

const option = '--import=' + import.meta.url;
if (!(process.env.NODE_OPTIONS ?? '').includes(option)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${option}`.trim();
const stub = pathToFileURL(resolvePath(fileURLToPath(new URL('..', import.meta.url)), 'tests/native-rxd-stub.mjs')).href;
registerHooks({
  resolve(specifier, context, next) {
    // The Android native module does not exist on the host; tests use the stub.
    if (specifier.endsWith('/modules/rxd') || specifier === 'modules/rxd') return { url: stub, shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      // TypeScript sources import each other without extensions; Node does not.
      if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier)) {
        const base = dirname(fileURLToPath(context.parentURL));
        for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`]) {
          const file = resolvePath(base, candidate);
          if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
  load(url, context, next) {
    const result = next(url, context);
    if (url.startsWith('file:') && url.includes('/@earendil-works/') && url.endsWith('.js') && result.source != null) {
      return { ...result, source: transformSmallContext(fileURLToPath(url), String(result.source)) };
    }
    return result;
  },
});
