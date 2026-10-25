import { requireNativeModule } from 'expo';
import type { AdbStatus } from '../../src/adb/state';
import type { LaunchableApp, VirtualDisplayState } from '../../src/virtual-display/state';

type NativeAdb = {
  status(): AdbStatus;
  pair(port: number, code: string): Promise<AdbStatus>;
  connect(port: number): Promise<AdbStatus>;
  check(): Promise<AdbStatus>;
  disconnect(): Promise<AdbStatus>;
  openSettings(): Promise<boolean>;
  virtualDisplayStatus(): VirtualDisplayState;
  virtualDisplayApps(query: string, offset: number): Promise<{ apps: LaunchableApp[]; nextOffset: number | null }>;
  startVirtualDisplay(packageName: string): Promise<VirtualDisplayState>;
  stopVirtualDisplay(): Promise<VirtualDisplayState>;
  virtualDisplaySnapshot(): Promise<{ image: string | null; error: string | null }>;
};
let native: NativeAdb | undefined;
// Lazy resolution keeps older development binaries usable outside this new route.
export function adb(): NativeAdb { return native ??= requireNativeModule<NativeAdb>('ArxdAdb'); }
