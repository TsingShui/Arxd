import type { Colors } from '../ui/theme';

/** Context windows read short: 128000 -> "128k", 1000000 -> "1m". */
export const contextLabel = (tokens: number): string => tokens >= 1000000 ? `${Number((tokens / 1000000).toFixed(1))}m` : `${Math.round(tokens / 1000)}k`;

/** Context size has its own ramp, so it never competes with the accent or the level tint. */
export const contextTone = (tokens: number, c: Colors): string => tokens >= 750000 ? c.contextLarge : tokens >= 250000 ? c.contextMedium : c.contextSmall;
