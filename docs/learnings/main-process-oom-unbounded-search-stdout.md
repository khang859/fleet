# Main-process OOM from unbounded search-tool stdout (and how to read Electron stackshots)

## What happened

A user's Fleet (2.39.0) "hung" for 120+ seconds and produced a macOS stackshot report.
The raw report looked like an infinite loop with bizarre frames (`rust_png`,
`node::sqlite`, `ares_dns_rr_get_ttl`). After re-symbolicating with Electron's
breakpad symbols, the real stack was a **V8 heap out-of-memory crash**:

```
fs.promises completion → microtask drain → JS → Runtime_StringSplit
→ String::SlowFlatten<ConsString> → NewRawTwoByteString
→ CollectGarbageAndRetryAllocation → V8::FatalProcessOutOfMemory
```

The "hang" was minutes of full-GC thrashing followed by the crash-dump writer.

## Root cause

Three main-process modules buffered **unbounded child-process stdout** into a
single string via `stdout += chunk.toString()` and later `.split('\n')` it:

- `file-search.ts` — `mdfind` over `~` by display name, per keystroke, no output cap
- `recent-images.ts` — `mdfind` for *every image under `~`* + recursive `readdir`
  of Desktop/Downloads/Pictures, fired on every FileSearchOverlay open
- `file-grep.ts` — `rg` whose `--max-count` is per-file, so total output is unbounded

On machines with huge Spotlight indexes these emit hundreds of MB. The `+=`
accumulation builds a giant ConsString; `split('\n')` must flatten it (allocating
the whole flat copy at once) and explodes a heap already filled by prior requests.
SIGTERM timeouts do not bound size — mdfind can emit hundreds of MB in seconds.

## Fix

`src/main/bounded-stdout.ts` — `captureBoundedStdout(proc, maxChars)` accumulates
stdout and SIGTERMs the child once the cap (8M chars) is exceeded, keeping the
truncated prefix. Applied to all five spawn sites; `scanKnownDirs()` also caps
collected paths (`SCAN_RESULT_LIMIT`).

## Lessons

1. **Never accumulate child-process stdout without a byte cap** in the main
   process — a kill-timeout is not a size bound. Use `captureBoundedStdout`.
2. **Stripped Electron stackshot symbols are nearest-symbol garbage.** Before
   trusting frame names, download `electron-v<ver>-darwin-arm64-symbols.zip`
   from the Electron release matching `package-lock.json`, check the module
   UUID against the report, and resolve `Electron Framework + <offset>` against
   the breakpad `FUNC` records. Tiny lambdas may be ICF-merged, so take
   promise-resolver frame identities with a grain of salt.
3. A V8 OOM presents as a long *hang* (GC thrash) before the crash — `Event: hang`
   reports can be memory bugs, not loops. `SlowFlatten<ConsString>` in the fatal
   stack means a string built by `+=` was flattened; go hunting for accumulators.
