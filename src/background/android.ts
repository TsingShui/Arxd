import { requireNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';
import { sessionRunner } from './session';

type Native = {
  status(): { enabled: boolean; active: boolean; stopping: boolean; generation: string | null }; setEnabled(enabled: boolean): void;
  acquire(id: string): Promise<void>; release(id: string): void;
  ready(generation: string): void; stop(): void;
};
let cached: Native | undefined;
export const backgroundSession = () => cached ??= requireNativeModule<Native>('ArxdAgentSession');
export function backgroundActive() { try { return backgroundSession().status().active; } catch { return false; } }
export async function enableBackground(enabled: boolean) {
  if (enabled && Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const allowed = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (allowed !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Enable Arxd notifications to start a visible long-running service');
  }
  backgroundSession().setEnabled(enabled);
}
export const agentSessions = sessionRunner({
  enabled: () => backgroundSession().status().enabled,
  acquire: (id) => backgroundSession().acquire(id),
  release: (id) => backgroundSession().release(id),
}, () => globalThis.crypto.randomUUID());
