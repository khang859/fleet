# Graph Report - src  (2026-08-07)

## Corpus Check
- Large corpus: 780 files · ~664,193 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 5054 nodes · 12630 edges · 203 communities (180 shown, 23 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 74 edges (avg confidence: 0.71)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Agent Service Core
- Copilot Window UI
- Chat Store & Persistence
- Chat View & Conversations
- Chat Skills Loader
- IPC Surface & Preload
- Clipboard & File Overlays
- Chat Composer & Persona
- Chat Image Generation
- Env Editor Filesystem
- Agent Thread & Composer
- Agent Renderer Store
- Remote SSH Browser UI
- Chat Settings Panels
- Chat Permission Manager
- Agent Diff
- Agent Settings & Types
- Agent MCP Import
- Agent Todo Panel
- Dashboard & Pane Chrome
- Agent MCP Server Settings
- Agent MCP Runtime
- Rune File Assist
- Chat Tool Runner & Sandbox
- Agent Session Store
- Claude Transcript Readers
- Renderer App Shell
- Agent Permission Model
- WSL & Shell Profiles
- Agent Git Watch
- Pi Env Injection
- Agent Path Tools & Ignore
- Chat OpenRouter Client
- Main Process Bootstrap
- Workspace & Tab State
- Chat Service Loop
- Image Service & Providers
- Settings Sections UI
- Fake Server
- Command Palette
- Env Sync UI & Toasts
- Tool Label
- Theme Resolution
- Sprite Loader
- Rune Config Types
- Agent Attachments
- File Search & Context
- Worktrees & Cwd Polling
- Fleet CLI
- Rune Assist Store
- Env Sync Config
- Path Platform
- Chat Permission Rules
- Pane Grid Layout
- Chat Web Fetch
- Fal.ai Image Provider
- Socket API & Commands
- Remote SSH Listing
- Agent Overview & Peek
- Learnings Embedder
- Annotation Store
- Pi Config Types
- Agent MCP Registry
- Event Bus
- Learnings IPC
- Rune Session Source
- Pane Rendering & Background
- Env Editor UI
- Git Changes & Diff Preview
- Fake Oauth Server
- Agent Image Store
- Chat IPC & Export
- Git Service
- Rune Config Manager
- App Shell & Shortcuts
- Starfield Visualizer
- Agent Models Catalog
- Pi Config Manager
- Remote SSH Transfer
- Agent Folder Picker
- Image Gallery & Viewer
- Session Tree
- Agent Tool Definitions
- Agent Prompt History
- Agent Spend Tracking
- Socket Server Supervisor
- Annotate & Search UI
- Terminal Background Settings
- Agent Image Attachments
- Chat Web Search Providers
- Copilot Window Lifecycle
- PTY Manager
- Remote SSH Service
- Pi Settings UI
- Renderer Hooks
- Env Var Expansion
- Copilot Session Store
- Layout Store
- Remote SSH Cache
- Shell Env View
- Motion & Overlays
- Agent OpenRouter Client
- Agent MCP Secret Types
- Chat Search & Backfill
- Chat Filesystem Tools
- Env Sync S3 Client
- Learnings Store
- Sidebar Chrome
- Agent MCP OAuth
- Agent MCP Secret Store
- Env Sync Secret Storage
- Claude Pricing
- Config Text
- Visualizer Particles
- Learnings MCP Server
- Remote SSH Transfers
- Space Canvas & Weather
- Activity Tracker
- Agent Bash Tool
- Env Sync Manager
- Transcript Viewer
- Space Renderer
- Agent Store Tests
- Reported Activity
- Annotate Service
- Learnings MCP Registrar
- Remote SSH Control
- Markdown Preview & Attachments
- Chat MCP Manager
- Env Sync Secrets
- Env Sync Modal
- Sessions Browser
- Copilot Hook Installer
- Shared Settings Types
- File Editor Pane
- Markdown Pane & Find
- Chat Secret Keys
- Main Logger & Bridge
- Notes Storage
- Pi Auth Inspector
- Sessions Service
- Rune Install & Status
- Pi Provider Ordering
- MCP Import Lift
- Attention Signals
- Rune Manager
- Settings Store
- Visualizer Ships
- Agent Grep Tool
- General Settings & Fonts
- Learnings Embed Service
- Learnings Vector Extension
- Pane Activity Glyphs
- Chat MCP Client
- Copilot Service Lifecycle
- Learnings Distiller
- Rune Config Editor
- Chat Settings Nav & Search
- Image Grid & Preview
- Visualizer Aurora
- Edit Match
- Env File Parsing
- Learnings Search
- Notification Detector
- SSH Host Detect
- Chat & Agent Markdown
- Chat Audit Log
- Agent MCP IPC
- Agent PDF Extraction
- Chat MCP Client Class
- Copilot Socket Server
- Rune Controls
- Visualizer Nebula
- Chat MCP Manager Class
- Client Test
- MCP Stdio Transport
- Clipboard Monitor
- Fleet CLI Installer
- Chat MCP Servers Tab
- MCP HTTP Transport
- Stream Buffer
- Env Sync Crypto
- PTY Data Router
- Pi Defaults Form
- Test Setup
- Env Sync State Store
- Safe External URLs
- Cwd Poller
- Workspace Path
- Env D
- Slideshow Scanner
- Image Service Test
- MCP Import Fixtures
- Learnings Embed Worker
- Runtime Env
- Asset Type Declarations

## God Nodes (most connected - your core abstractions)
1. `useWorkspaceStore` - 60 edges
2. `createLogger()` - 53 edges
3. `ChatStore` - 50 edges
4. `registerIpcHandlers()` - 50 edges
5. `PathContext` - 41 edges
6. `useChatStore` - 36 edges
7. `useSettingsStore` - 36 edges
8. `PtyManager` - 35 edges
9. `ImageService` - 34 edges
10. `useToastStore` - 34 edges

## Surprising Connections (you probably didn't know these)
- `McpSection()` --indirect_call--> `config()`  [INFERRED]
  renderer/src/components/agent/settings/mcp/McpSection.tsx → main/agent/mcp/__tests__/auth.test.ts
- `runCLI()` --indirect_call--> `v()`  [INFERRED]
  main/fleet-cli.ts → renderer/src/__tests__/shell-env-view.test.ts
- `expandRecord()` --indirect_call--> `v()`  [INFERRED]
  main/mcp-expand.ts → renderer/src/__tests__/shell-env-view.test.ts
- `listClaudeSessions()` --indirect_call--> `key()`  [INFERRED]
  main/sessions/claude-source.ts → renderer/src/lib/__tests__/shortcuts-palette.test.ts
- `listRuneSessions()` --indirect_call--> `key()`  [INFERRED]
  main/sessions/rune-source.ts → renderer/src/lib/__tests__/shortcuts-palette.test.ts

## Import Cycles
- None detected.

## Communities (203 total, 23 thin omitted)

### Community 0 - "Agent Service Core"
Cohesion: 0.05
Nodes (64): AgentEmitter, AgentService, CallContext, Deps, maxToolRounds(), mcpCaller(), textOnly(), toCompactMessages() (+56 more)

### Community 1 - "Copilot Window UI"
Cohesion: 0.05
Nodes (57): App(), TeleportPhase, getSpriteSheet(), validIds, AskUserQuestionBlock(), ChatMessageItem(), MODE_TOOLS, renderToolUse() (+49 more)

### Community 2 - "Chat Store & Persistence"
Cohesion: 0.05
Nodes (37): AUDIT_DECISIONS, AUDIT_STATUSES, AuditRowSchema, ChatStore, ChatVecHit, ChatVecRowSchema, ConversationRow, ConversationRowSchema (+29 more)

### Community 3 - "Chat View & Conversations"
Cohesion: 0.05
Nodes (50): ArtifactPanel(), EXT, ChatImage(), ChatImageLightbox(), ChatView(), Props, BUCKET_ORDER, bucketOf() (+42 more)

### Community 4 - "Chat Skills Loader"
Cohesion: 0.05
Nodes (36): estimateTokens(), Frontmatter, isRecord(), listExtraFiles(), LoadedSkill, parseSkillMd(), scanSkillsDir(), parseSlashInvocation() (+28 more)

### Community 5 - "IPC Surface & Preload"
Cohesion: 0.06
Nodes (64): collectDiagnosticsInfo(), openLogsFolder(), readRedactedLogTail(), redact(), FILE_LIST_IGNORE_DIRS, FileListEntry, IMAGE_MIME_TYPES, listFilesWsl() (+56 more)

### Community 6 - "Clipboard & File Overlays"
Cohesion: 0.07
Nodes (54): ClipboardHistoryOverlay(), ClipboardHistoryOverlayProps, formatTimestamp(), truncateLines(), addRecentFile(), FileSearchOverlay(), FileSearchOverlayProps, fileSearchResultSchema (+46 more)

### Community 7 - "Chat Composer & Persona"
Cohesion: 0.06
Nodes (49): Attachment, Composer(), composerKeyAction, ComposerKeyEvent, Props, SlashCommand, slashMenu, PersonaPicker() (+41 more)

### Community 8 - "Chat Image Generation"
Cohesion: 0.06
Nodes (31): ARGS_SCHEMA, GENERATE_IMAGE_TOOL, parseGenerateImageArgs(), runGenerateImage(), ChatWorkspace, resolveOverride(), ChatImageStorage, EXT_BY_MIME (+23 more)

### Community 9 - "Env Editor Filesystem"
Cohesion: 0.06
Nodes (44): assertEnvName(), buildEnvEntry(), createEnvFile(), ENV_EXCLUDE_DIRS, ENV_MAX_DEPTH, EXCLUDE_DIRS, isEnvName(), isTemplateName() (+36 more)

### Community 10 - "Agent Thread & Composer"
Cohesion: 0.06
Nodes (41): agentPhase, formatElapsed(), PHASE_LABEL, phaseShimmers(), reasoningLabel(), AgentActivity(), useElapsed(), AgentPermissionRow() (+33 more)

### Community 11 - "Agent Renderer Store"
Cohesion: 0.08
Nodes (50): msg(), CompactionField(), percent(), addSpend(), AgentStoreState, appendReasoning(), appendText(), applySummary() (+42 more)

### Community 12 - "Remote SSH Browser UI"
Cohesion: 0.06
Nodes (34): Crumb, toCrumbs(), Props, RemoteBreadcrumbs(), Props, RemoteDeleteDialog(), entryIcon(), Props (+26 more)

### Community 13 - "Chat Settings Panels"
Cohesion: 0.11
Nodes (34): SECTION_COMPONENTS, PersonaManager(), AgentToolsSection(), asToolsMode(), TOOL_MODES, ChatSettingsProvider(), ComposerSection(), inputCls (+26 more)

### Community 14 - "Chat Permission Manager"
Cohesion: 0.08
Nodes (23): Deps, Pending, PermissionEmitter, PermissionGrant, PermissionManager, PermissionRequest, baseRules, AuditDraft (+15 more)

### Community 15 - "Agent Diff"
Cohesion: 0.09
Nodes (38): diffReport(), runEdit(), forgetAllFiles(), remember(), requireFresh(), seen, Stamp, checked() (+30 more)

### Community 16 - "Agent Settings & Types"
Cohesion: 0.08
Nodes (36): AgentContextMeter(), AgentImageSettings(), AgentRoleSettings(), ModelFacts(), AgentSettingsPanel(), CatalogStatus(), OptionPills(), ParamSlider() (+28 more)

### Community 17 - "Agent MCP Import"
Cohesion: 0.08
Nodes (36): collect(), Entry, File, normalize(), ProjectFile, scanClaudeCode(), StringMap, DetectDeps (+28 more)

### Community 18 - "Agent Todo Panel"
Cohesion: 0.11
Nodes (37): ctx(), plan(), runTodoAdd(), runTodoUpdate(), AgentTodoPanel(), LIVE, showTodoPanel(), splitTodos() (+29 more)

### Community 19 - "Dashboard & Pane Chrome"
Cohesion: 0.06
Nodes (38): ErrorBoundary, log, Props, State, BADGE_CONFIG, formatFreshness(), logDnd, TabItem() (+30 more)

### Community 20 - "Agent MCP Server Settings"
Cohesion: 0.07
Nodes (35): call(), handlers, HTTP, snapshot(), SnapshotShape, StatusShape, FoundRow(), Group (+27 more)

### Community 21 - "Agent MCP Runtime"
Cohesion: 0.06
Nodes (25): alreadyAuthorized(), AuthDeps, liftedFields(), log, resolveAuth(), signIn(), Callback, CALLBACK_URLS (+17 more)

### Community 22 - "Rune File Assist"
Cohesion: 0.10
Nodes (28): CodedError, toError(), registerRuneAssistIpc(), ActiveTurn, CwdChat, log, RuneFileChatService, RuneFileChatServiceOptions (+20 more)

### Community 23 - "Chat Tool Runner & Sandbox"
Cohesion: 0.06
Nodes (37): BashResult, runBash(), scrubEnv(), buildBwrapArgv(), isSandboxAvailable(), makeSandboxWrap(), SandboxConfig, ROOT (+29 more)

### Community 24 - "Agent Session Store"
Cohesion: 0.09
Nodes (34): AGENT_ATTACHMENTS_DIR, AgentSessionStore, isMissing(), log, readHead(), readSpend(), readWindow(), SESSIONS_DIR (+26 more)

### Community 25 - "Claude Transcript Readers"
Cohesion: 0.08
Nodes (31): applyTranscriptLine(), ConversationReader, cwdToProjectDir(), formatToolInputPreview(), log, parseClaudeTranscript(), parseMessageLine(), sessionFilePath() (+23 more)

### Community 26 - "Renderer App Shell"
Cohesion: 0.08
Nodes (34): App(), killClosedTabPtys(), PiPlanModalEntry, CopilotSection(), SYSTEM_SOUNDS, getFirstDirtyPaneId(), getFirstLeaf(), Sidebar() (+26 more)

### Community 27 - "Agent Permission Model"
Cohesion: 0.09
Nodes (26): Deps, McpPermissionRequest, Pending, PermissionGate, PermissionGrant, PermissionRequest, emit, AgentPermissionRules (+18 more)

### Community 28 - "WSL & Shell Profiles"
Cohesion: 0.08
Nodes (20): defaultFileExists(), RegistryDeps, ShellProfileRegistry, decodeWslOutput(), defaultExec(), log, mapState(), parseListQuiet() (+12 more)

### Community 29 - "Agent Git Watch"
Cohesion: 0.11
Nodes (25): exists(), readCapped(), readGitHead(), readGitHeadAt(), readOperation(), resolveGitDir(), AgentGitWatcher, Entry (+17 more)

### Community 30 - "Pi Env Injection"
Cohesion: 0.08
Nodes (25): BEARER_MODE_UNSETS, defaultStore(), EnvInjectionStore, InjectedEnv, KEYS_MODE_UNSETS, log, PiEnvInjectionManager, PiEnvInjectionManagerOptions (+17 more)

### Community 31 - "Agent Path Tools & Ignore"
Cohesion: 0.11
Nodes (30): searchMentionFiles(), rels(), escapeLiteral(), globMatcher(), translate(), runGlob(), ALWAYS_SKIPPED, ignoreDecision() (+22 more)

### Community 32 - "Chat OpenRouter Client"
Cohesion: 0.10
Nodes (23): fallbackTitle(), generateTitle(), resolveTitle(), sanitizeTitle(), generateTags(), resolveTags(), sanitizeTags(), APP_HEADERS (+15 more)

### Community 33 - "Main Process Bootstrap"
Cohesion: 0.06
Nodes (33): activityTracker, annotateService, ANNOTATIONS_DIR, annotationStore, createWindow(), cwdPoller, envSyncManager, envSyncSecrets (+25 more)

### Community 34 - "Workspace & Tab State"
Cohesion: 0.08
Nodes (27): applyToolVisibility(), ClosedTabRecord, createLeaf(), createLeafWithProfile(), DEFUNCT_TAB_TYPES, ensureAnnotateTab(), ensureChatTab(), ensureImagesTab() (+19 more)

### Community 35 - "Chat Service Loop"
Cohesion: 0.10
Nodes (23): addUsage(), ChatEmitter, ChatService, createThinkSplitter(), Deps, isFilePart(), NamingConfig, parseDataUrl() (+15 more)

### Community 36 - "Image Service & Providers"
Cohesion: 0.13
Nodes (7): ImageProvider, generateId(), ImageService, isImageGenerationMeta(), ImageGenerationMeta, ImageGenerationStatus, ImageProviderSettings

### Community 37 - "Settings Sections UI"
Cohesion: 0.09
Nodes (25): AnnotateSection(), buildIssueUrl(), DiagnosticsSection(), EnvSyncSection(), NOTIFICATION_CHANNELS, NOTIFICATION_LABELS, NotificationKey, NotificationsSection() (+17 more)

### Community 38 - "Fake Server"
Cohesion: 0.09
Nodes (30): asParameters(), budget(), HttpStatus, log, readResult(), Route, ServerEntry, ToolResultShape (+22 more)

### Community 39 - "Command Palette"
Cohesion: 0.10
Nodes (29): CommandPalette(), CommandPaletteProps, paletteShortcut, toCommandItem(), Command, CommandDialog(), CommandDialogProps, CommandEmpty() (+21 more)

### Community 40 - "Env Sync UI & Toasts"
Cohesion: 0.09
Nodes (27): EnvSyncBadge(), fetchAggState(), SYNC_STATE_ORDER, ConflictTarget, ConflictTargetSchema, EnvSyncConflictDialog(), CopyDocMenu(), CopyDocMenuProps (+19 more)

### Community 41 - "Tool Label"
Cohesion: 0.11
Nodes (22): AgentImage(), AgentImagePreview(), AgentToolRow(), DiffBody(), LINE_STYLES, createdBody(), diffBody(), imageBody() (+14 more)

### Community 42 - "Theme Resolution"
Cohesion: 0.12
Nodes (31): GeneralSection(), useAppThemeVars(), useSystemPrefersDark(), deriveAppTheme(), FleetThemeCssProperties, getAppThemeCssVars(), mixHex(), normalizeAppTheme() (+23 more)

### Community 43 - "Sprite Loader"
Cohesion: 0.10
Nodes (20): Asteroid, ASTEROID_KEYS, AsteroidField, BloomPass, BODY_KINDS, BODY_SPRITES, BodyKind, CelestialBodies (+12 more)

### Community 44 - "Rune Config Types"
Cohesion: 0.09
Nodes (31): activeProviderLabel(), isRuneProvider(), numOptions(), profileDisplayName(), Props, RuneGeneralForm(), Props, RuneProfilesEditor() (+23 more)

### Community 45 - "Agent Attachments"
Cohesion: 0.12
Nodes (28): attachmentWireParts(), imageBytes(), imageWireParts(), log, mentionText(), pdfText(), readOnlyContext(), readPdf() (+20 more)

### Community 46 - "File Search & Context"
Cohesion: 0.11
Nodes (27): BoundedStdout, captureBoundedStdout(), MAX_STDOUT_CHARS, buildFallbackCommand(), buildRgCommand(), grepFiles(), isWslContext(), killActive() (+19 more)

### Community 47 - "Worktrees & Cwd Polling"
Cohesion: 0.11
Nodes (19): CwdPoller, readProcCwd(), mockExecInContext, mockMkdir, mockRaw, mockRm, ok(), routeGit() (+11 more)

### Community 48 - "Fleet CLI"
Cohesion: 0.12
Nodes (23): CLIResponse, COMMAND_MAP, FleetCLI, formatTable(), getHelpText(), HELP_GROUPS, isCLIResponse(), isRecord() (+15 more)

### Community 49 - "Rune Assist Store"
Cohesion: 0.10
Nodes (23): Props, RuneAnswerPopover(), Props, RuneAssistLayer(), Props, RuneAssistOverlay(), Props, RuneWorkingPill() (+15 more)

### Community 50 - "Env Sync Config"
Cohesion: 0.12
Nodes (23): CONFIG_REL, configPath(), findNearestConfig(), invalidateConfigCache(), log, mostSpecificInjectTarget(), nearestCache, readConfig() (+15 more)

### Community 51 - "Path Platform"
Cohesion: 0.13
Nodes (28): FleetProtocolPath, parseFleetUrl(), FileCandidate, generateThumbnail(), IMAGE_EXTS, scanKnownDirs(), scanWslDirs(), scanWslDirsBounded() (+20 more)

### Community 52 - "Chat Permission Rules"
Cohesion: 0.12
Nodes (25): escapeRegex(), evaluateExplicitPermission(), evaluatePermission(), matchesAny(), matchPattern(), ParsedRule, parseRule(), suggestRememberRule() (+17 more)

### Community 53 - "Pane Grid Layout"
Cohesion: 0.09
Nodes (28): AbsoluteResizeHandle(), AbsoluteResizeHandleProps, addCV(), calcToPixels(), CalcValue, computeLayout(), cv(), HandleEntry (+20 more)

### Community 54 - "Chat Web Fetch"
Cohesion: 0.11
Nodes (26): BlockedUrlError, capResult(), concat(), extractContent(), Extracted, FetchedPage, fetchPage(), HTML_TYPES (+18 more)

### Community 55 - "Fal.ai Image Provider"
Cohesion: 0.12
Nodes (17): ImageActionConfig, ImageActionInfo, toActionInfo(), FalAiProvider, isEditOpts(), isRecord(), parseActionSettings(), EditOpts (+9 more)

### Community 56 - "Socket API & Commands"
Cohesion: 0.12
Nodes (11): isSocketCommand(), SocketApi, SocketCommand, SocketCommandHandler, SocketResponse, FleetCommandHandler, sendCommand(), sendRaw() (+3 more)

### Community 57 - "Remote SSH Listing"
Cohesion: 0.16
Nodes (25): describeSshFailure(), execSsh(), hostKey(), testConnection(), buildRecursiveDeletePlan(), deletePlanToBatch(), listRecursive(), parseDeletePlan() (+17 more)

### Community 58 - "Agent Overview & Peek"
Cohesion: 0.13
Nodes (22): AgentOverview(), AgentOverviewProps, Row, SUMMARIZABLE_STATES, URGENCY, PeekPanel(), PeekPanelProps, workspaceToAgents() (+14 more)

### Community 59 - "Learnings Embedder"
Cohesion: 0.10
Nodes (11): EMBED_MODEL, log, WorkerEmbedderOptions, WorkerMessage, EMBED_DIM, Embedder, FakeEmbedder, NullEmbedder (+3 more)

### Community 60 - "Annotation Store"
Cohesion: 0.11
Nodes (16): ElementScreenshot, log, PendingRequest, AnnotationScreenshot, AnnotationStore, log, TEST_DIR, AccessibilityInfo (+8 more)

### Community 61 - "Pi Config Types"
Cohesion: 0.12
Nodes (24): KindMeta, KINDS, metaFor(), PiApiKeyInput(), Props, PiModelsEditor(), Props, APIS (+16 more)

### Community 62 - "Agent MCP Registry"
Cohesion: 0.07
Nodes (27): enabled, headers, type, url, command, type, FS_ROOT, enabled (+19 more)

### Community 63 - "Event Bus"
Cohesion: 0.13
Nodes (9): EventBus, EventMap, FleetEvent, PERMISSION_PATTERNS, PermissionLatch, NotificationRecord, NotificationStateManager, PRIORITY (+1 more)

### Community 64 - "Learnings IPC"
Cohesion: 0.12
Nodes (22): dateStamp(), dirSize(), handle(), IpcError, log, reqString(), validateCreateInput(), LearningsBrowser() (+14 more)

### Community 65 - "Rune Session Source"
Cohesion: 0.12
Nodes (25): activePath(), buildTree(), CachedSummary, __clearRuneSummaryCache(), contentBlockSchema, firstUserText(), mapSubagents(), mapUsage() (+17 more)

### Community 66 - "Pane Rendering & Background"
Cohesion: 0.15
Nodes (19): AgentPane(), AgentView, EMPTY_TODOS, RefocusDetail, BackgroundLayer(), BackgroundLayerProps, edgeFadeStyle(), FIT_STYLES (+11 more)

### Community 67 - "Env Editor UI"
Cohesion: 0.15
Nodes (21): basenameOf(), EnvEditorModal(), EnvForm(), Props, VarRow, EnvRawEditor(), Props, FileNavigator() (+13 more)

### Community 68 - "Git Changes & Diff Preview"
Cohesion: 0.10
Nodes (19): DiffHighlighterInstance, getLanguageFromFilename(), GitChangesModal(), GitChangesModalProps, ParsedFileDiff, parseDiffToFiles(), parseUnifiedDiff(), STATUS_COLORS (+11 more)

### Community 69 - "Fake Oauth Server"
Cohesion: 0.10
Nodes (19): RFC-7591, RFC-9728, config(), safeStorage, RFC-9207, approve(), body(), FakeOAuthServer (+11 more)

### Community 70 - "Agent Image Store"
Cohesion: 0.11
Nodes (13): AGENT_IMAGES_DIR, AgentImageStore, EXT_BY_MIME, log, within(), formatCost(), IMAGE_EXTENSIONS, MIME_BY_EXT (+5 more)

### Community 71 - "Chat IPC & Export"
Cohesion: 0.11
Nodes (16): Deps, registerChatIpc(), defaultStore(), KeyStore, Options, SafeStorageLike, SecretsData, ChatExportFormat (+8 more)

### Community 72 - "Git Service"
Cohesion: 0.17
Nodes (15): GitService, isWslCtx(), parseNumstat(), parseNumstatWithRename(), parsePorcelainV1(), resolveStatus(), mockExecInContext, mockGit (+7 more)

### Community 73 - "Rune Config Manager"
Cohesion: 0.13
Nodes (11): deepMerge(), extractZodIssues(), isPlainObject(), log, messageOf(), resolveRuneDir(), RuneConfigManager, RuneConfigManagerOptions (+3 more)

### Community 74 - "App Shell & Shortcuts"
Cohesion: 0.13
Nodes (19): PaneToolbar(), PaneToolbarProps, shortcutLabel(), ShortcutsHint(), SHORTCUTS, ShortcutsPanel(), ShortcutsPanelProps, leaf (+11 more)

### Community 75 - "Starfield Visualizer"
Cohesion: 0.12
Nodes (12): buildFillStyleEntry(), fillStyleLUT, getTwinkleFillStyle(), LAYER_CONFIGS, makeCachedFillStyle(), makeStar(), randomStarColor(), randomTwinkle() (+4 more)

### Community 76 - "Agent Models Catalog"
Cohesion: 0.12
Nodes (15): AgentModelCatalog, cacheSchema, catalogResponseSchema, ModelDefaults, modelSchema, NO_DEFAULTS, openRouterDefaultsSchema, reasoningOptionSchema (+7 more)

### Community 77 - "Pi Config Manager"
Cohesion: 0.14
Nodes (8): extractZodIssues(), log, messageOf(), PiConfigManager, PiConfigManagerOptions, PiConfigParseError, PiConfigValidationError, PiSettings

### Community 78 - "Remote SSH Transfer"
Cohesion: 0.19
Nodes (19): execSftpBatch(), sftpQuote(), assertSftpOk(), sftpBatchRemove(), sftpGet(), sftpMkdir(), sftpPut(), sftpPutAtomic() (+11 more)

### Community 79 - "Agent Folder Picker"
Cohesion: 0.12
Nodes (16): AgentFolderDialog(), AgentFolderDialogProps, Choice, Listing, Crumb, crumbTrail(), parentDir(), rootOf() (+8 more)

### Community 80 - "Image Gallery & Viewer"
Cohesion: 0.13
Nodes (19): DetailImage(), ImageDetail(), ImageDetailProps, ImageGallery(), View, ASPECT_RATIOS, FORMATS, ImageSettings() (+11 more)

### Community 81 - "Session Tree"
Cohesion: 0.15
Nodes (18): connectorPrefix(), formatTime(), NodeRow(), SessionTree(), TREE, flattenTree(), indexById(), pathIds() (+10 more)

### Community 82 - "Agent Tool Definitions"
Cohesion: 0.08
Nodes (24): AGENT_TOOL_NAMES, AGENT_TOOL_SPECS, AgentToolImage, AgentToolName, AgentToolSpec, BASH_DESCRIPTION, BASH_MAX_TIMEOUT_MS, BASH_MIN_TIMEOUT_MS (+16 more)

### Community 83 - "Agent Prompt History"
Cohesion: 0.17
Nodes (12): AgentHistoryStore, HISTORY_FILE, log, fill(), usePromptHistory(), AgentHistoryCursor, AgentHistoryEntry, HISTORY_IDLE (+4 more)

### Community 84 - "Agent Spend Tracking"
Cohesion: 0.17
Nodes (16): AgentSessionsTab(), sessionCost(), sessionCostTitle(), sessionLabel(), AgentSpendMeter(), formatUsd(), agentSessionsInUse(), addCost() (+8 more)

### Community 85 - "Socket Server Supervisor"
Cohesion: 0.13
Nodes (8): ErrorResponse, isRequest(), Request, Response, SocketServer, SuccessResponse, log, SocketSupervisor

### Community 86 - "Annotate & Search UI"
Cohesion: 0.14
Nodes (18): AnnotateModal(), AnnotateModalProps, looksLikeUrl(), AnnotateTab(), AnnotationDetail, timeAgo(), PaneEventDetailSchema, PiTab() (+10 more)

### Community 87 - "Terminal Background Settings"
Cohesion: 0.14
Nodes (16): NumberStepper(), SegmentedControl(), SliderInput(), BackgroundThumbnails(), ThumbnailGrid(), BgMode, deriveMode(), IMAGE_FILTERS (+8 more)

### Community 88 - "Agent Image Attachments"
Cohesion: 0.12
Nodes (18): completedEvent, errorBody, errorEvent, errorMessage(), generateImage(), ImageCallRequest, mimeOf(), oneShotBody (+10 more)

### Community 89 - "Chat Web Search Providers"
Cohesion: 0.15
Nodes (14): BRAVE_SCHEMA, BraveProvider, createWebSearchProvider(), ensureOk(), EXA_SCHEMA, ExaProvider, formatWebSearchResults(), stripHtml() (+6 more)

### Community 90 - "Copilot Window Lifecycle"
Cohesion: 0.14
Nodes (10): CopilotWindow, CopilotWindowStore, getDevBootstrapPath(), log, NOTE: Do NOT pass { visibleOnFullScreen: true } here — it triggers, findPaneForPid(), isClaudeInstalled(), log (+2 more)

### Community 92 - "Remote SSH Service"
Cohesion: 0.18
Nodes (10): guard(), log, registerRemoteSshIpcHandlers(), invalidateCached(), RemoteSshService, scratchDir(), DetectedHost, RemoteHost (+2 more)

### Community 93 - "Pi Settings UI"
Cohesion: 0.16
Nodes (18): PiAdvancedAccordion(), Props, PiPresetPicker(), Props, bedrockDot(), inferKind(), PiProvidersList(), Props (+10 more)

### Community 94 - "Renderer Hooks"
Cohesion: 0.13
Nodes (19): input, createdPtys, createTerminal(), draftInto(), drafts, flushDraft(), log, IMPORTANT: onScroll only fires for content-driven scroll (new lines added), (+11 more)

### Community 95 - "Env Var Expansion"
Cohesion: 0.21
Nodes (18): createTransport(), httpTransport(), resolved(), stdioTransport(), stringOnly(), expand(), expandArray(), expandRecord() (+10 more)

### Community 96 - "Copilot Session Store"
Cohesion: 0.13
Nodes (11): CopilotSessionStore, HookEvent, log, projectNameFromCwd(), statusToPhase(), log, PendingSocket, COPILOT_SOCKET_PATH (+3 more)

### Community 97 - "Layout Store"
Cohesion: 0.11
Nodes (5): containsPane(), LayoutStore, log, StoreSchema, stripPaneCmds()

### Community 98 - "Remote SSH Cache"
Cohesion: 0.19
Nodes (19): createLogger(), CacheMeta, CacheMetaSchema, cachePathFor(), cacheRoot(), clearHostCache(), commitCached(), ensureCacheDir() (+11 more)

### Community 99 - "Shell Env View"
Cohesion: 0.22
Nodes (16): log, PtyCreateOptions, PtyCreateResult, PtyEntry, clampSelection(), filterVars(), formatSpawnTime(), isSecret() (+8 more)

### Community 100 - "Motion & Overlays"
Cohesion: 0.11
Nodes (17): MarkdownContextMenu(), MarkdownContextMenuProps, Overlay(), OverlayProps, PiPlanModal(), PiPlanModalProps, ToastContainer(), ToolsConfigModal() (+9 more)

### Community 101 - "Agent OpenRouter Client"
Cohesion: 0.14
Nodes (17): registerAgentIpc(), excerpt(), log, resolveTitle(), sanitizeTitle(), SYSTEM_PROMPT, TitleInput, toTitleMessages() (+9 more)

### Community 102 - "Agent MCP Secret Types"
Cohesion: 0.10
Nodes (12): ClientInformation, defaultStore(), OAuthTokens, Options, SafeStorageLike, SecretScope, SecretsData, SecretStore (+4 more)

### Community 103 - "Chat Search & Backfill"
Cohesion: 0.13
Nodes (10): log, runChatBackfill(), sleep(), ChatSearchService, log, makeSnippet(), RowidRowSchema, DB_PATH (+2 more)

### Community 104 - "Chat Filesystem Tools"
Cohesion: 0.24
Nodes (19): assertReadablePath(), assertWritablePath(), credentialDenyRoots(), DENY_BASENAMES, isUnder(), norm(), realpathOrNearest(), buildMentionContext() (+11 more)

### Community 105 - "Env Sync S3 Client"
Cohesion: 0.20
Nodes (20): authFingerprint(), buildCredentials(), client(), clients, createBucket(), describeS3Error(), enrichMessage(), errorName() (+12 more)

### Community 106 - "Learnings Store"
Cohesion: 0.20
Nodes (6): log, runBackfill(), sleep(), registerLearningsIpcHandlers(), LearningsStore, Learning

### Community 107 - "Sidebar Chrome"
Cohesion: 0.16
Nodes (11): ColorPalettePicker(), ColorPalettePickerProps, clampSidebarWidth(), DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH_RATIO, MIN_SIDEBAR_WIDTH, logDnd, SidebarResizeHandle() (+3 more)

### Community 108 - "Agent MCP OAuth"
Cohesion: 0.20
Nodes (3): ManagerDeps, McpManager, messageOf()

### Community 110 - "Env Sync Secret Storage"
Cohesion: 0.12
Nodes (10): SecretsLike, defaultStore(), EnvSyncSecretsData, Options, SafeStorageLike, SecretsStore, StoredAuth, fakeSafe (+2 more)

### Community 111 - "Claude Pricing"
Cohesion: 0.20
Nodes (16): defaultCacheFile(), ensurePricesFresh(), loadCachedTable(), parsePriceTable(), writeCachedTable(), tmpDirs, BUNDLED_PRICES, ClaudeUsageInput (+8 more)

### Community 112 - "Config Text"
Cohesion: 0.21
Nodes (18): format(), formatEnv(), formatHeaders(), parseArgs(), parseEnv(), parseHeaders(), parsePairs(), parsePasted() (+10 more)

### Community 113 - "Visualizer Particles"
Cohesion: 0.11
Nodes (4): easeOutCubic(), Particle, ParticleSystem, WarpEffect

### Community 114 - "Learnings MCP Server"
Cohesion: 0.18
Nodes (10): BodyTooLargeError, GetArgs, LearningsMcpServer, log, readBody(), renderHit(), RpcRequest, RpcRequestSchema (+2 more)

### Community 115 - "Remote SSH Transfers"
Cohesion: 0.12
Nodes (15): ARGS, HOST, mocks, Props, formatBytes(), Props, TransferRow(), TransferStrip() (+7 more)

### Community 116 - "Space Canvas & Weather"
Cohesion: 0.16
Nodes (13): SpaceWeather, WeatherParticle, createThrottledLoop(), getDayNightBackground(), sizeCanvas(), SpaceCanvas(), SpaceCanvasProps, Tooltip (+5 more)

### Community 117 - "Activity Tracker"
Cohesion: 0.16
Nodes (6): ActivityTracker, ActivityTrackerOptions, log, PaneState, REMOTE_NAMES, SHELL_NAMES

### Community 118 - "Agent Bash Tool"
Cohesion: 0.15
Nodes (18): askedForATerminal(), Ending, execute(), HAS_A_TOOL, HEAD_CHARS, headline(), instead(), kill() (+10 more)

### Community 119 - "Env Sync Manager"
Cohesion: 0.27
Nodes (5): hashPlaintext(), resolveBucketRegion(), EnvSyncManager, EnvSyncTarget, SyncOutcome

### Community 120 - "Transcript Viewer"
Cohesion: 0.15
Nodes (12): DistillModal(), normalizeTags(), parseTags(), Phase, ClaudeMetaPanel(), formatClock(), formatCost(), formatDuration() (+4 more)

### Community 121 - "Space Renderer"
Cohesion: 0.22
Nodes (11): ACCENT_PALETTES, Ship, STATE_COLORS, getAnimState(), SpaceRenderer, TRAIL_RATES, getParentSprite(), getSubagentSprite() (+3 more)

### Community 122 - "Agent Store Tests"
Cohesion: 0.19
Nodes (15): activityApi, agentApi, ask(), calls(), catalogModel, compacted(), compacting(), emit() (+7 more)

### Community 123 - "Reported Activity"
Cohesion: 0.19
Nodes (6): ActivityReportDeps, levelForReported(), routeActivityReport(), Reported, ReportedActivity, ActivityState

### Community 124 - "Annotate Service"
Cohesion: 0.20
Nodes (5): NOTE: The IIFE source is stored as a string constant to avoid TypeScript, AnnotateService, cropRect(), writeResultFile(), ElementRect

### Community 125 - "Learnings MCP Registrar"
Cohesion: 0.18
Nodes (15): atomicWriteJson(), defaultPortFile(), learningsMcpEntry(), loadPreferredPort(), log, McpHttpEntry, mergeServerEntry(), ObjectSchema (+7 more)

### Community 126 - "Remote SSH Control"
Cohesion: 0.18
Nodes (13): buildSftpArgv(), buildSshArgv(), closeConnection(), controlDir(), controlPathFor(), log, run(), sharedOptions() (+5 more)

### Community 127 - "Markdown Preview & Attachments"
Cohesion: 0.18
Nodes (13): AgentAttachmentChip(), AgentMessageAttachments(), Pill(), pillLabel(), isMarkdownPath(), MARKDOWN_EXTENSIONS, MarkdownPreview, Props (+5 more)

### Community 128 - "Chat MCP Manager"
Cohesion: 0.19
Nodes (11): budgetResult(), CallResultSchema, ServerEntry, isMcpToolName(), McpConnectionState, McpServerConfig, McpServersConfig, McpServerStatus (+3 more)

### Community 130 - "Env Sync Modal"
Cohesion: 0.16
Nodes (13): AuthControl(), authSummary(), basename(), EnvSyncModal(), InitForm(), PassphraseControl(), primaryAction(), RepoAuthOverride() (+5 more)

### Community 131 - "Sessions Browser"
Cohesion: 0.21
Nodes (13): formatCost(), groupByProject(), isAgentFilter(), relativeTime(), SessionList(), SessionsTab(), View, SessionsTabCard() (+5 more)

### Community 132 - "Copilot Hook Installer"
Cohesion: 0.22
Nodes (14): buildHookEntries(), ClaudeSettings, DEFAULT_CLAUDE_DIR, getHookBinarySourcePath(), hasFleetHook(), HOOK_BINARY_NAME, HookEntry, install() (+6 more)

### Community 133 - "Shared Settings Types"
Cohesion: 0.14
Nodes (13): CopilotApi, PiState, UpdatesSection(), AiSettings, CopilotSettings, CopilotWorkspaceOverride, DeepPartial, ImageGenerationMode (+5 more)

### Community 134 - "File Editor Pane"
Cohesion: 0.20
Nodes (13): FileEditorPane(), flashField, flashRangeEffect, getLanguageName(), loadCodeMirrorLanguage(), Props, treeContainsPane(), writeRemote() (+5 more)

### Community 135 - "Markdown Pane & Find"
Cohesion: 0.18
Nodes (12): MarkdownFindBar(), MarkdownFindBarProps, MarkdownPane(), Props, ViewMode, PathChromeHeader(), Props, escapeRegExp() (+4 more)

### Community 136 - "Chat Secret Keys"
Cohesion: 0.19
Nodes (3): ChatSecrets, FakeData, WebSearchProviderId

### Community 137 - "Main Logger & Bridge"
Cohesion: 0.13
Nodes (12): BridgeEvent, BridgeRequest, BridgeResponse, log, RequestHandler, consoleFormat, electronApp, fileFormat (+4 more)

### Community 138 - "Notes Storage"
Cohesion: 0.24
Nodes (13): contextTag(), normalizeScope(), noteFile(), NoteIndex, NoteIndexSchema, noteKey(), readIndex(), readNote() (+5 more)

### Community 139 - "Pi Auth Inspector"
Cohesion: 0.19
Nodes (8): AuthMapSchema, log, PiAuthInspector, PiAuthInspectorOptions, PiModelCatalogModule, PublicModelSchema, BuiltInProviderStatus, ModelEntry

### Community 140 - "Sessions Service"
Cohesion: 0.26
Nodes (9): claudeProjectsDir(), listClaudeSessions(), registerSessionsIpcHandlers(), listRuneSessions(), readRuneSession(), runeSessionsDir(), SessionsService, SessionAgent (+1 more)

### Community 141 - "Rune Install & Status"
Cohesion: 0.25
Nodes (10): RuneInstallCommand(), installMessage(), RuneSection(), useRuneInstall(), useRuneStatus(), isAuthFailureText(), RUNE_INSTALL_COMMAND, RUNE_NOT_INSTALLED_MESSAGE (+2 more)

### Community 142 - "Pi Provider Ordering"
Cohesion: 0.18
Nodes (9): OrderedProviderRows, orderProviderRows(), PRIMARY_BUILTIN_IDS, ProviderRowInput, ProviderRowKind, dotClass, PiProviderRow(), PiProviderRowProps (+1 more)

### Community 143 - "MCP Import Lift"
Cohesion: 0.29
Nodes (10): bearerToken(), isSecret(), lift(), liftSecrets(), mask(), maskSecrets(), without(), safeStorage (+2 more)

### Community 144 - "Attention Signals"
Cohesion: 0.21
Nodes (12): flushOsNotifications(), raiseAlerts(), ActivityReportSchema, Alerts, alertsFor(), Attention, attentionOf(), channelsKeyFor() (+4 more)

### Community 145 - "Rune Manager"
Cohesion: 0.22
Nodes (7): execFileAsync, log, parseVersion(), RUNE_INSTALL_DIR, RuneManager, execFileMock, RuneInstallResult

### Community 146 - "Settings Store"
Cohesion: 0.20
Nodes (5): SettingsStore, DEFAULT_CHAT_SETTINGS, DEFAULT_SETTINGS, FleetSettings, FleetSettingsPatch

### Community 148 - "Agent Grep Tool"
Cohesion: 0.31
Nodes (12): clip(), compile(), contentResult(), count(), cutShort(), empty(), filesResult(), Match (+4 more)

### Community 149 - "General Settings & Fonts"
Cohesion: 0.21
Nodes (11): ACCENT_COLOR_OPTIONS, BUNDLED_FONTS, DARK_THEME_OPTIONS, FontFamilyPicker(), LIGHT_THEME_OPTIONS, parseFontSelection(), TERMINAL_THEME_OPTIONS, ShellProfilesState (+3 more)

### Community 151 - "Learnings Vector Extension"
Cohesion: 0.18
Nodes (8): LearningsStoreOptions, log, PendingEmbedding, toFtsQuery(), VecHit, loadVecExtension(), DB_PATH, TEST_DIR

### Community 152 - "Pane Activity Glyphs"
Cohesion: 0.26
Nodes (10): PaneStatusGlyph(), PaneStatusGlyphProps, activityBgClass(), activityBorderClass(), activityLiveness(), Hue, HUE_BG, HUE_BORDER (+2 more)

### Community 153 - "Chat MCP Client"
Cohesion: 0.24
Nodes (4): McpTool, Pending, ToolsListSchema, Transport

### Community 154 - "Copilot Service Lifecycle"
Cohesion: 0.31
Nodes (10): CopilotServiceState, drainPendingToggle(), initCopilot(), log, onCopilotSettingsChanged(), pruneDeadCopilotSessions(), startCopilotServices(), stopCopilot() (+2 more)

### Community 155 - "Learnings Distiller"
Cohesion: 0.35
Nodes (9): buildPrompt(), distillLearning(), ENGINE_ORDER, log, parseDraft(), runAgentOneShot(), serializeTranscript(), stripCodeFence() (+1 more)

### Community 156 - "Rune Config Editor"
Cohesion: 0.22
Nodes (8): RuneAdvancedAccordion(), Props, RuneSecretsForm(), LoadState, RuneSettingsEditor(), RUNE_SECRET_KEYS, RuneSecrets, RuneSecretsSchema

### Community 157 - "Chat Settings Nav & Search"
Cohesion: 0.29
Nodes (8): ChatSettingsNav(), SearchResults(), SECTION_BY_ID, CHAT_SETTINGS_INDEX, CHAT_SETTINGS_SECTIONS, ChatSettingsSection, SectionMeta, SettingsIndexEntry

### Community 158 - "Image Grid & Preview"
Cohesion: 0.24
Nodes (8): ImageGrid(), ImageGridProps, Thumbnail(), BackgroundPreview(), edgeFadeStyle(), FIT_STYLES, preloadImage(), toFleetImageUrl()

### Community 160 - "Edit Match"
Cohesion: 0.36
Nodes (9): applyEdit(), byTrimmedLines(), EditOutcome, indentOf(), indentShift(), indexesOf(), lineOf(), notFound() (+1 more)

### Community 161 - "Env File Parsing"
Cohesion: 0.38
Nodes (8): diffEnv(), EXCLUDE_DIRS, EXCLUDE_SUFFIXES, isCandidateName(), maskValue(), ParsedEnv, parseEnv(), scanCandidates()

### Community 162 - "Learnings Search"
Cohesion: 0.33
Nodes (6): LearningsSearchService, matchesFilter(), reciprocalRankFusion(), TEST_DIR, TEST_DIR, LearningSearchFilter

### Community 164 - "SSH Host Detect"
Cohesion: 0.36
Nodes (8): argvOf(), detectSshHost(), execFileAsync, log, parseSshArgv(), processTable(), VALUE_FLAGS, DetectedSshHost

### Community 165 - "Chat & Agent Markdown"
Cohesion: 0.27
Nodes (6): AgentMarkdown(), plugins, ChatMarkdown(), plugins, Props, sanitizeMarkdownUrl()

### Community 166 - "Chat Audit Log"
Cohesion: 0.27
Nodes (8): AuditLogView(), DECISION_CLASS, fmtTime(), ToolFilter, toolGroup(), ChatSettingsView(), ChatTab(), View

### Community 167 - "Agent MCP IPC"
Cohesion: 0.42
Nodes (8): forgetRemoved(), log, McpControl, McpIpcDeps, Picked, registerAgentMcpIpc(), rememberOAuth(), McpServersConfigSchema

### Community 168 - "Agent PDF Extraction"
Cohesion: 0.31
Nodes (5): clip(), extractPdfText(), bytes, ATTACHMENT_MAX_PDF_PAGES, ATTACHMENT_MAX_PDF_TEXT_CHARS

### Community 171 - "Rune Controls"
Cohesion: 0.31
Nodes (7): Props, Option, Options, RuneSelect(), RuneText(), RuneToggle(), toOptions()

### Community 172 - "Visualizer Nebula"
Cohesion: 0.33
Nodes (6): createCloudCanvas(), hexToRgb(), NEBULA_COLORS, NebulaCloud, NebulaSystem, randomCloud()

### Community 176 - "Clipboard Monitor"
Cohesion: 0.36
Nodes (6): getClipboardHistory(), history, makeEntry(), poll(), startClipboardMonitor(), ClipboardEntry

### Community 177 - "Fleet CLI Installer"
Cohesion: 0.36
Nodes (7): addFleetBinToShellProfile(), copyDirectoryRecursive(), installBundledCliArtifacts(), installFleetCLI(), installOpencodePlugin(), installSkillFile(), log

### Community 178 - "Chat MCP Servers Tab"
Cohesion: 0.46
Nodes (7): DOT, isRecord(), McpServersTab(), parseServers(), strArray(), strRecord(), toServerConfig()

### Community 181 - "Env Sync Crypto"
Cohesion: 0.67
Nodes (4): decrypt(), deriveKey(), encrypt(), scryptAsync

### Community 183 - "Pi Defaults Form"
Cohesion: 0.47
Nodes (5): parseThinkingLevel(), PiDefaultsForm(), Props, THINKING_LEVELS, PiThinkingLevel

### Community 186 - "Safe External URLs"
Cohesion: 0.80
Nodes (3): ALLOWED_PROTOCOLS, isSafeExternalUrl(), safeOpenExternal()

### Community 188 - "Workspace Path"
Cohesion: 0.60
Nodes (3): BootstrapWorkspaceOptions, normalizePath(), resolveBootstrapWorkspacePath()

### Community 189 - "Env D"
Cohesion: 0.50
Nodes (4): FleetApi, CSSProperties, react, Window

### Community 191 - "Image Service Test"
Cohesion: 0.50
Nodes (3): FLEET_IMAGES_DIR, GENERATIONS_DIR, TEST_HOME

## Knowledge Gaps
- **954 isolated node(s):** `TEST_DIR`, `CHAT_SKILLS_DIR`, `ctx`, `fakeCrypto`, `fakeSecrets` (+949 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createLogger()` connect `Remote SSH Cache` to `Chat Store & Persistence`, `Copilot Hook Installer`, `IPC Surface & Preload`, `Chat Skills Loader`, `Main Logger & Bridge`, `Pi Auth Inspector`, `Rune Manager`, `Agent MCP Runtime`, `Rune File Assist`, `Learnings Vector Extension`, `Agent Session Store`, `Claude Transcript Readers`, `Copilot Service Lifecycle`, `Learnings Distiller`, `WSL & Shell Profiles`, `Pi Env Injection`, `Main Process Bootstrap`, `SSH Host Detect`, `Fake Server`, `Agent MCP IPC`, `Agent Attachments`, `Worktrees & Cwd Polling`, `Fleet CLI Installer`, `Env Sync Config`, `Learnings Embedder`, `Annotation Store`, `Learnings IPC`, `Agent Image Store`, `Rune Config Manager`, `Pi Config Manager`, `Remote SSH Transfer`, `Agent Prompt History`, `Socket Server Supervisor`, `Copilot Window Lifecycle`, `Remote SSH Service`, `Env Var Expansion`, `Copilot Session Store`, `Layout Store`, `Shell Env View`, `Agent OpenRouter Client`, `Chat Search & Backfill`, `Learnings Store`, `Learnings MCP Server`, `Activity Tracker`, `Learnings MCP Registrar`, `Remote SSH Control`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `PiAgentManager` connect `Chat Skills Loader` to `Main Process Bootstrap`, `IPC Surface & Preload`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `RuneFileChatService` connect `Rune File Assist` to `Main Process Bootstrap`, `IPC Surface & Preload`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `TEST_DIR`, `CHAT_SKILLS_DIR`, `ctx` to the rest of the system?**
  _954 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Agent Service Core` be split into smaller, more focused modules?**
  _Cohesion score 0.04819277108433735 - nodes in this community are weakly interconnected._
- **Should `Copilot Window UI` be split into smaller, more focused modules?**
  _Cohesion score 0.05299608551641072 - nodes in this community are weakly interconnected._
- **Should `Chat Store & Persistence` be split into smaller, more focused modules?**
  _Cohesion score 0.047017543859649125 - nodes in this community are weakly interconnected._