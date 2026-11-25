import { Languages } from './icons.js';
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
