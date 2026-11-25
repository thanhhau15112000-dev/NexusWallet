import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import { App } from './App.js';
import { LanguageProvider } from './i18n/context.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <TooltipProvider delayDuration={250}>
        <App />
      </TooltipProvider>
    </LanguageProvider>
  </StrictMode>,
);
