import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/tokens.css';
import './styles/global.css';
import { startThemeWatcher } from './lib/theme';
import { initGhProfile } from './lib/ghProfile';
import { migrateLegacyStorage } from './lib/storageMigration';
import { purgeSeededDefaults } from './lib/agentExtras';
import App from './App';

// Move persisted pigry:* settings to their pigry:* names before anything
// reads them, then make sure every workspace menu has its default agent.
migrateLegacyStorage();
// Tiers 1-2 are hard-coded; strip the old seeded copies from storage.
purgeSeededDefaults();
startThemeWatcher();
initGhProfile();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
