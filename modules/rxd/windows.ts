import { requireNativeModule } from 'expo';
import type { LaunchableApp } from '../../src/virtual-display/state';
import type { SplitScreenState } from '../../src/split-screen/state';

type NativeAppWindows = {
  launcherApps(query: string, offset: number): Promise<{ apps: LaunchableApp[]; nextOffset: number | null }>;
  splitStatus(): Promise<SplitScreenState>;
  launchAdjacent(packageName: string): Promise<SplitScreenState>;
};
let native: NativeAppWindows | undefined;
export function appWindows(): NativeAppWindows { return native ??= requireNativeModule<NativeAppWindows>('ArxdAppWindows'); }
