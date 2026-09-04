export const IPC_CHANNELS = {
  APP_HOST_CONTEXT_GET: 'app:host-context:get',
  APP_QUIT_ASK: 'app:quit-ask',
  APP_QUIT_DECIDE: 'app:quit-decide',
  PTY_CREATE: 'pty:create',
  PTY_DATA: 'pty:data',
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_EXIT: 'pty:exit',
  PTY_GC: 'pty:gc',
  PTY_CWD: 'pty:cwd',
  PTY_RESOLVE_CWD: 'pty:resolve-cwd',
  LAYOUT_SAVE: 'layout:save',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_LIST: 'layout:list',
  LAYOUT_DELETE: 'layout:delete',
  NOTIFICATION: 'notification',
  PANE_FOCUSED: 'pane:focused',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  ENV_SYNC_GET_CONFIG: 'env-sync:get-config',
  ENV_SYNC_WRITE_CONFIG: 'env-sync:write-config',
  ENV_SYNC_SCAN: 'env-sync:scan',
  ENV_SYNC_STATUS: 'env-sync:status',
  ENV_SYNC_PULL: 'env-sync:pull',
  ENV_SYNC_PUSH: 'env-sync:push',
  ENV_SYNC_RESOLVE: 'env-sync:resolve',
  ENV_SYNC_DIFF: 'env-sync:diff',
  ENV_SYNC_CREATE_BUCKET: 'env-sync:create-bucket',
  ENV_SYNC_GET_SECRETS: 'env-sync:get-secrets',
  ENV_SYNC_SET_PASSPHRASE: 'env-sync:set-passphrase',
  ENV_SYNC_CLEAR_PASSPHRASE: 'env-sync:clear-passphrase',
  ENV_SYNC_SET_AUTH: 'env-sync:set-auth',
  ENV_SYNC_CLEAR_AUTH: 'env-sync:clear-auth',
  ENV_SYNC_ENCRYPTION_AVAILABLE: 'env-sync:encryption-available',
  ENV_SYNC_DISCOVER: 'env-sync:discover',
  GIT_IS_REPO: 'git:is-repo',
  GIT_REPO_ROOT: 'git:repo-root',
  GIT_STATUS: 'git:status',
  PTY_DRAIN: 'fleet:pty-drain',
  PTY_ATTACH: 'pty:attach',
  SHOW_FOLDER_PICKER: 'show-folder-picker',
  FILE_READDIR: 'file:readdir',
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_STAT: 'file:stat',
  FILE_OPEN_DIALOG: 'file:open-dialog',
  FILE_SAVE_DIALOG: 'file:save-dialog',
  FILE_LIST: 'file:list',
  FILE_READ_BINARY: 'file:read-binary',
  FILE_OPEN_IN_TAB: 'file:open-in-tab',
  FILE_SEARCH: 'file:search',
  FILE_GREP: 'file:grep',
  FILE_RECENT_IMAGES: 'file:recent-images',
  FILE_SCAN_IMAGE_FOLDER: 'file:scan-image-folder',
  BACKGROUND_ADOPT: 'background:adopt',
  FILE_CHECK_IGNORED: 'file:check-ignored',
  CLIPBOARD_HISTORY: 'clipboard:history',
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_CHANGED: 'clipboard:changed',
  SYSTEM_CHECK: 'system:check',
  UPDATE_CHECK: 'fleet:update-check',
  UPDATE_STATUS: 'fleet:update-status',
  UPDATE_INSTALL: 'fleet:install-update',
  /** Dev only: push a synthetic UpdateStatus down the real status path. */
  UPDATE_SIMULATE: 'fleet:update-simulate',
  GET_VERSION: 'fleet:get-version',
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  TERMINAL_CONTEXT_MENU: 'terminal:context-menu',
  LOG_BATCH: 'log:batch',
  ACTIVITY_STATE: 'activity:state',
  /** Renderer -> main: which panes the user can currently see. */
  ACTIVITY_VISIBLE_PANES: 'activity:visible-panes',
  /** Renderer -> main: a pane that reports its own state, having no process to watch. */
  ACTIVITY_REPORT: 'activity:report',
  /** Main -> renderer: ring the chime. Main owns how loud an event is. */
  ACTIVITY_CHIME: 'activity:chime',
  AI_SUMMARIZE_PANE: 'ai:summarize-pane',
  REMOTE_STATE: 'remote:state',
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',
  // Copilot
  COPILOT_SESSIONS: 'copilot:sessions',
  COPILOT_RESPOND_PERMISSION: 'copilot:respond-permission',
  COPILOT_GET_SETTINGS: 'copilot:get-settings',
  COPILOT_SET_SETTINGS: 'copilot:set-settings',
  COPILOT_INSTALL_HOOKS: 'copilot:install-hooks',
  COPILOT_UNINSTALL_HOOKS: 'copilot:uninstall-hooks',
  COPILOT_HOOK_STATUS: 'copilot:hook-status',
  COPILOT_INSTALL_HOOKS_TO: 'copilot:install-hooks-to',
  COPILOT_UNINSTALL_HOOKS_FROM: 'copilot:uninstall-hooks-from',
  COPILOT_HOOK_STATUS_FOR: 'copilot:hook-status-for',
  COPILOT_POSITION_GET: 'copilot:position:get',
  COPILOT_POSITION_SET: 'copilot:position:set',
  COPILOT_TOGGLE_EXPANDED: 'copilot:toggle-expanded',
  COPILOT_EXPANDED_CHANGED: 'copilot:expanded-changed',
  COPILOT_CHAT_HISTORY: 'copilot:chat-history',
  COPILOT_CHAT_UPDATED: 'copilot:chat-updated',
  COPILOT_SEND_MESSAGE: 'copilot:send-message',
  COPILOT_FOCUS_TERMINAL: 'copilot:focus-terminal',
  COPILOT_SERVICE_STATUS: 'copilot:service-status',
  COPILOT_ACTIVE_WORKSPACE: 'copilot:active-workspace',
  COPILOT_GET_ACTIVE_WORKSPACE: 'copilot:get-active-workspace',
  // Annotate
  ANNOTATE_START: 'annotate:start',
  ANNOTATE_SUBMIT: 'annotate:submit',
  ANNOTATE_CANCEL: 'annotate:cancel',
  ANNOTATE_SCREENSHOT: 'annotate:screenshot',
  ANNOTATE_SNAPSHOT_ELEMENT: 'annotate:snapshot-element',
  // Annotate UI
  ANNOTATE_UI_START: 'annotate:ui:start',
  ANNOTATE_COMPLETED: 'annotate:completed',
  ANNOTATE_LIST: 'annotate:list',
  ANNOTATE_GET: 'annotate:get',
  ANNOTATE_DELETE: 'annotate:delete',
  // Shell profiles & WSL
  SHELL_PROFILES_LIST: 'shell:profiles:list',
  WSL_STATUS: 'wsl:status',
  WSL_TO_WSL_PATH: 'wsl:to-wsl-path',
  WSL_TO_WIN_PATH: 'wsl:to-win-path',
  WSL_HOME_DIR: 'wsl:home-dir',
  // Sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_CHANGED: 'sessions:changed',
  // Learnings (cross-project knowledge base distilled from sessions)
  LEARNINGS_SEARCH: 'learnings:search',
  LEARNINGS_GET: 'learnings:get',
  LEARNINGS_CREATE: 'learnings:create',
  LEARNINGS_UPDATE: 'learnings:update',
  LEARNINGS_DELETE: 'learnings:delete',
  LEARNINGS_DISTILL: 'learnings:distill',
  LEARNINGS_EXPORT: 'learnings:export',
  LEARNINGS_SIMILAR: 'learnings:similar',
  LEARNINGS_TAGS: 'learnings:tags',
  LEARNINGS_STATUS: 'learnings:status',
  LEARNINGS_WARM_MODEL: 'learnings:warmModel',
  LEARNINGS_MODEL_CACHE_SIZE: 'learnings:modelCacheSize',
  LEARNINGS_CLEAR_MODEL_CACHE: 'learnings:clearModelCache',
  // Env Editor
  ENV_EDITOR_LIST: 'env-editor:list',
  ENV_EDITOR_READ: 'env-editor:read',
  ENV_EDITOR_WRITE: 'env-editor:write',
  ENV_EDITOR_CREATE: 'env-editor:create',
  ENV_EDITOR_RENAME: 'env-editor:rename',
  ENV_EDITOR_DELETE: 'env-editor:delete',
  ENV_EDITOR_RESTORE: 'env-editor:restore',
  // Project Notes
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  // Shell Environment (read-only spawn-time snapshot)
  SHELL_ENV_GET: 'shell-env:get',
  // Diagnostics ("Report a Problem")
  DIAGNOSTICS_GET_INFO: 'diagnostics:get-info',
  DIAGNOSTICS_GET_LOG_TAIL: 'diagnostics:get-log-tail',
  DIAGNOSTICS_OPEN_LOGS: 'diagnostics:open-logs',

  // ── Agent panes ────────────────────────────────────────────────────────────
  // The OpenRouter slice of the models.dev catalog, disk-cached in main. Agent
  // settings themselves ride on SETTINGS_GET/SET under `ai.agent`.
  AGENT_LIST_MODELS: 'agent:list-models',
  // Inference servers running on this machine. The list itself rides on
  // SETTINGS_GET/SET with everything else under `ai.agent`; what needs main is
  // asking those addresses what they are, which the renderer cannot do - it has
  // no network of its own, and a probe is a fetch to an arbitrary local port.
  //
  // TEST answers about one address without saving it, for the add form's button.
  // SCAN tries a handful of usual ports for servers Fleet has not been told
  // about. REFRESH re-asks a saved endpoint. STATUS is main volunteering the
  // whole set of rows whenever any of them changes, so a probe that finishes
  // after the settings tab was closed still lands somewhere.
  AGENT_ENDPOINT_TEST: 'agent:endpoint-test',
  AGENT_ENDPOINT_SCAN: 'agent:endpoint-scan',
  AGENT_ENDPOINT_REFRESH: 'agent:endpoint-refresh',
  AGENT_ENDPOINT_STATUS: 'agent:endpoint-status',
  // The OpenRouter API key, which main stores encrypted and never hands back.
  // App-wide rather than per pane: the key is the user's account.
  AGENT_SET_KEY: 'agent:set-key',
  AGENT_HAS_KEY: 'agent:has-key',
  AGENT_CLEAR_KEY: 'agent:clear-key',
  // One turn: SEND starts a stream and returns its id, CANCEL aborts it. The
  // transcript is renderer-side, so the request carries the whole history.
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  // Fold older messages into one summary. Shares CANCEL and the error channel,
  // and reports only the finished summary - nothing is streamed to the pane.
  AGENT_COMPACT: 'agent:compact',
  AGENT_COMPACT_DONE: 'agent:compact-done',
  AGENT_STREAM_CHUNK: 'agent:stream-chunk',
  AGENT_STREAM_REASONING: 'agent:stream-reasoning',
  AGENT_STREAM_DONE: 'agent:stream-done',
  AGENT_STREAM_ERROR: 'agent:stream-error',
  AGENT_TOOL_START: 'agent:tool-start',
  AGENT_TOOL_END: 'agent:tool-end',
  // A half-drawn image, on its way to the finished one. Sent as bytes rather
  // than a path because a partial is never saved: it is a progress indicator
  // that happens to look like the answer, and it is thrown away when the real
  // one lands. Nothing depends on any arriving.
  AGENT_IMAGE_PARTIAL: 'agent:image-partial',
  // A command the agent cannot run itself - a login, a password prompt, an
  // interactive picker - passed to the renderer to type into a terminal pane
  // beside the agent, where there is a person and a real tty.
  AGENT_HAND_OFF: 'agent:hand-off',
  // A command the rules do not settle on their own. Main asks, the pane renders
  // the question on the call's row, and the answer comes back on DECIDE. The
  // renderer never decides anything itself - it relays a click.
  AGENT_PERMISSION_ASK: 'agent:permission-ask',
  AGENT_PERMISSION_DECIDE: 'agent:permission-decide',
  // A subagent starting and, some minutes later, ending. START comes before any
  // of the child's own tool events, so the pane has somewhere to put them by the
  // time they arrive; DONE carries the report, which the pane writes onto the
  // call that asked for it and hands to the model on the next turn.
  //
  // Two events rather than one because a subagent outlives the turn that started
  // it: by the time it ends there is no stream left to end, and the pane it
  // belongs to is identified by its session rather than by a turn in flight.
  AGENT_TASK_START: 'agent:task-start',
  AGENT_TASK_DONE: 'agent:task-done',
  // The sub-transcript of one subagent, read when the user opens its card. Kept
  // by main rather than the pane, because a subagent has no pane: it is the one
  // conversation in Fleet nobody was watching while it happened.
  AGENT_TASK_TRANSCRIPT: 'agent:task-transcript',
  AGENT_TASK_CANCEL: 'agent:task-cancel',
  // Which subagents are still running, asked by a pane that has just replayed a
  // session and found rows saying "running". Main is the only one that knows:
  // the renderer that dispatched them may have been reloaded, or been a
  // different launch of the app entirely, and a row nobody is working on has to
  // stop claiming it is.
  AGENT_TASK_RUNNING: 'agent:task-running',
  // The thread on disk: an append-only event log per session, replayed when a
  // pane opens. The renderer decides what happened; main only writes it down.
  AGENT_SESSION_APPEND: 'agent:session-append',
  AGENT_SESSION_ADD_SPEND: 'agent:session-add-spend',
  AGENT_SESSION_LOAD: 'agent:session-load',
  // The sessions started in one folder, for the pane's Sessions tab, and the
  // removal of one. Which session a pane is currently on is the renderer's to
  // know, so the rules about that are enforced there rather than here.
  AGENT_SESSION_LIST: 'agent:session-list',
  AGENT_SESSION_DELETE: 'agent:session-delete',
  // A name for a session, from the exchange that opened it. Main returns the
  // text; the renderer decides which session log it belongs in.
  AGENT_GENERATE_TITLE: 'agent:generate-title',
  // One thing the user attached to a message - pasted, dropped, picked, or
  // `@`-mentioned. Main copies it somewhere durable or reads what it needs out
  // of it, and hands back the small record the message carries. The bytes never
  // come back: what the model gets is read at the moment the turn is built.
  // Voice dictation, straight up and down: base64 in, text out. Nothing
  // about the turn or the session log changes - it only fills the composer box.
  AGENT_TRANSCRIBE: 'agent:transcribe',
  /**
   * The OS microphone, resolved to a yes or a no: it reads the state, and asks
   * for it once if it has never been asked. Named for the ask rather than the
   * read, because on a never-asked machine it puts a dialog on screen.
   */
  AGENT_MIC_ACCESS: 'agent:mic-access',
  AGENT_ATTACH: 'agent:attach',
  // Files the `@` menu can offer, from the same gitignore-aware walk `glob`
  // and `grep` use, so the menu cannot offer what the sandbox would refuse.
  AGENT_MENTION_SEARCH: 'agent:mention-search',
  // What the composer's `/` menu offers, for a pane open on this folder. Asked
  // once when the pane opens, like the prompt history below: the offering may
  // lag a file added a moment ago, but resolving a name never does - that is
  // read off disk again on every turn.
  AGENT_COMMANDS_LIST: 'agent:commands-list',
  // Which branch a pane's folder is on. WATCH registers a pane and answers
  // immediately on HEAD; REFRESH asks for a re-read after something that no
  // file watcher would have seen, such as a tool call that may have been a
  // checkout. A pane whose folder is not a repo is watched too, and answers
  // `null` - not being in a repo is an ordinary state, not a failure.
  AGENT_GIT_WATCH: 'agent:git-watch',
  AGENT_GIT_UNWATCH: 'agent:git-unwatch',
  AGENT_GIT_REFRESH: 'agent:git-refresh',
  AGENT_GIT_HEAD: 'agent:git-head',
  // What the composer's Up key walks back through, scoped to a pane's folder.
  // LIST is asked once when a pane opens and answered from a file; ADD is
  // fire-and-forget, because a prompt that failed to be remembered must not be
  // a prompt that failed to send.
  AGENT_HISTORY_LIST: 'agent:history-list',
  AGENT_HISTORY_ADD: 'agent:history-add',
  // MCP servers this pane's agent can call tools on. The configs live in
  // settings under `ai.agent.mcpServers`, but they go through SET rather than
  // SETTINGS_SET so that saving also reconnects and answers with what happened.
  // STATUS is pushed whenever a connection changes state, which includes while
  // nobody asked - a server can drop at any time.
  AGENT_MCP_GET: 'agent:mcp-get',
  AGENT_MCP_SET: 'agent:mcp-set',
  AGENT_MCP_STATUS: 'agent:mcp-status',
  AGENT_MCP_RECONNECT: 'agent:mcp-reconnect',
  // What other tools on this machine have configured, and taking some of it.
  // The detection carries no credentials; IMPORT re-reads the source files in
  // main, which is the only place allowed to see them.
  AGENT_MCP_DETECT: 'agent:mcp-detect',
  AGENT_MCP_IMPORT: 'agent:mcp-import',
  // Signing in to one server, which opens the user's browser. Long-running and
  // cancellable, because it waits on a person.
  AGENT_MCP_SIGN_IN: 'agent:mcp-sign-in',
  AGENT_MCP_SIGN_OUT: 'agent:mcp-sign-out',
  // A static token the user types, straight into the encrypted store. It never
  // comes back out over IPC; the renderer only learns whether one is set.
  AGENT_MCP_SET_TOKEN: 'agent:mcp-set-token',
  // Skills: SKILL.md folders, in the shared agentskills.io format. Unlike MCP
  // servers these are files rather than settings, so there is no GET/SET pair -
  // LIST reads the folder, and the rest put things into it or take them out.
  // DETECT finds what other tools on this machine already have; FETCH clones a
  // repository and reports what is in it, DISCARD throws that clone away.
  AGENT_SKILLS_LIST: 'agent:skills-list',
  AGENT_SKILLS_DETECT: 'agent:skills-detect',
  AGENT_SKILLS_FETCH: 'agent:skills-fetch',
  AGENT_SKILLS_DISCARD: 'agent:skills-discard',
  AGENT_SKILLS_INSTALL: 'agent:skills-install',
  AGENT_SKILLS_REMOVE: 'agent:skills-remove',
  AGENT_SKILLS_REVEAL: 'agent:skills-reveal',
  // Memory: what earlier sessions wrote down. Three channels rather than the
  // skills' seven, and the two that are missing are the point - nothing here
  // creates or imports an entry, because the only thing that writes memory is
  // the agent mid-turn. LIST takes the working folder, since the project tier
  // is per-folder, and REMOVE is the user's undo.
  AGENT_MEMORY_LIST: 'agent:memory-list',
  AGENT_MEMORY_REMOVE: 'agent:memory-remove',
  AGENT_MEMORY_REVEAL: 'agent:memory-reveal',
  // Reminders the agent set for itself. Main owns them, because deciding that
  // one is due has to happen whether or not any pane is open on the session it
  // belongs to - which is also why CHANGED is pushed rather than polled.
  //
  // PULL_DUE is the one that matters: it is the only way a due schedule is ever
  // consumed, and it hands the batch over and clears it in the same call, so a
  // pane that asks twice gets it once. CANCEL is the user's stop button, which
  // needs no session of its own - a person clicking in their own pane is
  // already looking at the row they mean.
  AGENT_SCHEDULE_LIST: 'agent:schedule-list',
  AGENT_SCHEDULE_CANCEL: 'agent:schedule-cancel',
  AGENT_SCHEDULE_PULL_DUE: 'agent:schedule-pull-due',
  AGENT_SCHEDULE_CHANGED: 'agent:schedule-changed',

  // ── Remote (SSH) file browser ──────────────────────────────────────────────
  // Distinct from REMOTE_STATE above, which is the unrelated "is this pane's
  // foreground process a remote shell" boolean.
  REMOTE_SSH_TEST: 'remote-ssh:test',
  REMOTE_SSH_HOME: 'remote-ssh:home',
  REMOTE_SSH_LIST: 'remote-ssh:list',
  REMOTE_SSH_STAT: 'remote-ssh:stat',
  // Materialises a remote file into the local cache and returns its local path,
  // which is what lets the existing viewer panes and fleet-image:// /
  // fleet-pdf:// protocols work on remote files unchanged.
  REMOTE_SSH_FETCH: 'remote-ssh:fetch',
  REMOTE_SSH_READ_TEXT: 'remote-ssh:read-text',
  REMOTE_SSH_WRITE_TEXT: 'remote-ssh:write-text',
  REMOTE_SSH_MKDIR: 'remote-ssh:mkdir',
  REMOTE_SSH_RENAME: 'remote-ssh:rename',
  REMOTE_SSH_REMOVE: 'remote-ssh:remove',
  REMOTE_SSH_UPLOAD: 'remote-ssh:upload',
  REMOTE_SSH_DOWNLOAD: 'remote-ssh:download',
  REMOTE_SSH_TRANSFER_CANCEL: 'remote-ssh:transfer-cancel',
  // Renderer-bound event carrying a RemoteTransfer snapshot on every poll tick.
  REMOTE_SSH_TRANSFER_PROGRESS: 'remote-ssh:transfer-progress',
  REMOTE_SSH_DISCONNECT: 'remote-ssh:disconnect',
  // Best-effort: resolve the ssh destination a terminal pane is connected to.
  REMOTE_SSH_DETECT_HOST: 'remote-ssh:detect-host',
  // Fleet's shell snippet on the remote host: is it there, and put it there.
  REMOTE_SSH_RC_STATUS: 'remote-ssh:rc-status',
  REMOTE_SSH_RC_INSTALL: 'remote-ssh:rc-install',
  // Renderer-bound: the working directory of the shell on the far side of an ssh
  // pane. Separate from PTY_CWD, which is the local pane's own directory.
  REMOTE_CWD: 'remote:cwd'
} as const;
