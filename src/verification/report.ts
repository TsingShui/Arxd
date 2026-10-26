import { requireVerification } from './access';
import Rxd from '../../modules/rxd';
import { parseRecords } from '../workspace/core';
import type { ToolView, WorkspaceSnapshot } from '../workspace/core';

/** Evidence payload a verification stage publishes through logcat. */
function toolProof(tool: ToolView) {
  const details = tool.details as { exitCode?: number; identity?: { uid?: number; packageName?: string; debuggable?: boolean } } | undefined;
  let payload: { stdout?: string; exitCode?: number } = {};
  try { payload = JSON.parse(tool.text); } catch { /* NDJSON is parsed below. */ }
  const records = parseRecords(payload.stdout ?? tool.text);
  return { name: tool.name, isError: tool.isError, exitCode: details?.exitCode ?? payload.exitCode,
    durationMs: tool.durationMs, outputPreview: (payload.stdout ?? tool.text).slice(0, 512),
    computations: records.filter((r) => typeof r.python === 'number' || typeof r.node === 'number'),
    functions: records.flatMap((r) => typeof r.detail === 'object' && r.detail !== null && !Array.isArray(r.detail) && typeof (r.detail as { name?: unknown }).name === 'string' ? [(r.detail as { name: string }).name] : []),
    identity: details?.identity ? { uid: details.identity.uid, packageName: details.identity.packageName, debuggable: details.identity.debuggable } : undefined };
}

export async function reportUiStage(stage: string, value: WorkspaceSnapshot) {
  requireVerification();
  await Rxd.report(JSON.stringify({ event: 'arxd-ui', stage, active: value.active, palette: value.palette, appearance: value.appearance, motion: value.motion,
    conversationCount: value.conversations.length, pendingDeletions: value.deletions.length, fileCount: value.files.length, turnCount: value.turns.length,
    archived: !!value.conversations.find((row) => row.id === value.active)?.archived, archivedCount: value.conversations.filter((row) => row.archived).length,
    toolCount: value.turns.reduce((n, t) => n + t.tools.length, 0), busy: value.busy,
    fileIdentities: value.files.slice(-4).map((f) => ({ name: f.name, sha256: f.sha256 })),
    provider: value.turns.at(-1)?.provider, modelId: value.turns.at(-1)?.modelId, tokens: value.turns.reduce((n,t) => n+t.tokens,0), cost: value.turns.reduce((n,t) => n+t.cost,0), lastTools: value.turns.at(-1)?.tools.slice(-4).map(toolProof), model: value.model, lastAnswer: value.turns.at(-1)?.answer.slice(0, 2400), toolErrors: value.turns.flatMap((t) => t.tools).filter((t) => t.isError).length, lastStatus: value.turns.at(-1)?.status,
    phase: value.turns.at(-1)?.phase, timing: value.turns.at(-1)?.timing,
    activity: value.turns.at(-1)?.activities.map((block) => ({ kind: block.kind, id: block.id, ...(block.kind === 'tool' ? { state: block.state, durationMs: block.result?.durationMs, preview: !!block.output } : {}) })),
    entities: value.turns.flatMap((t) => t.tools.flatMap((tool) => tool.records
      .map((r) => typeof r.detail === 'object' && r.detail !== null && !Array.isArray(r.detail) && typeof r.detail.name === 'string' ? r.detail.name : null))).filter(Boolean),
  }));
}
