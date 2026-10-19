import Rxd from '../../modules/rxd';

/** Synchronous native build guard: call before any verification side effect. */
export function verificationEnabled(): boolean { return Rxd.verificationEnabled(); }
export function requireVerification(): void {
  if (!verificationEnabled()) throw new Error('Verification is disabled in this build');
}
export function verificationRequest(path: string, action: unknown): boolean {
  return path.startsWith('/verify') || (Array.isArray(action) ? action : [action]).some((value) => typeof value === 'string' && value.startsWith('ui-'));
}
