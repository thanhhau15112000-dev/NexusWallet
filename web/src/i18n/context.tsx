import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale, TranslationDictionary } from './types.js';
import { en } from './locales/en.js';
import { vi } from './locales/vi.js';

const STORAGE_KEY = 'nexus.lang';

const dictionaries: Record<Locale, TranslationDictionary> = { en, vi };

export type I18nContextValue = {
  lang: Locale;
  dict: TranslationDictionary;
  setLanguage: (lang: Locale) => void;
  toggleLanguage: () => void;
  interpolate: (template: string, params: Record<string, string | number>) => string;
};

const LanguageContext = createContext<I18nContextValue | null>(null);

function getInitialLanguage(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'vi') return saved;
  } catch {
    // localStorage blocked
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('vi')) {
    return 'vi';
  }
  return 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Locale>(getInitialLanguage);

  const setLanguage = (next: Locale) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
  };

  const toggleLanguage = () => {
    setLanguage(lang === 'en' ? 'vi' : 'en');
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const dict = useMemo(() => dictionaries[lang], [lang]);

  const interpolate = (template: string, params: Record<string, string | number>): string => {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }
    return result;
  };

  const value = useMemo(
    () => ({
      lang,
      dict,
      setLanguage,
      toggleLanguage,
      interpolate,
    }),
    [lang, dict],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useI18n must be used within a LanguageProvider');
  }
  return ctx;
}
