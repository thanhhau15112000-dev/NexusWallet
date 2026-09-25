import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe, Settings, X } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import type { Locale } from '../i18n/types.js';

export function SettingsMenu() {
  const { lang, setLanguage, dict } = useI18n();
  const [open, setOpen] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    if (!open) {
      setLangDropdownOpen(false);
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleSelectLanguage = (newLang: Locale) => {
    setLanguage(newLang);
  };

  return (
    <div className="settings-container" ref={containerRef}>
      <button
        type="button"
        className={`settings-icon-btn ${open ? 'is-active' : ''}`}
        onClick={() => setOpen(!open)}
        title={dict.settings.title}
        aria-label={dict.settings.title}
        aria-expanded={open}
      >
        <Settings size={17} className="settings-gear" />
      </button>

      {open ? (
        <div className="settings-popover" role="dialog" aria-label={dict.settings.title}>
          <div className="settings-popover-head">
            <span className="settings-popover-title">{dict.settings.title}</span>
            <button
              type="button"
              className="settings-close-btn"
              onClick={() => setOpen(false)}
              aria-label={dict.settings.close}
            >
              <X size={14} />
            </button>
          </div>

          <div className="settings-section">
            <button
              type="button"
              className={`settings-submenu-trigger ${langDropdownOpen ? 'is-open' : ''}`}
              onClick={() => setLangDropdownOpen(!langDropdownOpen)}
              aria-expanded={langDropdownOpen}
            >
              <span className="trigger-left">
                <Globe size={14} className="trigger-icon" />
                <span>{dict.settings.selectLanguage}</span>
              </span>
              <ChevronDown
                size={14}
                className={`trigger-chevron ${langDropdownOpen ? 'is-open' : ''}`}
              />
            </button>

            {langDropdownOpen ? (
              <div className="settings-lang-list">
                <button
                  type="button"
                  className={`settings-lang-option ${lang === 'en' ? 'is-selected' : ''}`}
                  onClick={() => handleSelectLanguage('en')}
                >
                  <span className="lang-name">{dict.settings.english}</span>
                  {lang === 'en' ? <Check size={14} className="check-icon" /> : null}
                </button>

                <button
                  type="button"
                  className={`settings-lang-option ${lang === 'vi' ? 'is-selected' : ''}`}
                  onClick={() => handleSelectLanguage('vi')}
                >
                  <span className="lang-name">{dict.settings.vietnamese}</span>
                  {lang === 'vi' ? <Check size={14} className="check-icon" /> : null}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
