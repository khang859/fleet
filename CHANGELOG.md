# Changelog

## v2.113.0

- **Long-running windows find out about updates** - Fleet checked for a new version once, just after launch, and never again. That answers the question for a session that lasts minutes and quietly stops answering it for one that lasts days, which is the normal case here: the window holds running agents and nobody closes it. At roughly one release every two or three days, a window left open for a week could be several versions behind while showing nothing at all. It now re-checks every four hours, when the window regains focus, and when the machine wakes, with all three behind a single throttle so that opening a laptop lid - which fires the wake and the focus together, often with the timer due as well - is one check rather than three.
- **Installing asks before it stops running agents** - `Restart to Update` went straight to the updater, which on Windows and Linux spawns the installer *before* it asks the app to quit. The close warning added in the last release then appeared after the installer was already running, so answering 'cancel' left the app open and being replaced underneath it. The question is now asked first, through the same check a Cmd+Q goes through, and nothing is spawned until it has been answered.
- **Release notes read as notes** - they were rendered as literal text, so every `-` and `**` in this file showed up as punctuation. See the [changelog](https://github.com/khang859/fleet/blob/main/CHANGELOG.md) for the full history.
- **The pill disappears when the installer it advertises is deleted** - `electron-updater` keeps one downloaded artifact in one pending directory, and later work in that directory destroys it. Starting a download of a different version empties the directory first, and a download that fails calls the clear method on its way out, so a staged update overtaken by a newer one whose download then fails left the pill advertising an installer that no longer existed. The pill is now invalidated by what actually destroys the file, and Settings offers a retry - the `Check for Updates` button - when the replacement fails instead of hiding it behind a stale staged state.

## v2.112.0

- **A close warning shows only work that the close will actually end** - a warning that listed every kind of live work the app could see and said "Closing stops all of them" was not always true. `shutdownAll()`, which kills background commands and cancels subagents, is wired to `will-quit` and to the non-darwin branch of `window-all-closed`, so on macOS a window close (clicking the X rather than Cmd+Q) would announce that both were ending and then leave them running in the dock. The population to warn about is now the population this particular close ends, determined before the dialog is shown: subagent and background rows are counted and listed only when the close actually terminates the process. Pane work is still genuinely lost on any close - an agent turn keeps running in main but the transcript is written by the renderer, so a window that closes mid-turn takes the reply with it - and that loss is still warned of. A pane's working directory is saved, so reopening a session restores where it was.
- **Workspace overrides now live under Application in Settings** - a setting specific to one folder used to hide at the bottom of the Copilot page, so anyone looking for per-workspace config had to know it was a Copilot concern. The Workspaces section now sits under Application > Workspaces and the Copilot page is Copilot-only, so each setting is easier to find. The active workspace in the list is marked, and hook status refreshes after the folder picker returns instead of only when you type.

## v2.111.0

- **Copying out of an SSH session reaches your own clipboard** - a yank in vim or a tmux copy on a remote host went to that host's clipboard, which is a clipboard nobody is looking at, so the only way back to your machine was to select the text with the mouse and lose the line wrapping along with it. Fleet now reads the escape sequence those programs have always been sending for this (OSC 52) and puts the text where you can paste it. It is read in the main process rather than the terminal, because writing the system clipboard is main's job either way and main sees the pane's output whether or not it is the pane you are looking at, so a background agent's copy is not lost. This works from local shells too, since vim and tmux are the same programs there. The reverse direction is deliberately missing: the sequence has a read form, and answering it would hand whatever is on your clipboard to the remote host on request, so there is no code path for it at all rather than a check that could later be relaxed.
- **Drop a file on an SSH pane and it lands in the folder you are in** - dropping a file used to mean the local shell's folder, which for a pane that is SSHed somewhere is not a folder the file can usefully go to at all, so moving a file across meant leaving the terminal for `scp` and typing the destination out by hand. The file now uploads over the SFTP connection Fleet already holds open for that host and the quoted remote path is typed at the prompt after it, so the next thing you do with it is one word away. It goes to the working directory the remote shell reports rather than to your home directory there, because the home directory is almost never where you wanted it and a file that lands somewhere you have to go and find is barely better than typing the path yourself. Several files dropped together upload one after another and each path is typed as it arrives, so a transfer that fails halfway leaves you with exactly the ones that made it and a message about the one that did not.
- **`fleet get <path>` pulls a remote file down to your Downloads** - the other direction had the same problem and no good answer inside the terminal. Typing `fleet get report.csv` on the remote now downloads it, with a row in the transfer strip while it moves. Only the path travels through the terminal; the bytes come down the SFTP connection, so a large file neither floods the pane nor blocks it, and the remote path's directory is thrown away before anything touches your disk, so the only thing a remote host gets to choose is the name. A name already taken is stepped around rather than overwritten.
- **Fleet asks before it writes anything to a host** - the last two need the remote shell to report where it is and to know what `fleet get` means, and no local process can work either out on its own, so a small snippet has to go on the host. Fleet writes `~/.fleetrc.sh` and adds one line to your `.bashrc` or `.zshrc`, and the dialog says those two files by name, because "install shell integration" is the kind of phrase people agree to without knowing what it touched. The answer is remembered per host so it is asked once, a host where the snippet was installed by hand is adopted silently, and a host still carrying an older version of it is offered the update rather than left quietly behind. Everything the snippet does is inert in whichever shell it did not expect, and the file is yours to delete.
- **The escape-sequence reader no longer loses long sequences** - terminal output is delivered in chunks on a 16 ms timer, so a sequence routinely arrives split in two, and the old reader kept only the last 200 bytes across that boundary. That is fine for a directory path and nowhere near enough for a clipboard payload carrying a real yank, which splits many times over. Sequences are now reassembled whatever the split, with a ceiling so that binary output containing a sequence start that never finishes cannot grow the buffer for the life of the pane.
- **A remote folder can no longer be mistaken for a local one** - the working directory a shell reports is used for two entirely different things depending on whether the pane is SSHed somewhere, and the flag that answers that question is set by a process check running every two seconds, which a remote shell's first prompt can arrive ahead of. A remote path taken as a local one became the pane's saved folder, which is the folder the pane reopens in after a restart, and it also switched off the fallback that would have corrected it, so a single mistimed sequence stuck and said nothing. The sequence carries the name of the machine it came from and that is now read as well, so the answer no longer depends on what a poll happened to have noticed yet (#552).

## v2.110.0

- **A background keeps working after you move or delete the picture** - a background was a path into your own filesystem and nothing more, so tidying up the folder a wallpaper came from left the window blank with nothing on screen to say why, and the slideshow quietly lost images one at a time as the files behind them went. The copy that fixes this already existed and was already the documented reason the store is there, but only the agent transcript's Set as background and Add to slideshow buttons went through it - the settings pane's own file picker stored whatever path the dialog handed back, which is the picker most likely to be pointed at a Downloads folder or a scratch directory that will not be there next month. Every picture that becomes a background is now copied into `~/.fleet/backgrounds` first and every setting points at the copy, so the original is yours to move, rename or delete from the moment you pick it. Settings written before this take ownership of their pictures on the next launch, ahead of the window rather than after it, because nothing tells the renderer a setting changed underneath it and a rewrite landing later would be undone by its next save; after that first launch the check costs a string comparison per path and reads no files at all. A path whose picture is already gone is left exactly as it was, since rewriting it changes nothing and dropping a wallpaper over a file the store will not take is the worse answer. Slideshows pointed at a folder are deliberately untouched: a folder is an explicit watch-this-directory arrangement, and freezing it to honour a copy would break the one thing it is for.
- **The copies are cleaned up when nothing points at them any more** - the store only ever grew, so a year of trying wallpapers out was a year of them sitting on disk with nothing referring to them. Removing a slideshow image, Clear All, Reset and switching a show back to a folder now all collect the pictures they orphan. It is a sweep of the whole store against the settings as they actually read, not a delete matched to each removal, and that is what makes it hold: those four are the same event as far as the disk is concerned, a crash halfway through any of them leaves the same orphan, and a sweep collects the ones an older build left behind as well. It only ever touches files inside the store - a background still pointing at a picture elsewhere on your disk is your file, and the whole point of the store is that Fleet deletes only what Fleet put there. Switching Mode to None kept the previous picture's path in memory alone so that switching back restored it, which the sweep would have collected out from under it; that path is a saved setting now, which also means the restore survives quitting the app, where before it did not.
- **A wallpaper is listed under the name you picked it by** - the copies are named by the picture's own name followed by the hash of its contents rather than the hash alone, because the settings pane shows the tail of whatever path it holds and a background chosen as `sunset.jpg` should not be read back to you as thirty-two hex characters. Adopting the same picture twice is still free and stores it once; two identical files under different names now each get stored, which is the price of a name you can recognise (#551).

## v2.109.0

- **Files you open now sit under the session you opened them from** - a file tab was appended to the end of the tab list with nothing recording where it came from, so a session and the files opened while working in it drifted apart down the sidebar, and the further apart they sat the less the two had to do with each other on screen. A file now hangs off its session, indented under it, newest directly below the session row so the one you just opened is always in the same place. The session it belongs to is the one you were looking at, and that includes the case where you were looking at another of that session's files, since that is still the session you are working in; a file opened with nothing focused at all - from the dashboard, or from the `fleet` CLI - goes to the deepest session whose folder actually contains it, and one that belongs to no session on screen stays where files have always gone. The relation is a display one and nothing else: a single id on the file tab, the pane and its lifetime untouched, and a parent that is gone resolves to nothing - so closing a session leaves its files in place at the top level rather than taking them with it, and an undo-close puts them back underneath it. Drawing a session's files from the session's own pass rather than from their own place in the list is what keeps the rest of the sidebar honest: a collapsed worktree group never renders them, a session inside a colour group renders them inside that group, a session dragged elsewhere takes its files along, a file dragged on its own leaves the nest and stays where you dropped it, and a drop aimed at the gap between a session and its files lands after them rather than cutting the pair apart. Terminal sessions only - agent panes have their own pinned section and keep their flat list (#550).

## v2.108.0

- **The Agent pane has a Full Access mode** - a third setting beside Ask and Auto, where every command runs the moment it is asked for and nothing stops to ask you about anything. Auto was deliberately built as a one-way relaxation: a small model can wave a command through, but it is never even shown the handful where being wrong costs a rewritten remote or a leaked key, so `sudo`, a pipe into a shell, a write outside the working folder and a force-push came to you whatever mode you were in. Full Access is the mode where that stops being true, which is the whole point of it - the always-ask list goes, the classifier is never consulted and never billed, and a connected server's tools run unasked as well, since a mode by that name that still stopped on every non-read-only MCP call would not be the thing it says it is. The one thing it does not override is a deny rule, because that is a sentence you wrote by hand about a command you had in mind, and a mode is not an argument against it: in the gate the new check sits immediately below the deny rules and above everything the gate would otherwise work out for itself, and a command you already said no to earlier in the same turn stays refused if you flip the mode mid-turn. It is also the one setting in the app that changes what runs on your machine without anybody being asked, so it does not survive a restart - the person it would catch out is the one who turned it on for a job that finished days ago, and Fleet comes up asking again with turning it back on a single click. The reset runs ahead of both the window and the IPC handlers, so the renderer can never draw a mode that is about to be taken away from it. There is no confirmation dialog and deliberately so: a dialog is a thing you learn to click through, where a control that is red the entire time the pane is open is a thing you keep seeing (#548).

## v2.107.2

- **Pasting into a terminal works on Linux and Windows** - `Ctrl+Shift+V` did nothing, and right-click → Paste opened the menu, took the click and left the prompt exactly as it was. Nothing was logged and nothing was shown, because the failure was a rejected promise nobody was catching: the app installs a deny-by-default permission handler that allowlists `media` and `clipboard-sanitized-write`, `clipboard-read` is not on it, and both paste paths wrapped `navigator.clipboard.readText()` in a bare `void ... .then(...)`. So every paste resolved into a `NotAllowedError` that was dropped on the floor. What kept this hidden is that neither of the two obvious places to look was broken. macOS never reaches that code at all - its paste goes through Electron's native Edit menu `paste` role, which does not touch the async clipboard API - so the whole thing is a Linux and Windows bug that could not be reproduced on the machine most likely to be looking for it. And a Claude Code or other TUI running inside the very same pane pastes perfectly, since it gets the raw keystroke over the PTY and reads the clipboard from its own process, which makes the pane look like it can paste right up until you try it at a plain shell prompt. The clipboard is now read in the main process over a `clipboard:read-text` channel rather than by adding `clipboard-read` to the allowlist, and the reason is the context menu specifically. Blink gates that API on transient user activation as well as on permission, and clicking an item in a native `Menu.popup()` is not a DOM user gesture, so granting the permission would have fixed `Ctrl+Shift+V` and left right-click → Paste depending on whether the original right-click was still inside the activation window. Main has neither gate, and the allowlist stays as narrow as it was. The Annotate dialog, which prefills its field from a URL on the clipboard, was silently failing on the same call and is fixed by the same change. `Ctrl+V` without Shift stays deliberately unbound and passes through to the PTY as `\x16`, which is what keeps vim's visual-block mode reachable; `Ctrl+Shift+V` is the terminal convention on both platforms (#547).

## v2.107.1

- **A pane you `cd` out of reopens where you left it** - the live working directory lived only in the session store the components read from, and nothing ever wrote it back into the layout, which is the thing that gets persisted and the thing the next launch spawns the shell into. So a pane moved from one project to another was labelled correctly for the rest of that session and then quietly reverted on every restart afterwards, forever. What made it hard to see is that nothing on screen was wrong: the title and the sidebar were faithfully reporting a pane that really had gone back to the old folder, so it reads as a stuck label right up until you check where the shell actually is. The new folder is now recorded on the pane, and on the tab as well when the pane is the tab's first one, since that is the pane the tab's own folder tracks and a second split wandering off is not the tab moving. The write is skipped when nothing actually moved, which matters more than it sounds: on macOS there is no OSC 7 hook of any kind, so every directory update comes from a five-second `pid-cwd` poll that fires whether or not the shell went anywhere, and a store update on each of those would mark the layout dirty on a timer and rewrite it to disk for the life of the window (#546).

## v2.107.0

- **The Agent pane can run on a model on your own machine, and the OpenRouter key is now optional** - a `llama-server`, an Ollama, an LM Studio or a vLLM on this computer is added by address and its models join the pickers beside the cloud ones, for the coding agent, session titles and the command classifier alike, so a machine with nothing but a local server on it now runs the pane without an account anywhere. Image generation and voice dictation are still OpenRouter's alone and say so where the key is asked for. A server is either typed in, with a Test button beside the field, or found by asking Fleet to look at the ten usual loopback ports - on request only, never on its own, and the sentence above the button says what pressing it will do before it does it. What Test reports is a warning rather than a validation: a process on your own laptop being off right now is the ordinary case, not a mistake in the form, so nothing it finds stops the address being saved. What it does do is say which of six things happened, because "could not connect" is the same sentence for a server that is off, one that is still loading thirty gigabytes, one that wants an API key and an address that belongs to something else entirely, and each of those is a different thing to go and do about it. The roster of the last successful check is kept, so quitting with the server off and reopening does not lose the model out of the picker - it is still there, greyed and still selectable, rather than a setting you had already made vanishing with nothing on screen to say where it went. Two things a real server taught us that the documentation would not have. llama.cpp accepts OpenRouter's `reasoning` parameter and ignores it, so asking for reasoning off did nothing at all: a session title came back empty with every one of its tokens spent thinking, and in auto mode every command would have fallen through to asking you. Where a call goes is now a record that carries its own dialect, and the local one says `chat_template_kwargs` instead. The other is that a context window has two numbers and they routinely differ by more than an order of magnitude - 16,384 allocated against 262,144 trained is an ordinary way to run a model on one card - and that a server with nothing loaded reports the window as `0` rather than leaving the field out, which a `??` chain walks straight into. Either would have had a conversation budgeted against a number that was never true, and found out mid-turn. Local model ids are namespaced rather than mixed in with the cloud ones, so nothing already chosen moves and there is no settings migration (#545).

## v2.106.1

- **The scrollback setting does something for the first time** - the field in Settings → General stored a number and read it back correctly, but nothing ever handed it to a terminal, so every pane ran on xterm's hardcoded 3000-line fallback no matter what was in the box. It is threaded through to the terminal now, along the path the font and theme settings already take, and applied to the live instance rather than by rebuilding it: xterm resizes both the normal and alternate buffers when that option changes and trims the oldest lines on the spot, so shrinking the number actually returns the memory instead of only capping future growth, and the pane keeps the buffer and the shell it already had. The default moved from 10,000 to 3,000, which is what everyone has been running all along - and that could not be done by editing the constant alone, because the settings library writes its defaults into the file on first launch, so the unused 10,000 has been sitting on disk for every existing user the whole time. Honouring it the moment the wiring started working would have taken a full pane from about 15 MB to about 37 MB, roughly three times the per-pane memory, in an app whose whole point is running many panes at once - the exact regression the fix existed to avoid, arriving as a side effect of the fix. A one-time migration rewrites exactly that number and leaves every other value alone, so 10,000 stays available to anyone who now picks it deliberately. The field is clamped to 500-100,000 as well: a live setting saved on a debounce turns a pause halfway through typing "3000" into a scrollback of 3, and those lines do not come back (#540).

## v2.106.0

- **A picture in a transcript can become the window's background without leaving the conversation** - deciding a generated image is worth looking at all day happens the moment it comes back, but acting on it meant copying the path, opening Settings and browsing back to a folder full of uuids to find the picture already on screen. Images in the transcript carry the two actions themselves now, as icon buttons that fade in over the thumbnail and as the same pair in the full-size viewer's toolbar, because whether a picture is worth the window is not a judgement anyone makes from a thumbnail and the actions have to survive opening it. Any image with a real path gets them, `read` results included, not only generated ones. A background is a path in settings and nothing more, so whatever it points at has to outlive every other reason the file exists - and an agent's image does not, since it lives under the conversation that made it and deleting that conversation would leave the user staring at a blank window with no idea what they did wrong. The file is copied into `~/.fleet/backgrounds` first and the setting points at the copy, named by a sha256 prefix of its own contents so that adopting twice is free: promoting one picture to both the background and the slideshow stores it once, and a slideshow cannot end up holding the same image under two names. The bytes written are the bytes that were hashed rather than a second read of the source, so a file changed in between cannot be stored under the name of contents it no longer has. Setting a background turns the slideshow off, because the slideshow wins over the single image path when both are set and the user would otherwise have asked for a picture and watched the old one carry on. Adding to a slideshow that is running off a folder seeds the list from the folder first, so the show carries on with one more image in it instead of collapsing to the single one just added - the folder is frozen at that moment, which is the honest half of a trade where a list and a folder cannot both be the source. Those adds are serialised on a promise queue: appending is a read-modify-write across two round trips and the settings store replaces the file list wholesale rather than merging it, so two clicks in the same second would both read the list as it was before either landed and the second write would drop the first picture with no sign it had gone. Behind the Settings pane's file dialog that interleaving was exotic; behind a button in a transcript it is what adding two images from one conversation looks like (#534).
- **Startup parses 2.12 MB of JavaScript instead of 6.98 MB** - `PaneGrid` statically imported every pane type, so opening a window on plain terminals still parsed pdfjs, CodeMirror, highlight.js and shiki for panes that were not on screen and might never be. Only the terminal pane is eager now and the rest load behind a per-pane suspense boundary, so a slow chunk cannot blank its siblings. Underneath that, `streamdown` and `@git-diff-view/shiki` both depend on shiki 3, which npm nests as two private copies beside Fleet's own shiki 4, and the bundler emitted all ~300 language grammars three times over; collapsing them onto one copy took total renderer JS from 35.08 MB to 16.89 MB across 934 files down to 342. The second half was the modals. Settings, Annotate and Sessions only render when their tab is active, and the Notes preview and Git Changes diff render nothing until their modal opens, yet all five were static imports - so react-markdown, highlight.js and `@git-diff-view` were parsed at startup by every window. The trap is that the app's modals are always mounted and self-manage via an `isOpen` prop, which makes a lazy import at the modal boundary resolve immediately and gain nothing; the overlay primitive returns null while closed, so a lazy child *inside* it never imports until first open, and that boundary preserves the exit animations that gating the mount would have destroyed. Git Changes needed a further split, with every value import moved into the lazy renderer so the parent deals in a plain string instead of an enum it had to import to name. What is left in the eager entry is xterm, the command palette and app chrome (#535).
- **The main process boots in 521 ms instead of 654 ms, and a cold start paints in 859 ms instead of 1025 ms** - evaluating the main bundle's module graph took ~380 ms before the window was created, and most of it was work for features a given launch may never touch. Four deferrals, measured one at a time: the S3 client and its credential providers (~30 ms) load on the first call rather than at import, since Env Sync is the only caller and every entry point into it was already async; `electron-updater` (~48 ms, with the ajv, conf and semver tree behind it) loads on first use, with its IPC handlers left registered eagerly because the renderer may call them the moment it mounts and the packaged-build launch check moved to after the window has loaded rather than in front of it; the web_fetch HTML pipeline (~20 ms of linkedom, readability and turndown) loads on the first fetch instead of on every launch; and the four settings stores open their files on first access, since the library writes its file atomically as part of construction and Fleet was doing four blocking fsyncs before it had a window to show. Module eval went 376 → 199 ms on production builds over interleaved runs from a fresh profile (#536).
- **Typing in a file editor no longer re-renders every pane in every tab** - one character in an editor re-rendered the whole tab tree, hidden tabs included, which is the app's core workflow: editing a file while several agent panes stream behind it. Two causes, neither in the pane path. The dirty-flag action fires on every keystroke and had no equality guard, so after the first character it set `true` over `true` forever and each call built a new workspace object, a new tabs array and a new object for every tab rather than the one owning the pane - and since the top-level subscription compares one level deep, a fresh workspace reference re-rendered everything below it. The enabling fix was in the tree walkers, which now return the node they were handed when no descendant changed: without that no guard is writable, because every walk rebuilt the whole tree, and with it an update touches only the spine down to the one node it edits. The divider drag had the same shape once per mousemove. Separately, two hooks called from the top-level component subscribed to their stores with no selector - and a hook body runs in its caller's render, so those were subscriptions on the component itself, one line below the comment warning against exactly that. Keyboard navigation reads state on demand inside its handler instead and binds its listener once; notifications select only the two setters they use. As a backstop the pane grid is memoised, along with a new terminal leaf that owns its four per-leaf handlers - memoising the terminal pane directly would have been inert, since the handlers can only be built per leaf and inlining them hands it four new functions on every render. Measured on a live window: fifty repeated dirty-flag writes now produce one store update instead of fifty, and a divider drag produces one from ten identical mousemoves while five genuinely different moves still produce five (#541).

## v2.105.0

- **The Agent pane's image model list was the wrong list, and the picker mounted every row in it** - the settings offered ten image models, nine of them Gemini or GPT-5 chat models and the tenth `openrouter/auto`, which is not an image model at all and is refused by the endpoint that would have had to run it. The list was built by filtering the models.dev chat-completions catalog for anything that can emit an image, while the tool posts to `https://openrouter.ai/api/v1/images` - a register of its own holding 41 models, most of which never appear in a completions catalog because you cannot hold a conversation with them. Flux, Seedream, Recraft, Qwen Image, Grok Imagine, Krea, Riverflow, MAI and every `gpt-image-*` were unreachable, 32 models in all. The larger half of the bug was that the same endpoint publishes `supported_parameters` per model and the spread is wide: `quality` on 7 of the 41, `resolution` on 17, `seed` on 10, `aspect_ratio` on 38 with 22 distinct values between them. Fleet drew a fixed Resolution, a fixed Quality and a Seed field for every model and sent all three, so Quality was a working-looking control that meant nothing for 34 of them, and the tool advertised a fixed eight-value aspect-ratio enum that included `21:9`, which 25 models reject after the picture has been paid for. The register is now downloaded beside the completions catalog, into the same cache file on the same daily schedule, and unlike the defaults list this fetch is not best effort: an empty image list is indistinguishable from "image generation is unavailable", so a failure fails the refresh and the last good cache is served with the reason attached. Each control is drawn from the chosen model's own lists and hidden when that list is empty, switching model drops the values the new one has no parameter for, and the tool's schema is rebuilt per turn from the model behind it so the aspect ratios offered are the ones it accepts and the reference ceiling is its own. The per-token price is gone from the image rows, since it says nothing useful about the cost of a picture, and in its place is a link to the model's OpenRouter page where the pricing and the samples both live. Underneath all of it the picker was mounting 200 rows on every open and unmounting them on every close - a row costs about 0.3ms, so opening the coding picker cost 83ms, five frames of work for rows nobody had scrolled to. It pages instead, 24 rows at a time, growing as the scroll nears the bottom, which took the open to 33ms; and because the 200 cap was removed rather than tightened, both lists are complete for the first time, all 278 tool-capable models and all 41 image models (#533).

## v2.104.0

- **The Agent pane knows how to prompt an image model, and what it knew before was a generation out of date** - the guidance Fleet shipped told an agent to front-load its tokens, keep a prompt to 30-75 words, finish with a couple of quality modifiers and hold text inside a picture to three words at the most. That is all advice for models that read a prompt as a bag of tags, and the one behind the button is `fal-ai/nano-banana-2`, which reads it as instructions, renders whole paragraphs accurately, and treats "masterpiece, 4k, trending on artstation" as words it has been asked to spend attention on. The three-word rule was the expensive one, because it steers the agent away from the single capability that most separates a current model from its predecessor: a poster that could have carried its own headline came back with the headline drawn as scribble. A bundled `image-prompting` skill replaces it, written against the `image` tool as it actually is rather than against image generation in general - one prompt, up to four references, eight aspect ratios and nothing else, no seed, and no way for the model to look at what it made, which is why a second attempt is a fresh charge for a different picture rather than a refinement of the first one. It carries the scene/subject/details/use-case/constraints skeleton, the rule that a literal string goes in quotes with its typography named as a constraint rather than wished for as a vibe, indexed roles for reference images and a character anchor pasted verbatim to hold a series together, and per-family notes for Gemini image, GPT Image and Grok, since which of them answers is a setting the skill cannot assume. The `fleet` skill's copy of the same advice, which serves the `fleet images` CLI for agents running in a terminal rather than in a pane, is corrected where it stood. So is the one line of the `image` tool's own description that told the agent to describe an edit as the finished result instead of as a change with a preserve list beside it - without that list the model treats the whole frame as editable and quietly redraws the face, the background and the lighting along with the sleeve it was asked about, and the line was the last thing steering it wrong on turns where the skill never loads (#532).

## v2.103.0

- **A long image prompt stays inside the transcript, and a generated picture says where it is** - an `image` row puts the whole prompt in its target slot, and with a real prompt the row measured 4068px inside a 672px column, ran off the side of the pane and took the transcript's horizontal scrollbar with it. The row had carried `truncate` the entire time and it had never once done anything, because `truncate` is `white-space: nowrap`, which makes the span's minimum width the whole string, and the turn container is `items-start`, which sizes every child to its own content rather than to the column: a box that is never narrower than its text has nothing to trim. The cap goes on the container rather than on each row, since `items-start` is the thing that removes the bound and every row type added later would otherwise have to remember to defend itself - the four that exist today had all forgotten. Underneath the picture the prompt is now printed in full, because the row can only hold its first few words and a generated image has nothing else that says what was wanted: the file is a hash, and the picture cannot tell you what it was asked for and missed. Below that is the path, which copies on a click. It gives way in the middle rather than at the end, since a store path is two long ids and a name and does not fit, while the folders are identical for every picture in a session and the file name is the only part that says which one this is. The same path is reachable from inside the full-size viewer, which is where a picture is actually judged and which covers the row it came from; it answers with a tick rather than a toast, because a toast is drawn behind the overlay where nobody is looking. Only for `image` - a picture that came back from `read` has its path on its own row already. Two further bugs surfaced on the way, both of them older than this work. Every copy button in the app had been doing nothing: the deny-by-default permission handler added for dictation answers no to everything it does not recognise, and writing to the clipboard is a permission Chromium asks for even from a click, so `navigator.clipboard.writeText` was rejecting in a focused window on a real gesture at all thirteen call sites - the code block copy, Annotate's "Path copied to clipboard", the shell environment values, the SSH browser's path copy, terminal copy-on-select - and because most of them announce success alongside the write rather than from its result, the app had been claiming to copy for as long as the handler had been there. And every modal was being painted under the sidebar: `z-50` only ranks an element against its siblings inside the nearest stacking context, and the pane column is a `z-10` sitting in the same row as the `z-20` sidebar cards, so no number written inside a pane could ever win it. Overlays are rendered into the body instead, which fixes all twenty-one of them at once (#531).

## v2.102.0

- **The Agent pane can read a web page, and does it without asking** - a coding agent that cannot open the documentation it is being asked about is guessing from a training cutoff, so `web_fetch` takes a URL and hands back the article as markdown. It runs the moment it is called, the way `read` and `edit` do: no permission card, no origin rules, no per-URL question. A pane that rewrites your files unasked and then stops to ask before looking at a public web page is drawing the line in a place nobody would defend, and the only thing a prompt in that position teaches is to click through it. What the agent may never reach is decided in code instead, where it costs nobody a click - cloud metadata endpoints are refused whatever the settings say, since `169.254.169.254` exists to hand out IAM credentials to anything that asks and is the worked example in every SSRF advisory; every redirect hop is judged again from scratch rather than inheriting the first URL's verdict, because a page that is allowed to be read is not thereby allowed to send us somewhere; and a name that answers with one public address and one private one is refused outright, since that is not half-safe, it is a name that reaches the private one as soon as the order changes. The part that took the work is that the socket goes where we checked. Checking the host string and then handing the name to an HTTP client looks like a guard and is not one - the client resolves the name again when it opens the socket, and nothing says the second answer matches the first - and the obvious fix cannot be written, because Node's `fetch` is undici, undici ignores `http.Agent` outright and re-resolves at connect time, so an agent with a custom resolver compiles, reads correctly, and does nothing at all. The fetch path is `node:https` with a `lookup` that returns the one vetted address and ignores the hostname it is handed, which is the only place the promise can actually be kept. A page whose served HTML is an empty shell is loaded in an offscreen sandboxed browser window and read again, which is most of what a dev server serves; a local page renders under a rule that lets it load its own bundle, and a page from the internet renders under one that cannot reach this machine at all, whatever you have allowed yourself to name. Reading a page you can reach is on by default and switchable off, and what comes back is framed as data with a line saying anything in it that looks like an instruction is not one (#530).
- **The AI review workflow runs again, and the ESLint warning backlog is gone** - the review job was floating on whatever `opencode` version happened to publish that morning and the Go cache was pointed at a `go.mod` that is not there, so the workflow was failing on setup before it read a line of the diff; the version is pinned and the cache points at `hooks/fleet-copilot-go/go.mod`. Alongside it, the warnings that had accumulated under the error gate added in v2.97.1 are cleared, which mostly meant deleting optional chains and `??` fallbacks the compiler could already prove would never fire - each one a small claim that a value might be missing, standing next to a type saying it cannot be, and a reader has to stop and work out which of the two is lying (#529).

## v2.101.0

- **A pane stops drawing lines around itself, and how much of the wallpaper shows through one is finally yours to set** - a pane was drawing two edges, not one: a 1px border, and just outside it a 1px status ring, because a Tailwind ring is a box-shadow outside the border box rather than part of it. The ring was carried for every state including `idle` and `working`, so it was on every pane all the time and therefore said nothing, and over a background image the pair read as an outline pasted onto the picture rather than as the card's own edge. Both are gone; a pane is bounded by the gutter around it, its rounded ground and its title bar, and the ring now appears only for states that actually want you, which makes the ring appearing the signal. The title bar goes the same way - the full-width strip and its bottom border are replaced by a pill holding the status glyph and the path, with the hover toolbar in a matching pill at the other end. The row underneath them stays in normal flow at full width, which is doing two jobs: it is still the click and double-click target, and rename is only easy to hit because the target is the whole width, and being in flow is what makes it structurally impossible for the pill to cover the terminal's first line. A chip positioned absolutely over the pane would have needed the terminal padded by exactly the chip's height, and that constant drifts the moment either side changes - which is precisely how the toolbar used to end up sitting on the first line of output. The two pills are pinned to a shared height rather than left to their own padding, since the toolbar's is set by its icon buttons and the title's by its line box and those land 2px apart, which reads as a wobble between two things on the same line; the viewer panes' path bar gets the identical treatment so a window of mixed panes has one kind of title on it. And the glass itself becomes three sliders under Terminal Background. How much image showed through a pane had been a hardcoded constant, leaving the picture's own Opacity as the only lever - and opacity scales chroma and luminance together, so the single available move drained the colour out of an image on its way to making it dim enough to read over. Tint sets how much of its own theme colour a pane keeps, Saturation puts the colour back without making the picture any brighter, and Frost blurs the backdrop behind panes only, so the gutter between them stays sharp and the panes read as sheets of glass rather than as one softened image. The new fields are flat rather than a nested object, which is what lets the settings store's spread-defaults migration pick them up without changes of its own, and they default to the values the panes were already hardcoded to, so an upgrade looks identical until a slider moves; with nothing dialled in the backdrop filter is omitted entirely rather than set to a no-op, so the default path creates no compositing layer (#528).

## v2.100.0

- **The terminal renders on xterm 6** - the DOM renderer measured about twice the echo-latency headroom at 32 panes, which is the shape of a Fleet window with a fleet of agents streaming into it, and that was the whole reason to move. GPU rendering was measured alongside it and ruled out: Chromium caps an application at 16 live WebGL contexts and fails silently past that, panes seventeen and up keeping a canvas whose context is dead and which paints nothing at all, with no event to tell anyone. The upgrade withdrew three things the app had been relying on, none of which raised an error and none of which the test suite could see. Scrolling stopped unpinning a pane: v6 scrolls through VS Code's scrollable element, which stops wheel and key events before they bubble, so the listeners that notice you have scrolled up never ran at all, and every fresh chunk of output snapped the view back to the bottom - scrollback was unreadable in any pane still producing output. Nothing paints the theme background any more either; that was the old viewport's job, and all v6 leaves in its place is a hardcoded opaque black, which buried the terminal background image and left the light themes rendering dark text on a dark pane. And the scrollbar stopped being a native one, so it missed the styling every other scroll port in the app picks up and arrived as a 14px slider in the wrong colour; it is teal and 6px again, with the full 14px kept as the grab target, since a scrollbar you can catch is worth more than a narrow hit box. The addons deliberately stay where they are - the 6.x line is published on a beta tag only and pins a beta core (#527).

## v2.99.0

- **The Agent pane knows what machine it is on and what time it is** - it was told one fact about its surroundings, the working folder, and left to guess the rest, which is how an agent writes `sed -i ''` on Linux, reaches for `brew` on Windows, and answers "what changed this week?" out of a training cutoff months stale. The system prompt now carries the platform, the OS version, the shell, whether the folder is a repo, the timezone and the model serving the turn, appended by Fleet where the working folder line used to sit alone so a custom system prompt cannot drop it; the repo check is the same bounded walk of git's own files the status line uses, so nothing is spawned to answer it. Subagents get the identical block, on the reasoning already applied to skills and project instructions - a child runs `bash` on this machine and has no conversation to have been told which machine that is. The clock deliberately does not go there. The system message is the request's cache prefix, so a timestamp in it would rewrite that prefix every round and throw the cached prefix away with it, a forty-round turn paying full rate forty times over, and it would be wrong regardless, since the prompt is built once per turn while a turn can run for an hour. It rides as a message immediately before the newest user message instead, in the region that is re-sent uncached anyway, which makes the accurate answer also the free one - and it is left off a turn the user did not open, so a pane resuming after a subagent reports still ends on that report rather than on a statement of the time the model might feel invited to answer. Which fields to send follows where Claude Code, Codex and opencode independently converged; their `<env>` tag does not come along, because Fleet answers with whichever model OpenRouter routes the turn to and a tag one of them has never seen is either ignored or read out loud, so the clock speaks under `Note from Fleet, not from the user:` like every other block Fleet pushes onto a round (#526).

## v2.98.0

- **Panes are cards on one canvas now, not tiles that each re-centre the wallpaper** - `background-position: center` resolves against the element it is set on, so a three-way split was showing the same picture three times over. There is a single canvas behind the whole window and every surface floats on it: terminals hold 22% of their own ground so the image reads straight through the monospace, prose panes stay near-solid at 88% because a transcript is read a paragraph at a time and a picture moving underneath costs more than it gives, and the sidebar and the three tool pages become cards with the same gutter the panes have. Those gutters are now actually 8px, which they were not - the grid's `p-1` had never done anything, because leaves are absolutely positioned and an absolute child resolves against its ancestor's padding box, so the inset had to move to a wrapper. The pane toolbar leaves its floating position over the terminal's first line of output and moves into the title bar, eleven icons collapsing to three plus an overflow menu. Focus stops being a blue ring: the accent already means *something needs you* here - the status ring, the activity glyph, the permission prompt - so spending it on which pane the cursor is in made one colour say two unrelated things, and shouted the less interesting one. The focused card keeps its shadow, firms its border and lights its own title bar while every other card flattens onto the canvas and greys, which is how macOS has marked active windows for decades; nothing dims, so terminal output in a background pane keeps full contrast. The sidebar's Agents, Tools and Workspaces sections fold away to their headers, keeping their counts and add buttons live while folded, and acting on a folded section opens it rather than hiding what you just asked for. Two bugs fell out along the way. `text-white` headings were invisible in all four light themes, because the tool pages had been left largely outside the theme system - 34 hardcoded classes in Annotate, eight settings sections on raw `neutral-*`, and `bg-blue-600` buttons that ignored the accent colour entirely, all now on `--fleet-*` tokens. And renaming a pane lost focus the instant it started: the container's click handler focuses xterm, xterm taking focus blurred the rename input, and so the field was destroyed by the trailing click of the double-click that had just opened it (#525).

## v2.97.1

- **A running agent no longer blocks the terminal or starves the rest of the app** - typing in a normal terminal pane went dead while an Agent pane was streaming, and the agent itself re-read files it had already read instead of working through its task list. The blocking was a chain rather than one bug: the agent sent one IPC message per streamed token, the main process queue filled, the PTY's 16ms flush timer missed, and the PTY buffer crossed its 256KB high watermark and paused. There is no low watermark, so nothing but a renderer-originated drain could unpause it, and the renderer was itself pinned re-rendering the transcript once per token. Keystrokes were reaching the shell the whole time, since node-pty pauses the read side only; what was withheld was the echo, which reads as dead input. Streamed text is now coalesced into one message per pane per frame, with any non-text event flushing held text first so a tool row can never draw above the sentence introducing it; a paused PTY resumes after 250ms without a drain, which is the low watermark it never had; and the transcript's components are memoized. The starving was the same complaint further down - a search resolving the working folder once per file through a synchronous symlink walk across twenty thousand of them, a session replaying its whole history to total up a turn, an OpenRouter call that had gone silent holding an app-wide subagent slot forever, one conversation taking every subagent slot, and a build taking every core away from the flush timer. Searches now stand aside every eight files and stat in a bounded pool, running totals are read from the end of the file, a call idle for 90 seconds is abandoned, one conversation is capped at three of the five slots, and shell commands run at below-normal priority (#523).
- **ESLint from 104 errors to zero, and a gate in CI so it stays there** - the errors were mostly `as` casts standing in for runtime checks over data crossing a process boundary, now replaced with real type guards, plus a `CopilotSection` that declared three hooks after two early returns and so changed its hook count once settings arrived, which React throws on. `npm run lint` now runs in CI beside typecheck (#524).

## v2.97.0

- **The Agent pane remembers what a session learned** - short markdown notes about this project and this user, written by the agent itself. An entry is one fact in one file under `.fleet/memory/`, in the project or in your home directory, carrying a name and a one-line description in its frontmatter. Disclosure is skill-style: every entry's headline rides in the `memory` tool's own description each round and the body arrives only when the model asks for it, which is what lets a year of notes accumulate without the prompt growing to match. `memory_write` writes silently mid-turn as an ordinary tool row rather than a permission card, and there is deliberately no delete tool - a wrong entry is corrected by writing over it under the same name, leaving the diff visible in the transcript, and removing one outright is yours to do in the new Memory section of Settings. Subagents read memory and never write it. The other half is `/refine`, a bundled command that looks back over the conversation it is run in and records the few things a future session would otherwise learn the hard way; its prompt is evidence-first, so a candidate qualifies only if you can point at where it happened and writing nothing is a correct outcome, and it reports last, so what was written and what earned it both land in the turn. The pane also now reads the project's own standing instructions - `AGENTS.md`, falling back to `CLAUDE.md` - injected unconditionally and never truncated, because a cap on those is a silent removal of rules the project wrote down expecting them to be followed; past 20,000 estimated tokens the context meter turns amber and tells you what the file costs instead (#522).

## v2.96.0

- **Speaking a prompt into the Agent pane** - hold the mic beside the paperclip and talk, or press `Cmd+Shift+V` and talk, and the transcript lands at the caret in the composer you already use. Nothing is ever sent for you: what you get is an ordinary message, so slash commands, `@` mentions, attachments and prompt history all work on it unchanged, and `Cmd+Z` puts the box back the way it was. A short press toggles recording on and leaves it on; a long one records until you let go, and moving off the button while holding throws the clip away. Transcription goes through the OpenRouter key already in Agent settings, on Whisper Large v3 Turbo pinned to Groq - the one provider that honours recognition hints, which is what spends the hint budget on your project folder name, the current branch and a list of coding vocabulary so identifiers come back spelled the way they are written. The model is yours to change, and the settings pane says which choices keep the hints. Text-to-speech is deliberately absent: agents answer in diffs and tool-call chatter, none of which is worth listening to. The care is in the failures rather than the happy path - a near-silent clip is dropped before upload rather than handed to a model that invents words out of silence, an unplugged microphone transcribes what it already captured, Escape cancels the recording without touching the turn that is streaming, switching tabs mid-recording releases the microphone and discards the transcript rather than posting it into an empty box, and a request that fails keeps the audio so retrying costs nothing (#521).

## v2.95.0

- **Subagents in the Agent pane** - a `task` tool that hands a scoped errand to a second agent with its own context, its own transcript and its own bill, and reports one answer back. Definitions are markdown with YAML frontmatter, read from `.fleet/agents/` over `~/.fleet/agents/` over the two that ship with the app; the body is the child's system prompt and the frontmatter sets a default tool allowlist the parent can narrow per call. A subagent is a turn, so it runs through the same rounds loop, the same tools and the same permission gate - what differs is only what it is handed: no image tool, no MCP, and no subagent of its own. Up to five run at once and they outlive the turn that dispatched them, each asking its own questions on its own card, so five of them stopped on five commands cannot cross-wire (#497).
- **Skills, and installing them from disk or a repository** - a skill is a folder with a `SKILL.md` in it: instructions the agent reads only when it decides it needs them, so the name and description cost one line of the tool roster and the body arrives on the first call. Three tiers with the most specific winning - the one Fleet ships, `~/.fleet/skills` for every project, `<cwd>/.fleet/skills` for one - and nothing is cached, so editing a `SKILL.md` takes effect on the next turn. Two ways in, because those are the two ways skills actually travel: import reads the roots other harnesses already use (Claude Code, OpenCode, `~/.agents`) and copies what you tick, and from a repository clones, shows what is inside, and throws the checkout away. Both copy rather than read foreign directories live, so a skill cannot change under the agent (#502).
- **Commands as files on disk, and `/pr-review`** - a command is a markdown file with frontmatter, found in the ones that ship with the app, your own in `~/.fleet/commands`, and the project's in `.fleet/commands`. Adding one is adding a file. Expansion happens at the single point every user message passes through on the way to the wire, and nothing is stored expanded: the transcript keeps what you typed, and an edited prompt file takes effect on the next message. The bundled `/pr-review` checks out the PR, fans out to review subagents on four distinct angles, then verifies every candidate against a default verdict of refuted - a finding survives only with a quotable path:line and a concrete trigger - and asks before posting anything (#500).
- **`/implement`, a command for building a feature end to end** - explore, clarify, plan, stop, build, verify, review. The stop is the point of it: the pane has no plan mode, so the gate before a change lands on disk is the prompt telling the model to end its turn with the plan in the conversation and wait. Clarify sits before the plan rather than after it, since a question asked once the architecture is chosen is asked too late to change it, and the verify step names no commands of its own - it reads them off `CLAUDE.md`, `package.json` and CI, because the folder you opened the pane on is not this repository. It finishes green, self-reviewed by a review subagent whose findings it re-derives before believing, and uncommitted (#501).
- **An agent pane can open in a new worktree** - the New Agent folder dialog gains a "New worktree" checkbox, enabled whenever the chosen folder sits in a git repository, so an agent can be given a branch and a working tree nobody else is editing. The worktree is always cut from the repository root, since `git worktree add` names both the branch and the directory after the path it is handed; a folder picked below the root is carried across, so picking `src/` opens the agent at `<worktree>/src`. The existing close-time confirmation, undo window and on-disk removal all apply unchanged (#499).
- **The permission card answers to the keyboard** - Enter runs the command, but only when there is nothing to send, so a draft caught mid-sentence is still a message you meant to send and Enter never becomes a way to agree to a command without having looked at it. The card is held back until the typing stops, which is where the danger actually was: a card that lands between two keystrokes takes the next key with it. Nothing autofocuses the approve button, because Space activates a focused one. Escape twice interrupts the turn - one press is too easy to arrive by accident, and what it discards is minutes of work. Each answer now names the question it was given, so the store can never resolve it against the next one (#498).
- **A conversation can wake itself up later** - three tools let the model set a 5-field cron reminder for itself; when it comes due it arrives as a new message in the conversation that set it, and an ordinary turn follows from it. Main owns the records and is the only place due-ness is decided, split into a producer and an idempotent consumer so double delivery is impossible rather than unlikely, and the timer recomputes from the wall clock and ticks eagerly on start, which is the whole of the app-was-closed catch-up. Four guardrails: ten schedules per session, a chain depth of three, a five-minute floor checked two ways, and a panel you can always see and cancel from. Subagents get none of it (#517).
- **The subagents still running, beside the conversation** - a dispatched subagent was the one thing in the pane with no home on screen while it worked: its card is pinned to the row that started it, and the parent goes on writing above that row until it scrolls out. A second card below the task list now lists only the ones still running, and they leave the moment they report; a chip carries the same count when the column is not up. The model gets the same roster on the wire each round, so it stops re-dispatching work already in flight (#505).
- **A run of the same lookup folds into one row** - answering one question takes the agent a dozen reads, and drawn one to a row they are most of the transcript. Three or more `read`, `glob` or `grep` calls in a row become "Read 5 files", with the first two targets and a remainder beside the count and the rows themselves behind a disclosure. Three, because folding a pair saves one line and costs a filename. Only the lookups fold: a change to a file, a command, a picture and an errand are each a row that *is* the thing that happened. A run also ends at a failed call, which is the row you most need to see and so the last one to bury in a count (#519).
- **The task list floats as a card** - it was a full-height slab with a hard left border, butting into the tab strip and leaving a tall run of empty tint below a short plan, which reads as a region of the pane that failed to load rather than as a short list. It now hugs its list on the same glass surface as the composer, and a long list scrolls inside it instead of running off the bottom (#503).
- **The conversation stays centered when the cards are up** - the card column and the conversation are flex siblings, so the moment the agent wrote a plan the whole reading column slid 136px left, out from under the tabs above it. A matching gutter puts the two centers back together and means nothing moves when a card comes or goes, clamped to the room actually spare so a narrow pane keeps its reading width instead. The styled scrollbar's 6px is real layout width, which had the transcript and the composer 3px apart; they are now the same box at every pane width (#518).
- **The collapsed sidebar rail gets the sections it was missing** - the rail is a second copy of the tab list, so three rules the sidebar learned were never copied across: agents were mixed into the tab run instead of pinned above the tools block, and markdown and ssh-browser tabs drew a terminal prompt. It also showed no status at all, so an agent waiting on a permission prompt was invisible while collapsed. That decision moves into one component both the sidebar row and the rail render, rather than being stated a second time - which is how the drift happened (#520).
- **Auto mode was silently inert on a reasoning model** - it was on, read-only commands still stopped and asked, and there was no error anywhere. The classifier asks for one word and gives it eight tokens, and no reasoning parameter was posted, so on a reasoning model those tokens went on thinking, content came back empty, and an empty answer read as "ask" - indistinguishable, from the gate's side, from a model that considered the command and declined it. This was the ordinary path: the classifier defaults to the coding model, which is by definition the strongest one you picked (#507, #508).
- **A late subagent report no longer makes the pane answer twice** - a turn that finishes while one child is still out resumed on the report and wrote its whole summary again, nearly word for word, at a full extra turn's cost. The resume is right; what was wrong is that the resumed turn was told nothing, leaving the request that started the work as the last thing said. It now says it is a continuation (#506).
- **A queued subagent no longer looks like a failed one** - asking for a sixth subagent while five are running put two red-looking rows in the middle of the work, identical in the transcript to a subagent that does not exist. Nothing went wrong: the cap was borrowing the error channel because throwing is how the manager tells the model to try again later. It is now told apart by type and shown as "waiting for a slot" (#510).
- **Old sessions lost their tool calls on reopen** - `z.unknown().transform(...)` makes the key itself required in zod 4, so every tool call written before the task list shipped failed to parse and was skipped. The messages came back; what the agent had done in them did not (#505).

## v2.94.0

- **Auto mode answers the ordinary permission questions** - a long session asks the same thing over and over, and a prompt clicked through without reading has stopped being a prompt. A cheap model now sees the command line and the working folder and answers `safe` or `ask`; only a plain `safe` runs anything, so a refusal, an outage, a missing key, or anything else it could say all land on `ask`. It can only ever remove a question, never add a refusal: deny rules and the always-ask list (`sudo`, credential paths, pipes into a shell, writes outside the folder, force pushes, hard resets) are checked first in code and a model never sees them. Not offered for MCP tools, since a call name and a JSON blob do not say what running it would do. One judgement per command per turn, billed into the turn that caused it, off until it is chosen from the composer, and the built-in classifier instructions are readable in settings with room to append your own notes (#496).
- **Stale tool results stop going back on the wire** - a file read forty rounds ago is either still true, in which case reading it again costs one round, or has since been edited, in which case resending it is resending something wrong. Old `read`, `glob`, and `grep` results are now replaced with a line saying they were cleared, while the calls themselves stay, so the model still sees that it read the file. Only on the way out: the pane and the session log keep every result in full. Bash, edits, and images are never touched, the last five calls are always kept, and a pass that would free less than 20k tokens does nothing rather than throw away the cached prefix. Unlike compaction it is lossless, needs no model call, and runs first, so a session often never reaches the lossy one (#495).

## v2.93.0

- **The Pi agent and Rune are removed** - both come out whole rather than leaving a half-wired surface behind, following the Chat/Images and Kanban removals. Pi takes its settings section, tab and plan modal, agent/config/auth/env managers, the fleet-bridge WebSocket server and its extensions, the bundled pi-skills, and the `fleet pi` CLI group with it. Rune takes its settings section, managers, the Cmd+I Rune Assist overlay, and its session source. Sessions is now Claude-only, so the agent filter, agent badge, and session tree UI are gone. Existing learnings keep their provenance and still load (#493).
- **Cmd+Shift+V is free again** - the shortcut toggled the visualizer and shadowed paste-style use of the same chord. The visualizer is still reachable from the command palette (#494).

## v2.92.0

- **The Chat and Images tools are removed** - the native Agent pane supersedes both, so the OpenRouter Chat tool and the fal.ai image generator come out whole: their tabs, settings, bundled chat skills, and the `fleet images` CLI commands. Saved workspaces drop the two tabs on load, and settings written by an older version shed their now-dead entries on the next write. Your OpenRouter API key carries over untouched and is now managed from Agent settings; the Agent pane's own image tool is unaffected (#491).
- **The Kanban board is removed** - the board, its PM agent, swarms, and the dispatcher and CLI that drove them (#489).

## v2.91.0

- **A native Agent pane** - a coding agent that lives in Fleet rather than in a terminal running someone else's CLI, built from scratch on OpenRouter. Agents get their own sidebar section, open in a folder you pick, and show the branch the work is landing on under the composer. Tools cover `read`/`glob`/`grep`, `edit`/`write` with read-before-edit, `bash`, a todo list, an image tool, and a `terminal` tool that types commands needing a person (a login, a picker, a dev server) into a real terminal beside the pane. Shell commands the rules do not settle stop and ask, and a blocked turn announces itself outside its own pane. The transcript streams with collapsing reasoning, Markdown replies, diffs for every change, and attached files and PDFs read off the main thread. Conversations persist to disk, context is accounted and compacted automatically at a threshold you set, cost is shown as it runs, and Up-arrow recalls the last hundred prompts for that folder. App-wide settings cover the provider key, per-role models from the models.dev catalog, output limits, reasoning effort, and an editable system prompt (#484).
- **MCP servers in the Agent pane** - stdio and Streamable HTTP servers, added by form or by pasting the config block straight out of a README, with per-tool checkboxes so a server with thirty tools can be used for three. Full OAuth 2.1 with PKCE, dynamic client registration, discovery, and a loopback redirect, plus static bearer tokens; every credential lives in `safeStorage` and never crosses IPC or lands in `fleet-settings.json`. Fleet can import the servers already configured in Claude Code and OpenCode at user and project scope, lifting plaintext credentials into the keychain on the way in. Tool counts are totalled and turn amber past fifty, since every tool is sent on every turn. MCP calls render as English in the transcript and go through the same permission gate as everything else, with per-server "always allow" (#486).

## v2.90.0

- **Remote file browsing over SSH** - a new tileable pane that browses folders on a remote host, with hosts either auto-detected from a pane you are already SSH'd into or saved in Settings. Files open in Fleet's existing viewers (images, text/code, PDF, rendered Markdown), text files can be edited and saved back atomically with a stale-write guard, files can be downloaded and drag-dropped in to upload with live progress, and entries can be renamed, deleted, or created as new folders. Connections reuse a single multiplexed SSH session and all mutations go over SFTP, so no remote shell ever interprets a filename (#479).

## v2.89.0

- **Auto tools mode for Chat** - a new default tool-permission mode that auto-approves safe actions using static safety tiers: a safe-bash command classifier, plus automatic approval for web fetches and file edits, with per-category auto-approve toggles and a tool-mode picker in the composer (#467).

## v2.88.0

- **Chat permission bar** - tool-approval prompts (Allow once / Allow & remember / Deny) now appear in a pinned bar just above the composer instead of piling up inside the message stream, detached from the reply that triggered them. It shows one request at a time with a click-to-expand "+N more" peek and an "Allow all" batch action, and retro-applies a remembered rule to matching pending requests so approving the first of several identical calls clears the rest. A decided card lingers briefly as "Allowed"/"Denied" then fades (#466).

## v2.87.0

- **Shell Environment viewer** - a read-only ⌘K viewer that shows the environment variables a Fleet terminal is spawned with, snapshotted at spawn time and grouped by provenance, with secret values masked (#465).

## v2.86.0

- **Project Notes** - a new pane-toolbar tool (next to Telescope) that gives every project a Markdown scratchpad. Notes are scoped to the git repo root (folder fallback) so the same note shows from any subfolder, stored centrally under `~/.fleet/notes` to keep your repos pristine. Features a split live editor+preview, debounced autosave with ⌘S, and an external-change conflict guard (#464).

## v2.85.0

- **Auto-inject the Fleet skill into Claude Code** - Claude Code running inside Fleet now learns the `fleet` CLI automatically via the `SessionStart` hook, so agents can drive Fleet (open files/images, annotate pages, generate images) with no manual step; the "Inject Fleet Skills" toolbar button and shortcut are removed (#463).
- **Render local images in the Markdown preview** - `file://` and relative image paths now display in the Markdown preview instead of showing a broken image (#462).
- **UX polish sweep** - refinements across tabs, sidebar, settings, chat, and the pane toolbar (#461).
- **fleet-drive** - a CDP-based driver for the live dev UI that can screenshot, snapshot, click, type, and eval against the running dev window (#460).

## v2.84.2

- **Fix Chat transcript reordering tool calls when a turn finished** - assistant turns now record the true chronological order of text and tool-call blocks, so a reply that goes text → tool → text renders identically while streaming and once complete, instead of grouping all tool cards above the text on completion (#459).

## v2.84.1

- **Fix orphaned Git worktree tab that couldn't be closed** - closing a worktree tab's group down to a single remaining tab left it permanently stuck; both the tab's close button and Cmd+W now correctly close it, including the on-disk worktree cleanup (#458).

## v2.84.0

- **UI modernization pass** - re-tuned design tokens, bundled Inter UI font with tabular figures, and unified motion tokens across menus/panels with ease-out-expo overlays and faster exits (#398, #399, #400).
- **Agent overview improvements** - a two-axis per-pane status glyph, an urgency-sorted overview surface, a peek panel to glance and reply to a non-focused agent, and cheap AI-generated one-line pane summaries (#401, #402, #403, #454).
- **Awaiting-input visibility** - the count of agents awaiting input now surfaces in the window title and dock badge (#453).
- **Terminal and chrome polish** - a modern, focus-aware xterm surface, tightened row heights/buttons, tokens unified across PaneHeader/PaneToolbar/SearchBar, and chrome that recedes versus focused content (#446, #455, #457).
- **Interactive-state gaps filled** - skeleton loaders, focus rings, and aria-labels added across the app (#456).

## v2.83.0

- **Configurable tool-round limit in Chat** - the agent's model⇄tool loop is no longer capped at a hardcoded 4 rounds. The default is now 25, and it's adjustable in Chat settings under Agent & Tools → Advanced, so multi-step requests no longer abort early with "I reached the tool-round limit" (#445).

## v2.82.2

- **Tool calls now persist and re-render in Chat** - the tools an assistant turn ran (and their output) are saved on the message and shown as collapsible cards after reload, instead of vanishing when the turn ended (#434, #422).
- **No more stuck tool spinners** - gated tools (`bash`, `mcp`, `web_search`, `web_fetch`) always emit a terminal status, so a thrown tool can no longer leave a spinner stuck on "generating"/"Fetching…" (#423).
- **Tool errors and blocked/denied outcomes are visible** - execution errors and disabled/blocked tool outcomes now surface in the UI rather than being silently swallowed (#422, #427).
- **Tool-round exhaustion no longer hides work** - hitting the tool-round limit now shows an explicit message and keeps the tool calls that ran, instead of replacing them with a canned line (#428).
- **Permission cards are no longer removed optimistically** - Allow/Deny on a permission card is driven by authoritative stream events, so denied commands leave a visible trace (#424).
- **Stream lifecycle fixes** - cancel/abort and conversation-switch reconcile against stream events; regenerate now replaces the turn instead of appending a duplicate (#429, #430, #436, #432).
- **Renderer error surfacing** - streaming and tool errors are reflected in the UI consistently (#435, #438, #437, #439).
- **Conversation switch & composer state** - switching conversations cancels the active stream and preserves composer state correctly (#431, #433).
- **web_fetch resilience** - more robust fetching and error handling for the Chat `web_fetch` tool (#425, #426).

## v2.82.1

- **Fix bundled Chat skills missing in the installed app** - the `create-goal` skill (and other bundled chat skills) now appear in the Chat `/` slash menu in packaged builds; they were previously only visible in dev because the skill folders weren't copied into the app's resources.

## v2.82.0

- **⌘K command palette** - a rebuilt command palette (cmdk) with grouped, contextual commands and a jump-to-needy action that surfaces items needing attention (#421).
- **web_fetch tool for Chat** - the Chat agent can now fetch and read web pages (fetch, readability, turndown), with a hidden-BrowserWindow fallback for SPA pages (#419).

## v2.81.0

- **Reasoning/thinking display panel** — the Chat agent's reasoning is now surfaced in a dedicated, collapsible thinking panel during streaming (#411).
- **Streaming & waiting-state polish** — refined streaming output and waiting-state indicators for smoother, clearer feedback while the agent works (#412).
- **Inline conversation rename** — rename a conversation directly in the sidebar without leaving the list (#417).
- **Delete a single message/turn** — remove an individual message or turn from a conversation (#416).
- **Model picker upgrades** — the model picker now shows a loading state and per-model capability badges (#418).
- **Conversation-switch loading skeleton** — switching conversations shows a loading skeleton instead of a blank flash (#413).
- **Persona picker as Radix popover** — the persona picker is rebuilt as a Radix popover for better keyboard and accessibility behavior (#415).
- **Menu & panel micro-animations** — added subtle micro-animations to menus and panels for a more polished feel (#414).

## v2.80.0

- **Isolated workspace per conversation** — each Chat conversation now gets its own dedicated `~/.fleet/chat/{id}` folder, so file reads, writes, and generated images are scoped to that conversation instead of sharing one global workspace (#386).
- **Create-goal chat skill** — a bundled skill that writes structured goal docs to `docs/goals/`, plus a fix for the empty slash-command menu (#387).

## v2.79.0

- **Chat settings redesign** — the Chat settings screen is rebuilt with a left-nav rail and focused panes: progressive disclosure, instant-apply toggles with a save-status cue, search-to-jump, and an upgraded API-key field. All settings are preserved (#384).
- **Conversation sidebar redesign + semantic search** — the Chat conversation sidebar now groups conversations by recency with a pinned section and polished rows, and search is upgraded from keyword-only to hybrid semantic search (per-message embeddings via sqlite-vec fused with FTS5 through reciprocal rank fusion, degrading silently to FTS when unavailable) (#383).
- **Chat agent knows the current date/time** — the Chat agent's context now includes the current date and time, so it can answer time-relative questions and reason about recency accurately (#380).

## v2.78.0

- **More web-search providers in Chat** — the pluggable web-search tool now supports **Exa** and **Brave** alongside Tavily. Keys are stored per-provider (encrypted) so switching providers keeps each key intact, and a settings dropdown drives the choice (#369).
- **Chat tool-use feedback & responsiveness** — read-only tools (read_file, glob, search) now show a compact status pill instead of silent thinking dots, and folder scans no longer freeze the Electron main process: the glob/search and @-mention filesystem walks are now async and yield to the event loop (#374, #376). The @-mention picker is also debounced with a latest-wins guard.
- **Stop interrupts scans promptly** — the agentic glob/search walk now honors the abort signal, so hitting Stop mid-scan interrupts the filesystem walk instead of running to completion (#377).

## v2.77.0

- **Chat message renderer overhaul** — the Chat tool adopts [Streamdown](https://streamdown.ai) for streaming Markdown (#341) with **Shiki dual-theme code highlighting** (#342), a focused code-block header with height cap (#343), hardened model-rendered links/images (#344), GFM **table zebra striping** and clean prose (#345), and an **asymmetric layout** — flat assistant text, user bubbles (#346).
- **Streaming & motion** — throttled token→state updates for smoother streaming (#338), a **screen-reader announcer** architecture (#339), **stream error states with scoped retry** (#340), a **streaming caret** with pre-first-token thinking indicator (#347), and message-entrance motion tokens (#348).
- **Composer, scroll & accessibility** — IME-safe keyboard contract in the composer (#336), **use-stick-to-bottom** message scrolling (#337), composer auto-grow with focus ring and empty/no-key states (#349), a **hover message action-bar** with quiet metadata (#350), and an **accessibility audit** covering icons, focus rings, reduced-motion, and contrast (#351).

## v2.76.2

- **Fix: high CPU while agents are running** — the session list re-read and re-parsed the entire `~/.claude/projects` (and `~/.rune/sessions`) history on every transcript write, so an active agent could pin the main process. Session summaries are now cached by file mtime/size; only changed transcripts are re-parsed (#332).

## v2.76.1

- **Fix: Chat settings now scrolls** — the Chat → Settings page couldn't scroll, hiding everything below the fold including the **Extensions & Capabilities** section (MCP Servers and Skills tabs). The settings view now inherits a bounded height so the full page is reachable.

## v2.76.0

- **Chat becomes an agentic workbench** — the Chat tool grows from a chat box into a full agent workspace. It can now run **bash and filesystem tools** with a permission engine and tool-call cards (#289, #291), **write and edit files** (#309), connect to **MCP servers** as a native client (#292), load **Agent Skills** (#293), and run a **web-search tool** (#303), with an **audit log / tool-activity view** over everything it does (#308).
- **Conversation management** — search, folders, and pinning (#300), background **auto-naming** and topical **auto-tagging** of conversations (#290, #307), **branching/forking** (#296), per-conversation **Markdown/JSON export** (#304), and **message edit + regenerate** with a 1-of-N version pager (#295).
- **Authoring & context** — **@-mention file/folder context** (#297), **slash-command prompt templates** (#299), **persona / system-prompt presets** (#301), and **image & PDF uploads** wired to vision models (#302).
- **Artifacts panel** — html/svg/markdown results render in a dedicated side panel (#305).
- **Cost & caching** — live **token/cost display** with prompt caching (#298).
- **Settings restructure** — Chat settings reorganized into Models / Tools & Permissions / Extensions (#310), plus a **copy button** on code blocks in agent output (#288).

## v2.75.0

- **Chat image generation & editing tool** — the Chat tool can now generate and edit images, with results rendered inline in the conversation (#287).
- **Searchable model selector** — the Chat model picker is now a searchable combobox for quickly finding any model in OpenRouter's catalog (#286).

## v2.74.0

- **Chat (OpenRouter) tool** — a new pinned **Chat** tool brings a general-purpose AI assistant into Fleet (#280). Hold multiple SQLite-persisted conversations, pick any model live from OpenRouter's catalog, and watch replies stream in as rendered markdown. Your OpenRouter API key is entered in the tool's own Settings view and encrypted at rest via Electron `safeStorage` — it never crosses into the renderer. The picked model now persists per conversation, cancelling a stream keeps whatever streamed so far, and the conversation list is fully keyboard-navigable (#285).

## v2.73.0

- **Kanban SDLC pipeline templates** — full-feature tickets now expand into a staged pipeline (explore → spec → build → QA) with dedicated stage personas, read-only explore tooling, a spec-approval gate, and a QA stage that gates PR-readiness and re-arms `request_changes` within an attempt cap. A template dropdown, stage badges, and an approve-spec proposal card surface the pipeline on the board, and stale pipelines are swept and flagged as blocked.
- **PM autopilot agent** — an event-driven PM coordinator runs board turns with safe authority tools (arm/unblock/reassign), raises Approve/Dismiss proposal cards, and posts an optional daily 9am standup digest. Guarded against board-switch races and concurrent ticks, with a per-board turn queue and persona mandate.
- **User-created tab groups** — group tabs on the sidebar with custom colors (#277).
- **Opencode plugin for Fleet tools** — exposes Fleet's tooling to opencode (#278).
- **Learnings semantic search + MCP access** — the Learnings KB now supports semantic vector search and is reachable by Rune and Claude Code over MCP (#267), plus a post-ship retro/learning loop for shipped Kanban work (#235).
- **Diagnostics & "Report a Problem"** — automatic error capture with a one-click problem report from settings (#273).
- **Perf: coalesce xterm writes for hidden terminal panes** — batches output for off-screen terminals to cut overhead (#279).

## v2.72.2

- **Fix Board PM chat hanging on "Thinking" forever** — the PM chat set its in-flight flag before running turn setup (config writes, `rune` spawn) and only ever cleared it from the child process's exit/error events. If setup threw, or `rune` ignored `SIGTERM`, the flag latched on and the panel showed "Thinking…" indefinitely with the input disabled, recoverable only by restarting Fleet. Every exit path now funnels through a single cleanup: setup failures clear the flag and surface an error, the turn timeout escalates `SIGTERM` → `SIGKILL`, and the transcript read-back can no longer strand the status transition.

## v2.72.1

- **Fix Learnings distill noise from Rune** — headless `rune --prompt` runs now set `RUNE_NO_ATTACH=1`, so Rune no longer scans the prompt for file references and auto-attaches them. Previously, distilling a session (or running a Kanban worker / PM chat) fed Rune a prompt full of incidental file paths, which Rune inlined from the current directory and annotated with `(could not attach …)` lines on stdout — polluting the prompt and corrupting the distilled learning. Requires Rune v0.9.0+ (older Rune ignores the variable).

## v2.72.0

- **Learnings KB — distill sessions into reusable knowledge** — a new **Learnings** view in the Sessions tool turns finished agent sessions into durable, cross-project engineering notes. Hit **✨ Distill** on a session (or one Rune branch) and Fleet runs a headless one-shot pass (Rune, falling back to Claude) to draft a titled markdown learning — problem, root cause, fix, tags — which you can edit, dedup-merge against existing entries, and save into a Fleet-owned store (`~/.fleet/learnings/learnings.db`, separate from any repo). Browse, full-text search, edit, and export learnings as standalone `.md` into any project. Hardened across the board: FTS5 handles punctuation/CJK input, exact tag-membership filtering, agent-failure output is never saved as a "learning", orphaned distill processes are killed as a group, IPC inputs are validated and errors sanitized, exports avoid filename collisions and Windows reserved names, and titles are stripped of HTML before export.

## v2.71.2

- **Fixed broken images, backgrounds & PDFs on macOS/Linux** — a regression from the WSL path work caused every locally-served file (`fleet-image://` / `fleet-pdf://`) to be routed through a WSL UNC bridge, which fails on non-Windows hosts. Backgrounds, the image viewer, image gallery, recent screenshots, slideshows, and the PDF viewer no longer come up blank on macOS and Linux. Native POSIX paths are now served directly; the WSL bridge only runs on Windows.

## v2.71.1

- **Fixed opening files from WSL panes** — opening a file (via Telescope, file browser, grep, or a markdown link) from a **WSL (this machine)** pane no longer fails with `ENOENT … stat 'C:\home\…'`. The file's WSL distro is now remembered on the viewer pane and its path is bridged to a `\\wsl.localhost\…` UNC path before being read, fixing the markdown, file-editor, PDF, and image viewers. No effect on macOS, Linux, or native-Windows files.

## v2.71.0

- **WSL repos run inside the distro** — for boards and panes backed by a `\\wsl.localhost\…` repo, Fleet now executes git/grep/find/ls-files, env-editor/env-sync, worktree management, and the full **kanban autopilot** pipeline (worker, verify, and review agents) *inside* the WSL distro instead of over the UNC bridge, and translates WSL↔Windows paths for file serving, screenshots, and paste. This makes autopilot, file tooling, and worktrees behave correctly for repos that live in WSL. **Note:** autopilot agents require **mirrored** WSL networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`); in the default NAT mode the run is refused with an actionable message, because a distro can't reach Fleet's board server on the Windows host over NAT.
- **Rune Quick-Assist** — summon Rune right at your cursor in any open file. A transient overlay auto-detects whether you're **asking** (answer appears in a one-shot anchored popover) or **editing** (the file is changed in place, then auto-reloaded and flashed, with one-click revert), backed by a non-blocking working pill and per-pane concurrency — no docked panel, chips, or mode juggling.

## v2.70.1

- **Clearer Claude session metadata** — the transcript header's cramped metadata strip is replaced with a labeled key→value panel (Cost, Model, Messages, Tokens, Cache, Branch, Duration). Cryptic glyphs are gone; every value carries a visible label, with token/cache breakdowns in tooltips. Session list cost badges gain explanatory tooltips.

## v2.70.0

- **Claude session cost estimator** — Claude session rows now show an estimated **cost badge**, and the transcript header gains a metadata strip aggregating token usage. Costs are computed from a bundled Claude pricing table that best-effort refreshes from a remote source (with cache fallback), and model-less entries are skipped so they don't void a session's estimate.
- **Kanban agent code review (autopilot phase 5)** — completed tasks now pass through an automated **agent code-review stage** before reaching review/auto-merge. A reviewer worker inspects the task's diff and returns a verdict via a `kanban_review_verdict` tool: approve hands the task on to integrate/review, while a bounce spawns a bounded fix run with the review feedback in its prompt (retries capped, then blocked + notify). Adds a reviewer profile setting, an **Auto-review** toggle, a review badge on the board, and a dedicated `review_ready` notification. (Schema v15.)
- **Kanban deterministic verify gates (autopilot)** — per-project verify commands (typecheck/test/lint) now run in the worktree after a task is completed, before it reaches review/integrate. A failure bounces a fresh work run with the failure output in its prompt; bounded retries then block the task and notify. Verify commands are editable per project in the Projects dialog, and long-running suites keep the task claim alive instead of failing open. (Schema v14.)
- **Kanban auto-group tickets into features (autopilot phase 4)** — Fleet now detects related tickets and suggests grouping them into a feature. Decompose children are grouped automatically on completion, and a board banner surfaces feature suggestions you can accept or dismiss. (Schema v13.)
- **Slideshow Files-mode management** — the Files-mode terminal background slideshow gains a non-destructive **Add…** button (appends and dedupes by path) alongside **Clear All**, replacing the old single "Change…" button that discarded your whole list. Thumbnails can be **drag-reordered** (with accessible ‹ › move buttons), and the full file list is now shown and scrollable as the management surface.

- **Kanban feature PR lifecycle (autopilot phase 3)** — features now manage their own draft→ready GitHub PR. When the first task in a feature merges into its integration branch, Fleet auto-opens a **draft PR** for the feature and pushes the branch; subsequent task merges keep it updated. Once every task in the feature is done, the draft PR is automatically **flipped to ready for review** (using **Ship** also marks an existing draft ready), with a notification when it happens. The PR poller now tracks feature-PR state and the board rollup shows whether a feature's PR is draft or ready. (Schema v12.)
- **Fix: permission notification no longer spams** — the "An agent needs your permission" OS notification (and chime) fired repeatedly while a Claude prompt was on screen because detection ran on every terminal redraw. It now fires **once per request**, re-arming only after you respond.
- **Fix: Telescope hides stale recent files** — recently-opened files that no longer exist on disk are filtered out of the Telescope picker.

## v2.68.0

- **Kanban integration autopilot (phase 2)** — completed feature tasks now integrate themselves. When a worktree task in a feature reaches review, the dispatcher auto-merges its branch into the feature's integration branch and marks it done (no review click needed). On a merge conflict it spawns a bounded **resolve run**: a worker merges the target branch into the worktree, resolves conflicts, verifies, commits, and returns the task to review for a retry — capped at 2 attempts, after which the task blocks with a notification. Once every task in a feature is done, its integration branch is auto-synced with main (conflicts handed to a resolve run on a system task). Clicking **Merge to base** on a conflicting standalone task now also spawns a resolve run instead of only commenting. Gated by a new **Auto-integrate** setting (default on). All git work is local — pushing the feature branch and opening the PR remain manual for now.
- **Redesigned Terminal Background settings** — the terminal background panel was reworked around Baymard Institute and Nielsen Norman Group usability guidelines. A visible **None / Image / Slideshow** segmented control replaces the old always-on picker plus checkbox (switching modes is non-destructive and remembers your image). Interval and transition are now precise numeric steppers instead of sliders; the opacity, blur, and edge-fade sliders gain editable numeric fields. Selected slideshow images show as a **thumbnail grid** (with overflow count and per-image remove), a **live preview** renders sample terminal text over your configured background, and the controls are grouped under Slideshow / Timing / Appearance headers. Adds a **Reset to default** button, hides timing controls when a file list has a single image, and shows a **legibility hint** (WCAG-based) when a high-opacity, low-blur image would make terminal text hard to read.

## v2.67.0

- **Terminal background slideshows** — the terminal background can now cycle through multiple images with a smooth crossfade. Pick a folder (new images are picked up automatically) or a hand-selected list of files, choose shuffle or sequential order, and set the interval (10s–30min) and transition duration (0.2–5s). All panes — including hidden background workspaces — stay in sync on a single clock, the fade swaps instantly under reduced-motion preferences, and the existing single-image background plus its opacity/blur/edge-fade/fit adjustments work unchanged.
- **Kanban auto-assign (autopilot phase 1)** — unassigned ready tasks are automatically assigned via a new `assign` run mode and `autoAssign` setting, the first step toward board autopilot.

## v2.66.0

- **Kanban projects registry** — register project folders per board to ground the PM agent in real code. A new **Projects** dialog in the board toolbar lets you add projects (first becomes the default), and the board-scoped PM reads these to route new tickets to the right repo, distinguish feature repos from implementation projects, and understand project structure. (Requires Rune ≥ v0.6.0.)
- **Board knowledge home** — the PM maintains `MEMORY.md` (injected into every chat turn) and authors PRDs/specs in a `docs/` folder; tickets and tasks can reference these docs, which are inlined into worker prompts at dispatch so agents have full context.
- **PM artifact review** — the PM can now review finished work: `kanban_show` lists kept artifacts on the board, and a new `kanban_artifact_read` tool reads artifact contents, so the PM can verify completeness and decide next steps.

## v2.65.0

- **PM chat for the Kanban board** — a new "Board PM" panel (green PM button in the board toolbar) lets you manage the board by conversation: describe features, bugs, or a pile of ideas and the PM shapes them into well-scoped tickets, refines specs, sets priorities, links dependencies, groups work into features, and moves cards — live on the board as you chat. Powered by headless Rune (one session per board, persisted across restarts; requires Rune ≥ v0.6.0 for `--resume` with `--prompt`). The PM gets a board-scoped kanban toolset and obeys the same rules as the UI: it can't touch running tasks or other boards. Errors (Rune missing, provider auth, crashes) surface in the panel, and turns time out after 5 minutes.

## v2.64.0

- **Choose which sidebar Tools are shown** — the sidebar Tools section (Annotate, Kanban, Images, Sessions) is now configurable. A sliders button in the Tools header (and in the collapsed mini-sidebar) opens a picker where each tool can be toggled on or off, with an enabled count shown in the header. Tools default to Annotate only; Kanban is available as Experimental, while Images and Sessions are opt-in. Enabling a tool pins its tab; disabling removes it. The preference is global and persists across restarts. Sessions also gains an icon in the collapsed mini-sidebar.

## v2.63.0

- **Branch/DAG tree visualization for Rune sessions** — Rune persists each session as a branching graph (forks, clones, compaction), but the Sessions tool only ever showed the active path. A new collapsible tree rail in the transcript pane renders the full graph in `git log --graph` style: the active branch is marked, compaction nodes are badged, and per-node role/time/token-usage show on hover. Clicking a branch shows that path's transcript. Session-level subagents are surfaced in the rail. Single-branch Rune sessions and all Claude Code sessions keep the existing linear view.

## v2.62.3

- **Fix: Session transcript still could not scroll (completes the v2.62.2 fix)** — the real cause was the Sessions grid using an implicit `auto` row, which grew to the full transcript height and was clipped by the parent's `overflow-hidden`. Constraining the grid row to `minmax(0, 1fr)` caps it at the viewport so the transcript scrolls. Verified with a headless layout test.

## v2.62.2

- **Fix: Session transcript could not scroll** — long sessions ran off the bottom with no scrollbar because the scroll container lacked `min-h-0`. Vertical scrolling now works, and long content (tool output, paths, code) wraps to the panel width instead of clipping off-screen.

## v2.62.1

- **Fix: Sessions tab showed "No sessions" despite sessions on disk** — both session sources were silently dropping every entry. Rune sessions failed because nodes can store `content: null`, which the parser rejected instead of treating as empty. Claude sessions failed because the working directory was only read from the first transcript line, which recent Claude Code versions fill with metadata that carries no path. Both sources now load correctly under the All / Rune / Claude Code filters.

## v2.62.0

- **Sessions tool — browse and resume past agent conversations** — a new pinned **Sessions** tab in the Tools section gathers every past **Rune** and **Claude Code** session in one place, grouped by project and searchable. Click a session to read its full transcript in-app, then hit **Resume ▸** to continue it in a new terminal tab opened in the session's original folder. Filter the list by agent (All / Rune / Claude Code) and set a preferred default in Settings → Rune — it defaults to Rune and remembers your choice. The library refreshes live as sessions change on disk.

## v2.61.1

- **Fix: WSL tabs failed to open with "zsh: permission denied"** — when WSL was your default shell, new tabs launched `wsl.exe -d <distro> ~`, where wsl.exe treats the trailing `~` as a command and the login shell tried to execute your home directory. Fleet now uses the documented `--cd ~` flag, so WSL tabs open in your home directory as expected. (This only surfaced after WSL distro detection was fixed in 2.60.0.)

## v2.61.0

- **Default shell profile picker** — Settings → General now has a **Default Profile** dropdown listing your detected shell profiles (system shells and WSL distros), with an **(auto-detect)** option. New tabs use the chosen profile right away, no restart needed. This wires up the setting whose backend shipped in 2.60.0.

## v2.60.0

- **Rune installs where your shell can find it** — the Settings → Rune install/update button now installs Rune into `~/.fleet/bin` (a directory Fleet keeps on your PATH) instead of letting the install script pick `/usr/local/bin`, which isn't on PATH for Homebrew-on-Apple-Silicon setups and left `rune` as "command not found".
- **More reliable WSL distro detection** — Fleet now decodes `wsl.exe` output correctly even when it omits a byte-order mark (previously this dropped every distro), falls back to `wsl --list --quiet` when needed, and pins the absolute `System32\wsl.exe` path instead of relying on PATH.
- **Default shell profile** — you can now set a preferred shell profile that new tabs use by default, falling back to auto-detection when it's unset.

## v2.59.0

- **One-click Rune install & update** — the Settings → Rune tab now installs Rune for you. When Rune isn't found, an **Install Rune** button runs the install script directly; when it's already installed, an **Update** button re-runs it and reports the version change (e.g. _Updated v1.0.0 → v1.1.0_, or _Already on the latest_). The copyable command and install guide remain as a manual fallback.

## v2.58.0

- **Remote session indicator** — tabs now show a **remote** pill in the sidebar when the terminal is in an SSH/mosh session, so you can tell at a glance which tabs are on a remote host versus your local machine. Detection covers `ssh`, `mosh`, `et`, `telnet`, `rsh`, `autossh`, and `sshpass`, and the pill clears automatically when you disconnect.

## v2.57.1

- Rune settings: replaced the separate provider/profile controls with one **Active provider** selector that shows both base providers and provider profiles, so it is clear which provider Rune will actually use.
- Selecting a base provider now clears the active profile, while selecting a profile preserves the base provider as a fallback.
- Active provider profiles can be edited directly from the Provider section, with safer optimistic updates for quick model/endpoint edits.

## v2.57.0

- **Edit Rune settings in-app** — Settings → Rune now has a full editor for `~/.rune/settings.json`, so you no longer need to drop into Rune's terminal UI to configure it. Set your **provider** and model, **thinking effort**, **icon/activity** styles, **auto-compact**, **web fetch/search**, and **subagents** (concurrency, timeout, retention) right from Fleet.
- **API keys** — manage Rune's Groq, RunPod, OpenRouter, Brave, and Tavily keys as redacted set/clear fields (stored in `~/.rune/secrets.json`).
- **Advanced** — configure Ollama endpoint/`num_ctx`/think, RunPod & OpenRouter endpoints, repo-map, and add/edit/delete **provider profiles** with an active-profile selector.
- Edits write straight to Rune's config files and preserve any keys Fleet doesn't manage; clearing a field resets it to Rune's default.

## v2.56.0

- **PDF viewing** — `fleet open <file>.pdf` now opens PDFs in a dedicated viewer tab instead of being rejected as a binary file. Pages render with a bundled **pdf.js** engine (no external reader needed), with **page navigation**, **zoom in/out**, and **Fit width** controls in the status bar.
- PDF text is **selectable and copyable** — drag to highlight any text and press **Cmd/Ctrl+C**, just like a real document.
- Open PDFs alongside anything else: `fleet open report.pdf src/main/index.ts` opens a PDF viewer and a code tab side by side, and restored PDF tabs re-render on relaunch.

## v2.55.0

- Markdown doc tabs (`fleet open <file>.md`) gain real **copy tooling**: you can now **select and copy** any text, and highlighting auto-copies it with a **"Copied" toast** so you always know it worked — whether you highlight, press **Cmd/Ctrl+C**, or use the new **right-click menu**.
- **Right-click menu** in the preview: Copy selection, Select all, Copy document as Markdown or plain text, and Find.
- **Per-code-block copy buttons** appear on hover over any fenced code block.
- A **"Copy as…"** menu in the Preview/Raw bar copies the whole document as Markdown or as rendered plain text.
- **Find-in-document** (**Cmd/Ctrl+F**) with live match count, next/previous, and highlight — reusing the same shortcut as terminal search.

## v2.54.0

- Motion polish across the app: the remaining dialogs (keyboard shortcuts, new annotation, Pi plan, feature editor, swarm, env-sync conflict, provider picker) now **fade, zoom, and slide in and out** instead of snapping, matching the rest of the app's animations.
- Every interactive button now has **tactile press feedback** — a subtle scale on click — across the Kanban board, settings panels, overlays, toolbars, and image gallery.
- All of the above fully respects the OS **"reduce motion"** setting, which neutralizes animations and press effects.
- Kanban board: fixed the board toolbar clipping its action buttons (Nudge, Swarm, **New Task**) when the window was too narrow — they were unreachable without maximizing. The toolbar now wraps and the actions drop to their own row.

## v2.53.0

- Settings: terminal background images can now **fade at the edges**. Two new sliders in Settings → General — **Fade Left/Right** and **Fade Top/Bottom** — feather the image's edges into the terminal background so an image that doesn't quite fill the window no longer looks hard-cropped. Set each axis independently (0–50%); corners blend automatically when both are active.

## v2.52.1

- Sidebar: fixed the collapsed mini-rail showing tool icons (Kanban, Images, Annotate) in the wrong place. They now sit at the bottom above the workspace switcher and settings, matching the expanded sidebar's layout.

## v2.52.0

- Settings: terminals can now have a **custom background image**. Pick any image from disk in Settings → General → Terminal Background and tune its **Opacity** (dim it so terminal text stays readable), **Blur**, and **Fit** (Cover / Contain / Center / Tile), or **Clear** it to return to the solid theme color. The background applies live to every open terminal — no restart needed.

## v2.51.0

- Settings: the **App Theme** picker now actually re-themes the whole app. Previously it only stored a light/dark value that nothing applied (the UI was always dark). It now offers **System** (follow your OS), **Match Terminal Theme**, and a full set of named **Dark** and **Light** presets — the app chrome (backgrounds, borders, text) recolors live to match, derived from each theme's palette. Your existing setting is carried over automatically.

## v2.50.0

- Settings: nine new built-in terminal themes — Nord, Tokyo Night, Tokyo Night Storm, Gruvbox Dark, One Dark, Monokai, Solarized Light, Gruvbox Light, and Catppuccin Latte — drawn from each project's canonical palette. The Terminal Theme picker now groups its options into **Dark** and **Light** sections for easier browsing.

## v2.49.0

- Kanban: tasks can now be grouped into a first-class **Feature** you can focus on, track, and ship as one unit. A feature selector in the toolbar filters the board to a single feature, and a new **Features** dashboard tab shows every feature's progress and PR rollup at a glance. Tasks created while a feature is focused inherit its repo and base branch (no more re-entering workspace config), and **Decompose again** re-runs the orchestrator over a feature that was only partially broken down.
- Kanban: pull requests are now tracked first-class. A task that opens a PR shows its state (open/merged/closed/draft) and CI checks as a badge on the card and in the drawer, polled from `gh` in the background, and the Features dashboard rolls these up per feature ("N open · M merged" + checks summary).
- Kanban: a feature can own an **integration branch** (`fleet/feature-<id>`). Worktree tasks in the feature branch off it and merge back into it, so the whole feature ships as one feature→main pull request instead of many noisy ones. New **Sync main** and **Ship feature** actions refresh the integration branch from main and open the feature PR, and a local conflict pre-check warns on the card and drawer — with the conflicting file list and a re-check button — before you merge.
- Kanban: worktrees no longer pile up on disk. A merged worktree is pruned automatically when you merge it, a throttled background sweep reclaims merged worktrees of finished tasks, and a new **Branches** tab lists every live worktree with its ahead/behind and merged status plus one-click prune (individual or "prune all merged"). Unmerged work is never destroyed — a task still in review or running can't be pruned, and an unmerged branch is always kept.

## v2.48.0

- Kanban: worktree tasks now go through a review gate before they're done. A worktree task's agent finishing no longer auto-completes the card — its work is committed and the card lands in a new "Review" column, where you pick one of three drawer actions: **Merge to base**, **Make Pull Request**, or **Do Nothing** (accept and keep the branch). Merge runs safely (in place when the base branch is checked out and clean, otherwise via a detached temp worktree push) so your working checkout is never disturbed, and conflicts keep the card in review with a note. The in-app diff shows the committed `base...HEAD` changes, and child/swarm workers inherit the parent's base branch. Scratch and directory tasks still complete straight to done.
- Kanban: the create-task form now has a Triage/Todo column picker and defaults new tasks to Triage instead of Todo. Creating an "isolated copy" (worktree) task against a folder that isn't a git repo is now blocked up front with a clear message instead of failing later at claim time.
- Kanban: the orchestrator can no longer assign a decomposed task to a worker profile that doesn't exist — `kanban_create` validates the assignee and rejects unknown profiles with the list of valid names, so the orchestrator retries with a real one.

## v2.47.0

- Kanban: headless workers no longer fail as "worker pid not alive" when an agent ends its turn with a question instead of completing. rune now enforces a completion contract in headless runs (new `--require-tool` flag): a worker that tries to stop without calling `kanban_complete`/`kanban_block` is nudged to keep going, and if it still won't finish it exits with a distinct signal. Fleet classifies that as a deliberate "review-required" block (with Reply & Resume) instead of a crash, so a single pause no longer thrashes a card into give-up. Crash-retry limit raised to 3 and the liveness grace window widened to 120s. Requires rune v0.4.0+.

## v2.46.0

- Kanban: dispatching a triage task to the orchestrator now assigns it. Previously a task sent to decompose/specify kept an empty assignee while the orchestrator ran; the card now shows the orchestrator profile as its assignee, matching how worker tasks display who's running them.

## v2.45.0

- Kanban: answering a blocked card is now one click. When an agent blocks with a question, the task drawer shows a "Question" section and a Reply & Resume box — type your answer, click once, and the agent is re-queued in the same mode it last ran (a worker run returns to Ready, an orchestrator run back to triage), dispatched immediately instead of waiting for the next poll. This replaces the old comment → move-to-Ready → re-assign → wait sequence. A secondary "Add comment" still records a note without resuming.

## v2.44.0

- Kanban: Fleet now checks whether Rune (the agent that runs every task) is installed. A new Settings → Rune section shows the installed version or, when it's missing, a copyable install command and an install guide. The status re-checks automatically when you return to the window, so installing Rune in a terminal updates it without a restart.
- Kanban: when Rune isn't installed, the board shows a banner instead of letting tasks silently fail. Tasks that can't spawn now record a clear, actionable reason ("Rune couldn't be found on your PATH…") in their run history rather than a cryptic "worker pid not alive".

## v2.43.0

- Kanban: child and swarm tasks now inherit a directory-scoped parent's workspace. Previously a task scoped to a project directory spawned children in an empty scratch sandbox, so they failed when looking for files the parent referenced. Decomposed and swarm tasks now run in the same `dir` (and path) as their parent.
- Kanban: the orchestrator is now a single, built-in planner instead of a user-created profile. It ships with a research-backed default persona (scale the breakdown to the task, write self-contained children with explicit acceptance criteria, maximize parallelism) and a "Reset to default" button in Settings. It can't be deleted or assigned to a task.

## v2.42.0

- Kanban: scheduled tasks. Schedule a task to run once at a future time, or on a recurring cadence (a simple interval or a cron expression). Recurring schedules act as templates that spawn a fresh instance task on each fire; one-shots run in place. Fires missed while the app was closed are skipped and realigned to the next future occurrence. Adds a "Scheduled" lane and a Schedule section (with a live next-fire preview) in the task drawer.
- Kanban: task artifacts. Agents can produce durable output files (documents, code, data) via the `kanban_artifact` tool. Browse, preview, download, reveal, discard/restore, and reuse them as the seed for a new task or swarm — all from a new Board ↔ Artifacts toggle inside the Kanban view. Discarded artifacts are soft-deleted and auto-purged after a configurable retention window.
- Kanban: the task drawer now shows where an agent runs — an empty scratch sandbox, a project directory, or an isolated git worktree (with its repo path and branch).

## v2.41.0

- Rune running inside Fleet is now detected automatically and receives Fleet's terminal command skill context by pasting the bundled `fleet.md` skill into the session. The ready marker is stripped from terminal output and handled across PTY chunk boundaries.

## v2.40.0

- First-class Windows + WSL support. New WSL panes now launch in `$HOME` instead of the Windows-mounted path Electron's cwd resolves to. Tab titles collapse to `~` on Windows and WSL just like macOS/Linux, and native Windows panes (PowerShell/cmd) now track `cd` changes via `pid-cwd`. macOS and Linux behavior is unchanged.

## v2.39.0

- Linux releases now ship as `.deb` (Debian/Ubuntu) and `.rpm` (Fedora/RHEL) in addition to `.AppImage`. The `.deb` postinstall installs an AppArmor profile so the Chromium sandbox works on Ubuntu 24.04+ without `--no-sandbox`. Recommended install: `sudo apt install ./fleet_<version>_amd64.deb`.

## v2.38.1

- Fixed the bundled Pi `code-review` skill frontmatter so packaged Pi startup no longer reports a YAML skill conflict.

## v2.38.0

- Pi plan mode now opens approved plans in a Fleet modal with approve/reject actions, replacing the silent write-to-disk flow.
- New bundled `code-review` Pi skill: reviews the current branch's diff against a base ref and writes findings to `docs/reviews/YYYY-MM-DD-<topic>.md`. Mounted via a new `--skill` launch flag and shipped in packaged builds via `extraResources`.

## v2.37.0

- Added terminal tab duplication so an existing terminal pane can be cloned into a new tab.
- Fixed Pi provider config and plan-mode tool policy hardening.
- Fixed copy/paste handling on Windows/Linux terminals and added a right-click menu.

## v2.36.2

- Fixed Pi agent tab closing instantly when opened via `fleet pi`. `@mariozechner/pi-coding-agent` v0.68.0 replaced prebuilt tool exports with cwd-bound factories, and the `fleet-plan-mode` extension still imported the removed names, causing pi to abort on startup. The extension now uses `createGrepToolDefinition(cwd)`, `createFindToolDefinition(cwd)`, and `createLsToolDefinition(cwd)`.

## v2.36.1

- Shift+Enter now inserts a newline in terminal panes, matching Opt+Enter (macOS) and Alt+Enter (Windows/Linux). Terminals can't natively distinguish Shift+Enter from Enter, so xterm.js was falling through to plain Enter; the custom key handler now translates it to Meta+Enter (`\x1b\r`).

## v2.36.0

- The expanded sidebar is now resizable. Drag its right edge to adjust width (min 180px, max 90% of the window). Double-click the drag handle to reset to the default width. Each workspace remembers its own sidebar width.

## v2.35.0

- Editor chrome and the markdown preview sidebar now display the full file path instead of just the filename, making it easier to distinguish files with the same name across different directories.

## v2.34.1

- Telescope (file/grep/browse modes) and the Cmd+O open-file dialog now route markdown files through the markdown preview pane, matching the behavior of the `fleet open` CLI.

## v2.34.0

- Pi Agent settings page redesigned: unified Providers list (built-in + custom in one place), zero-state welcome strip with three starter options, trimmed Defaults section, and a collapsed Advanced accordion for theme/model cycling/config folder.
- Amazon Bedrock has a first-class configuration panel. Set AWS region, profile, access keys, and session token in Fleet; secrets are encrypted via the OS keychain (`safeStorage`) and injected into every Pi tab Fleet spawns. Values never cross the IPC boundary to the renderer and do not affect the `pi` CLI in your terminal.
- Removed the Bedrock "custom provider" preset from the Add-Provider picker. Existing `providers.bedrock` entries surface a one-time inline migration prompt inside the new Bedrock panel.

## v2.33.0

- Settings → Pi Agent tab: configure default provider/model/thinking level/theme, view built-in provider auth status, and add/edit/delete custom providers (Amazon Bedrock, Ollama, LM Studio, OpenRouter, Vercel AI Gateway, generic OpenAI-compatible) backed by `~/.pi/agent/{settings,models}.json`. Writes preserve unknown fields via Zod passthrough.
- Pi plan mode: `/plan` in the Pi tab enters a read-only investigation mode with an injected protocol (understand, explore, check scope, ask when ambiguous, consider alternatives, follow existing patterns, YAGNI). Write/exec tools (`write`, `edit`, `bash`, `fleet_run`) are blocked. Pi calls `exit_plan_mode` with a markdown plan; after the user approves, the plan is written to `docs/plans/YYYY-MM-DD-<topic>.md` and plan mode exits.
- Add pane toolbar to Pi agent tab
- Fix fleet CLI to install bundled chunks

## v2.32.0

- Auto-update Pi coding agent to the latest version on packaged launch
- Add Pi agent version display and manual update check in Settings → Updates

## v2.31.0

- Add dashboard empty state with ASCII art header, recent files, and recent folders
- Track recent folders in localStorage for quick workspace access

## v2.30.0

- Add telescope picker — multi-mode fuzzy finder modal with file, symbol, and browse modes
- Add image preview support in telescope file picker
- Dim gitignored files in telescope browse mode
- Enable directory navigation in telescope browse mode
- Add pane naming headers to terminal panes
- Fix native cursor visibility in TUI apps
- Fix custom scrollbar applied globally
- Improve pane header visibility, contrast, and active highlight

## v2.29.0

- Add markdown preview tab with preview/raw sub-tabs

## v2.28.0

- Add Pi agent tab type with Fleet extensions

## v2.27.1

- Fix git changes tool not loading after app restart with restored workspaces
- Fix cmd+click / ctrl+click to open links in browser

## v2.27.0

- Add mode selection for annotations: choose between Element Selection or Free Draw before starting
- Fix free draw annotations being lost on submit (canvas overlay was not saved)
- Replace sharp-based image compositing with in-page canvas compositing (fixes bundled Electron compatibility)
- Add move/drag tool (V key) for repositioning drawn elements in free draw mode
- Hide picker UI (highlight, tooltip, badges) from captured screenshots
- Save full-page drawing overlay as standalone screenshot for AI context

## v2.26.1

-

## v2.26.0

-

## v2.25.2

- **Annotate**: Fix copy path to copy full absolute path so AI agents can find annotation files
- **Annotate**: Fix toolbar annotate button not working when Annotate sidebar tab isn't active

## v2.25.1

- **Annotate**: Make Annotate tab a special non-closable sidebar card with teal accent (matching Images tab treatment)
- **Docs**: Add `fleet annotate` to injected skill documentation

## v2.25.0

### Features

- **Annotate**: Webpage annotation with element picker and UI

### Bug Fixes

- **Tabs**: Make Cmd+1-9 target normal tabs, skip Images and Settings

## v2.24.0

### Features

- **Copilot**: Workspace-scoped sessions — sessions are tagged with the workspace they originated from
- **Copilot**: Workspace filter toggle and labels in session list to view sessions per workspace or all workspaces
- **Copilot**: Active workspace label in session detail header
- **Copilot**: Per-workspace Claude config overrides and custom config directory support
- **Copilot**: Config change UX with toast notifications, inline warnings, and terminal restart prompts
- **Copilot**: Per-workspace hooks UI

### Bug Fixes

- **Copilot**: Survive SIGINT so Stop hook event reaches Fleet
- **Copilot**: Re-apply hooks fix for per-workspace hooks

## v2.23.2

### Bug Fixes

- **Images**: Show pinned Images tab on fresh install — new users were missing the tab because the fresh-install startup path bypassed ensureImagesTab

## v2.23.1

### Bug Fixes

- **Images**: Increase fal.ai poll timeout from 5 to 15 minutes to handle longer queue wait times
- **Images**: Fix endpoint mismatch in fal.ai provider where poll/result/cancel used hardcoded model instead of submitted endpoint

## v2.23.0

### Features

- **Landing**: Add GitHub Pages landing page with auto-resolved download links to latest arm64 dmg

### Improvements

- **Landing**: Convert all images to webp for faster load times
- **Copilot**: Simplify system checks to fleet.sock only, auto-enable copilot on macOS

### Bug Fixes

- **Landing**: Add .nojekyll to bypass Jekyll processing

## v2.22.0

### Features

- **Copilot**: Show permission details inline in session list
- **Copilot**: Add formatPermissionSummary utility
- **Copilot**: Add bioluminescent clockwork owl mascot

### Bug Fixes

- **CI**: Regenerate latest-mac.yml from actual artifacts to prevent sha512 mismatch
- **Images**: Recent images now appear immediately by bypassing Spotlight indexing delay

## v2.21.1

### Bug Fixes

- **Copilot**: Prune stale sessions when Fleet tabs are closed

## v2.21.0

### Features

- **Copilot**: Add armored cybernetic dragon mascot with gold/black theme
- **Copilot**: Flexible animation system — mascots can now define custom frame counts and per-state animations
- **Copilot**: Animation preview in mascot picker with idle/processing/permission/complete state buttons
- **Copilot**: Hover-to-preview in mascot grid (Baymard UX research-informed)

### Improvements

- **Copilot**: Assembly script now supports variable frame counts (not just 9)

## v2.20.0

### Features

- **Copilot**: Replace side panel with centered rich pane overlay
- **Copilot**: Sci-fi CSS frame with glowing teal border, corner accents, and scanline overlay
- **Copilot**: Teleport animation when mascot transitions between floating and pane header

### Fixes

- **Copilot**: Fix mascot becoming unclickable after closing panel (setIgnoreMouseEvents bug)
- **Copilot**: Fix teleport animation not playing (renderer now drives animation timing before window resize)
- **Copilot**: Remove invisible hit area spanning full pane width around mascot

### Improvements

- **Copilot**: Increase font sizes across all copilot UI components for better readability
- **Copilot**: Enlarge header mascot to 96px, centered above pane
- **Copilot**: Remove "Fleet Copilot" label from pane header

## v2.19.3

### Fixes

- **Build**: Fix CI releases missing extraResources (mascots, hooks) — `--config` was replacing electron-builder.yml instead of merging with it

## v2.19.2

### Fixes

- **Mascots**: Fix fleet-asset:// sprites not rendering in packaged builds by using direct readFile instead of net.fetch file:// proxy

## v2.19.1

### Fixes

- **Mascots**: Fix fleet-asset:// protocol not loading sprites in packaged builds by adding full scheme privileges (standard, secure, corsEnabled)

## v2.19.0

### Features

- **Copilot**: Add robot and kraken mascot sprite sheets
- **Copilot**: Extract mascot selection into dedicated view with improved navigation
- **UI**: Replace emoji icons with Lucide React icons in copilot views

### Fixes

- **Toolbar**: Refocus terminal after inject fleet skills button click
- **Copilot**: Fix mascot grid responsiveness and CSS layout
- **Copilot**: Remove debounce from toggle expanded to improve responsiveness

### Refactors

- **Mascots**: Replace base64 embedded sprites with static WebP files via fleet-asset:// protocol

## v2.18.0

### Features

- **Copilot**: Add mascot selection to settings with multiple selectable mascots
- **Copilot**: Add armored polar bear mascot option
- **Copilot**: Add mascot sprite assembly script for building sprite sheets from source frames

## v2.17.0

### Features

- **Dev mode**: Allow dev and production Fleet instances to run simultaneously via `FLEET_DEV` env var, using separate socket paths and skipping single-instance lock

### Fixes

- **Images**: Enable scrolling in image gallery grid
- **Copilot**: Move copilot socket from `/tmp` to `~/.fleet/` for consistency with main socket

## v2.16.1

### Fixes

- **Copilot**: Replace boolean service flag with state machine to prevent race conditions on rapid enable/disable toggle
- **Copilot**: Add 5-second timeout to socket server shutdown to prevent hanging on disable
- **Copilot**: Graceful pending socket shutdown (FIN before destroy) when disabling copilot
- **Copilot**: Wrap hook installer filesystem operations in try/catch to prevent unhandled errors
- **Copilot**: Clear session store on disable to prevent stale sessions on re-enable
- **Copilot**: Wrap all lifecycle operations (syncScript, dispose, window create) in try/catch
- **Copilot**: Detect missing Claude Code installation and show actionable guidance in settings and session list
- **Copilot**: Show explanatory text when hooks are not installed instead of just a red badge

## v2.16.0

### Features

- **Copilot**: AI mascot companion — a draggable spaceship sprite that floats over your desktop, shows live agent session status, and expands into an interactive panel
- **Copilot Chat**: View conversation history and send messages to Claude Code sessions directly from the copilot panel
- **Copilot Permissions**: Approve or deny tool permission requests from the copilot UI without switching to the terminal
- **Copilot Settings**: Configure copilot behavior, toggle visibility, and manage session preferences
- **CRT Styling**: Retro CRT bezel frame for the copilot expanded panel with shadcn/ui components
- **Direction-Aware Panel**: Copilot panel expands toward screen center based on sprite position

### Fixes

- Fixed copilot hook to only trigger for Fleet-managed sessions
- Fixed mascot position clamping to screen bounds during drag
- Fixed permission prompts not showing in copilot panel
- Restored dock icon with updated pixel art spaceship
- Fixed copilot panel phantom click double-toggle
- Fixed CRT frame proportions and position clamping

## v2.15.0

### Features

- **Fleet Skills**: AI agent integration via toolbar button — inject Fleet-specific skills into Claude Code and other agents
- **Toolbar Tooltips**: Added Radix tooltips to pane toolbar with inject-skills shortcut hint

### Fixes

- Fixed OS-appropriate path separators for fleet skills path
- Fixed images tab existence check across all workspaces
- Fixed worktree removal confirmation when shell exits in worktree tab

### Docs

- Updated fleet skills with image prompt best practices and missing CLI options

## v2.14.1

### Changes

- Removed Star Command system

## v2.14.0

### Features

- **Worktree Management**: Create, manage, and organize git worktrees directly from Fleet with visual group headers, collapsible groups, and persistent layout
- **Worktree Lifecycle**: Automated worktree creation with conflict detection, safe removal with undo, and support for renaming worktrees and group headers
- **Activity Detection**: Real-time tracking of terminal activity with visual badges, silence timers, and foreground process detection to identify when agents are working
- **Activity Indicators**: Tabs now show activity status with reduced-motion support and off-screen summary badges in the sidebar
- **Image Protocol**: Improved image loading performance with `fleet-image://` protocol replacing base64 IPC

### Fixes

- Fixed file search overlay scroll jumping when opening
- Improved drag and drop behavior to prevent cross-group reordering and duplicate drop indicators
- Fixed sidebar tab contrast and group header styling
- Corrected activity state persistence to prevent clearing on tab focus
- Fixed tab restoration with proper CWD persistence across workspace saves
- Improved git worktree detection to use live working directory
- Enhanced worktree removal resilience and branch conflict avoidance

### Removed

- Removed Star Command system (starbase, crews, missions, sectors, comms, cargo, protocols, admiral, navigator, first officer)
- Removed fleet CLI commands: sectors, missions, crew, comms, cargo, log, protocols, config
- Removed system dependency check screen (AppPreChecks)
- Kept fleet CLI commands: images, open

## v2.13.0

- Added cargo send system: `fleet cargo send` CLI command with env auto-detection, socket dispatch, and explicit file/content support
- Added cargo evaluation sweep with First Officer recovery and safety net
- Added `awaiting-cargo-check` status with all completion points transitioned to use it
- Added cargo raw output streaming to disk via WriteStream
- Added migration 017 for `cargo_checked` column on missions
- Updated all crew prompts and workspace templates with cargo send instructions
- Fixed Cmd+F search box overlap with toolbar (#164)
- Fixed Shift+Click to open links in default browser (#165)
- Fixed `fleet images edit` command for local file paths (#163)
- Fixed test mocks to prevent real API calls

## v2.12.1

- Fixed TUI redraw after hard refresh via SIGWINCH resize trick
- Fixed lint errors and included awaiting-guidance status in listCrew
- Fixed logger mock in pty-manager tests to resolve fake timer conflicts

## v2.12.0

- Added Winston logger system with structured logging, IPC bridge, and daily log rotation
- Added First Officer consultant mode for mid-flight crew guidance
- Added Sentinel guidance sweep to dispatch consultant for stuck crews
- Added file-based prompt composition with mission-type templates and shared modules
- Fixed overlay paste by blurring xterm before focusing overlay input
- Fixed overlay admiral PTY paneId when on Star Command tab
- Fixed sidebar drag-and-drop using wrong indices and double-firing

## v2.11.0

- Converted settings modal to full tab page (#160)
- Added per-action model configuration for image actions (CLI flags + Settings UI)
- Fixed model name display in action settings

## v2.10.0

- Added extensible image actions system for generated images (#159)
- Made sidebar consistent across all tab types (#158)
- Fixed socket single instance lock to prevent multi-instance socket conflicts
- Added generated images to File overlay with scoped tabs

## v2.9.0

- Added fal.ai image generation integration via `fleet images` CLI commands (generate, edit, status, list, retry, config)
- Added pinned Images tab with thumbnail grid gallery, detail view with full metadata, and per-provider settings
- Added styled ImagesTabCard in sidebar with last-generated thumbnail and in-progress badge
- Added Images icon to collapsed sidebar strip
- Added provider abstraction (ImageProvider interface) for future extensibility beyond fal.ai
- Added prompt engineering guide to Fleet CLI skill template
- Changed Admiral reset to regenerate config files (CLAUDE.md, SKILL.md, settings) instead of deleting entire workspace
- Non-blocking image generation: CLI returns immediately, background polling handles download

## v2.8.0

- Added per-mission-type model configuration (crew*model*\* config keys via migration 016)
- Added model config fields to Starbase Settings UI with select dropdowns
- Added analyst_model to CONFIG_DEFAULTS
- Removed stale admiral_model and anthropic_api_key config fields from UI
- Fixed terminal unmount on pane split/close and hidden resize bug

## v2.7.7

- Removed unused elapsed variable from active visualizer loop
- Removed star command crews and sector rendering from fleet visualizer

## v2.7.6

- Added Clipboard History Overlay (Cmd+Shift+H) for quick access to recent clipboard items
- Added toolbar icon for clipboard history (when relevant)
- Fixed terminal focus restoration after pasting from clipboard overlay
- Fixed clipboard polling pause when unfocused for improved battery performance

## v2.7.5

- Fixed missing Cmd+Shift+O keyboard handler for file search overlay

## v2.7.4

- Fixed Station Dormant overlay not appearing after exiting Claude CLI (duplicate ptyManager.onExit call overwrote the admiral exit handler)

## v2.7.3

- Fixed Admiral terminal falling back to bare shell when Claude CLI exits; now shows Station Dormant overlay

## v2.7.2

- Fixed CI release pipeline merging arm64 entry into latest-mac.yml before publishing

## v2.7.1

- Fixed navigator stdio streams not destroyed in error handler, preventing CI hangs
- Fixed repair missions not included in review and fix crew dispatch
- Fixed repair crew SIGTERM incorrectly treated as error despite committed work

## v2.7.0

- Added File Search Overlay for fast file discovery with recent images, sort options (date, name, size), and persistent folder selection
- Added role activity logging through ShipsLog class for improved observability and debugging
- Added keyboard shortcut and command palette entry for file search
- Fixed bracketed paste mode for file path insertion into terminals

## v2.6.7

- Fixed duplicate PTY onExit listener stacking on HMR reloads
- Fixed silent onData callback overwrite on duplicate registration
- Fixed URL scheme validation for shell.openExternal (security)
- Fixed PTY data disposal on exit and flush timer cleanup
- Replaced O(N) PTY data broadcast with O(1) Map-based routing (performance)
- Replaced broad Zustand store subscriptions with granular selectors (performance)
- Removed unnecessary fit() call on click and memoized workspaceToAgents (performance)

## v2.6.6

- Fixed Apple Silicon users receiving the x64 build via auto-update (arm64 and x64 DMGs now published as separate files)
- Fixed node/claude not found on startup check screen due to shell PATH not being enriched in time

## v2.6.5

- Fixed active tab and pane not being restored after app restart
- Fixed split pane inheriting tab's original CWD instead of live CWD
- Fixed workspace switch losing live CWDs
- Fixed undo-close restoring terminal at stale working directory

## v2.6.4

- Fixed double cursor appearing after switching macOS workspaces and returning to a TUI terminal (e.g. Claude Code)

## v2.6.3

- Fixed CI by merging mac jobs into universal build
- Fixed forceDevUpdateConfig guard in main process

## v2.6.2

- Fixed opening external links in system browser
- Fixed missing --original-mission-id warning on repair missions
- Fixed analyst timeout (increased to 30s, configurable, with retry)
- Fixed Linux snap build failure by removing deb target

## v2.6.1

- Added file browser drawer (Cmd+Shift+E)
- Added Analyst service for LLM-powered error classification and PR verdict extraction
- Added Sentinel status wired into the Admiral sidebar
- Combined Admiral role tiles into a single unified command square
- Fixed worktree branch name shown in PR diff stat
- Fixed Sentinel crash from lazy-loading Notification in runtime child process
- Fixed auto-commit failure detection in repair crew cleanup
- Fixed terminal scrollback history no longer serialized on workspace save
- Moved shortcuts `?` button to top bar with OS-aware placement

## v2.6.0

- Fixed issue where restored tabs showed full terminal history on app relaunch
- Release notes in the Updates tab now display as plain text

## v2.5.0

- Initial release notes support
