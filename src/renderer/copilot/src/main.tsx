import { createRoot } from 'react-dom/client';

// Placeholder App until full component is created
function App(): React.JSX.Element {
  return <div>Copilot loading...</div>;
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
