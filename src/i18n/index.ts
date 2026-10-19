import { getLocales, useLocales } from 'expo-localization';
import { useCallback, useEffect } from 'react';
import { resolveLocale, setActiveLocale, translate, type Locale } from './base.ts';

export { translate, resolveLocale, type Locale } from './base.ts';

export function localeNow(): Locale {
  const locale = resolveLocale(getLocales()[0]?.languageCode);
  setActiveLocale(locale);
  return locale;
}

export function useI18n() {
  const locales = useLocales();
  const locale = resolveLocale(locales[0]?.languageCode);
  useEffect(() => { setActiveLocale(locale); }, [locale]);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars),
    [locale],
  );
  return { locale, t };
}
