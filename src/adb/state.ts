export type AdbPhase = 'disconnected' | 'pairing' | 'connecting' | 'checking' | 'connected';
export type AdbStatus = { supported: boolean; phase: AdbPhase; paired: boolean; port: number | null; uid: number | null; checkedAt: number | null; error: string | null };

/** Pairing history alone never means authorized; only a freshly verified shell channel does. */
export function adbReady(state?: AdbStatus): boolean {
  return !!state?.supported && state.phase === 'connected' && state.uid === 2000 && Number.isFinite(state.checkedAt) && state.checkedAt! > 0;
}
export function adbBusy(state?: AdbStatus): boolean {
  return !!state && ['pairing', 'connecting', 'checking'].includes(state.phase);
}
export function adbPort(text: string): number | undefined {
  const value = text.trim();
  if (!/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
}
export function adbLabel(state?: AdbStatus): string {
  if (!state) return 'Not checked yet';
  if (!state.supported) return 'Unavailable';
  if (adbReady(state)) return 'ADB shell connected';
  if (state.phase === 'pairing') return 'Pairing';
  if (state.phase === 'connecting') return 'Connecting';
  if (state.phase === 'checking') return 'Checking';
  return state.paired ? 'Paired, not connected' : 'Not paired';
}
export const adbErrors: Record<string, string> = {
  unsupported: 'Wireless ADB requires Android 11 or newer.',
  invalid_port: 'Enter a port between 1 and 65535.',
  invalid_code: 'Enter the six-digit pairing code.',
  busy: 'An ADB operation is already running.',
  pair_first: 'Pair this device before connecting.',
  pairing_failed: 'Pairing failed. Keep the pairing dialog open and check its port and code.',
  connection_failed: 'Could not connect. Use the connection port, not the pairing port, and keep Wireless debugging on.',
  connection_lost: 'ADB connection lost. Check Wireless debugging and reconnect.',
  not_shell: 'The connection did not return Android shell UID 2000.',
  timeout: 'ADB request timed out. Check the port and retry.',
};
export function adbError(code: string): string { return adbErrors[code] ?? 'ADB operation failed.'; }
