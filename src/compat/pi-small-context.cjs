const { createHash } = require('node:crypto');

const { arxdSmallContextPolicy } = require('../agent/small-context-policy.cjs');
const policy = `\n${arxdSmallContextPolicy.toString()}\n`;
const sources = [
  { suffix: '/@earendil-works/pi-durable/dist/harness/generation.js', hash: 'c7902ec218c6268474969142a70d4ba485eb75c7ee18f6d75c3923a60510c34e', edit: (source) => source
    .replace('thresholdCompaction(view, entries, resolved.contextWindow, settings.compaction)', 'thresholdCompaction(view, entries, resolved.contextWindow, arxdSmallContextPolicy(settings.compaction, resolved.contextWindow))')
    .replace('const policy = settings.compaction;', 'const policy = arxdSmallContextPolicy(settings.compaction, runtime.models.getModel(ref.provider, ref.modelId)?.contextWindow ?? 0);') + policy },
  { suffix: '/@earendil-works/pi-durable/dist/harness/compaction.js', hash: '70b9218282ffe80fa20aaf98356531f3f27de8ab6ed0ba27b174324267aaa3a4', edit: (source) => source.replace('const policy = settings.compaction;', 'const policy = arxdSmallContextPolicy(settings.compaction, model.contextWindow);') + policy },
  { suffix: '/@earendil-works/pi-ai/dist/api/simple-options.js', hash: '9b3cc0ae6daa86fdc050bc0cb0f3f986401e64ccddbde6757183c9f8ad411be2', edit: (source) => source.replace('- CONTEXT_SAFETY_TOKENS;', '- Math.min(CONTEXT_SAFETY_TOKENS, Math.max(512, Math.floor(model.contextWindow / 10)));') },
];

// originalSource remains the unchanged upstream bytes when composing the guarded
// retry transform; verify those before applying disjoint policy edits.
// Both native bundling and host E2E use the exact same pinned transformation.
// Large-model defaults, task names/checkpoints, entries and replay stay upstream.
exports.transformSmallContext = (filename, source, originalSource = source) => {
  const rule = sources.find((entry) => filename.replaceAll('\\', '/').endsWith(entry.suffix));
  if (!rule) return source;
  if (createHash('sha256').update(originalSource).digest('hex') !== rule.hash) throw new Error('Pi 1.3 source changed; review the small-context compatibility transform');
  return rule.edit(source);
};
