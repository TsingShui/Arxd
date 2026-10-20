import { getLocales, useLocales } from 'expo-localization';
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getAndroidWorkspace } from '../workspace/android';
import { activeLocale, resolveLanguage, setActiveLocale, translate, type LanguageMode, type Locale } from './base.ts';

export { translate, resolveLocale, resolveLanguage, type LanguageMode, type Locale } from './base.ts';

const initialLocale = resolveLanguage('system', getLocales()[0]?.languageCode);
setActiveLocale(initialLocale);
const LanguageContext = createContext<{ language: LanguageMode; locale: Locale }>({ language: 'system', locale: initialLocale });

/** One language owner for all routes and non-React text. The workspace stores
 * only the user's override; following Android still reacts to OS changes. */
export function I18nProvider({ children, standalone = false }: { children: ReactNode; standalone?: boolean }) {
  const locales = useLocales();
  const systemLanguage = locales[0]?.languageCode;
  const [language, setLanguage] = useState<LanguageMode>('system');
  const [ready, setReady] = useState(standalone);
  if (standalone && !ready) setReady(true);
  const locale = resolveLanguage(language, systemLanguage);

  useEffect(() => {
    if (standalone) return;
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void getAndroidWorkspace().then((core) => {
      if (!alive) return;
      const update = (value: ReturnType<typeof core.getSnapshot>) => {
        if (!alive) return;
        setActiveLocale(resolveLanguage(value.language, systemLanguage));
        setLanguage(value.language);
      };
      update(core.getSnapshot());
      unsubscribe = core.subscribe(update);
      setReady(true);
    }).catch(() => { if (alive) { setActiveLocale(resolveLanguage('system', systemLanguage)); setReady(true); } });
    return () => { alive = false; unsubscribe?.(); };
  }, [standalone, systemLanguage]);

  useEffect(() => {
    setActiveLocale(locale);
    if (!ready || standalone) return;
    // Refresh translated projections without changing stored user text, starting
    // requests, or reconfiguring a task that is already running.
    let alive = true;
    void getAndroidWorkspace().then((core) => { if (alive) return core.refresh(); }).catch(() => undefined);
    return () => { alive = false; };
  }, [locale, ready, standalone]);

  return createElement(LanguageContext.Provider, { value: { language, locale } }, ready ? children : null);
}

export function localeNow(): Locale { return activeLocale(); }

export function useI18n() {
  const { language, locale } = useContext(LanguageContext);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars),
    [locale],
  );
  return { language, locale, t };
}
