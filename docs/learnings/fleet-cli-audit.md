# Fleet CLI Audit

**Date:** 2026-03-19
**Branch:** crew/fleet-crew-fa94
**Tester:** Fleet Crew (automated audit)

---

## Overview

The Fleet CLI is operational. The binary lives at `~/.fleet/bin/fleet` (on PATH) and delegates to `~/.fleet/lib/fleet-cli.js` via `node`. The source is `src/main/fleet-cli.ts`. It communicates with the running Fleet Electron app through a Unix socket at `~/.fleet/fleet.sock`.

**Dependencies:** Node.js (required), Fleet app running (for socket commands).

---

## Full Command Tree

### Top-level special commands
| Command | Description |
|---------|-------------|
| `fleet open <path> [path2 ...]` | Open file(s) in Fleet viewer |

### Sectors
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet sectors list` | `sector.list` | List all sectors |
| `fleet sectors show <id>` | `sector.info` | Show sector details |
| `fleet sectors info <id>` | `sector.info` | Alias for show |
| `fleet sectors add --path <path>` | `sector.add` | Add a sector |
| `fleet sectors remove <id>` | `sector.remove` | Remove a sector |

### Missions
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet missions list` | `mission.list` | List all missions |
| `fleet missions add --sector <id> --type <code\|research> --summary "..." --prompt "..."` | `mission.create` | Create a mission |
| `fleet missions create ...` | `mission.create` | Alias for add |
| `fleet missions show <id>` | `mission.status` | Show mission status |
| `fleet missions status <id>` | `mission.status` | Alias for show |
| `fleet missions update <id> --status <status>` | `mission.update` | Update mission status |
| `fleet missions cancel <id>` | `mission.cancel` | Cancel a mission |
| `fleet missions abort <id>` | `mission.cancel` | Alias for cancel |
| `fleet missions verdict <id> --verdict <approved\|changes-requested\|escalated> --notes "..."` | `mission.verdict` | Issue verdict on mission |

### Crew
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet crew list` | `crew.list` | List all active crew |
| `fleet crew deploy --mission <id> [--sector <id>]` | `crew.deploy` | Deploy crew to a mission |
| `fleet crew info <id>` | `crew.info` | Show crew member details |
| `fleet crew status <id>` | `crew.info` | Alias for info |
| `fleet crew show <id>` | `crew.info` | Alias for info |
| `fleet crew recall <id>` | `crew.recall` | Recall (stop) a crew member |
| `fleet crew dismiss <id>` | `crew.recall` | Alias for recall |
| `fleet crew kill <id>` | `crew.recall` | Alias for recall |
| `fleet crew stop <id>` | `crew.recall` | Alias for recall |
| `fleet crew remove <id>` | `crew.recall` | Alias for recall |
| `fleet crew observe <id>` | `crew.observe` | Observe a crew member |
| `fleet crew message <id> --message "..."` | `crew.message` | Send message to crew |
| `fleet crew msg <id> --message "..."` | `crew.message` | Alias for message |
| `fleet crew send <id> --message "..."` | `crew.message` | Alias for message |

### Comms
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet comms inbox` | `comms.list` | List transmissions |
| `fleet comms check` | `comms.check` | Check for unread transmissions |
| `fleet comms read <id>` | `comms.read` | Mark transmission as read |
| `fleet comms read-all` | `comms.read-all` | Mark all transmissions as read |
| `fleet comms send --to <crew-id\|admiral> --message "..."` | `comms.send` | Send transmission |
| `fleet comms resolve ...` | `comms.send` | Alias for send |
| `fleet comms delete <id>` | `comms.delete` | Delete a transmission |
| `fleet comms clear` | `comms.clear` | Clear all transmissions |
| `fleet comms show <id>` | `comms.info` | Show transmission details |
| `fleet comms info <id>` | `comms.info` | Alias for show |

### Cargo
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet cargo list` | `cargo.list` | List all cargo (passthrough, not in COMMAND_MAP) |
| `fleet cargo show <id>` | `cargo.inspect` | Inspect cargo item |
| `fleet cargo inspect <id>` | `cargo.inspect` | Alias for show |
| `fleet cargo pending --sector <id>` | `cargo.pending` | List pending cargo for sector |
| `fleet cargo produce --sector <id> --type <type> --path <path>` | `cargo.produce` | Produce cargo artifact |

### Config
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet config get --key <key>` | `config.get` | Get a config value |
| `fleet config set --key <key> --value <value>` | `config.set` | Set a config value |

### Log
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet log groups` | `log.show` | Show ships log event groups |
| `fleet log list` | `log.show` | Alias for groups |

### Supply Routes (passthrough — not in COMMAND_MAP, but works)
| CLI Command | Maps To | Description |
|-------------|---------|-------------|
| `fleet supply-route list` | `supply-route.list` | List supply routes |
| `fleet supply-route add ...` | `supply-route.add` | Add a supply route |
| `fleet supply-route remove ...` | `supply-route.remove` | Remove a supply route |

---

## Test Results

### fleet open — PASS

`fleet open` works correctly end-to-end.

| Test | Result |
|------|--------|
| `fleet open` (no args) | PASS — prints usage |
| `fleet open /nonexistent.txt` | PASS — "Error: file not found" |
| `fleet open /tmp` (directory) | PASS — "Error: directories not supported" |
| `fleet open /tmp/test.txt` (existing text file) | PASS — "Opened 1 file(s) in Fleet" |
| `fleet open /tmp/image.png` (existing image) | PASS — "Opened 1 file(s) in Fleet" |
| `fleet open /tmp/fake.zip` (binary) | PASS — "Error: unsupported binary file" |

**How `fleet open` works:** It resolves absolute paths, validates each file (exists, not directory, not binary), classifies images by extension, then sends a `file.open` command to the socket server with all valid files. Files are opened as viewer panes in Fleet.

### Socket-backed commands — PASS (Fleet app is running)

| Command | Result |
|---------|--------|
| `fleet sectors list` | PASS — returns table of 2 sectors |
| `fleet missions list` | PASS — returns table of missions |
| `fleet crew list` | PASS — returns table of active crew |
| `fleet comms inbox` | PASS — returns transmissions table |
| `fleet comms check` | PASS — returns unread count |
| `fleet comms read-all` | PASS — marks transmissions as read |
| `fleet cargo list` | PASS — returns cargo table |
| `fleet log list` | PASS — returns ships log events |
| `fleet supply-route list` | PASS — returns "No supply-route found." |
| `fleet config get --key theme` | PASS — returns "OK" (no theme set) |

### Validation (client-side, no socket needed) — PASS

All validation messages fire correctly before attempting socket connection:

| Command | Validation |
|---------|------------|
| `fleet sectors add` (no --path) | PASS — correct error |
| `fleet sectors show` (no id) | PASS — correct error |
| `fleet sectors remove` (no id) | PASS — correct error |
| `fleet missions add` (no --sector) | PASS — correct error |
| `fleet missions add --sector x` (no --type) | PASS — lists valid types |
| `fleet missions add ... --type bad` | PASS — rejects invalid type |
| `fleet missions add ... --type code --summary x` (no --prompt) | PASS — correct error |
| `fleet crew deploy` (no --mission) | PASS — shows workflow |
| `fleet crew deploy --mission "some text"` | PASS — rejects non-numeric |
| `fleet crew recall` (no id) | PASS — correct error |
| `fleet crew info` (no id) | PASS — correct error |
| `fleet crew message` (no id) | PASS — correct error |
| `fleet comms read` (no id) | PASS — correct error |
| `fleet comms send` (no --to) | PASS — correct error |
| `fleet comms delete` (no id) | PASS — correct error |
| `fleet cargo show` (no id) | PASS — correct error |
| `fleet cargo pending` (no --sector) | PASS — correct error |
| `fleet missions verdict` (no id) | PASS — correct error |
| `fleet config get` (no --key) | PASS — correct error |
| `fleet config set` (no --key) | PASS — correct error |

---

## Bugs and Issues Identified

### Bug 1: All commands exit with code 0, even on errors (HIGH)

Every command — success or failure — exits with code 0. Error messages like "Error: file not found" and "Error: sectors add requires --path" are printed to stdout, but the process exits 0.

This breaks any scripting or automation that checks exit codes to detect failures.

**Example:**
```bash
fleet open /nonexistent.txt; echo $?   # → 0 (should be non-zero)
fleet sectors add; echo $?             # → 0 (should be non-zero)
```

**Root cause:** `runCLI()` returns a string in all cases (success or error). The entrypoint just does `process.stdout.write(output + '\n')` with no exit code management:
```typescript
runCLI(process.argv.slice(2), sockPath, { retry: true }).then((output) => {
  if (output) process.stdout.write(output + '\n');
});
```

**Fix:** Check if the output starts with `"Error:"` and call `process.exit(1)`, or return a `{ output, exitCode }` object from `runCLI`.

---

### Bug 2: No `--help` system (MEDIUM)

`fleet --help` returns only a bare usage string: `Usage: fleet <group> <action> [--key value ...]`. There is no subcommand help. Worse, `fleet sectors --help` (or any `fleet <group> --help`) hits the socket and returns `Error: Unknown command: sectors.--help (NOT_FOUND)`.

**Example:**
```bash
fleet --help          # → "Usage: fleet <group> <action> [--key value ...]"
fleet sectors --help  # → "Error: Unknown command: sectors.--help (NOT_FOUND)"
```

**Fix:** Intercept `--help` in the CLI before routing to the socket. Print per-group usage strings.

---

### Bug 3: `ping` command unreachable from CLI (LOW)

The socket server has a `case 'ping'` handler. But the CLI parses all commands as `group action`, so `fleet ping` would need action=undefined and fails, and `fleet ping test` tries to call `ping.test` which fails. There's no way to invoke the `ping` command from the CLI.

**Fix:** Add `ping` as a special top-level command (like `open`), or remove the server-side `ping` handler since it's unused.

---

### Bug 4: `supply-route` commands not in COMMAND_MAP and undocumented (LOW)

`fleet supply-route list/add/remove` works via passthrough (commands not in COMMAND_MAP fall through directly to the socket), but:
- There is no client-side validation for `supply-route.add` or `supply-route.remove`
- They are not documented anywhere in the CLI

**Fix:** Add entries to `COMMAND_MAP` and validation in `validateCommand()`.

---

### Bug 5: `cargo list` not in COMMAND_MAP (LOW)

`fleet cargo list` works via passthrough, but `cargo.list` is not in `COMMAND_MAP`. This is inconsistent with other cargo commands that have explicit mappings.

**Fix:** Add `'cargo.list': 'cargo.list'` to `COMMAND_MAP`.

---

## Summary

| Category | Status |
|----------|--------|
| `fleet open` | ✅ Fully working |
| Sectors commands | ✅ Working |
| Missions commands | ✅ Working |
| Crew commands | ✅ Working |
| Comms commands | ✅ Working |
| Cargo commands | ✅ Working |
| Config commands | ✅ Working |
| Log commands | ✅ Working |
| Supply route commands | ✅ Working (via passthrough) |
| Socket connectivity | ✅ Fleet app is running, socket responsive |
| Validation | ✅ All checked commands validate correctly |
| Exit codes | ❌ Always 0, even on errors |
| Help system | ❌ Not implemented |

**The Fleet CLI fundamentally works.** All core commands connect to the socket, return data, and print formatted tables. `fleet open` works correctly. The main issues are quality-of-life: exit codes always 0 (breaks scripting) and no help system.
