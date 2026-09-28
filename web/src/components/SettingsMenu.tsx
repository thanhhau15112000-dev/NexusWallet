import { Languages } from './icons.js';
import { useI18n } from '../i18n/context.js';

/** One-click EN/VI toggle for the page header; shows the active language. */
export function LanguageToggle() {
  const { lang, setLanguage, dict } = useI18n();
  return (
    <button
      type="button"
      className="lang-toggle-btn"
      onClick={() => setLanguage(lang === 'en' ? 'vi' : 'en')}
      title={dict.topbar.switchLanguage}
      aria-label={dict.topbar.switchLanguage}
    >
      <Languages size={16} />
      <span>{lang.toUpperCase()}</span>
    </button>
  );
}
