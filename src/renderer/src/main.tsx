import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { createLogger } from './logger';
import { useWorkspaceStore } from './store/workspace-store';
import { useSettingsStore } from './store/settings-store';
import { useSessionsStore } from './store/sessions-store';
import { useRemoteSshStore } from './store/remote-ssh-store';
import { useAgentStore } from './store/agent-store';
import { useAgentMcpStore } from './store/agent-mcp-store';
import { useAgentSkillsStore } from './store/agent-skills-store';
import { useAgentMemoryStore } from './store/agent-memory-store';
import { useNotificationStore } from './store/notification-store';
import './index.css';

const log = createLogger('renderer');

window.addEventListener('error', (event) => {
  log.error('uncaught error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  log.error('unhandled rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

// Global click handler for Cmd+Click (macOS) / Ctrl+Click (Windows/Linux) on links
// to open in default browser. Catches clicks on <a> tags before other handlers.
window.addEventListener(
  'click',
  (event) => {
    if (!event.metaKey && !event.ctrlKey) return;

    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Only handle external URLs (http/https)
    if (!href.startsWith('http://') && !href.startsWith('https://')) return;

    event.preventDefault();
    event.stopPropagation();
    void window.fleet.shell.openExternal(href);
  },
  true
); // Use capture phase to intercept before other handlers

// Force-load bundled Nerd Fonts before rendering.
// xterm.js draws on <canvas> which doesn't trigger @font-face downloads
// (no DOM text references the fonts), so document.fonts.ready resolves
// immediately. We use document.fonts.load() to explicitly activate each
// variant, racing against a timeout so the app still renders if fonts fail.
const fontFamilies = ['JetBrains Mono Nerd Font', 'Symbols Nerd Font'];
const fontVariants = [
  { weight: 'normal', style: 'normal' },
  { weight: 'bold', style: 'normal' },
  { weight: 'normal', style: 'italic' },
  { weight: 'bold', style: 'italic' }
];

const fontLoads = fontFamilies.flatMap((family) =>
  fontVariants.map(async ({ weight, style }) =>
    document.fonts.load(`${style} ${weight} 16px "${family}"`)
  )
);

// fleet-drive: expose store state to `npm run drive -- eval` in dev only.
// Note: theme is React state (see hooks/use-app-theme.ts), not a store — read
// it from the DOM instead. Never present in a packaged build.
if (import.meta.env.DEV) {
  window.__FLEET__ = {
    stores: {
      workspace: useWorkspaceStore,
      settings: useSettingsStore,
      sessions: useSessionsStore,
      remoteSsh: useRemoteSshStore,
      agent: useAgentStore,
      agentMcp: useAgentMcpStore,
      agentSkills: useAgentSkillsStore,
      agentMemory: useAgentMemoryStore,
      notification: useNotificationStore
    }
  };
}

const fontTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));

void Promise.race([Promise.allSettled(fontLoads), fontTimeout]).then(() => {
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
  }
});
