import { en } from './en.ts';

/**
 * Locale plumbing with no React Native dependency, so agent and workspace
 * modules (and the Node host tests) can translate without loading native code.
 * The app sets the active locale from `expo-localization` at startup and
 * whenever it changes; everything else reads it here.
 */
export type Locale = 'zh' | 'en';

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

/** Chinese is the source language: `t()` takes the Chinese string as its key. */
export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  const template = locale === 'zh' ? text : en[text] ?? text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => (key in vars ? String(vars[key]) : match));
}

/** Translate with the active locale — the non-component counterpart of `t`. */
export function tr(text: string, vars?: Record<string, string | number>): string {
  return translate(active, text, vars);
}
