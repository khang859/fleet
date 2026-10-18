/**
 * The sentence inside an IPC rejection.
 *
 * Electron prefixes what main threw with its own channel plumbing, and "Error
 * invoking remote method 'agent:skills:fetch':" in front of the message is noise
 * to everyone who is not debugging Electron.
 */
export function cleanIpcError(message: string): string {
  const marker = message.lastIndexOf('Error: ');
  return marker === -1 ? message : message.slice(marker + 'Error: '.length);
}
