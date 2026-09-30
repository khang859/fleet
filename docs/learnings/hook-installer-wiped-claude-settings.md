# The hook installer wiped Claude's settings.json on a parse failure

`install()` in the copilot hook installer read `<claude dir>/settings.json`, and if `JSON.parse` threw it logged "starting fresh" and carried on with `{}`.
It then wrote back a file holding only Fleet's hooks, so every other setting the user had - `model`, `permissions`, their own hooks, `env` - was gone.
A non-object top level (an array, `null`) took the same path, because `parseClaudeSettings` returned `null` and `null` also meant "use `{}`".

Reproduced with a temp config folder whose `settings.json` had one `//` comment and a trailing comma: after `install(dir)` the file contained only `hooks`.

This was survivable while installation was an opt-in macOS copilot toggle.
It is not once Fleet installs hooks by default on every platform, which is what the Orchestrator work needs.

## Fix

- Parse failure or a non-object top level aborts the install, leaves the file byte-for-byte untouched, and throws an error the settings UI can show.
- Before any write, the previous file is copied to `settings.json.fleet-bak`.
- The write goes to a temp file in the same folder and is renamed into place, so an interrupted write cannot leave a truncated file.
- The hook command is quoted, so a home folder with spaces still runs it.

## Rule

Never treat "I could not read the user's config" as "the user has no config".
A read-modify-write of a file you do not own must fail closed.
