# Redacting secrets with BSD sed leaked an API key

## What happened

While designing eva settings, an agent read `~/.eva/config.toml` with a `sed -E` redaction:

```bash
sed -E 's/((key|token|secret)[a-z_]*\s*=\s*)"[^"]*"/\1"<redacted>"/I' ~/.eva/config.toml
```

macOS ships BSD sed.
BSD `sed -E` does not support `\s`, so the pattern never matched and the raw `api_key` value was printed into the session log.
The key had to be rotated.

## Fix

- Do not print secret-bearing files at all when only their shape is needed.
  List the keys instead, for example `awk -F= '{print $1}' ~/.eva/config.toml`.
- If values must be masked, use POSIX classes (`[[:space:]]`), not `\s`, and test the command on a fake file first.
- Treat `~/.eva/config.toml`, `~/.aws`, `~/.config/gh` and any `*.env` as secret-bearing.
