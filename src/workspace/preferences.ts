import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { defineDoc, type ConversationId } from '@earendil-works/pi-durable';
import { arxdInstructions, composeCustomInstructions } from '../agent/instructions.ts';
import { isLocalModelId } from '../agent/local-provider.ts';
import { MAX_IMPORT_BYTES, MIN_IMPORT_BYTES } from './limits.ts';

export type Palette = 'fire' | 'spring';
export type AppearanceMode = 'system' | 'light' | 'dark';
export type MotionMode = 'system' | 'reduced';
export type ModelMode = string;
export type PromptProfile = { id: string; name: string; text: string; updatedAt: number };
export type Preferences = {
  model?: ModelMode; testModelMigrated?: boolean;
  promptProfiles?: PromptProfile[]; activePromptCloud?: string | null; activePromptLocal?: string | null;
  palette: Palette; appearance?: AppearanceMode; motion?: MotionMode; importLimit?: number;
  thinking?: ModelThinkingLevel; thinkingByModel?: Record<string, ModelThinkingLevel>;
  active: ConversationId | null; conversations: ConversationId[];
};

export const PreferencesDoc = defineDoc<Preferences>({ kind: 'arxd.preferences', version: 1, scope: 'session', initial: () => ({ palette: 'fire', appearance: 'system', motion: 'system', deletions: [], active: null, conversations: [] }) });

/// A stored limit is only honoured when it is a usable byte count inside the app ceiling;
/// anything else falls back to the ceiling instead of silently shrinking imports.
export const importLimitOf = (preferences: Readonly<Preferences> | undefined) => {
  const value = preferences?.importLimit;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_IMPORT_BYTES && value <= MAX_IMPORT_BYTES ? value : MAX_IMPORT_BYTES;
};

export function appearanceOf(preferences: Readonly<Preferences> | undefined): AppearanceMode {
  return preferences?.appearance ?? (preferences ? preferences.palette === 'spring' ? 'light' : 'dark' : 'system');
}

export function instructionText(mode: ModelMode | undefined, preferences: Readonly<Preferences> | undefined) {
  if (!mode || mode === 'test') return undefined;
  const local = isLocalModelId(mode);
  const id = local ? preferences?.activePromptLocal : preferences?.activePromptCloud;
  const custom = id ? preferences?.promptProfiles?.find((profile) => profile.id === id)?.text : undefined;
  return composeCustomInstructions(arxdInstructions(local), custom);
}

// Explicit choices are remembered per model. A model never inherits another
// model's level; only its own cached value (or the legacy single preference
// recorded for that same model) seeds it, otherwise Pi's first level applies.
export function rememberedThinking(preferences: Readonly<Preferences> | undefined, mode: ModelMode | undefined, levels: readonly ModelThinkingLevel[]): ModelThinkingLevel {
  const remembered = mode ? preferences?.thinkingByModel?.[mode] : undefined;
  const legacy = mode && preferences?.model === mode ? preferences?.thinking : undefined;
  return remembered && levels.includes(remembered) ? remembered : legacy && levels.includes(legacy) ? legacy : levels[0];
}

export function selectModelPreference(prefs: Preferences, value: ModelMode): void {
  // Materialize the legacy single preference under the model it was chosen
  // for before the active model id moves on.
  if (prefs.thinking && prefs.model && prefs.model !== value && !prefs.thinkingByModel?.[prefs.model])
    prefs.thinkingByModel = { ...(prefs.thinkingByModel ?? {}), [prefs.model]: prefs.thinking };
  prefs.model = value;
  prefs.testModelMigrated = true;
}
