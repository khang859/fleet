import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/main/__tests__/**/*.test.ts', 'src/renderer/src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    clearMocks: true,
    forceExit: true
  }
});
