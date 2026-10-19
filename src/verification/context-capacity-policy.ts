import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, DEFAULT_COMPACTION_POLICY, Harness } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openDatabaseAsync } from 'expo-sqlite';
import { ArxdSqlite } from '../agent/sqlite';
import { createCapacityProjection } from '../workspace/context-capacity';
import { requireVerification } from './access';

/** Actual Android SQLite/Pi policy settings. No model, section hook or tool runs. */
export async function verifyCapacityPolicyAvailability(check: (value: unknown, label: string) => void) {
  requireVerification();
  const database = new ArxdSqlite(await openDatabaseAsync('arxd-capacity-policy-' + globalThis.crypto.randomUUID() + '.sqlite'));
  const policy = { ...DEFAULT_COMPACTION_POLICY };
  const models = createModels(); models.setProvider(fauxProvider({ api: 'arxd-capacity-policy-v1', models: [{ id: 'policy-model', contextWindow: 128000 }] }).provider);
  // Pi owns the adapter after open; never close the underlying Expo handle again.
  // The adapter's idempotent close also covers storage/harness initialization failure.
  let cleanup = () => database.close();
  let failure: { error: unknown } | undefined;
  try {
    const harness = await Harness.open(await SqliteStorage.open(database), { models, registry: createRegistry(), settings: { compaction: policy } }, BACKGROUND_CONTEXT);
    cleanup = () => harness.close(BACKGROUND_CONTEXT);
    const projection = createCapacityProjection({ harness, models, policy: () => ({ ...policy }) }, () => undefined);
    const unsubscribe = harness.subscribeCommits((publication) => projection.observe(publication));
    cleanup = async () => { unsubscribe(); projection.close(); await harness.close(BACKGROUND_CONTEXT); };
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'policy-model' } } });
    await conversation.commit(async (tx) => {
      for (let i = 0; i < 3; i++) await tx.appendEntry(conversation.id, { kind: 'arxd.capacity-policy-history', model: [{ role: 'user', content: 'p'.repeat(105000), timestamp: Date.now() }] });
    }, BACKGROUND_CONTEXT);
    async function value() {
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      for (let i = 0; i < 80; i++) {
        const capacity = projection.read(conversation, agent);
        if (capacity.state === 'current') return capacity;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Actual Android policy projection did not settle');
    }
    const active = await value();
    check(active.tokens === 90000 && active.thresholds.actionable && active.emphasis === 'background', 'Separate actual Android Pi settings fixture has 90000 committed tokens and an actionable 78848 background threshold');
    const history = (await conversation.context(BACKGROUND_CONTEXT)).entries.length;
    policy.keepRecentTokens = 200000;
    const noPrefix = await value();
    check(!noPrefix.thresholds.actionable && noPrefix.emphasis === 'normal', 'A valid threshold without a sufficiently old compressible prefix remains nonactionable');
    policy.keepRecentTokens = DEFAULT_COMPACTION_POLICY.keepRecentTokens;
    policy.enabled = false;
    const disabled = await value();
    check(!disabled.thresholds.enabled && !disabled.thresholds.actionable && disabled.thresholds.background === null && disabled.thresholds.blocking === null && disabled.emphasis === 'normal', 'Actual disabled Harness compaction settings expose no actionable warning threshold');
    policy.enabled = true; policy.reserveTokens = 128000;
    const impossible = await value();
    check(impossible.thresholds.enabled && !impossible.thresholds.actionable && impossible.thresholds.blocking === null && impossible.emphasis === 'normal', 'A nonpositive available compaction boundary remains nonactionable with normal emphasis');
    policy.reserveTokens = Number.NaN;
    const invalid = await value();
    check(!invalid.thresholds.actionable && invalid.thresholds.background === null && invalid.thresholds.blocking === null && invalid.thresholds.reserve === 0 && invalid.emphasis === 'normal', 'Unavailable malformed policy accounting has finite inactive thresholds without NaN display values');
    policy.reserveTokens = DEFAULT_COMPACTION_POLICY.reserveTokens; policy.backgroundTokens = 0;
    const noBackground = await value();
    check(noBackground.thresholds.background === null && noBackground.thresholds.blocking === 111616 && noBackground.emphasis === 'normal', 'Actual zero background allowance disables that warning while preserving the valid blocking boundary');
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    check(!inspection.tasks.length && !inspection.submissions.length && (await conversation.context(BACKGROUND_CONTEXT)).entries.length === history, 'Inspecting all policy states starts no generation, task, submission or compaction and preserves committed entries');
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try { await cleanup(); }
    catch (cleanupError) {
      if (failure) throw new AggregateError([failure.error, cleanupError], `Capacity policy verification failed: ${String(failure.error)}; cleanup failed: ${String(cleanupError)}`);
      throw cleanupError;
    }
  }
}
