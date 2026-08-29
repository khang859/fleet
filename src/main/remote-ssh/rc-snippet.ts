// src/main/remote-ssh/rc-snippet.ts

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteHost } from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';
import { execSsh } from './ssh-control';
import { resolveRemotePath } from './ssh-listing';
import { writeRemoteText } from './ssh-transfer';

const log = createLogger('remote-ssh:rc');

/**
 * Shell integration for a host the user SSHes into from a Fleet pane.
 *
 * Fleet cannot see a remote shell's working directory - no local process knows
 * it - so the remote shell has to say. The snippet emits OSC 7 on every prompt,
 * which is the same sequence Fleet already reads for local panes, and adds a
 * `fleet get` command that asks Fleet to pull a file down over the SFTP
 * connection it already holds open.
 *
 * The bytes never travel through the terminal. The sequence carries only a path.
 */

/**
 * Fleet's private OSC code, in the range terminals leave to applications. This
 * module writes it and `pty-osc-bridge.ts` reads it - they are the two halves of
 * one protocol, so the constant lives with the writer.
 */
export const FLEET_OSC_CODE = 5522;

/** Bumped when `fleetRcContents` changes, so an out-of-date host is reinstalled. */
export const FLEET_RC_VERSION = 1;

const RC_FILENAME = '.fleetrc.sh';

/**
 * The one line appended to the user's rc files. A fixed string with no
 * interpolation of anything Fleet did not author, so the rc-file append adds no
 * new call site to `ssh-quote.ts`'s security boundary.
 */
const SOURCE_LINE = '[ -f "$HOME/.fleetrc.sh" ] && . "$HOME/.fleetrc.sh"';

/**
 * The script written to `~/.fleetrc.sh` on the remote host.
 *
 * Deliberately POSIX-ish and shell-agnostic: it is sourced from both `.bashrc`
 * and `.zshrc`, and has to be inert in whichever one it did not expect.
 */
export function fleetRcContents(): string {
  return `# fleet-shell-integration v${FLEET_RC_VERSION}
# Written by Fleet. Safe to delete; Fleet will offer to reinstall it.

# Base64 without line wrapping. GNU base64 wraps at 76 columns, so the newlines
# are stripped rather than assumed absent.
__fleet_b64() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 | tr -d '\\n'
  else
    printf '%s' "$1" | openssl base64 -A
  fi
}

# Report the working directory to Fleet on every prompt. Fleet needs this to
# know where a dragged-and-dropped file should land.
__fleet_osc7() {
  printf '\\033]7;file://%s%s\\033\\\\' "$(hostname 2>/dev/null)" "$PWD"
}

if [ -n "\${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __fleet_osc7
elif [ -n "\${BASH_VERSION:-}" ]; then
  case "\${PROMPT_COMMAND:-}" in
    *__fleet_osc7*) ;;
    '') PROMPT_COMMAND='__fleet_osc7' ;;
    *) PROMPT_COMMAND="__fleet_osc7;\${PROMPT_COMMAND}" ;;
  esac
fi

# fleet get <path>... - ask Fleet to download these files to your computer.
fleet() {
  case "\${1:-}" in
    get)
      shift
      if [ "$#" -eq 0 ]; then
        echo "usage: fleet get <path>..." >&2
        return 2
      fi
      __fleet_rc=0
      for __fleet_f in "$@"; do
        if [ ! -f "$__fleet_f" ]; then
          echo "fleet get: $__fleet_f: not a file" >&2
          __fleet_rc=1
          continue
        fi
        __fleet_abs=$(cd "$(dirname -- "$__fleet_f")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename -- "$__fleet_f")")
        if [ -z "$__fleet_abs" ]; then
          echo "fleet get: $__fleet_f: could not resolve path" >&2
          __fleet_rc=1
          continue
        fi
        printf '\\033]${FLEET_OSC_CODE};get;%s\\033\\\\' "$(__fleet_b64 "$__fleet_abs")"
        echo "fleet: downloading $__fleet_abs"
      done
      unset __fleet_f __fleet_abs
      return $__fleet_rc
      ;;
    ''|help|-h|--help)
      echo "usage: fleet get <path>..." >&2
      return 2
      ;;
    *)
      echo "fleet: unknown command '$1'" >&2
      echo "usage: fleet get <path>..." >&2
      return 2
      ;;
  esac
}
`;
}

/**
 * Append the source line to whichever rc files exist, creating `~/.bashrc` only
 * when neither does - so a host that has never had one still gets the hook,
 * without Fleet inventing rc files a user already chose not to have.
 *
 * Idempotent: `grep -qF` means installing twice, or over a line the user added
 * by hand, changes nothing the second time.
 */
export function rcAppendCommand(): string {
  const line = `\\n# fleet-shell-integration\\n${SOURCE_LINE}\\n`;
  return [
    `for f in "$HOME/.bashrc" "$HOME/.zshrc"; do`,
    `[ -e "$f" ] || continue;`,
    `grep -qF .fleetrc.sh "$f" || printf '${line}' >> "$f";`,
    `done;`,
    `grep -qsF .fleetrc.sh "$HOME/.bashrc" "$HOME/.zshrc" || printf '${line}' >> "$HOME/.bashrc"`
  ].join(' ');
}

/** Where Fleet stages the script before uploading it. */
function scratchDir(): string {
  return join(homedir(), '.fleet', 'remote-cache', '.scratch');
}

/** Whether this host already sources Fleet's snippet, and at which version. */
export async function checkRcInstalled(
  host: RemoteHost
): Promise<{ installed: boolean; version: number | null }> {
  const result = await execSsh(host, `head -n 1 "$HOME/${RC_FILENAME}" 2>/dev/null || true`, {
    timeoutMs: 20_000
  });
  const firstLine = result.stdout.toString('utf-8').trim();
  const match = /^# fleet-shell-integration v(\d+)$/.exec(firstLine);
  if (!match) return { installed: false, version: null };
  return { installed: true, version: Number.parseInt(match[1], 10) };
}

/**
 * Write the snippet and wire it into the user's rc files.
 *
 * The file goes over SFTP (no remote shell parses its contents); only the
 * fixed, Fleet-authored append command runs through `ssh`.
 */
export async function installRcSnippet(host: RemoteHost): Promise<void> {
  const home = await resolveRemotePath(host, '~');
  const remotePath = `${home.replace(/\/+$/, '')}/${RC_FILENAME}`;
  await writeRemoteText(host, remotePath, fleetRcContents(), scratchDir());

  const result = await execSsh(host, rcAppendCommand(), { timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Could not update the remote shell startup files.');
  }
  log.debug('rc snippet installed', { host: host.host });
}

/** Typed into the live pane after install, so the open shell picks the hook up now. */
export const RC_SOURCE_COMMAND = `. "$HOME/${RC_FILENAME}"\n`;
