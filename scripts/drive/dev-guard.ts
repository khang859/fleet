import { runningDevInstance } from './instance';

// Runs before `npm run dev`. A second dev instance of the same checkout opens
// a second window, cannot bind the CDP port, and overwrites the session file,
// so `npm run drive` can no longer reach either window.
void runningDevInstance().then((instance) => {
  if (!instance) return;
  process.stderr.write(
    `Fleet dev is already running for this checkout (pid ${instance.pid ?? 'unknown'}, ` +
      `CDP port ${instance.port}). Not starting another.\n` +
      `Drive it with \`npm run drive\`, or stop it with \`npm run drive -- stop\`.\n`
  );
  process.exit(1);
});
