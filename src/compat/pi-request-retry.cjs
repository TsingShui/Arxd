/* global __dirname */
const { createHash } = require('node:crypto');
const path = require('node:path');

// Audited Pi-durable 1.3.0 distribution. Transform at bundle time, never mutate
// node_modules. A dependency update must re-audit scheduling and checkpoint
// semantics before changing these hashes. Android is the accepted runtime.
const hashes = {
  generation: 'c7902ec218c6268474969142a70d4ba485eb75c7ee18f6d75c3923a60510c34e',
  compaction: '70b9218282ffe80fa20aaf98356531f3f27de8ab6ed0ba27b174324267aaa3a4',
};
const helper = JSON.stringify(path.resolve(__dirname, '../agent/request-retry.ts'));
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Pi retry compatibility anchor changed: ' + before.slice(0, 90));
  return source.replace(before, after);
}
function transform(source, kind) {
  if (createHash('sha256').update(source).digest('hex') !== hashes[kind]) throw new Error('Pi 1.3 retry source changed; re-audit durable network-only retry adaptation');
  source = `import { requestEpoch, REQUEST_TOTAL_MS, retryableRequest as isRetryableAssistantError, requestFailureMessage, safeRequestError } from ${helper};\n` + source;
  source = replace(source, 'import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";', 'import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";');
  source = `import { defineDoc as defineArxdDoc } from "../documents.js";\nconst ArxdRequestRecordsDoc = defineArxdDoc({kind:"arxd.requests",version:1,scope:"conversation",history:"latest",fork:"initial",initial:()=>({records:[]})});\n` + source;
  if (kind === 'generation') {
    source = replace(source, 'async function failModelError(runtime, text, context) {', `async function failModelError(runtime, text, context) {
        const agent = await runtime.agent(context);
        const model = agent.model && runtime.models.getModel(agent.model.provider, agent.model.modelId);`);
    source = replace(source, '        const live = await tx.doc(LiveDoc, runtime.conversationId);\n        endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });', `        const live = await tx.doc(LiveDoc, runtime.conversationId);
        if (model) {
            const failure = (await tx.doc(ArxdRequestRecordsDoc, runtime.conversationId)).records.findLast(record => record.failure)?.failure;
            const request = failure ?? { id: String(runtime.taskId), attempt: 1, stage: "compaction", deadlineAt: runtime.now() };
            const message = requestFailureMessage(model, request, failure?.category ?? "unknown", text);
            if (failure) message.arxdFailure = { ...failure, message: text, retryable: false };
            await appendAssistant(tx, runtime.conversationId, message);
        }
        endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });`);
    source = replace(source, 'import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";\n', '');
    source = replace(source, 'const overflow = message.stopReason === "error" && isContextOverflow(message);', 'const overflow = false; // HTTP/protocol context failure is terminal; no reactive resend.');
    source = replace(source, '        request: async (task, runtime, context) => {', `        request: async (task, runtime, context) => {
            const checkpoint = task.state.checkpoint;
            const arxdRequest = { id: String(runtime.taskId), attempt: checkpoint.attempt, stage: "generation", deadlineAt: checkpoint.arxdRequest?.deadlineAt ?? runtime.now() + REQUEST_TOTAL_MS };
            // Charge before dispatch. A crashed dispatch remains consumed.
            await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, phase: "dispatch", arxdRequest, arxdEpoch: requestEpoch } }), context);
        },
        dispatch: async (task, runtime, context) => {`);
    source = replace(source, '            const view = await runtime.context(conversationId, context, { at: cutoff });\n            let messages = view.messages;', `            if (task.state.checkpoint.arxdEpoch !== requestEpoch) {
                const message = requestFailureMessage(model, task.state.checkpoint.arxdRequest, "network", "App interrupted a charged model attempt; its remote outcome is unknown");
                await classify(runtime, { ...task.state.checkpoint, model: ref, messages: task.state.checkpoint.pinnedMessages ?? [] }, message, context);
                return;
            }
            const view = await runtime.context(conversationId, context, { at: cutoff });
            let messages = task.state.checkpoint.pinnedMessages ?? view.messages;`);
    source = replace(source, '            await runtime.hooks.each("beforeRequest", async (hook) => {', '            if (!task.state.checkpoint.pinnedMessages) await runtime.hooks.each("beforeRequest", async (hook) => {');
    source = replace(source, '                ...streamOptions,\n                signal: runtime.signal,', '                ...streamOptions,\n                arxdRequest: task.state.checkpoint.arxdRequest,\n                signal: runtime.signal,');
    source = replace(source, '            const request = { attempt, compacted, model: ref, cutoff, messages: view.messages };', '            const request = { ...task.state.checkpoint, attempt, compacted, model: ref, cutoff, messages, pinnedMessages: messages };');
    source = replace(source, `            const { attempt, compacted, until } = task.state.checkpoint;
            await runtime.sleep(until, context);`, `            const { attempt, until } = task.state.checkpoint;
            await runtime.sleep(until, context);`);
    source = replace(source, `                const checkpoint = {
                    phase: "prepare",
                    attempt: attempt + 1,
                    ...(compacted === undefined ? {} : { compacted }),
                };`, `                const { until: _until, arxdEpoch: _epoch, ...pinned } = task.state.checkpoint;
                const checkpoint = { ...pinned, phase: "request", attempt: attempt + 1 };`);
    source = replace(source, `            const checkpoint = {
                phase: "retry",
                attempt,
                ...(compacted === undefined ? {} : { compacted }),
                until,
            };`, `            const checkpoint = { ...request, phase: "retry", attempt, until };
            delete checkpoint.messages; // pinnedMessages retains the exact hook-adjusted context.
            if (checkpoint.compacted === undefined) delete checkpoint.compacted;`);
  } else {
    source = replace(source, '        summarize: async (task, runtime, context) => {', `        summarize: async (task, runtime, context) => {
            const checkpoint = task.state.checkpoint;
            const arxdRequest = { id: String(runtime.taskId), attempt: checkpoint.attempt, stage: "compaction", deadlineAt: checkpoint.arxdRequest?.deadlineAt ?? runtime.now() + REQUEST_TOTAL_MS };
            await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, phase: "summarizeDispatch", arxdRequest, arxdEpoch: requestEpoch } }), context);
        },
        summarizeDispatch: async (task, runtime, context) => {`);
    source = replace(source, '                ...forwarded,\n                cacheRetention:', '                ...forwarded,\n                arxdRequest: request.arxdRequest,\n                cacheRetention:');
    source = replace(source, '            const message = await runtime.models.completeSimple(model, { messages }, options);', `            const message = request.arxdEpoch !== requestEpoch
                ? requestFailureMessage(model, request.arxdRequest, "network", "App interrupted a charged compaction attempt; its remote outcome is unknown")
                : await runtime.models.completeSimple(model, { messages }, options);`);
  }
  if (kind === 'compaction') {
    source = replace(source, '                await recordUsage(tx, runtime.conversationId, "models", `${message.provider}/${message.model}`, message.usage);', `                const ledger = await tx.doc(ArxdRequestRecordsDoc, runtime.conversationId);
                ledger.records.push({ requestId: String(runtime.taskId), attempt, at: runtime.now(), outcome: summary !== undefined ? "completed" : "failed", ...(message.arxdFailure ? { failure: message.arxdFailure } : {}), ...(message.content.length ? { partial: message.content.filter(b => b.type === "text" || b.type === "thinking").map(b => b.text ?? b.thinking ?? "").join("\\n").slice(0,8192) } : {}) });
                if (ledger.records.length > 64) ledger.records.splice(0, ledger.records.length - 64);
                await recordUsage(tx, runtime.conversationId, "models", message.provider + "/" + message.model, message.usage);`);
  }
  source = source.replace('runtime.now() + retryDelayMs(policy, attempt) : 0', 'Math.min(runtime.now() + retryDelayMs(policy, attempt), message.arxdFailure.deadlineAt) : 0');
  // Include exhaustion in the persisted safe failure, not just a transient banner.
  const anchor = kind === 'generation' ? '    const policy = settings.retry;' : '            const policy = runtime.settings.retry;';
  source = replace(source, anchor, `${anchor}
            if (message.arxdFailure?.retryable && (attempt >= 4 || runtime.now() >= message.arxdFailure.deadlineAt)) {
                message.errorMessage = safeRequestError((attempt >= 4 ? "Network failure; three retries exhausted: " : "Request total deadline exhausted: ") + (message.errorMessage ?? ""));
                message.arxdFailure.message = message.errorMessage;
            }`);
  return source;
}
module.exports = { transform };
