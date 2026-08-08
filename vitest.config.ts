import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // The logger falls back to the real home directory whenever it cannot find
    // Electron, which under vitest means the suite appends its fixtures to the
    // log the running app is writing. Set here rather than in the setup file so
    // it is in place before any module reads it at import time.
    env: { FLEET_LOG_DIR: join(tmpdir(), 'fleet-test-logs') },
    include: [
      'src/main/__tests__/**/*.test.ts',
      'src/main/**/__tests__/**/*.test.ts',
      'src/shared/__tests__/**/*.test.ts',
      'src/renderer/src/**/__tests__/**/*.test.ts',
      'src/renderer/copilot/src/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts'
    ],
    setupFiles: ['src/test-setup.ts'],
    clearMocks: true,
    // @ts-expect-error — forceExit not in vitest 4.x InlineConfig type defs but accepted at runtime
    forceExit: true
  }
});
