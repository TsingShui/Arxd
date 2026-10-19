/**
 * Native-free import ceilings. The Android adapter enforces the same ceiling, so
 * a configured value can only lower what one capture may contain.
 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024;
export const MIN_IMPORT_BYTES = 1024 * 1024;

/**
 * One user message ceiling. Mainstream agents do not cap a message at chat-sized
 * lengths: Codex CLI keeps the same order of magnitude (`1 << 20`) purely as a
 * safety bound while overflow is left to the context budget and compaction. Arxd
 * matches it so one paste cannot monopolize the window, and it agrees with the
 * 1 MiB single-value budget in `context-capacity.ts`.
 */
export const MAX_MESSAGE_CHARS = 1 << 20;
