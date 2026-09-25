import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LanguageProvider } from './i18n/context.js';
import '@fontsource-variable/dm-sans';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
);
