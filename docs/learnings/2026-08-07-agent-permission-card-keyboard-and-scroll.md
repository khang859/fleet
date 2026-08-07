# Agent permission card: a shrinking scrollport, and Enter with a live composer

## Problem

Two complaints about the Agent pane's permission card:

1. Pressing Enter while the card was open did nothing useful - it showed "Answer the question above first" instead of accepting.
2. With the transcript already scrolled to the bottom, opening the card left its buttons below the fold.

## Root cause of the scroll bug

Not the card. The tail-following effect in `AgentThread`'s `Transcript` observed only the *content* element:

```ts
const observer = new ResizeObserver(() => {
  const grown = content.getBoundingClientRect().height;
  if (grown <= height) { height = grown; return; }
  ...
});
observer.observe(content);
```

That catches the transcript growing, but not the *window onto it* getting shorter.
Anything that appears below the transcript - the "your message is still here" notice, an error line, the status line, the composer growing under a long draft - takes its height out of the scroll container without changing content height at all.
`scrollTop` stays valid, no scroll event fires, the ResizeObserver never sees a change, and the end of the transcript silently slips below the fold.

Measured with `npm run drive` against the live window, pressing Enter with a draft typed while the card was open:

| | clientHeight | gap below tail | card fully visible |
|---|---|---|---|
| before Enter | 607 | 19 | yes |
| after Enter (notice appeared) | 585 | 41 | **no** |

The card itself was innocent: when nothing else changed size, the content-growth path already recovered within 50ms.

## Fix

Observe the scroll container as well, and treat "content grew" and "window shrank" as the same event - both mean the reader lost their place at the tail:

```ts
const lostRoom = grownContent > contentHeight || shrunkPort < portHeight;
contentHeight = grownContent;
portHeight = shrunkPort;
if (!lostRoom || !atTail.current) return;
endRef.current?.scrollIntoView({ block: 'end' });
```

This fixes a whole class of bug, not just the permission card.

## The keyboard half: what other harnesses do

Researched ten harnesses before choosing. The finding that mattered:

- **No harness autofocuses the approve button.** Cline explicitly avoids it - its refocus effect is gated on `!enableButtons`, so it stops pulling focus back to the textarea but never moves focus to the button.
- **Accidental approval while typing is the dominant failure mode.** Codex [#7744](https://github.com/openai/codex/issues/7744) (typing `y` or `a` fired approve), Claude Code [#23643](https://github.com/anthropics/claude-code/issues/23643) ("steals keyboard focus mid-keystroke"), Claude Code [#32630](https://github.com/anthropics/claude-code/issues/32630) (Cmd+Enter approved *and* sent the half-typed message).
- The TUI camp (Claude Code, Codex, Gemini, OpenCode, Aider, Goose) preselects the affirmative and Enter approves - but in all six **the composer is gone** while the prompt is up. Fleet's composer stays live, which is why their model cannot be copied wholesale.

**Do not autofocus the approve button.** Space activates a focused button, so a user typing a queued message would approve a command by typing a space.

## What Fleet does

1. **Typing-idle deferral** (`PERMISSION_TYPING_IDLE_MS = 1000`), the fix Claude Code and Codex both landed on independently. Codex ships `APPROVAL_PROMPT_TYPING_IDLE_DELAY = Duration::from_secs(1)`; Claude Code's changelog 2.1.30 reads "Fixed permission dialogs stealing focus while actively typing". The card is held back until the typing stops, so it can never appear between two keystrokes. Once drawn it stays drawn - it is the turn's question, not a notification.

   `useSettledAsk` reports typing through a **ref**, and the timer reschedules itself by re-reading that ref. Typing with nothing pending therefore costs no render at all - important, because a `setState` per keystroke here would re-render the whole transcript.

2. **Enter approves only when there is nothing to send** (empty box, no attachments). This is not extra caution: `agentSlashCommand` exists so that typing `/clear` in full and pressing Enter runs the command. Without the guard, Enter would approve the command instead of running `/clear`, and a draft mid-sentence would be answered by reflex.

3. **Escape twice interrupts** the turn, armed for 2s. One press is too easy to arrive by accident, and what it discards is minutes of work and the money that bought it.

## Reproducing

`npm run drive -- fixture agent-permission-ask` seeds a streaming turn that stops on a permission question, at the foot of a transcript long enough to scroll.
The question arrives a beat *after* the transcript, because a state seeded all at once cannot reproduce a reader already parked at the tail when the card appears under them.

## Gotcha met on the way

Two `npm run dev` servers from different checkouts collide on Vite's port.
The second takes 5174 while `ELECTRON_RENDERER_URL` and `.fleet-drive/session.json` can disagree about which one the window actually loaded, so `fleet-drive` attaches to a window whose renderer is being served by the *other* checkout - which renders blank, since the preload and the module graph come from different trees.
Symptom: `document.body.innerHTML.length === 87` and `typeof window.__FLEET__ === 'undefined'`.
Check `curl -s http://localhost:<port>/src/main.tsx | head` and look at which absolute path the `/@fs/` imports point at before trusting anything you measure.
