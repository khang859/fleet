import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// Wait for bundled Nerd Fonts to load before rendering.
// xterm.js draws on <canvas> which doesn't re-render when fonts arrive late,
// so we must ensure fonts are ready before the first terminal is created.
document.fonts.ready.then(() => {
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  }
});
