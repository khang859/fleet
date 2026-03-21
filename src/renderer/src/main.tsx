import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

window.addEventListener('error', (event) => {
  console.error('[renderer:error]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error('[renderer:unhandledrejection]', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Force-load bundled Nerd Fonts before rendering.
// xterm.js draws on <canvas> which doesn't trigger @font-face downloads
// (no DOM text references the fonts), so document.fonts.ready resolves
// immediately. We use document.fonts.load() to explicitly activate each
// variant, racing against a timeout so the app still renders if fonts fail.
const fontFamilies = [
  'JetBrains Mono Nerd Font',
  'Symbols Nerd Font',
];
const fontVariants = [
  { weight: 'normal', style: 'normal' },
  { weight: 'bold', style: 'normal' },
  { weight: 'normal', style: 'italic' },
  { weight: 'bold', style: 'italic' },
];

const fontLoads = fontFamilies.flatMap((family) =>
  fontVariants.map(({ weight, style }) =>
    document.fonts.load(`${style} ${weight} 16px "${family}"`)
  )
);

const fontTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));

Promise.race([
  Promise.allSettled(fontLoads),
  fontTimeout,
]).then(() => {
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(<App />);
  }
});
