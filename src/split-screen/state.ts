export type SplitScreenState = {
  supported: boolean; multiWindow: boolean; packageName: string | null;
  requestedAt: number | null; elapsedMs: number | null; error: string | null;
};

/** Observing Arxd's window never proves that the selected app is its neighbor. */
export function splitScreenLabel(state?: SplitScreenState): string {
  if (!state) return 'Checking';
  if (!state.supported) return 'Automatic split-screen launch requires Android 12L or newer.';
  if (state.multiWindow) return 'Arxd is in multi-window mode. Confirm the selected app is beside it.';
  if (state.requestedAt !== null) return (state.elapsedMs ?? 0) >= 4000
    ? 'Split-screen was not confirmed. The app may have opened normally. Use manual split-screen.'
    : 'Split-screen requested';
  return 'Split-screen ready';
}
export function splitScreenError(code?: string | null): string {
  switch (code) {
    case 'unsupported': return 'Automatic split-screen launch requires Android 12L or newer.';
    case 'not_foreground': return 'Keep Arxd visible before requesting split screen.';
    case 'invalid_app': return 'Choose an enabled launcher app other than Arxd.';
    default: return 'The system could not open this app beside Arxd.';
  }
}
