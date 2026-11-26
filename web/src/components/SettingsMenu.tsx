import { useState } from 'react';
import { Languages, Moon, Sun } from './icons.js';
import { useI18n } from '../i18n/context.js';
import { Button } from './ui/button.js';

/** One-click EN/VI toggle for the page header; shows the active language. */
export function LanguageToggle() {
  const { lang, setLanguage, dict } = useI18n();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 px-2.5 text-xs font-medium text-ink"
      onClick={() => setLanguage(lang === 'en' ? 'vi' : 'en')}
      title={dict.topbar.switchLanguage}
      aria-label={dict.topbar.switchLanguage}
    >
      <Languages size={14} className="text-muted" aria-hidden="true" />
      <span>{lang.toUpperCase()}</span>
    </Button>
  );
}

type Theme = 'light' | 'dark';
const THEME_KEY = 'nexus.theme';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Light/dark switch. index.html applies the saved (or system) theme before paint; this flips and saves it. */
export function ThemeToggle() {
  const { dict } = useI18n();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? dict.topbar.switchToDark : dict.topbar.switchToLight;

  const toggle = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be blocked; the theme still applies for this page load.
    }
    setTheme(next);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 w-8 px-0 text-muted"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
    </Button>
  );
}
