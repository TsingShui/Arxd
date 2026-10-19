import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily, type ConversationId, type Harness } from '@earendil-works/pi-durable';

export type PhaseKind = 'waiting' | 'thinking' | 'answer' | 'tool';
export type PhaseTiming = {
  key: string; kind: PhaseKind; process: string; startedAt: number;
  state: 'running' | 'done' | 'interrupted'; endedAt?: number; durationMs?: number;
};
export type TurnTiming = {
  process: string; startedAt: number; phases: PhaseTiming[];
  endedAt?: number; incomplete: boolean; truncated: boolean;
};
export type ActivePhase = { key: string; kind: PhaseKind; evidenceAt?: number };

export const TimingDoc = defineDocFamily<TurnTiming, null>({
  kind: 'arxd.turn-timing', version: 1, family: true, scope: 'conversation',
  history: 'latest', fork: 'initial',
  initial: () => ({ process: '', startedAt: 0, phases: [], incomplete: false, truncated: false }),
});

/** Only observed phase transitions write; rendering clocks never touch storage. */
export function createTimingTracker(harness: Harness) {
  const process = globalThis.crypto.randomUUID();
  const openedAt = Date.now();
  const clocks = new Map<string, number>();
  return {
    process,
    openedAt,
    async update(conversation: ConversationId, turn: string, startedAt: number,
      active: ActivePhase[], completed: Map<string, number | undefined>, endedAt?: number, settled = false) {
      const previous = await harness.snapshot(TimingDoc, conversation, turn, BACKGROUND_CONTEXT);
      const next: TurnTiming = previous ? { ...previous, phases: previous.phases.map((phase) => ({ ...phase })) }
        : { process, startedAt, phases: [], incomplete: false, truncated: false };
      const now = Date.now();
      const clock = performance.now();
      const prefix = `${conversation}/${turn}/`;
      const observedEnd = settled && previous?.process === process && previous.phases.some((phase) => phase.state === 'running');
      if (next.process !== process && next.phases.some((phase) => phase.state === 'running')) {
        for (const phase of next.phases) if (phase.state === 'running') {
          phase.state = 'interrupted'; next.incomplete = true;
        }
        next.process = process;
      }
      for (const phase of next.phases) {
        const measured = completed.get(phase.key);
        if (measured !== undefined && phase.state !== 'interrupted') {
          phase.durationMs = measured; phase.state = 'done';
          clocks.delete(prefix + phase.key);
        } else if (phase.state === 'running' && !active.some((value) => value.key === phase.key)) {
          const begin = clocks.get(prefix + phase.key);
          if (begin !== undefined) {
            phase.durationMs = Math.max(0, Math.round(clock - begin));
            phase.endedAt = now; phase.state = 'done';
          } else { phase.state = 'interrupted'; next.incomplete = true; }
          clocks.delete(prefix + phase.key);
        }
      }
      for (const phase of active) {
        if (next.phases.some((value) => value.key === phase.key)) continue;
        // A persisted partial from a previous App process is not fresh thinking.
        if (phase.evidenceAt !== undefined && phase.evidenceAt < openedAt) continue;
        if (next.phases.length >= 128) { next.truncated = true; continue; }
        next.phases.push({ key: phase.key, kind: phase.kind, process, startedAt: now, state: 'running' });
        next.process = process;
        clocks.set(prefix + phase.key, clock);
      }
      if (endedAt !== undefined) next.endedAt = endedAt;
      else if (observedEnd) next.endedAt = now;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        await harness.commit(async (tx) => {
          const draft = await tx.doc(TimingDoc, conversation, turn, null);
          draft.process = next.process; draft.startedAt = next.startedAt;
          draft.phases = next.phases; draft.incomplete = next.incomplete; draft.truncated = next.truncated;
          if (next.endedAt !== undefined) draft.endedAt = next.endedAt;
        }, BACKGROUND_CONTEXT);
      }
      return next;
    },
  };
}
