import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('copilot index.html is missing its #root mount point');
createRoot(root).render(<App />);
