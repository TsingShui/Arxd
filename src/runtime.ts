import { getRandomValues, randomUUID } from 'expo-crypto';
import clone from '@ungap/structured-clone';

// Pi's portable core expects these standard APIs. Keep native randomness rather
// than substituting Math.random for persisted conversation identities.
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues, randomUUID }, configurable: true });
}
if (!globalThis.structuredClone) {
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (options?.transfer?.length) throw new Error('Transferable structuredClone is unavailable in this native JS host');
    return clone(value);
  };
}
if (!Promise.withResolvers) {
  Promise.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
  };
}
