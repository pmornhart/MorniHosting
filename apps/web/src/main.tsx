import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import './i18n';
import { applyTheme, initialTheme } from '@/features/shell/theme';
import { rememberDiscordToken } from '@/features/admin/DiscordLinkPage';
import { App } from './App';
import { showConsoleNotice } from './lib/console-notice';

showConsoleNotice();
applyTheme(initialTheme());
// Before a possible detour over the login page, which would drop the "#token".
rememberDiscordToken();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
