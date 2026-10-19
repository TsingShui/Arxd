import Rxd from '../../modules/rxd';

/** Verification reports are byte-bounded and survive Android's per-log-line cap. */
export function publishEvidence(json: string) {
  const size = new TextEncoder().encode(json).length;
  if (size > 196608) throw new Error('Verification report exceeds 192 KiB');
  JSON.parse(json);
  if (size <= 3000) { void Rxd.report(json); return; }
  const id = globalThis.crypto.randomUUID();
  const parts = Math.ceil(json.length / 700);
  for (let index = 0; index < parts; index++) {
    void Rxd.report(JSON.stringify({ event: 'arxd-evidence-part', id, index, parts, data: json.slice(index * 700, (index + 1) * 700) }));
  }
}
