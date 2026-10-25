export type VirtualDisplayState = {
  phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unsupported';
  packageName: string | null; component: string | null; displayId: number | null; taskId: number | null; uid: number | null;
  width: number; height: number; densityDpi: number; error: string | null;
};
export type LaunchableApp = { packageName: string; label: string };
export function virtualDisplayReady(state?: VirtualDisplayState): boolean {
  return !!state && state.phase === 'running' && state.uid === 2000 && Number.isInteger(state.displayId) &&
    state.displayId! > 0 && Number.isInteger(state.taskId) && state.taskId! > 0 && !!state.packageName &&
    !!state.component?.startsWith(state.packageName + '/') && state.width > 0 && state.height > 0;
}
export function virtualDisplayLabel(state?: VirtualDisplayState): string {
  if (!state) return 'Not checked yet';
  if (virtualDisplayReady(state)) return 'Virtual display active';
  if (state.phase === 'starting') return 'Starting';
  if (state.phase === 'stopping') return 'Stopping';
  if (state.phase === 'unsupported') return 'Virtual display unavailable';
  if (state.phase === 'error') return 'Virtual display stopped with an error';
  return 'Virtual display stopped';
}
export const virtualDisplayErrors: Record<string, string> = {
  unsupported: 'This virtual display controller requires Android 15 or newer and shell display permissions.',
  adb_required: 'Connect and verify ADB before launching an app on a virtual display.',
  invalid_app: 'Choose an enabled launcher app other than Arxd in the primary Android user.',
  invalid_size: 'The virtual display size or density exceeds its limits.',
  app_running: 'This app already has a task. Close it manually before starting this isolated test.',
  task_budget: 'The device task or app list exceeds the supported limit.',
  already_running: 'Stop the current virtual display before starting another.',
  start_failed: 'Could not start the virtual display.',
  launch_failed: 'The app did not start on the requested virtual display. No primary-display fallback was attempted.',
  controller_failed: 'The virtual display controller failed.',
  invalid_reply: 'The controller did not return a matching shell-owned display and app task.',
  session_lost: 'The virtual display session ended. Reconnect ADB if needed; there is no automatic restart.',
  not_running: 'No virtual display is running.',
  no_frame: 'No preview frame is available yet. Try refreshing the preview.',
  cancelled: 'Virtual display startup was cancelled.',
  cleanup_pending: 'Cleanup could not be confirmed. The controller lease will expire; check again shortly.',
};
export function virtualDisplayError(code: string): string { return virtualDisplayErrors[code] ?? 'The virtual display controller failed.'; }
