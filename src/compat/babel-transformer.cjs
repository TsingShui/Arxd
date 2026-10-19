/* global __dirname, __filename */
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const upstream = require(getDefaultConfig(path.resolve(__dirname, '../..')).transformer.babelTransformerPath);
const { transformSmallContext } = require('./pi-small-context.cjs');

// Chord 1.3.0 copyJson passes a numeric array index into getOwnPropertyDescriptor.
// Hermes forwards that number to Proxy traps; Chord's array overlay only accepts
// string keys. Normalize the key without relaxing strict-JSON validation. The
// sibling isJsonValue implementation already uses String(index).
const chordSha256 = '671e8953a01808904e0dcaa76c964802585fe854df154b63e6c86efa80fc33e6';
module.exports = {
  ...upstream,
  transform(args) {
    const originalSource = args.src;
    if (args.options.platform === 'android' && args.filename.replaceAll('\\', '/').endsWith('/@earendil-works/chord/dist/json.js')) {
      if (createHash('sha256').update(args.src).digest('hex') !== chordSha256) {
        throw new Error('Chord JSON source changed; review the Hermes array-key compatibility transform');
      }
      args = { ...args, src: args.src.replace('Object.getOwnPropertyDescriptor(value, index)', 'Object.getOwnPropertyDescriptor(value, String(index))') };
    }
    if (args.options.platform === 'android') {
      const kind = /\/@earendil-works\/pi-durable\/dist\/harness\/(generation|compaction)\.js$/.exec(args.filename.replaceAll('\\', '/'))?.[1];
      if (kind) args = { ...args, src: require('./pi-request-retry.cjs').transform(args.src, kind) };
      const name = args.filename.replaceAll('\\', '/');
      const google = name.endsWith('/@earendil-works/pi-ai/dist/api/google-generative-ai.js') ? 'piGoogle' : name.endsWith('/@google/genai/dist/web/index.mjs') ? 'genaiWeb' : name.endsWith('/@google/genai/dist/index.mjs') ? 'genaiDefault' : undefined;
      if (google) args = { ...args, src: require('./google-request-fetch.cjs').transform(args.src, google) };
      args = { ...args, src: transformSmallContext(args.filename, args.src, originalSource) };
    }
    return upstream.transform(args);
  },
  getCacheKey() {
    return createHash('sha256').update(upstream.getCacheKey()).update(__dirname).update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, 'pi-request-retry.cjs'))).update(fs.readFileSync(path.join(__dirname, 'google-request-fetch.cjs'))).update(fs.readFileSync(require.resolve('./pi-small-context.cjs'))).update(fs.readFileSync(path.join(__dirname, '../agent/small-context-policy.cjs'))).digest('hex');
  },
};
