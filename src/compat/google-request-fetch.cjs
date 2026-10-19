const { createHash } = require('node:crypto');
// Pi AI 1.3.0 + GenAI 2.21.0. GenAI has no public per-client fetch hook in
// this path. Carry it on that client's private HTTP options, never mutate the
// process-global fetch (concurrent generation/compaction must stay isolated).
const hashes = {
  piGoogle: '3a19fb56e96e60751a27a19f891264a3ab471cf4973307308ffdc8f8d2669397',
  genaiWeb: 'f27dcab951b1a7fd75dd9a1646c47851cda41b81922a59802bd574462c77e35d',
  genaiDefault: '72756e2e7f2771c130552495371ff0e8bd82e3beefa3cb0ec3422fcb986a892d',
};
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Google request-fetch compatibility anchor changed: ' + before.slice(0, 90));
  return source.replace(before, after);
}
function transform(source, kind) {
  if (createHash('sha256').update(source).digest('hex') !== hashes[kind]) throw new Error('Google SDK source changed; re-audit per-client transport and retry adaptation');
  if (kind === 'piGoogle') {
    source = replace(source, `            if (options?.fetch && options.fetch !== globalThis.fetch) {
                throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
            }`, '');
    source = replace(source, 'const client = createClient(model, apiKey, options?.headers);', 'const client = createClient(model, apiKey, options?.headers, options?.fetch);');
    source = replace(source, 'function createClient(model, apiKey, optionsHeaders) {', 'function createClient(model, apiKey, optionsHeaders, arxdFetch) {');
    source = replace(source, 'httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,', 'httpOptions: { ...httpOptions, ...(arxdFetch ? { arxdFetch, retryOptions: { attempts: 1, httpStatusCodes: [] } } : {}) },');
  } else {
    source = replace(source, '        const retryableStatusCodes =', '        if (this.clientOptions.httpOptions?.arxdFetch) retryOptions = { attempts: 1, httpStatusCodes: [] };\n        const retryableStatusCodes =');
    source = replace(source, 'response = await fetch(url, Object.assign(Object.assign({}, requestInit), { signal: attempt.signal }));', 'response = await (this.clientOptions.httpOptions?.arxdFetch ?? fetch)(url, Object.assign(Object.assign({}, requestInit), { signal: attempt.signal }));');
  }
  return source;
}
module.exports = { transform };
