import { Languages } from './icons.js';
import { cn } from '../lib/utils.js';
import { useI18n } from '../i18n/context.js';
import { Button } from './ui/button.js';

/** One-click EN/VI toggle for the page header; shows the active language. */
export function LanguageToggle(props: { dark?: boolean }) {
  const { lang, setLanguage, dict } = useI18n();
  return (
    <Button
      type="button"
      variant={props.dark ? 'darkOutline' : 'outline'}
      size="sm"
      className={cn(
        'h-8 gap-1.5 px-2.5 font-mono text-xs font-medium',
        props.dark ? 'text-obsidian-ink' : 'text-ink',
      )}
      onClick={() => setLanguage(lang === 'en' ? 'vi' : 'en')}
      title={dict.topbar.switchLanguage}
      aria-label={dict.topbar.switchLanguage}
    >
      <Languages size={14} className={props.dark ? 'text-signal' : 'text-muted'} aria-hidden="true" />
      <span>{lang.toUpperCase()}</span>
    </Button>
  );
}
