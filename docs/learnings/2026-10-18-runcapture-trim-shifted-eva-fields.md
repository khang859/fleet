# A trimmed shell output shifted eva's server fields

## What happened

Settings › Agency › Crew › Runtimes showed eva's "Model server" as `provider = "openrouter"` and its "Address" as `# api_key set`.
The Key row said "No key in eva", though a key was set.

`readEvaServer` runs one shell line that prints the three `CHAT_*` variables, one per line, and then lines from eva's `config.toml`.
It read the variables by line number.
`runCapture` trims stdout, so when the variables were empty, their blank lines at the top were removed.
Every line then moved up, and the file lines were read as the variables.

The unit test missed it because its fake shell did not trim.

## Fix

The shell line now prints each variable by name, as `CHAT_PROVIDER=...`, and `readEvaServer` reads them by name.
A trim can remove nothing that a later line depends on.
The test's fake shell now trims, as `runCapture` does, and it failed before the fix.

## Rule

Never parse shell output by line position when a line can be empty.
Tag each value with its name.
Make a fake match the real thing in the ways that change the data, such as trimming.
