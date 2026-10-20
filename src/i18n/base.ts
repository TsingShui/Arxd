import { en } from './en.ts';
import { zh } from './zh.ts';
import { legacyKeys } from './legacy-keys.ts';

/**
 * Locale plumbing with no React Native dependency, so agent and workspace
 * modules (and the Node host tests) can translate without loading native code.
 * The root provider resolves the saved override against `expo-localization`
 * before product routes mount; non-React text reads the same active locale.
 */
export type Locale = 'zh' | 'en';
export type LanguageMode = 'system' | Locale;

export function languageModeOf(value: unknown): LanguageMode {
  return value === 'zh' || value === 'en' ? value : 'system';
}

export function resolveLanguage(mode: LanguageMode, languageCode: string | null | undefined): Locale {
  return mode === 'system' ? resolveLocale(languageCode) : mode;
}

let active: Locale = 'zh';

export function resolveLocale(languageCode: string | null | undefined): Locale {
  return languageCode?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setActiveLocale(locale: Locale) {
  active = locale;
}

export function activeLocale(): Locale {
  return active;
}

/** Translation APIs use stable English source strings as keys. Chinese runtime
 * errors are temporarily recognized through a compatibility lookup; unknown
 * messages remain unchanged rather than being mistaken for keys. */
export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  const key = Object.hasOwn(en, text) ? text : legacyKeys[text];
  const template = key ? (locale === 'zh' ? zh[key] : en[key]) ?? text : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => (key in vars ? String(vars[key]) : match));
}

/** Translate with the active locale — the non-component counterpart of `t`. */
export function tr(text: string, vars?: Record<string, string | number>): string {
  return translate(active, text, vars);
}
