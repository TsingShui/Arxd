import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSmallContext } from '../src/compat/pi-small-context.cjs';

const option = '--import=' + import.meta.url;
if (!(process.env.NODE_OPTIONS ?? '').includes(option)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${option}`.trim();
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.startsWith('file:') && url.includes('/@earendil-works/') && url.endsWith('.js') && result.source != null) {
    return { ...result, source: transformSmallContext(fileURLToPath(url), String(result.source)) };
  }
  return result;
} });
