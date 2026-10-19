import { requireVerification } from './access';
import { verifyCapacityPolicyAvailability } from './context-capacity-policy';
import { safeRequestError } from '../agent/request-retry';
import { publishEvidence } from './evidence';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { UserEntry, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import Rxd from '../../modules/rxd';
import type { Workspace } from '../workspace/core';
import { setCapacitySummary, setCapacityGeneration, setCapacityStreamProbe, setCapacityUsageFixture } from './capacity-provider';

/** Real Android App/Pi state; only the external model response is deterministic. */
type CapacityGate = { stage(name: string): void; check(): void };
async function verifyContextCapacityImpl(core: Workspace, gate: CapacityGate) {
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => { gate.check(); if (!condition) throw new Error(label); checks.push(label); };
  async function settled() {
    for (let attempt = 0; attempt < 80; attempt++) {
      const snapshot = await core.refresh();
      if (snapshot.capacity.state === 'current') return snapshot.capacity;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Capacity projection did not settle: ' + JSON.stringify(core.getSnapshot().capacity));
  }
  gate.stage('initial-and-provider-anchors');
  await core.select(null); await core.model('test');
  assert(core.getSnapshot().capacity.tokens === null && core.getSnapshot().capacity.ratio === null, 'Uncreated conversation displays unknown instead of zero');
  await core.send('<arxd-capacity-probe tokens="1"/>');
  const tiny = await settled();
  assert(tiny.tokens === 1 && tiny.ratio! > 0, 'Very small valid usage is distinct from unknown or an empty context: ' + JSON.stringify(capacityDiagnostic(core)));
  await core.send('<arxd-capacity-probe tokens="32000"/>');
  const first = await settled();
  assert(first.tokens === 32000 && first.limit === 128000 && first.ratio === .25, 'Independent normalized 32k usage over actual 128k window gives 25%');
  assert(first.source === 'provider-anchored-estimate' && first.usageTokens === 32000, 'Cache read tokens are counted once in normalized total');
  const firstConversation = core.getSnapshot().active!;
  const countBeforeInspect = core.getSnapshot().turns.length;
  for (let i = 0; i < 5; i++) await core.refresh();
  assert(core.getSnapshot().turns.length === countBeforeInspect && !(await core.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 'Repeated capacity inspection performs no model request tool execution or compaction');
  await core.select(null); await core.send('<arxd-capacity-probe tokens="64000"/>');
  const other = core.getSnapshot().active!;
  await settled();
  gate.stage('uncached-model-switch');
  const firstStored = (await core.harness.conversation(firstConversation, BACKGROUND_CONTEXT))!;
  await firstStored.configure({ model: { provider: 'deepseek', modelId: 'deepseek-flash' } }, BACKGROUND_CONTEXT);
  await firstStored.commit((tx) => tx.appendEntry(UserEntry, firstConversation, { model: [{ role: 'user', content: 'uncached capacity switch fixture', timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
  // Read the actual public Pi/Android SQLite context, then delay its delivery.
  // The real old snapshot arrives after the switch; no fixture context is returned.
  const originalConversation = core.harness.conversation.bind(core.harness);
  let enteredRead!: () => void; let releaseRead!: () => void;
  const reading = new Promise<void>((resolve) => { enteredRead = resolve; });
  const releaseContextRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let held = false;
  core.harness.conversation = async (...args) => {
    const actual = await originalConversation(...args);
    if (actual && args[0] === firstConversation) {
      const context = actual.context.bind(actual);
      actual.context = async (...contextArgs) => {
        const captured = await context(...contextArgs);
        if (!held) { held = true; enteredRead(); await releaseContextRead; }
        return captured;
      };
    }
    return actual;
  };
  const alternateWindow = core.connections.models('deepseek').find((entry) => entry.definition.id === 'deepseek-flash')!.definition.contextWindow;
  let mixed = false;
  const snapshots = core.subscribe((snapshot) => {
    if (!snapshot.active || snapshot.capacity.conversationId === null) return;
    const expectedProvider = snapshot.active === firstConversation ? 'deepseek' : 'faux';
    const expectedLimit = snapshot.active === firstConversation ? alternateWindow : 128000;
    if (snapshot.capacity.conversationId !== String(snapshot.active) || (snapshot.capacity.model && (snapshot.capacity.model.provider !== expectedProvider || snapshot.capacity.limit !== expectedLimit)) || (snapshot.active === other && snapshot.capacity.state === 'current' && snapshot.capacity.tokens !== 64000)) mixed = true;
  });
  try {
    await core.select(firstConversation);
    await Promise.race([reading, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No uncached capacity read entered')), 3000))]);
    assert(held && core.getSnapshot().capacity.state !== 'current', 'Uncached capacity estimate is in flight at the actual Pi context read');
    await core.select(other);
    const switched = await settled();
    assert(switched.conversationId === String(other) && switched.model?.provider === 'faux' && switched.limit === 128000 && switched.tokens === 64000, 'Switch during an outstanding different-model estimate preserves the selected conversation basis');
    releaseRead(); await new Promise((resolve) => setTimeout(resolve, 350)); await core.refresh();
    assert(!mixed && core.getSnapshot().capacity.tokens === 64000, 'A late canceled context read never publishes a mixed conversation/model snapshot');
  } finally { releaseRead(); snapshots(); core.harness.conversation = originalConversation; }
  await firstStored.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, BACKGROUND_CONTEXT);
  await core.select(firstConversation);
  await core.send('<arxd-capacity-probe tokens="48000"/>');
  const second = await settled();
  assert(second.tokens === 48000 && second.tokens !== first.tokens! + 48000, 'Current occupancy uses the latest request rather than repeated billed history');
  const conversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  await conversation.commit(async (tx) => { await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: 'user', content: '1234567', timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  const trailing = await settled();
  assert(trailing.tokens === 48002 && trailing.trailingTokens === 2, 'Seven known trailing characters add exactly two Pi estimated tokens');
  gate.stage('actual-history-pagination');
  await conversation.commit(async (tx) => { for (let i = 0; i < 150; i++) await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: 'user', content: 'capacity-pagination-' + i, timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  const beforeHistory = await settled();
  const firstPage = await core.refresh();
  assert(firstPage.hasMoreHistory && firstPage.turns.length > 0, 'Pagination fixture has actual older native history beyond the first 128 records');
  const expandedPage = await core.earlier();
  const afterHistory = await settled();
  assert(expandedPage.turns.length > firstPage.turns.length && !expandedPage.hasMoreHistory && afterHistory.revision === beforeHistory.revision && afterHistory.tokens === beforeHistory.tokens, 'Loading an actual older UI history page preserves effective context occupancy');
  gate.stage('model-limits-and-usage-edges');
  await conversation.configure({ model: { provider: 'deepseek', modelId: 'deepseek-flash' } }, BACKGROUND_CONTEXT);
  const changed = await settled();
  assert(changed.model?.provider === 'deepseek' && changed.limit !== 128000 && changed.source === 'estimate', 'Model switch resolves its own window and rejects incompatible usage anchor without network');
  await conversation.configure({ model: { provider: 'missing-capacity-model', modelId: 'unknown' } }, BACKGROUND_CONTEXT);
  await core.refresh(); await new Promise((resolve) => setTimeout(resolve, 350)); await core.refresh();
  assert(core.getSnapshot().capacity.limit === null && core.getSnapshot().capacity.ratio === null, 'Unavailable model has no fabricated denominator or percentage');
  await conversation.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, BACKGROUND_CONTEXT);
  await core.send('<arxd-capacity-probe tokens="128000"/>');
  assert((await settled()).ratio === 1 && (await settled()).remaining === 0, 'Exact-full context is finite and distinct from over-limit');
  await core.send('<arxd-capacity-probe tokens="160000"/>');
  const over = await settled();
  assert(over.ratio! > 1 && over.tokens === 160000 && over.remaining === 0 && over.emphasis === 'over-limit', 'Over-limit context retains real ratio and nonnegative remaining capacity');
  await core.send('<arxd-capacity-probe tokens="0"/>');
  const noUsage = await settled();
  assert(Number.isSafeInteger(noUsage.tokens) && noUsage.tokens! > 0 && (noUsage.source === 'estimate' || noUsage.tokens! >= 160000), 'Zero/missing usage never fabricates an empty context');
  await core.select(null); await core.send('<arxd-capacity-probe tokens="0"/>');
  const withoutAnchor = await settled();
  const unanchoredConversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  const independentlyEstimated = (await unanchoredConversation.context(BACKGROUND_CONTEXT)).messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  assert(independentlyEstimated > 0 && withoutAnchor.source === 'estimate' && withoutAnchor.usageTokens === 0 && withoutAnchor.tokens === independentlyEstimated, 'A genuinely unanchored zero-usage conversation counts the actual committed Pi system/tool/message context approximately');
  gate.stage('normalized-cache-and-malformed-provider-usage');
  try {
    for (const fixture of [
      { input: 12000, output: 1000, cacheRead: 8000, cacheWrite: 11000, totalTokens: 32000 },
      { input: 12000, output: 1000, cacheRead: 8000, cacheWrite: 11000, totalTokens: 0 },
    ]) {
      await core.select(null); setCapacityUsageFixture(fixture); await core.send('<arxd-capacity-probe tokens="0"/>');
      const normalized = await settled();
      assert(normalized.tokens === 32000 && normalized.usageTokens === 32000 && normalized.source === 'provider-anchored-estimate' && normalized.ratio === .25, 'Actual provider cacheRead/cacheWrite is counted exactly once with ' + (fixture.totalTokens ? 'normalized total' : 'zero-total component fallback'));
    }
    for (const malformed of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await core.select(null); setCapacityUsageFixture({ input: malformed, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      let rejected = false;
      try { await core.send('<arxd-capacity-probe tokens="0"/>'); } catch { rejected = true; }
      const projected = await settled();
      assert(!core.getSnapshot().busy && Number.isFinite(projected.tokens) && projected.tokens! > 0 && projected.source === 'estimate' && projected.usageTokens === 0, 'Malformed provider usage ' + String(malformed) + ' is ' + (rejected ? 'rejected at the actual generation/storage boundary' : 'excluded as an anchor after actual provider/storage admission') + ' with a finite committed estimate');
    }
  } finally { setCapacityUsageFixture(); }
  await core.select(unanchoredConversation.id); await settled();
  gate.stage('connection-qualified-capabilities-and-numeric-boundaries');
  const configurationIds: string[] = [];
  const configurationConversation = unanchoredConversation;
  const manual = { id: 'same-upstream-capacity', name: 'Capacity configuration fixture', contextWindow: 128000, maxTokens: 1024, thinking: ['off' as const] };
  try {
    for (const window of [128000, 64000]) {
      const connection = await core.connections.save({ name: `Capacity ${window}`, preset: 'custom', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:1/capacity-inspection-only', auth: 'none' });
      configurationIds.push(connection.id);
      await core.connections.manual(connection.id, { ...manual, contextWindow: window }, {}, true);
    }
    const [connectionA, connectionB] = configurationIds;
    await configurationConversation.configure({ model: { provider: connectionA, modelId: manual.id } }, BACKGROUND_CONTEXT);
    const a = await settled();
    await configurationConversation.configure({ model: { provider: connectionB, modelId: manual.id } }, BACKGROUND_CONTEXT);
    const b = await settled();
    assert(a.model?.id === b.model?.id && a.model?.provider !== b.model?.provider && a.limit === 128000 && b.limit === 64000 && a.tokens === b.tokens && b.ratio === a.ratio! * 2 && a.configurationRevision !== b.configurationRevision, 'Identical upstream model IDs remain connection-qualified with independent denominators and revisions');
    assert(a.model?.limitSource === 'manual' && b.model?.limitSource === 'manual' && b.source === 'estimate', 'Manual capabilities retain their provenance without a model request or incompatible usage anchor');
    const modelB = core.connections.models(connectionB)[0];
    await core.connections.manual(connectionB, { ...manual, contextWindow: 96000 }, {}, true, modelB.id);
    const edited = await settled();
    assert(edited.limit === 96000 && edited.tokens === b.tokens && edited.configurationRevision !== b.configurationRevision, 'Editing a real manual capability invalidates the denominator and configuration revision atomically');
    const old = core.connections.get(connectionB);
    await core.connections.save({ name: old.name + ' revised', preset: old.preset, protocol: old.protocol, endpoint: old.endpoint, auth: old.auth }, old.id, old.revision);
    const revised = await settled();
    assert(revised.limit === edited.limit && revised.tokens === edited.tokens && revised.configurationRevision !== edited.configurationRevision, 'A real connection revision invalidates the capacity configuration even when its window is unchanged');
    for (const invalid of [undefined, 0, -1, 8191, 8192.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const before = core.connections.get(connectionB).revision;
      let rejected = false;
      try { await core.connections.manual(connectionB, { ...manual, contextWindow: invalid as number }, {}, true, modelB.id); } catch { rejected = true; }
      assert(rejected && core.connections.get(connectionB).revision === before && (await settled()).configurationRevision === revised.configurationRevision, 'Real manual-model boundary rejects invalid context window ' + String(invalid) + ' without mutating a valid snapshot');
    }
    await core.connections.manual(connectionB, { ...manual, contextWindow: 8192 }, {}, true, modelB.id);
    const small = await settled();
    assert(small.limit === 8192 && small.thresholds.reserve === 2048 && small.thresholds.background === 5120 && small.thresholds.blocking === 6144, 'Actual selected 8k model exposes its adapted execution policy: reserve 2048, background 5120, blocking 6144');
    async function fill(target: number) {
      const current = await settled(); const missing = target - current.tokens!;
      assert(Number.isSafeInteger(missing) && missing > 0, 'Threshold fixture admits a known positive token increment');
      await configurationConversation.commit((tx) => tx.appendEntry(configurationConversation.id, { kind: 'arxd.capacity-policy-fixture', model: [{ role: 'user', content: 'x'.repeat(Math.floor(missing * 3.5)), timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
      const value = await settled(); assert(value.tokens === target, 'Public committed-context estimator reaches independent threshold fixture ' + target); return value;
    }
    for (const [target, emphasis] of [[5119, 'normal'], [5120, 'normal'], [5121, 'background'], [6143, 'background'], [6144, 'background'], [6145, 'blocking']] as const) {
      const boundary = await fill(target);
      assert(boundary.thresholds.actionable && boundary.emphasis === emphasis, 'Actual 8k selected policy boundary ' + target + ' has ' + emphasis + ' emphasis');
    }
    await core.connections.manual(connectionB, { ...manual, contextWindow: 128000 }, {}, true, modelB.id);
    for (const [target, emphasis] of [[78847, 'normal'], [78848, 'normal'], [78849, 'background'], [111615, 'background'], [111616, 'background'], [111617, 'blocking']] as const) {
      const boundary = await fill(target);
      assert(boundary.thresholds.background === 78848 && boundary.thresholds.blocking === 111616 && boundary.thresholds.actionable && boundary.emphasis === emphasis, 'Actual 128k selected policy boundary ' + target + ' has ' + emphasis + ' emphasis');
    }
    assert(!(await core.harness.snapshot(LiveDoc, configurationConversation.id, BACKGROUND_CONTEXT))?.compactions?.length, 'Changing display emphasis across actual thresholds does not start automatic compaction');
  } finally {
    await configurationConversation.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, BACKGROUND_CONTEXT);
    for (const id of configurationIds) await core.connections.remove(id);
    await settled();
  }
  gate.stage('disabled-and-unavailable-native-policy-settings');
  await verifyCapacityPolicyAvailability(assert);
  gate.stage('streamed-committed-basis-and-read-coalescing');
  await core.select(null); await core.model('test'); await core.send('<arxd-capacity-probe tokens="0"/>');
  const streamConversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  // Count only actual public Pi context reads. Return each real result unchanged.
  const realConversation = core.harness.conversation.bind(core.harness);
  let contextReads = 0;
  core.harness.conversation = async (...args) => {
    const actual = await realConversation(...args);
    if (actual?.id === streamConversation.id) { const read = actual.context.bind(actual); actual.context = async (...parameters) => { contextReads++; return read(...parameters); }; }
    return actual;
  };
  let enteredStream!: () => void; let releaseStream!: () => void; let enteredTerminal!: () => void; let releaseTerminal!: () => void;
  const streamEntered = new Promise<void>((resolve) => { enteredStream = resolve; });
  const streamRelease = new Promise<void>((resolve) => { releaseStream = resolve; });
  const terminalEntered = new Promise<void>((resolve) => { enteredTerminal = resolve; });
  const terminalRelease = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const stream = { requests: 0, deltas: 0, terminals: 0, contexts: [] as import('@earendil-works/pi-ai').TranscriptContext[], beforeTerminal: async () => { if (stream.terminals === 1) { enteredTerminal(); await terminalRelease; } } };
  setCapacityGeneration(async () => { if (stream.requests === 1) { enteredStream(); await streamRelease; } });
  setCapacityStreamProbe(stream);
  const streaming = core.send('<arxd-capacity-stream/>');
  try {
    await streamEntered;
    const committed = await settled();
    const readsBefore = contextReads;
    let heartbeat = 0; const ticks = setInterval(() => { heartbeat++; }, 20);
    releaseStream(); await terminalEntered; clearInterval(ticks);
    const streamedSnapshot = await settled();
    assert(stream.deltas >= 20 && heartbeat >= 4 && core.getSnapshot().turns.at(-1)?.activities.some((block) => block.kind === 'thinking' || block.kind === 'text'), 'Real deterministic thinking/text/tool deltas render while the JavaScript event loop remains responsive');
    assert(streamedSnapshot.basis === 'last-committed-context' && streamedSnapshot.revision === committed.revision && streamedSnapshot.tokens === committed.tokens, 'Unfinished streamed thinking/text/tool arguments do not inflate committed capacity');
    assert(contextReads - readsBefore <= 2, 'Streaming deltas do not trigger per-frame full Pi context reads');
    releaseTerminal(); await streaming; setCapacityGeneration();
    const complete = await settled();
    assert(stream.requests === 2 && core.getSnapshot().turns.at(-1)?.tools.filter((tool) => tool.name === 'skill_search' && !tool.isError).length === 1, 'The deterministic stream performs one actual admitted skill-search tool round and exactly two provider requests');
    const context = await streamConversation.context(BACKGROUND_CONTEXT);
    const independent = context.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    assert(complete.source === 'estimate' && complete.tokens === independent && complete.revision !== committed.revision && complete.tokens! > committed.tokens!, 'Committed streamed output and tool result refresh the same Pi estimate after admission');
    const beforeInspect = { requests: stream.requests, tools: core.getSnapshot().turns.reduce((total, turn) => total + turn.tools.length, 0), entries: context.entries.length, head: context.head?.id };
    for (let i = 0; i < 8; i++) await core.refresh();
    const afterInspect = await streamConversation.context(BACKGROUND_CONTEXT);
    assert(stream.requests === beforeInspect.requests && core.getSnapshot().turns.reduce((total, turn) => total + turn.tools.length, 0) === beforeInspect.tools && afterInspect.entries.length === beforeInspect.entries && afterInspect.head?.id === beforeInspect.head && (await settled()).tokens === complete.tokens, 'Repeated capacity inspection causes no provider/tool invocation, committed entry, compaction head or token change');
  } finally {
    releaseStream(); releaseTerminal(); setCapacityGeneration(); await streaming.catch(() => undefined); setCapacityStreamProbe(); core.harness.conversation = realConversation;
  }
  gate.stage('admitted-system-tools-skills-and-immutable-edits');
  const nonce = globalThis.crypto.randomUUID().slice(0, 8);
  const skillIds: string[] = [];
  const selectedBody = 'CAPACITY_SELECTED_BODY_' + nonce + '_'.repeat(7000);
  const unrelatedBody = 'CAPACITY_UNLOADED_BODY_' + nonce + '_'.repeat(7000);
  const skillSource = 'capacity-skills-' + nonce;
  const definition = (name: string, body: string) => `---\nname: ${name}\ndescription: Admitted capacity metadata ${nonce} for ${name}.\n---\n${body}\n`;
  // File Manager mkdir creates one level; own the parent before creating skills.
  await Rxd.createDirectory('workspace', skillSource);
  let admissionFailure: { error: unknown } | undefined;
  try {
    for (const [name, body] of [['capacity-selected-' + nonce, selectedBody], ['capacity-unloaded-' + nonce, unrelatedBody]]) {
      await Rxd.createDirectory('workspace', skillSource + '/' + name);
      await Rxd.writeFile('workspace', skillSource + '/' + name + '/SKILL.md', definition(name, body), '');
      const record = await core.skills.import('workspace', skillSource + '/' + name); skillIds.push(record.id); await core.skills.enabled(record.id, true);
    }
    await core.select(null); await core.model('test'); await core.send('<arxd-capacity-probe tokens="0"/>');
    const admitted = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
    await core.skills.choose(skillIds[0], true);
    const probe = { requests: 0, deltas: 0, terminals: 0, contexts: [] as import('@earendil-works/pi-ai').TranscriptContext[] };
    setCapacityStreamProbe(probe);
    try {
      await core.send('Read the selected skill through the real admitted-context path.');
      const value = await settled(); const view = await admitted.context(BACKGROUND_CONTEXT);
      const system = view.messages.filter((message) => message.role === 'system');
      const results = view.messages.filter((message) => message.role === 'toolResult');
      const total = view.messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0);
      assert(value.source === 'estimate' && value.tokens === total && total > 0 && system.some((message) => message.toolsAdded?.some((tool) => tool.name === 'skill_load')), 'Independent full prepared Pi context includes actual system text and admitted tool definitions');
      assert(system.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0) > 0 && results.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0) > 0 && results.some((message) => message.toolName === 'skill_load' && JSON.stringify(message.content).includes(selectedBody)), 'Actual selected skill body and nonempty tool result contribute to the committed estimate');
      assert(JSON.stringify(system).includes('capacity-unloaded-' + nonce) && !JSON.stringify(view.messages).includes(unrelatedBody) && !results.some((message) => message.toolName === 'skill_load' && JSON.stringify(message.content).includes(unrelatedBody)), 'Enabled discovery admits unrelated skill metadata without eagerly loading its full instructions');
      const edit = await admitted.commit((tx) => tx.appendEntry(admitted.id, { kind: 'arxd.capacity-edit-source', model: [{ role: 'user', content: '1234567', timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
      assert((await settled()).tokens === total + 2, 'Known seven-character committed contribution adds two tokens after the admitted tool round');
      await admitted.commit((tx) => tx.appendEntry(admitted.id, { kind: 'arxd.capacity-edit-replace', edits: [{ target: edit.id, action: 'replace', messages: [{ role: 'user', content: '12345671234567', timestamp: Date.now() }] }] }), BACKGROUND_CONTEXT);
      assert((await settled()).tokens === total + 4, 'Immutable replacement counts its new effective contribution instead of archived original text');
      await admitted.commit((tx) => tx.appendEntry(admitted.id, { kind: 'arxd.capacity-edit-omit', edits: [{ target: edit.id, action: 'omit' }] }), BACKGROUND_CONTEXT);
      assert((await settled()).tokens === total, 'Immutable omission removes the effective contribution while retaining historical entries');
      const beforeEdit = await settled(); const working = await core.skills.working(skillIds[0]);
      await core.skills.save(skillIds[0], definition('capacity-selected-' + nonce, selectedBody + ' NEW_PUBLISHED_INSTRUCTIONS_' + nonce), working.sha256);
      assert((await settled()).tokens === beforeEdit.tokens, 'Publishing working skill bytes does not retroactively rewrite already admitted context');
      await core.send('Read the updated selected skill.');
      const updated = await settled(); const updatedContext = await admitted.context(BACKGROUND_CONTEXT);
      assert(updated.tokens === updatedContext.messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0) && updated.configurationRevision !== beforeEdit.configurationRevision && JSON.stringify(updatedContext.messages).includes('NEW_PUBLISHED_INSTRUCTIONS_' + nonce), 'Actual skill-version admission invalidates prompt provenance and counts the newly loaded instructions');
    } finally { setCapacityStreamProbe(); }
  } catch (error) {
    admissionFailure = { error };
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const id of skillIds) {
      try { await core.skills.choose(id, false); await core.skills.enabled(id, false); await core.skills.remove(id); }
      catch (error) { errors.push(error); }
    }
    // The native deletion API bounds traversal; this exact fresh path is fixture-owned.
    try { await Rxd.deleteFile('workspace', skillSource); }
    catch (error) { errors.push(error); }
    if (errors.length) {
      const failures = [...(admissionFailure ? [admissionFailure.error] : []), ...errors];
      throw new AggregateError(failures, 'Capacity skill fixture cleanup failed: ' + failures.map(String).join('; '));
    }
  }
  gate.stage('manual-compaction-failure-cancel-success');
  // Real compaction with independently written long committed history, following existing Pi verification fixtures.
  await core.select(null); await core.send('<arxd-capacity-probe tokens="0"/>');
  const compactConversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  assert(!(await core.compact()).compacted, 'No-op compaction cannot invent a reclaimed capacity value');
  await compactConversation.commit(async (tx) => {
    for (let i = 0; i < 3; i++) await tx.appendEntry(UserEntry, compactConversation.id, { model: [{ role: 'user', content: 'history '.repeat(14000), timestamp: Date.now() }] });
  }, BACKGROUND_CONTEXT);
  const large = await settled();
  const original = (await compactConversation.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.id);
  setCapacitySummary('error');
  let failed = false; try { await core.compact(); } catch { failed = true; }
  assert(failed && (await settled()).tokens === large.tokens, 'Failed compaction preserves last effective capacity');
  let entered!: () => void; let release!: () => void;
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const summaryGate = new Promise<void>((resolve) => { release = resolve; });
  setCapacitySummary(async () => { entered(); await summaryGate; });
  const canceled = core.compact(); await enteredGate;
  assert((await settled()).tokens === large.tokens, 'Running summary has not reclaimed committed context');
  await core.cancelCompaction(); release();
  assert((await canceled).cancelled && (await settled()).tokens === large.tokens, 'Canceled compaction does not fabricate a decrease');
  setCapacitySummary('normal');
  assert((await core.compact()).compacted, 'Existing Pi manual compaction commits a real summary/head');
  const compacted = await settled();
  assert(compacted.head !== large.head && compacted.tokens! < large.tokens! && compacted.source === 'estimate', 'Committed head updates occupancy and invalidates old usage anchors');
  const after = (await compactConversation.entries({ order: 'ascending' }, 128, undefined, BACKGROUND_CONTEXT)).items;
  assert(original.every((id) => after.some((entry) => entry.id === id)), 'Capacity projection and compaction preserve original historical entries');
  gate.stage('background-compaction-head-placement');
  // Default background compaction: summary may finish while the provider is still answering.
  await core.select(null); await core.send('<arxd-capacity-probe tokens="0"/>');
  const backgroundConversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  await backgroundConversation.commit(async (tx) => { for (let i = 0; i < 2; i++) await tx.appendEntry(UserEntry, backgroundConversation.id, { model: [{ role: 'user', content: 'history '.repeat(20000), timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  const beforeBackground = await settled();
  assert(beforeBackground.thresholds.actionable && beforeBackground.emphasis === 'background', 'Warning follows actual background threshold and eligible history');
  assert(!(await core.harness.snapshot(LiveDoc, backgroundConversation.id, BACKGROUND_CONTEXT))?.compactions?.length, 'Reading a threshold crossing does not start compaction');
  let enteredRequest!: () => void; let releaseRequest!: () => void;
  const atRequest = new Promise<void>((resolve) => { enteredRequest = resolve; });
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  setCapacityGeneration(async () => { enteredRequest(); await requestGate; });
  const generating = core.send('<arxd-capacity-probe tokens="0"/>'); await atRequest;
  let queued = false;
  for (let i = 0; i < 100; i++) {
    queued = !!(await core.harness.snapshot(InboxDoc, backgroundConversation.id, BACKGROUND_CONTEXT))?.items.some((item) => item.mode === 'write' && item.entry.kind === 'pi.compaction');
    if (queued) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert(queued, 'Real background summary waits for a generation boundary');
  const waiting = await settled();
  assert(waiting.head === beforeBackground.head && waiting.summaryPending && waiting.tokens! >= beforeBackground.tokens!, 'Queued summary retains old effective head and capacity');
  let duplicate = false; try { await core.compact(); } catch { duplicate = true; }
  assert(duplicate, 'Queued summary cannot start duplicate manual compaction');
  releaseRequest(); await generating; setCapacityGeneration();
  const afterBackground = await settled();
  assert(afterBackground.head !== beforeBackground.head && !afterBackground.summaryPending && afterBackground.tokens! < waiting.tokens!, 'Capacity decreases only after background summary head placement');
  gate.stage('blocking-compaction');
  // Default blocking path uses the same committed-head estimator and preserves all raw records.
  await core.select(null); await core.send('<arxd-capacity-probe tokens="0"/>');
  const blockingConversation = (await core.harness.conversation(core.getSnapshot().active!, BACKGROUND_CONTEXT))!;
  await blockingConversation.commit(async (tx) => { for (let i = 0; i < 3; i++) await tx.appendEntry(UserEntry, blockingConversation.id, { model: [{ role: 'user', content: 'history '.repeat(25000), timestamp: Date.now() }] }); }, BACKGROUND_CONTEXT);
  const beforeBlocking = await settled();
  assert(beforeBlocking.emphasis === 'blocking' || beforeBlocking.emphasis === 'over-limit', 'Large committed context reflects actual blocking threshold');
  await core.send('<arxd-capacity-probe tokens="0"/>');
  const afterBlocking = await settled();
  assert(afterBlocking.head !== beforeBlocking.head && afterBlocking.tokens! < beforeBlocking.tokens!, 'Real blocking compaction updates the committed capacity basis');
  // Public Android Pi/storage seam: hostile-size committed fields must degrade
  // before hashing/serialization, then recover when an immutable edit omits them.
  async function rejectedBudget(fragment: string) {
    for (let i = 0; i < 80; i++) {
      const value = (await core.refresh()).capacity;
      if (['stale', 'unavailable'].includes(value.state) && value.reason?.includes(fragment)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Oversized committed capacity field was not rejected: ' + fragment);
  }
  gate.stage('oversized-committed-context-budget');
  const visibleTurns = core.getSnapshot().turns.length;
  // A >1MiB UserEntry would render an impossible user bubble (the composer is
  // capped at MAX_MESSAGE_CHARS = 1 Mi code units, and this fixture is 128 above
  // it) and exercise native layout instead of estimation.
  // A real custom entry contributes the identical user model message to Pi.
  const oversized = await blockingConversation.commit((tx) => tx.appendEntry(blockingConversation.id, { kind: 'arxd.capacity-size-fixture', model: [{ role: 'user', content: 'x'.repeat(1048576 + 128), timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
  const unavailable = await rejectedBudget('single JSON value');
  assert(core.getSnapshot().turns.length === visibleTurns && (await blockingConversation.context(BACKGROUND_CONTEXT)).messages.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.length === 1048576 + 128), 'Oversized fixture is real committed Pi model context without an unrelated visible user bubble');
  assert(unavailable.state !== 'current' && unavailable.model?.id === afterBlocking.model?.id, 'Oversized single committed field degrades explicitly without changing model identity');
  await blockingConversation.commit((tx) => tx.appendEntry(blockingConversation.id, { kind: 'arxd.capacity-fixture-edit', edits: [{ target: oversized.id, action: 'omit' }] }), BACKGROUND_CONTEXT);
  const recovered = await settled();
  assert(recovered.tokens === afterBlocking.tokens, 'Omitting oversized context recovers identical Pi accounting and provider provenance');
  gate.stage('oversized-prompt-budget');
  const instructions = (await blockingConversation.agent(BACKGROUND_CONTEXT)).instructions;
  await blockingConversation.configure({ instructions: 'p'.repeat(1048576 + 128) }, BACKGROUND_CONTEXT);
  try {
    const promptRejected = await rejectedBudget('single JSON value');
    assert(promptRejected.tokens === null && promptRejected.state === 'unavailable', 'Oversized prompt/cache-key context is rejected before synchronous serialization');
  } finally { await blockingConversation.configure({ instructions: instructions ?? null }, BACKGROUND_CONTEXT); }
  assert((await settled()).tokens === recovered.tokens, 'Restoring original prompt configuration recovers the exact context estimate');
  gate.stage('deep-structure-budget');
  let nested: JsonValue = 'trusted depth fixture';
  for (let i = 0; i < 80; i++) nested = { value: nested };
  const deep = await blockingConversation.commit((tx) => tx.appendEntry(blockingConversation.id, { kind: 'arxd.capacity-depth-fixture', model: [fauxAssistantMessage(fauxToolCall('capacity_depth_fixture', { value: nested }), { stopReason: 'toolUse' })] }), BACKGROUND_CONTEXT);
  const deepRejected = await rejectedBudget('JSON depth 64');
  assert(deepRejected.state === 'stale' && deepRejected.tokens === recovered.tokens, 'Deep committed tool arguments retain the previous valid occupancy instead of replacing it');
  await blockingConversation.commit((tx) => tx.appendEntry(blockingConversation.id, { kind: 'arxd.capacity-fixture-edit', edits: [{ target: deep.id, action: 'omit' }] }), BACKGROUND_CONTEXT);
  const compactedForRestart = await settled();
  assert(compactedForRestart.tokens === afterBlocking.tokens, 'Omitting bounded-structure fixtures restores identical committed-context occupancy');
  gate.stage('restart-basis-capture');
  const finalConversation = core.getSnapshot().active;
  await core.select(other);
  const anchoredForRestart = await settled();
  assert(anchoredForRestart.tokens === 64000 && anchoredForRestart.source === 'provider-anchored-estimate', 'An untouched provider-anchored conversation retains its valid usage before restart');
  await core.select(finalConversation); await settled();
  const state = { conversation: finalConversation, capacity: compactedForRestart, anchored: { conversation: other, capacity: anchoredForRestart } };
  const previous = await Rxd.readFile('workspace', '.context-capacity-verification.json').catch(() => undefined);
  await Rxd.writeFile('workspace', '.context-capacity-verification.json', JSON.stringify(state), previous?.sha256 ?? '');
  gate.check();
  publishEvidence(JSON.stringify({ event: 'arxd-context-capacity', verified: true, checks, fixture: { conversation: state.conversation }, capacity: compactedForRestart, mode: 'offline-deterministic/real-android-app-pi' }));
}

async function reopenContextCapacityImpl(core: Workspace, gate: CapacityGate) {
  gate.stage('reopen-anchored-and-compacted-context');
  const state = JSON.parse((await Rxd.readFile('workspace', '.context-capacity-verification.json')).text!);
  async function recovered(conversation: Parameters<Workspace['select']>[0]) {
    await core.select(conversation);
    for (let i = 0; i < 80 && core.getSnapshot().capacity.state !== 'current'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); await core.refresh(); }
    return core.getSnapshot().capacity;
  }
  if (!state.anchored) throw new Error('Restart fixture has no independently anchored conversation');
  const anchored = await recovered(state.anchored.conversation);
  if (anchored.state !== 'current' || anchored.source !== 'provider-anchored-estimate' || anchored.tokens !== state.anchored.capacity.tokens || anchored.configurationRevision !== state.anchored.capacity.configurationRevision || anchored.revision !== state.anchored.capacity.revision) throw new Error('Fresh-process provider usage anchor changed without a model/context change');
  const capacity = await recovered(state.conversation);
  if (capacity.state !== 'current' || capacity.tokens !== state.capacity.tokens || capacity.limit !== state.capacity.limit || capacity.revision !== state.capacity.revision) throw new Error('Fresh-process capacity basis changed without context mutation');
  gate.check();
  publishEvidence(JSON.stringify({ event: 'arxd-context-capacity-reopen', verified: true, capacity, anchored, mode: 'fresh-process/real-android-pi-storage' }));
}

function capacityDiagnostic(core: Workspace) {
  const value = core.getSnapshot().capacity;
  return { state: value.state, tokens: value.tokens, limit: value.limit, ratio: value.ratio, source: value.source, usageTokens: value.usageTokens, trailingTokens: value.trailingTokens, model: value.model, configurationRevision: value.configurationRevision, revision: value.revision, head: value.head, reason: value.reason, anchor: value.anchorDiagnostics };
}
async function withCapacityFailure(core: Workspace, phase: 'initial' | 'reopen', run: (gate: CapacityGate) => Promise<void>) {
  let stage = 'starting', expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatchdog!: (error: Error) => void;
  const watchdog = new Promise<never>((_, reject) => { rejectWatchdog = reject; });
  const failure = () => new Error('Capacity verification stage exceeded 60 seconds: ' + stage);
  const gate: CapacityGate = {
    check() { if (expired) throw failure(); },
    stage(name) {
      this.check(); stage = name; clearTimeout(timer);
      publishEvidence(JSON.stringify({ event: 'arxd-context-capacity-progress', phase, stage, at: Date.now(), capacity: capacityDiagnostic(core) }));
      timer = setTimeout(() => { expired = true; rejectWatchdog(failure()); }, 60000);
    },
  };
  try { gate.stage('starting'); await Promise.race([run(gate), watchdog]); }
  catch (error) { publishEvidence(JSON.stringify({ event: 'arxd-context-capacity-failed', verified: false, phase, stage, error: safeRequestError(error), capacity: capacityDiagnostic(core) })); throw error; }
  finally { clearTimeout(timer); }
}
export function verifyContextCapacity(core: Workspace) { requireVerification(); return withCapacityFailure(core, 'initial', (gate) => verifyContextCapacityImpl(core, gate)); }
export function reopenContextCapacity(core: Workspace) { requireVerification(); return withCapacityFailure(core, 'reopen', (gate) => reopenContextCapacityImpl(core, gate)); }
