import { AppState } from 'react-native';
import Rxd from '../../modules/rxd';

/** Coalesced hints, plus authoritative resume/15s fallback scans for missed events. */
export function watchSharedSkills(changed: () => void) {
  let closed = false, probing = false, lastRevision = '', lastScan = 0;
  async function probe(force = false) {
    if (closed || probing || AppState.currentState !== 'active') return;
    probing = true;
    try {
      const revision = await Rxd.skillsRevision();
      if (!closed && (force || revision !== lastRevision || Date.now() - lastScan >= 15000)) {
        lastRevision = revision; lastScan = Date.now(); changed();
      }
    } finally { probing = false; }
  }
  const interval = setInterval(() => { void probe().catch(() => undefined); }, 1000);
  const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void probe(true).catch(() => undefined); });
  return () => { closed = true; clearInterval(interval); listener.remove(); };
}
