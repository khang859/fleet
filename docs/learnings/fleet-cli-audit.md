# Fleet CLI Audit — 2026-03-19

An end-to-end functional audit of the `fleet` CLI. The CLI is installed at `~/.fleet/bin/fleet`, which is a bash wrapper that resolves Node.js and delegates to `~/.fleet/lib/fleet-cli.js`.

---

## Environment

- **Node.js**: v24.10.0
- **Socket**: `~/.fleet/fleet.sock` — present and accepting connections
- **Fleet app**: Running (Electron, socket confirmed active)

---

## Full Command Tree

The CLI uses the pattern `fleet <group> <action> [--key value ...]`. All commands communicate with the running Fleet Electron app via a Unix socket.

### Sectors
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet sectors list` | `sector.list` | ✅ Pass |
| `fleet sectors show <id>` | `sector.info` | ✅ Pass |
| `fleet sectors info <id>` | `sector.info` | ✅ Pass (alias) |
| `fleet sectors add --path <path>` | `sector.add` | ✅ Pass (validation works) |
| `fleet sectors remove <id>` | `sector.remove` | ✅ Pass (validation works) |

### Missions
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet missions list` | `mission.list` | ✅ Pass |
| `fleet missions add --sector <id> --type <code\|research> --summary "..." --prompt "..."` | `mission.create` | ✅ Pass (validation works) |
| `fleet missions create ...` | `mission.create` | ✅ Pass (alias) |
| `fleet missions show <id>` | `mission.status` | ✅ Pass |
| `fleet missions status <id>` | `mission.status` | ✅ Pass (alias) |
| `fleet missions update <id> --status <status>` | `mission.update` | ✅ Pass (validation works) |
| `fleet missions cancel <id>` | `mission.cancel` | ✅ Pass (validation works) |
| `fleet missions abort <id>` | `mission.cancel` | ✅ Pass (alias) |
| `fleet missions verdict <id> --verdict <approved\|changes-requested\|escalated>` | `mission.verdict` | ✅ Pass |

### Crew
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet crew list` | `crew.list` | ✅ Pass |
| `fleet crew deploy --sector <id> --mission <id>` | `crew.deploy` | ✅ Pass |
| `fleet crew recall <id>` | `crew.recall` | ✅ Pass (validation works) |
| `fleet crew dismiss <id>` | `crew.recall` | ✅ Pass (alias) |
| `fleet crew kill <id>` | `crew.recall` | ✅ Pass (alias) |
| `fleet crew stop <id>` | `crew.recall` | ✅ Pass (alias) |
| `fleet crew remove <id>` | `crew.recall` | ✅ Pass (alias) |
| `fleet crew info <id>` | `crew.info` | ✅ Pass |
| `fleet crew status <id>` | `crew.info` | ✅ Pass (alias) |
| `fleet crew show <id>` | `crew.info` | ✅ Pass (alias) |
| `fleet crew observe <id>` | `crew.observe` | ✅ Pass (returns terminal buffer) |
| `fleet crew message <id> --message "..."` | `crew.message` | ✅ Pass (validation works) |
| `fleet crew msg <id> --message "..."` | `crew.message` | ✅ Pass (alias) |
| `fleet crew send <id> --message "..."` | `crew.message` | ✅ Pass (alias) |

### Comms
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet comms inbox` | `comms.list` | ✅ Pass |
| `fleet comms check` | `comms.check` | ✅ Pass (outputs nothing if no unread) |
| `fleet comms send --to <crew-id\|admiral> --message "..."` | `comms.send` | ✅ Pass (validation works) |
| `fleet comms resolve --to <id> --message "..."` | `comms.send` | ✅ Pass (alias) |
| `fleet comms read <id>` | `comms.read` | ✅ Pass (validation works) |
| `fleet comms read-all` | `comms.read-all` | ✅ Pass |
| `fleet comms delete <id>` | `comms.delete` | ✅ Pass (validation works) |
| `fleet comms clear` | `comms.clear` | ✅ Pass |
| `fleet comms show <id>` | `comms.info` | ✅ Pass (validation works) |
| `fleet comms info <id>` | `comms.info` | ✅ Pass (alias) |

### Cargo
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet cargo list` | `cargo.list` | ✅ Pass (passes through — no explicit COMMAND_MAP entry) |
| `fleet cargo show <id>` | `cargo.inspect` | ✅ Pass |
| `fleet cargo inspect <id>` | `cargo.inspect` | ✅ Pass (alias) |
| `fleet cargo pending --sector <id>` | `cargo.pending` | ✅ Pass |
| `fleet cargo produce --sector <id> --type <type> --path <path>` | `cargo.produce` | ✅ Pass (validation works) |

### Log
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet log groups` | `log.show` | ✅ Pass |
| `fleet log list` | `log.show` | ✅ Pass (alias) |

### Config
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet config get --key <key>` | `config.get` | ✅ Pass |
| `fleet config set --key <key> --value <value>` | `config.set` | ✅ Pass |

### Supply Routes (server-handled, no CLI wrapper)
| CLI Command | Maps To | Status |
|---|---|---|
| `fleet supply-route list` | `supply-route.list` | ✅ Pass (passes through — no COMMAND_MAP entry) |
| `fleet supply-route add --from <id> --to <id>` | `supply-route.add` | ✅ Pass (server validates, no client-side validation) |
| `fleet supply-route remove <id>` | `supply-route.remove` | ✅ Pass (server validates) |

### File Open (special command — not group/action pattern)
| CLI Command | Status |
|---|---|
| `fleet open <file>` | ✅ Pass |
| `fleet open <file1> <file2> ...` | ✅ Pass (multi-file) |

---

## Test Results: fleet open

`fleet open` is the **only command that breaks the `fleet <group> <action>` pattern** — it's handled as a special case directly in `runCLI()` before the normal group/action dispatch.

**Behavior tested:**

| Input | Output | Pass? |
|---|---|---|
| `fleet open` | `Usage: fleet open <path> [path2 ...]` | ✅ |
| `fleet open /nonexistent/file.txt` | `Error: file not found: /nonexistent/file.txt` | ✅ |
| `fleet open /some/directory` | `Error: directories not supported, use a file path: /some/directory` | ✅ |
| `fleet open /tmp/test.zip` | `Error: unsupported binary file: /tmp/test.zip` | ✅ |
| `fleet open /some/file.js` | `Opened 1 file(s) in Fleet` | ✅ |
| `fleet open /some/image.png` | `Opened 1 file(s) in Fleet` (as `paneType: "image"`) | ✅ |

**Conclusion: `fleet open` works correctly end-to-end.**

---

## Dependency Check

- **Node.js v24.10.0** — available on PATH ✅
- **Fleet socket** `~/.fleet/fleet.sock` — present and accepting connections ✅
- **Fleet Electron app** — running ✅

---

## Bugs and Issues Found

### Bug 1: `fleet --help` is nearly useless

Running `fleet --help` or `fleet` with no args produces only:

```
Usage: fleet <group> <action> [--key value ...]
```

There is no listing of available groups, commands, or flags. Users cannot discover the command tree without reading source code. `fleet sectors --help` returns `Error: Unknown command: sectors.--help (NOT_FOUND)` — help flags aren't intercepted.

**Recommendation:** Add a proper help system — either a static help text block or a `--help` interceptor that lists available groups and their actions.

### Bug 2: `cargo list` missing from COMMAND_MAP

`fleet cargo list` works (the CLI falls back to `cargo.list` directly) but unlike other commands it has no explicit COMMAND_MAP entry. The pattern is inconsistent — all other cargo subcommands are mapped, but `cargo.list` is not.

**Recommendation:** Add `'cargo.list': 'cargo.list'` to COMMAND_MAP for consistency.

### Bug 3: `supply-route` commands have no CLI wrappers or client-side validation

The server (`socket-server.ts`) handles `supply-route.list`, `supply-route.add`, and `supply-route.remove`, but the CLI has no COMMAND_MAP entries or validation for them. They happen to work because the CLI passes through unknown commands verbatim, but:
- No validation error messages before the round-trip to the server
- No documentation or discoverability
- `supply-route.add` has no client-side `--from`/`--to` validation (the server validates and returns an error)

**Recommendation:** Add supply-route entries to COMMAND_MAP and add validation cases in `validateCommand()`.

### Bug 4: `crew.deploy`, `crew.observe`, `config.get`, `config.set` not in COMMAND_MAP

These four commands have client-side validation in `validateCommand()` but are absent from COMMAND_MAP. They work because `mapCommand()` falls back to `group.action` when no mapping is found — but this is an implementation accident, not intentional design. The inconsistency could cause confusion if someone extends the CLI.

**Recommendation:** Add these to COMMAND_MAP explicitly:
```js
'crew.deploy': 'crew.deploy',
'crew.observe': 'crew.observe',
'config.get': 'config.get',
'config.set': 'config.set',
```

### Observation: `fleet crew observe` dumps raw terminal buffer

`fleet crew observe <id>` returns the crew's full terminal buffer as a string. This can be a large blob of text. There is no pagination or line limit. For long-running crews, this output could be thousands of lines.

---

## Summary

The Fleet CLI is **fully functional**. Every tested command either executes correctly or returns a clear, actionable error message. The socket connection to the running Electron app works reliably. `fleet open` works correctly for text and image files, with proper rejection of directories and binary files.

The main areas for improvement are discoverability (no real `--help`) and minor inconsistencies in the COMMAND_MAP (missing entries for commands that work via fallthrough).
