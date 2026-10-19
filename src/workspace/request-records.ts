import { defineDoc } from '@earendil-works/pi-durable';
import type { RequestFailure } from '../agent/request-retry';

export type RequestRecord = { requestId: string; attempt: number; at: number; outcome: 'failed' | 'completed'; failure?: RequestFailure; partial?: string };
/** Separate from the model transcript: background compaction must not append to
 * a busy conversation. A bounded durable ledger retains its own diagnostics. */
export const RequestRecordsDoc = defineDoc<{ records: RequestRecord[] }>({ kind: 'arxd.requests', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ records: [] }) });
