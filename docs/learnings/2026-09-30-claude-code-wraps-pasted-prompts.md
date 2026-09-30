# Claude Code wraps a pasted prompt, and its model will not follow it

Found while verifying task 5.1 of the Orchestrator change (how `fleet_send` delivers a prompt), against Claude Code 2.1.285 on Linux, by writing bytes into a real `claude` pane through `window.fleet.pty.input`.

## What happened

The design said to send a prompt as a bracketed paste (`ESC[200~ … ESC[201~`) followed by `\r` about 50 ms later.
A multi-line paste was submitted as one prompt, but the transcript recorded it as:

```
\n\n<pasted_content id="af18">\n[orchestrator] Line one: …\n</pasted_content id="af18">\n
```

The model replied that the pasted text "came from the pasted text and not from you", and did not follow it.
The recorded text also no longer matched what was sent, so the origin hash would never match.

Each way of writing the same text, with the result in the transcript:

| How it was written                        | Recorded as                           |
| ----------------------------------------- | ------------------------------------- |
| Bracketed paste, 4 lines, 110 characters  | wrapped                               |
| Bracketed paste, 1 line                   | verbatim, followed                    |
| Plain write, 4 lines with LF, one chunk   | verbatim, followed                    |
| Plain write, 3,592 characters, one chunk  | wrapped                               |
| 200-character chunks, 20 ms apart         | verbatim, followed                    |
| 500 and 800-character chunks, 20 ms apart | verbatim                              |
| 1,000-character chunks, 20 ms apart       | wrapped                               |
| 200-character chunks, no gap              | wrapped (they coalesce into one read) |

So Claude Code treats a bracketed paste of more than one line, or a single read of more than about 800 characters, as pasted content.
Written as keystrokes, LF inserts a line break and `\r` submits.

Two more details from the same run:

- A tab was recorded as four spaces.
- A `/` at the start of a later line, and an `@` mention left open at the final `\r`, were both kept as typed and did not open a menu that swallowed the Enter.

## How it was fixed

`fleet_send` types the prompt instead of pasting it: control characters other than LF are dropped, a tab becomes four spaces, and the text is written in 128-character chunks 25 ms apart, then `\r` 50 ms later.
That is well under the paste threshold, and what is written is what the transcript records, so the origin hash matches.
A prompt that ends in `\` is refused, because `\` then Enter is Claude Code's line break, not a submit.

## Takeaways

- A TUI's paste handling is part of how its model is prompted. Claude Code marks pasted text as untrusted, so a tool that must be obeyed has to type.
- Check what the transcript recorded, not only what the terminal showed. The terminal showed the pasted prompt as three normal lines.
