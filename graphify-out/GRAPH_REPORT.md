# Graph Report - /Users/khangnguyen/Development/fleet/src  (2026-08-07)

## Corpus Check
- Large corpus: 883 files · ~782,569 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 5978 nodes · 15683 edges · 208 communities (191 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 94 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Kanban Board Contracts
- IPC Surface & Preload
- Env Sync Manager
- Chat Persistence & Search
- Kanban Board Store
- Agent Session Store
- Sidebar & Layout State
- Clipboard & File Overlays
- Kanban Command Surface
- Settings Store & Sections
- Chat Skills Loader
- Appearance Settings Controls
- Env File Editor
- Kanban Board UI
- Chat Composer & Persona
- Chat View & Conversations
- Agent MCP Import
- Chat Permission Manager
- Dashboard & Pane Chrome
- Kanban Git Workspace
- Agent Service Core
- Agent Todo Panel
- Chat Bash & FS Tools
- Command Palette & Overview
- Agent Renderer Store
- Chat Image Generation
- Notes & Fleet Bridge
- Kanban Agent Spawning
- App Shell & Shortcuts
- Agent Tool Definitions
- Agent Permission Model
- Chat Secrets & Web Search
- Kanban Dispatcher
- Main Process Bootstrap
- Agent OpenRouter Client
- Motion
- Backgroundlayer
- Agent MCP Runtime
- Learnings Embedder
- Agentthread
- Agent Types
- Agentfolderdialog
- Agent Git Watch
- Agent MCP Servers
- Learnings Store & Search
- Rune File Assist
- Remote Ssh Store
- Pi Env Injection
- Main Logger & Bridge
- Chat OpenRouter Client
- Chat Service Loop
- Kanban Store
- Agent MCP OAuth
- Copilot Window
- Transcriptview
- Image Service & Providers
- Claude Session Sources
- Panegrid
- Chat Web Fetch
- Tool Label
- Sprite Loader
- Agent Image Store
- Kanban MCP Server
- Agent Attachments
- Rune Assist Store
- Fal.ai Image Provider
- Modelpicker
- Rune Config Types
- Sshbrowserpane
- Env Sync Secrets
- Remote SSH Listing
- Agent Diff
- Rune Config Manager
- Copilot Renderer
- Provider Ordering
- Event Bus
- Path Platform
- Rune Session Source
- Copilot Mascots
- Agent MCP Registry
- Pi Config Manager
- Fake Oauth Server
- Recent Images
- Git Service
- Kanban Pipeline Templates
- Socket API & Commands
- Mcpserverrow
- Imagegrid
- Starfield
- Images
- Agent Models Catalog
- Copilot Session Store
- Remote SSH Transfer
- Pi Config Types
- Agent Prompt History
- Learnings IPC
- Fileeditorpane
- Cwd Poller
- Fleet CLI
- Use Chat Settings
- Renderer Hooks
- Ignore
- Artifact Files
- Remote SSH Service
- Expand
- Env Sync S3 Client
- Kanban Store
- Kanban Notifications
- PTY Manager
- Remote SSH Cache
- Activity Tracker
- Fake Server
- Claude Pricing
- Socket Server Supervisor
- Particles
- Chat MCP Client
- Copilot Conversation Reader
- WSL Service
- Spacecanvas
- Bash
- Kanban PM Autopilot
- Layout Store
- Learnings MCP Server
- Config Text
- Sessiontree
- Space Renderer
- File Search & Context
- Kanban Store
- Kanban PM Chat
- Learnings Distiller
- Learnings MCP Registrar
- Remote SSH Control
- Shell Env View
- Annotate Service
- Kanban Store
- Shell Profiles
- Gitchangesmodal
- Reported Activity
- Copilot Hook Installer
- Worktree Service
- Sessionlist
- Pidefaultsform
- Annotation Store
- Mcpserverstab
- Pi Auth Inspector
- Activity
- Rune
- Lift
- Manager
- Attention Signals
- Kanban Store
- Rune Manager
- Ships
- Grep
- Copilot Store
- Learnings Embed Service
- Stream Buffer
- Runecontrols
- Frecency
- Mcp Ipc Test
- Kanban Store
- SSH Host Detect
- Annotate Types
- Imageviewerpane
- Sections
- Aurora
- Edit Match
- Kanban PM Digest
- Kanban Store Test
- Chatmarkdown
- Auditlogview
- File Open
- Expand
- Pr Poller
- Notification Detector
- Worktree Service Test
- Permissionruleseditor
- Nebula
- Client Test
- Transport
- Safe Bash
- Pm Paths
- Kanban PM Agents
- Runesecretsform
- Transport
- Sandbox
- Env Sync Crypto
- Kanban Workspace Wsl Test
- Test Setup
- Workspace Path
- Env D
- Extensionssection
- Env Sync Secrets
- Image Service Test
- Mcp
- Proposal Commands Test
- Learnings Embed Worker
- Runtime Env
- Assets D

## God Nodes (most connected - your core abstractions)
1. `KanbanStore` - 184 edges
2. `KanbanCommands` - 100 edges
3. `registerKanbanIpc()` - 69 edges
4. `createLogger()` - 63 edges
5. `useWorkspaceStore` - 63 edges
6. `Task` - 59 edges
7. `registerIpcHandlers()` - 51 edges
8. `ChatStore` - 50 edges
9. `KanbanDispatcher` - 47 edges
10. `useSettingsStore` - 45 edges

## Surprising Connections (you probably didn't know these)
- `McpSection()` --indirect_call--> `config()`  [INFERRED]
  renderer/src/components/agent/settings/mcp/McpSection.tsx → main/agent/mcp/__tests__/auth.test.ts
- `expandRecord()` --indirect_call--> `v()`  [INFERRED]
  main/agent/mcp/expand.ts → renderer/src/__tests__/shell-env-view.test.ts
- `expandRecord()` --indirect_call--> `v()`  [INFERRED]
  main/chat/mcp/expand.ts → renderer/src/__tests__/shell-env-view.test.ts
- `runCLI()` --indirect_call--> `v()`  [INFERRED]
  main/fleet-cli.ts → renderer/src/__tests__/shell-env-view.test.ts
- `PreparedArtifact` --references--> `ArtifactKind`  [EXTRACTED]
  main/kanban/artifact-files.ts → shared/kanban-types.ts

## Import Cycles
- None detected.

## Communities (208 total, 17 thin omitted)

### Community 0 - "Kanban Board Contracts"
Cohesion: 0.04
Nodes (88): CreateDefaults, log, SWARM_MAX_WORKERS, ASSIGN_TOOLS, BoardScope, DECOMPOSE_TOOLS, JsonRpcRequest, log (+80 more)

### Community 1 - "IPC Surface & Preload"
Cohesion: 0.04
Nodes (94): collectDiagnosticsInfo(), openLogsFolder(), readRedactedLogTail(), redact(), FILE_LIST_IGNORE_DIRS, FileListEntry, IMAGE_MIME_TYPES, listFilesWsl() (+86 more)

### Community 2 - "Env Sync Manager"
Cohesion: 0.05
Nodes (67): diffEnv(), EXCLUDE_DIRS, EXCLUDE_SUFFIXES, hashPlaintext(), isCandidateName(), maskValue(), ParsedEnv, parseEnv() (+59 more)

### Community 3 - "Chat Persistence & Search"
Cohesion: 0.04
Nodes (52): Deps, registerChatIpc(), ChatSearchService, makeSnippet(), AUDIT_DECISIONS, AUDIT_STATUSES, AuditRowSchema, ChatStore (+44 more)

### Community 4 - "Kanban Board Store"
Cohesion: 0.03
Nodes (5): KanbanStore, prInfoFromRow(), TEST_DIR, SuggestionStatus, Task

### Community 5 - "Agent Session Store"
Cohesion: 0.05
Nodes (65): AgentSessionStore, isMissing(), log, readHead(), readSpend(), readWindow(), SESSIONS_DIR, AgentSessionsTab() (+57 more)

### Community 6 - "Sidebar & Layout State"
Cohesion: 0.05
Nodes (54): ColorPalettePicker(), ColorPalettePickerProps, clampSidebarWidth(), DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH_RATIO, MIN_SIDEBAR_WIDTH, getFirstDirtyPaneId(), getFirstLeaf() (+46 more)

### Community 7 - "Clipboard & File Overlays"
Cohesion: 0.07
Nodes (59): ClipboardHistoryOverlay(), ClipboardHistoryOverlayProps, formatTimestamp(), truncateLines(), addRecentFile(), FileSearchOverlay(), FileSearchOverlayProps, fileSearchResultSchema (+51 more)

### Community 8 - "Kanban Command Surface"
Cohesion: 0.08
Nodes (5): KanbanCommands, MANUAL_STATUSES, registerKanbanIpc(), executeProposal(), KanbanReviewActionResult

### Community 9 - "Settings Store & Sections"
Cohesion: 0.05
Nodes (47): SettingsStore, baseTask, AnnotateSection(), CopilotSection(), SYSTEM_SOUNDS, KANBAN_NOTIFY_LABELS, KanbanSection(), WORKSPACE_KINDS (+39 more)

### Community 10 - "Chat Skills Loader"
Cohesion: 0.05
Nodes (35): estimateTokens(), Frontmatter, isRecord(), listExtraFiles(), LoadedSkill, parseSkillMd(), scanSkillsDir(), parseSlashInvocation() (+27 more)

### Community 11 - "Appearance Settings Controls"
Cohesion: 0.06
Nodes (55): NumberStepper(), SegmentedControl(), SliderInput(), ACCENT_COLOR_OPTIONS, BUNDLED_FONTS, DARK_THEME_OPTIONS, FontFamilyPicker(), GeneralSection() (+47 more)

### Community 12 - "Env File Editor"
Cohesion: 0.06
Nodes (55): assertEnvName(), buildEnvEntry(), createEnvFile(), ENV_EXCLUDE_DIRS, ENV_MAX_DEPTH, EXCLUDE_DIRS, isEnvName(), isTemplateName() (+47 more)

### Community 13 - "Kanban Board UI"
Cohesion: 0.07
Nodes (49): ArtifactPreview(), KIND_ICON, ArtifactRow(), ArtifactsView(), groupByTaskRun(), KIND_OPTIONS, STATE_OPTIONS, TaskGroup (+41 more)

### Community 14 - "Chat Composer & Persona"
Cohesion: 0.05
Nodes (50): Attachment, Composer(), composerKeyAction, ComposerKeyEvent, Props, SlashCommand, slashMenu, PersonaPicker() (+42 more)

### Community 15 - "Chat View & Conversations"
Cohesion: 0.06
Nodes (46): ArtifactPanel(), EXT, ChatView(), Props, BUCKET_ORDER, bucketOf(), ConversationList(), relativeTime() (+38 more)

### Community 16 - "Agent MCP Import"
Cohesion: 0.06
Nodes (53): collect(), Entry, File, normalize(), ProjectFile, scanClaudeCode(), StringMap, DetectDeps (+45 more)

### Community 17 - "Chat Permission Manager"
Cohesion: 0.07
Nodes (32): Deps, Pending, PermissionEmitter, PermissionGrant, PermissionManager, PermissionRequest, escapeRegex(), evaluateExplicitPermission() (+24 more)

### Community 18 - "Dashboard & Pane Chrome"
Cohesion: 0.05
Nodes (49): ASCII_LINES, Dashboard(), DashboardProps, LINE_COLORS, ErrorBoundary, log, Props, State (+41 more)

### Community 19 - "Kanban Git Workspace"
Cohesion: 0.08
Nodes (55): DEFAULT_INTEGRATION_OPS, IntegrationOps, log, log, branchExists(), checkMergeConflicts(), classifyCheck(), cleanupTempWorktree() (+47 more)

### Community 20 - "Agent Service Core"
Cohesion: 0.07
Nodes (45): AgentEmitter, AgentService, CallContext, Deps, maxToolRounds(), mcpCaller(), textOnly(), toCompactMessages() (+37 more)

### Community 21 - "Agent Todo Panel"
Cohesion: 0.08
Nodes (47): ctx(), plan(), runTodoAdd(), runTodoUpdate(), AgentPane(), AgentView, EMPTY_TODOS, RefocusDetail (+39 more)

### Community 22 - "Chat Bash & FS Tools"
Cohesion: 0.06
Nodes (52): BashResult, runBash(), scrubEnv(), assertReadablePath(), assertWritablePath(), credentialDenyRoots(), DENY_BASENAMES, isUnder() (+44 more)

### Community 23 - "Command Palette & Overview"
Cohesion: 0.07
Nodes (45): AgentOverview(), AgentOverviewProps, Row, SUMMARIZABLE_STATES, URGENCY, CommandPalette(), CommandPaletteProps, paletteShortcut (+37 more)

### Community 24 - "Agent Renderer Store"
Cohesion: 0.08
Nodes (52): msg(), CompactionField(), percent(), addSpend(), AgentStoreState, appendReasoning(), appendText(), applySummary() (+44 more)

### Community 25 - "Chat Image Generation"
Cohesion: 0.07
Nodes (28): ARGS_SCHEMA, GENERATE_IMAGE_TOOL, parseGenerateImageArgs(), runGenerateImage(), ChatWorkspace, resolveOverride(), ChatImageStorage, EXT_BY_MIME (+20 more)

### Community 26 - "Notes & Fleet Bridge"
Cohesion: 0.05
Nodes (36): getClipboardHistory(), history, makeEntry(), poll(), startClipboardMonitor(), FleetBridgeServer, execAsync, hostContext() (+28 more)

### Community 27 - "Kanban Agent Spawning"
Cohesion: 0.07
Nodes (42): AgentHost, agentHostFor(), agentMcpConfigPosixPath(), agentMcpUrl(), AgentSpawn, AgentSpawnSpec, agentWslLocation, buildAgentSpawn() (+34 more)

### Community 28 - "App Shell & Shortcuts"
Cohesion: 0.07
Nodes (37): App(), killClosedTabPtys(), PiPlanModalEntry, PaneToolbar(), PaneToolbarProps, shortcutLabel(), SettingsTab(), ShortcutsHint() (+29 more)

### Community 29 - "Agent Tool Definitions"
Cohesion: 0.06
Nodes (42): checked(), images, parseArgs(), runAgentTool(), runMcp(), summarize(), REFUSED, runTerminal() (+34 more)

### Community 30 - "Agent Permission Model"
Cohesion: 0.08
Nodes (33): Deps, McpPermissionRequest, Pending, PermissionGate, PermissionGrant, PermissionRequest, emit, AgentPermissionRules (+25 more)

### Community 31 - "Chat Secrets & Web Search"
Cohesion: 0.06
Nodes (22): ChatSecrets, defaultStore(), KeyStore, Options, SafeStorageLike, SecretsData, FakeData, BRAVE_SCHEMA (+14 more)

### Community 32 - "Kanban Dispatcher"
Cohesion: 0.13
Nodes (4): DispatcherDeps, KanbanDispatcher, makeVerifyingTask(), task()

### Community 33 - "Main Process Bootstrap"
Cohesion: 0.05
Nodes (40): activityTracker, annotateService, ANNOTATIONS_DIR, annotationStore, createWindow(), cwdPoller, envSyncManager, envSyncSecrets (+32 more)

### Community 34 - "Agent OpenRouter Client"
Cohesion: 0.07
Nodes (39): registerAgentIpc(), searchMentionFiles(), chunkSchema, collectToolCalls(), completeOnce(), CompletionRequest, completionSchema, errorMessage() (+31 more)

### Community 35 - "Motion"
Cohesion: 0.06
Nodes (38): ConflictTarget, ConflictTargetSchema, EnvSyncConflictDialog(), AuthControl(), PassphraseControl(), CopyDocMenu(), CopyDocMenuProps, MarkdownContextMenu() (+30 more)

### Community 36 - "Backgroundlayer"
Cohesion: 0.09
Nodes (34): AnnotateModal(), AnnotateModalProps, looksLikeUrl(), AnnotateTab(), AnnotationDetail, timeAgo(), BackgroundLayer(), BackgroundLayerProps (+26 more)

### Community 37 - "Agent MCP Runtime"
Cohesion: 0.07
Nodes (24): alreadyAuthorized(), AuthDeps, liftedFields(), log, resolveAuth(), signIn(), Callback, CALLBACK_URLS (+16 more)

### Community 38 - "Learnings Embedder"
Cohesion: 0.07
Nodes (20): log, runChatBackfill(), sleep(), DB_PATH, seedAndEmbed(), TEST_DIR, log, runBackfill() (+12 more)

### Community 39 - "Agentthread"
Cohesion: 0.08
Nodes (31): AgentPermissionRow(), args(), spoken(), Composer(), EMPTY_PARTIALS, EMPTY_TODOS, Message(), ReasoningBlock() (+23 more)

### Community 40 - "Agent Types"
Cohesion: 0.08
Nodes (30): clip(), extractPdfText(), bytes, AgentContextMeter(), AgentImageSettings(), AgentRoleSettings(), ModelFacts(), OptionPills() (+22 more)

### Community 41 - "Agentfolderdialog"
Cohesion: 0.07
Nodes (29): AgentAttachmentChip(), AgentMessageAttachments(), Pill(), pillLabel(), AgentFolderDialog(), AgentFolderDialogProps, Choice, Listing (+21 more)

### Community 42 - "Agent Git Watch"
Cohesion: 0.10
Nodes (26): exists(), readCapped(), readGitHead(), readGitHeadAt(), readOperation(), resolveGitDir(), AgentGitWatcher, Entry (+18 more)

### Community 43 - "Agent MCP Servers"
Cohesion: 0.07
Nodes (14): AgentMcpSecrets, ClientInformation, defaultStore(), OAuthTokens, Options, parse(), SafeStorageLike, SecretScope (+6 more)

### Community 44 - "Learnings Store & Search"
Cohesion: 0.10
Nodes (18): log, LearningsStore, LearningsStoreOptions, log, PendingEmbedding, toFtsQuery(), VecHit, LearningsSearchService (+10 more)

### Community 45 - "Rune File Assist"
Cohesion: 0.11
Nodes (28): isAuthFailureText(), registerRuneAssistIpc(), ActiveTurn, CwdChat, log, RuneFileChatService, RuneFileChatServiceOptions, sessionsFileSchema (+20 more)

### Community 46 - "Remote Ssh Store"
Cohesion: 0.06
Nodes (27): ARGS, HOST, mocks, entryIcon(), Props, RowActions, Props, applySort() (+19 more)

### Community 47 - "Pi Env Injection"
Cohesion: 0.08
Nodes (25): BEARER_MODE_UNSETS, defaultStore(), EnvInjectionStore, InjectedEnv, KEYS_MODE_UNSETS, log, PiEnvInjectionManager, PiEnvInjectionManagerOptions (+17 more)

### Community 48 - "Main Logger & Bridge"
Cohesion: 0.06
Nodes (29): ElementScreenshot, log, PendingRequest, CodedError, toError(), BridgeEvent, BridgeRequest, BridgeResponse (+21 more)

### Community 49 - "Chat OpenRouter Client"
Cohesion: 0.10
Nodes (23): fallbackTitle(), generateTitle(), resolveTitle(), sanitizeTitle(), generateTags(), resolveTags(), sanitizeTags(), APP_HEADERS (+15 more)

### Community 50 - "Chat Service Loop"
Cohesion: 0.10
Nodes (24): addUsage(), ChatEmitter, ChatService, createThinkSplitter(), Deps, isFilePart(), NamingConfig, parseDataUrl() (+16 more)

### Community 51 - "Kanban Store"
Cohesion: 0.08
Nodes (15): SpawnWorkerArgs, WorkerExit, scratchWorkspace(), seedPipeline(), TEST_DIR, featureReviewTask(), reviewable(), reviewing() (+7 more)

### Community 52 - "Agent MCP OAuth"
Cohesion: 0.10
Nodes (19): asParameters(), budget(), HttpStatus, log, ManagerDeps, McpManager, messageOf(), readResult() (+11 more)

### Community 53 - "Copilot Window"
Cohesion: 0.09
Nodes (23): CopilotWindow, CopilotWindowStore, getDevBootstrapPath(), log, NOTE: Do NOT pass { visibleOnFullScreen: true } here — it triggers, CopilotServiceState, drainPendingToggle(), initCopilot() (+15 more)

### Community 54 - "Transcriptview"
Cohesion: 0.10
Nodes (28): LearningsBrowser(), relativeTime(), searchModeBadge(), formatCost(), groupByProject(), isAgentFilter(), relativeTime(), SessionList() (+20 more)

### Community 55 - "Image Service & Providers"
Cohesion: 0.14
Nodes (6): ImageProvider, generateId(), ImageService, isImageGenerationMeta(), ImageGenerationMeta, ImageProviderSettings

### Community 56 - "Claude Session Sources"
Cohesion: 0.10
Nodes (27): aggregateClaudeUsage(), assistantLineSchema, buildClaudeSummary(), CachedSummary, ClaudeAggregate, claudeCostFields(), claudeMessagesToTranscriptMessages(), claudePreview() (+19 more)

### Community 57 - "Panegrid"
Cohesion: 0.08
Nodes (33): AbsoluteResizeHandle(), AbsoluteResizeHandleProps, addCV(), calcToPixels(), CalcValue, computeLayout(), cv(), HandleEntry (+25 more)

### Community 58 - "Chat Web Fetch"
Cohesion: 0.10
Nodes (29): BlockedUrlError, capResult(), concat(), extractContent(), Extracted, FetchedPage, fetchPage(), HTML_TYPES (+21 more)

### Community 59 - "Tool Label"
Cohesion: 0.11
Nodes (22): AgentImage(), AgentImagePreview(), AgentToolRow(), DiffBody(), LINE_STYLES, createdBody(), diffBody(), imageBody() (+14 more)

### Community 60 - "Sprite Loader"
Cohesion: 0.10
Nodes (20): Asteroid, ASTEROID_KEYS, AsteroidField, BloomPass, BODY_KINDS, BODY_SPRITES, BodyKind, CelestialBodies (+12 more)

### Community 61 - "Agent Image Store"
Cohesion: 0.10
Nodes (20): AGENT_ATTACHMENTS_DIR, AGENT_IMAGES_DIR, AgentImageStore, EXT_BY_MIME, log, within(), formatCost(), IMAGE_EXTENSIONS (+12 more)

### Community 62 - "Kanban MCP Server"
Cohesion: 0.10
Nodes (10): readArtifactPreview(), KanbanMcpServer, RunScope, toolsForMode(), makeServer(), scope, call(), register() (+2 more)

### Community 63 - "Agent Attachments"
Cohesion: 0.12
Nodes (28): attachmentWireParts(), imageBytes(), imageWireParts(), log, mentionText(), pdfText(), readOnlyContext(), readPdf() (+20 more)

### Community 64 - "Rune Assist Store"
Cohesion: 0.10
Nodes (23): Props, RuneAnswerPopover(), Props, RuneAssistLayer(), Props, RuneAssistOverlay(), Props, RuneWorkingPill() (+15 more)

### Community 65 - "Fal.ai Image Provider"
Cohesion: 0.12
Nodes (18): ImageActionConfig, ImageActionInfo, toActionInfo(), FalAiProvider, isEditOpts(), isRecord(), parseActionSettings(), EditOpts (+10 more)

### Community 66 - "Modelpicker"
Cohesion: 0.18
Nodes (15): MaxToolRoundsField(), SystemPromptField(), ModelPicker(), Props, inputCls, selectCls, Field(), FieldGroup() (+7 more)

### Community 67 - "Rune Config Types"
Cohesion: 0.10
Nodes (29): activeProviderLabel(), isRuneProvider(), numOptions(), profileDisplayName(), Props, RuneGeneralForm(), RUNE_ACTIVITY_MODES, RUNE_COMPACT_THRESHOLDS (+21 more)

### Community 68 - "Sshbrowserpane"
Cohesion: 0.10
Nodes (22): Crumb, toCrumbs(), Props, RemoteBreadcrumbs(), Props, RemoteDeleteDialog(), RemoteEntryList, NameRequest (+14 more)

### Community 69 - "Env Sync Secrets"
Cohesion: 0.09
Nodes (7): defaultStore(), EnvSyncSecrets, EnvSyncSecretsData, SecretsStore, fakeSafe, FakeStore, v()

### Community 70 - "Remote SSH Listing"
Cohesion: 0.16
Nodes (25): describeSshFailure(), execSsh(), hostKey(), testConnection(), buildRecursiveDeletePlan(), deletePlanToBatch(), listRecursive(), parseDeletePlan() (+17 more)

### Community 71 - "Agent Diff"
Cohesion: 0.17
Nodes (23): diffReport(), runEdit(), remember(), requireFresh(), seen, Stamp, checkEditableSize(), readTextFile() (+15 more)

### Community 72 - "Rune Config Manager"
Cohesion: 0.12
Nodes (13): deepMerge(), extractZodIssues(), isPlainObject(), log, messageOf(), resolveRuneDir(), RuneConfigManager, RuneConfigManagerOptions (+5 more)

### Community 73 - "Copilot Renderer"
Cohesion: 0.13
Nodes (18): ChatMessageItem(), MODE_TOOLS, renderToolUse(), ToolUseBlock(), Badge, BadgeProps, badgeVariants, Button (+10 more)

### Community 74 - "Provider Ordering"
Cohesion: 0.13
Nodes (21): OrderedProviderRows, orderProviderRows(), PRIMARY_BUILTIN_IDS, ProviderRowInput, ProviderRowKind, PiPresetPicker(), Props, dotClass (+13 more)

### Community 75 - "Event Bus"
Cohesion: 0.12
Nodes (8): EventBus, EventMap, FleetEvent, PERMISSION_PATTERNS, PermissionLatch, NotificationRecord, NotificationStateManager, PRIORITY

### Community 76 - "Path Platform"
Cohesion: 0.14
Nodes (23): checkoutBranchWorktree(), worktreeRootFor(), FleetProtocolPath, parseFleetUrl(), formatSize(), getBasename(), PdfViewerPane(), PdfViewerPaneProps (+15 more)

### Community 77 - "Rune Session Source"
Cohesion: 0.11
Nodes (26): activePath(), buildTree(), CachedSummary, __clearRuneSummaryCache(), contentBlockSchema, firstUserText(), mapSubagents(), mapUsage() (+18 more)

### Community 78 - "Copilot Mascots"
Cohesion: 0.15
Nodes (22): App(), TeleportPhase, getSpriteSheet(), validIds, AskUserQuestionBlock(), CrtFrame(), AnimationPreview(), MascotPicker() (+14 more)

### Community 79 - "Agent MCP Registry"
Cohesion: 0.07
Nodes (27): enabled, headers, type, url, command, type, FS_ROOT, enabled (+19 more)

### Community 80 - "Pi Config Manager"
Cohesion: 0.13
Nodes (9): extractZodIssues(), log, messageOf(), PiConfigManager, PiConfigManagerOptions, PiConfigParseError, PiConfigValidationError, PiModelsFileSchema (+1 more)

### Community 81 - "Fake Oauth Server"
Cohesion: 0.10
Nodes (19): RFC-7591, RFC-9728, config(), safeStorage, RFC-9207, approve(), body(), FakeOAuthServer (+11 more)

### Community 82 - "Recent Images"
Cohesion: 0.13
Nodes (22): BoundedStdout, captureBoundedStdout(), MAX_STDOUT_CHARS, buildFallbackCommand(), buildRgCommand(), grepFiles(), isWslContext(), killActive() (+14 more)

### Community 83 - "Git Service"
Cohesion: 0.17
Nodes (15): GitService, isWslCtx(), parseNumstat(), parseNumstatWithRename(), parsePorcelainV1(), resolveStatus(), ExecResult, mockExecInContext (+7 more)

### Community 84 - "Kanban Pipeline Templates"
Cohesion: 0.13
Nodes (18): FULL_FEATURE, getTemplate(), MAX_FANOUT, PipelineTemplate, QA_ATTEMPT_CAP, QUICK_FIX, ExpanderDeps, expandTemplate() (+10 more)

### Community 85 - "Socket API & Commands"
Cohesion: 0.12
Nodes (9): isSocketCommand(), SocketApi, SocketCommand, SocketCommandHandler, SocketResponse, FleetCommandHandler, sendCommand(), sendRaw() (+1 more)

### Community 86 - "Mcpserverrow"
Cohesion: 0.12
Nodes (19): McpDraft, FoundRow(), Group, groupByFile(), keyOf(), McpImportDialog(), SOURCE_LABEL, McpSection() (+11 more)

### Community 87 - "Imagegrid"
Cohesion: 0.11
Nodes (19): DetailImage(), ImageDetail(), ImageDetailProps, ImageGallery(), View, ImageGrid(), ImageGridProps, Thumbnail() (+11 more)

### Community 88 - "Starfield"
Cohesion: 0.12
Nodes (12): buildFillStyleEntry(), fillStyleLUT, getTwinkleFillStyle(), LAYER_CONFIGS, makeCachedFillStyle(), makeStar(), randomStarColor(), randomTwinkle() (+4 more)

### Community 89 - "Images"
Cohesion: 0.12
Nodes (19): completedEvent, errorBody, errorEvent, errorMessage(), generateImage(), ImageCallRequest, mimeOf(), oneShotBody (+11 more)

### Community 90 - "Agent Models Catalog"
Cohesion: 0.12
Nodes (15): AgentModelCatalog, cacheSchema, catalogResponseSchema, ModelDefaults, modelSchema, NO_DEFAULTS, openRouterDefaultsSchema, reasoningOptionSchema (+7 more)

### Community 91 - "Copilot Session Store"
Cohesion: 0.12
Nodes (8): CopilotSessionStore, HookEvent, log, projectNameFromCwd(), statusToPhase(), CopilotSocketServer, CopilotPendingPermission, CopilotSessionPhase

### Community 92 - "Remote SSH Transfer"
Cohesion: 0.19
Nodes (19): execSftpBatch(), sftpQuote(), assertSftpOk(), sftpBatchRemove(), sftpGet(), sftpMkdir(), sftpPut(), sftpPutAtomic() (+11 more)

### Community 93 - "Pi Config Types"
Cohesion: 0.13
Nodes (22): KindMeta, KINDS, metaFor(), PiApiKeyInput(), Props, PiModelsEditor(), Props, APIS (+14 more)

### Community 94 - "Agent Prompt History"
Cohesion: 0.17
Nodes (12): AgentHistoryStore, HISTORY_FILE, log, fill(), usePromptHistory(), AgentHistoryCursor, AgentHistoryEntry, HISTORY_IDLE (+4 more)

### Community 95 - "Learnings IPC"
Cohesion: 0.15
Nodes (20): dateStamp(), dirSize(), handle(), IpcError, log, registerLearningsIpcHandlers(), reqString(), validateCreateInput() (+12 more)

### Community 96 - "Fileeditorpane"
Cohesion: 0.13
Nodes (20): FileEditorPane(), flashField, flashRangeEffect, getLanguageName(), loadCodeMirrorLanguage(), Props, treeContainsPane(), writeRemote() (+12 more)

### Community 97 - "Cwd Poller"
Cohesion: 0.11
Nodes (9): CwdPoller, readProcCwd(), log, PtyCreateOptions, PtyCreateResult, PtyEntry, getDefaultShell(), hasWSL() (+1 more)

### Community 98 - "Fleet CLI"
Cohesion: 0.20
Nodes (17): CLIResponse, COMMAND_MAP, FleetCLI, formatTable(), formatWatchEvent(), getHelpText(), HELP_GROUPS, isCLIResponse() (+9 more)

### Community 99 - "Use Chat Settings"
Cohesion: 0.15
Nodes (16): SECTION_COMPONENTS, PersonaManager(), ChatSettingsProvider(), ComposerSection(), ConversationsSection(), DangerZoneSection(), ModelsSection(), PersonasSection() (+8 more)

### Community 100 - "Renderer Hooks"
Cohesion: 0.13
Nodes (19): input, createdPtys, createTerminal(), draftInto(), drafts, flushDraft(), log, IMPORTANT: onScroll only fires for content-driven scroll (new lines added), (+11 more)

### Community 101 - "Ignore"
Cohesion: 0.17
Nodes (18): forgetAllFiles(), escapeLiteral(), globMatcher(), translate(), runGlob(), ALWAYS_SKIPPED, ignoreDecision(), IgnoreRule (+10 more)

### Community 102 - "Artifact Files"
Cohesion: 0.15
Nodes (19): ArtifactPreview, assertContained(), CODE_EXT, copyFromFd(), DATA_EXT, DOCUMENT_EXT, guessKind(), isSecretPath() (+11 more)

### Community 103 - "Remote SSH Service"
Cohesion: 0.19
Nodes (8): guard(), log, registerRemoteSshIpcHandlers(), RemoteSshService, scratchDir(), TransferEmit, RemoteHost, RemoteTransferRequest

### Community 104 - "Expand"
Cohesion: 0.21
Nodes (18): expand(), expandArray(), expandRecord(), expandVars(), Expansion, MissingVar, missingVars(), createTransport() (+10 more)

### Community 105 - "Env Sync S3 Client"
Cohesion: 0.20
Nodes (20): authFingerprint(), buildCredentials(), client(), clients, createBucket(), describeS3Error(), enrichMessage(), errorName() (+12 more)

### Community 106 - "Kanban Store"
Cohesion: 0.13
Nodes (5): buildRetroBriefing(), FRICTION_EVENTS, feature(), Feature, TaskRun

### Community 107 - "Kanban Notifications"
Cohesion: 0.16
Nodes (13): BufferItem, COUNT_WORD, KanbanNotificationPayload, KanbanNotifier, KanbanNotifierDeps, LABEL, PRIORITY, REVIEW_GATE_PASS_KINDS (+5 more)

### Community 109 - "Remote SSH Cache"
Cohesion: 0.21
Nodes (19): CacheMeta, CacheMetaSchema, cachePathFor(), cacheRoot(), clearHostCache(), commitCached(), ensureCacheDir(), evictIfNeeded() (+11 more)

### Community 110 - "Activity Tracker"
Cohesion: 0.15
Nodes (6): ActivityTracker, ActivityTrackerOptions, log, PaneState, REMOTE_NAMES, SHELL_NAMES

### Community 111 - "Fake Server"
Cohesion: 0.16
Nodes (16): asMessage(), asRecord(), fakeServer, FakeServerOptions, hangingTransport(), refusingTransport(), DELETE, managerOver() (+8 more)

### Community 112 - "Claude Pricing"
Cohesion: 0.20
Nodes (16): defaultCacheFile(), ensurePricesFresh(), loadCachedTable(), parsePriceTable(), writeCachedTable(), tmpDirs, BUNDLED_PRICES, ClaudeUsageInput (+8 more)

### Community 113 - "Socket Server Supervisor"
Cohesion: 0.15
Nodes (3): isRequest(), SocketServer, SocketSupervisor

### Community 114 - "Particles"
Cohesion: 0.11
Nodes (4): easeOutCubic(), Particle, ParticleSystem, WarpEffect

### Community 115 - "Chat MCP Client"
Cohesion: 0.16
Nodes (6): McpClient, McpTool, Pending, ResponseSchema, ToolsListSchema, Transport

### Community 116 - "Copilot Conversation Reader"
Cohesion: 0.17
Nodes (11): applyTranscriptLine(), ConversationReader, cwdToProjectDir(), formatToolInputPreview(), log, parseClaudeTranscript(), parseMessageLine(), sessionFilePath() (+3 more)

### Community 117 - "WSL Service"
Cohesion: 0.16
Nodes (10): decodeWslOutput(), defaultExec(), log, mapState(), parseListQuiet(), parseListVerbose(), WslExec, WslService (+2 more)

### Community 118 - "Spacecanvas"
Cohesion: 0.16
Nodes (13): SpaceWeather, WeatherParticle, createThrottledLoop(), getDayNightBackground(), sizeCanvas(), SpaceCanvas(), SpaceCanvasProps, Tooltip (+5 more)

### Community 119 - "Bash"
Cohesion: 0.15
Nodes (18): askedForATerminal(), Ending, execute(), HAS_A_TOOL, HEAD_CHARS, headline(), instead(), kill() (+10 more)

### Community 120 - "Kanban PM Autopilot"
Cohesion: 0.19
Nodes (7): BoardBatch, buildEventBriefing(), isCronDue(), PmAutopilot, PmAutopilotConfig, PmAutopilotDeps, TRIGGER_KINDS

### Community 121 - "Layout Store"
Cohesion: 0.13
Nodes (5): containsPane(), LayoutStore, log, StoreSchema, stripPaneCmds()

### Community 122 - "Learnings MCP Server"
Cohesion: 0.19
Nodes (10): BodyTooLargeError, GetArgs, LearningsMcpServer, log, readBody(), renderHit(), RpcRequest, RpcRequestSchema (+2 more)

### Community 123 - "Config Text"
Cohesion: 0.25
Nodes (16): format(), formatEnv(), formatHeaders(), parseArgs(), parseEnv(), parseHeaders(), parsePairs(), parsePasted() (+8 more)

### Community 124 - "Sessiontree"
Cohesion: 0.20
Nodes (12): connectorPrefix(), formatTime(), NodeRow(), SessionTree(), TREE, flattenTree(), indexById(), pathIds() (+4 more)

### Community 125 - "Space Renderer"
Cohesion: 0.22
Nodes (11): ACCENT_PALETTES, Ship, STATE_COLORS, getAnimState(), SpaceRenderer, TRAIL_RATES, getParentSprite(), getSubagentSprite() (+3 more)

### Community 126 - "File Search & Context"
Cohesion: 0.22
Nodes (15): buildCommand(), isWslContext(), killActive(), processResults(), searchFiles(), statResult(), buildContextArgv(), execInContext() (+7 more)

### Community 128 - "Kanban PM Chat"
Cohesion: 0.24
Nodes (3): PmChatService, QueuedTurn, PmTurnOrigin

### Community 129 - "Learnings Distiller"
Cohesion: 0.18
Nodes (14): buildPrompt(), distillLearning(), ENGINE_ORDER, log, parseDraft(), runAgentOneShot(), serializeTranscript(), stripCodeFence() (+6 more)

### Community 130 - "Learnings MCP Registrar"
Cohesion: 0.18
Nodes (15): atomicWriteJson(), defaultPortFile(), learningsMcpEntry(), loadPreferredPort(), log, McpHttpEntry, mergeServerEntry(), ObjectSchema (+7 more)

### Community 131 - "Remote SSH Control"
Cohesion: 0.18
Nodes (13): buildSftpArgv(), buildSshArgv(), closeConnection(), controlDir(), controlPathFor(), log, run(), sharedOptions() (+5 more)

### Community 132 - "Shell Env View"
Cohesion: 0.31
Nodes (12): clampSelection(), filterVars(), formatSpawnTime(), isSecret(), matchesQuery(), SECTIONS, varsForSection(), ShellEnvModal() (+4 more)

### Community 133 - "Annotate Service"
Cohesion: 0.22
Nodes (4): NOTE: The IIFE source is stored as a string constant to avoid TypeScript, AnnotateService, cropRect(), writeResultFile()

### Community 134 - "Kanban Store"
Cohesion: 0.23
Nodes (3): parseVerifyCommands(), VERIFY_COMMANDS_SCHEMA, Project

### Community 135 - "Shell Profiles"
Cohesion: 0.19
Nodes (6): defaultFileExists(), RegistryDeps, ShellProfileRegistry, freshStore(), listMock, ShellProfile

### Community 136 - "Gitchangesmodal"
Cohesion: 0.15
Nodes (11): DiffHighlighterInstance, getLanguageFromFilename(), GitChangesModal(), GitChangesModalProps, ParsedFileDiff, parseDiffToFiles(), parseUnifiedDiff(), STATUS_COLORS (+3 more)

### Community 137 - "Reported Activity"
Cohesion: 0.20
Nodes (5): ActivityReportDeps, levelForReported(), routeActivityReport(), Reported, ReportedActivity

### Community 138 - "Copilot Hook Installer"
Cohesion: 0.22
Nodes (14): buildHookEntries(), ClaudeSettings, DEFAULT_CLAUDE_DIR, getHookBinarySourcePath(), hasFleetHook(), HOOK_BINARY_NAME, HookEntry, install() (+6 more)

### Community 139 - "Worktree Service"
Cohesion: 0.28
Nodes (9): ADJECTIVES, generateWorktreeName(), getHomeDir(), getRepoName(), isWslCtx(), log, NOUNS, WorktreeService (+1 more)

### Community 140 - "Sessionlist"
Cohesion: 0.21
Nodes (12): BadgeStatus, elapsed(), SessionList(), sessionStatus(), sortSessions(), statusLabel(), formatPermissionSummary(), PermissionSummary (+4 more)

### Community 141 - "Pidefaultsform"
Cohesion: 0.19
Nodes (12): PiAdvancedAccordion(), Props, parseThinkingLevel(), PiDefaultsForm(), Props, THINKING_LEVELS, LoadState, PiWelcomeStrip() (+4 more)

### Community 142 - "Annotation Store"
Cohesion: 0.22
Nodes (6): AnnotationScreenshot, AnnotationStore, log, TEST_DIR, AnnotationResult, AnnotationMeta

### Community 143 - "Mcpserverstab"
Cohesion: 0.22
Nodes (12): DOT, isRecord(), McpServersTab(), parseServers(), strArray(), strRecord(), toServerConfig(), McpConnectionState (+4 more)

### Community 144 - "Pi Auth Inspector"
Cohesion: 0.19
Nodes (8): AuthMapSchema, log, PiAuthInspector, PiAuthInspectorOptions, PiModelCatalogModule, PublicModelSchema, BuiltInProviderStatus, ModelEntry

### Community 145 - "Activity"
Cohesion: 0.28
Nodes (9): agentPhase, formatElapsed(), PHASE_LABEL, phaseShimmers(), reasoningLabel(), AgentActivity(), useElapsed(), AgentMessage (+1 more)

### Community 146 - "Rune"
Cohesion: 0.30
Nodes (9): RuneMissingBanner(), RuneInstallCommand(), installMessage(), RuneSection(), useRuneInstall(), useRuneStatus(), RUNE_REPO_URL, RuneInstallResult (+1 more)

### Community 147 - "Lift"
Cohesion: 0.29
Nodes (10): bearerToken(), isSecret(), lift(), liftSecrets(), mask(), maskSecrets(), without(), safeStorage (+2 more)

### Community 148 - "Manager"
Cohesion: 0.19
Nodes (5): budgetResult(), CallResultSchema, McpManager, McpServersConfig, namespacedToolName()

### Community 149 - "Attention Signals"
Cohesion: 0.21
Nodes (12): flushOsNotifications(), raiseAlerts(), ActivityReportSchema, Alerts, alertsFor(), Attention, attentionOf(), channelsKeyFor() (+4 more)

### Community 150 - "Kanban Store"
Cohesion: 0.25
Nodes (3): removeAttachmentFile(), appendArtifactReference(), TaskAttachment

### Community 151 - "Rune Manager"
Cohesion: 0.21
Nodes (7): execFileAsync, log, parseVersion(), RUNE_INSTALL_DIR, RuneManager, execFileMock, RUNE_INSTALL_COMMAND

### Community 153 - "Grep"
Cohesion: 0.31
Nodes (12): clip(), compile(), contentResult(), count(), cutShort(), empty(), filesResult(), Match (+4 more)

### Community 154 - "Copilot Store"
Cohesion: 0.20
Nodes (8): CopilotApi, createLogger(), CopilotStoreState, CopilotView, log, Window, CopilotSession, CopilotSettings

### Community 156 - "Stream Buffer"
Cohesion: 0.20
Nodes (5): iconFor(), STATUS_BADGE, ToolCallView(), StreamBuffer, ChatToolCallStatus

### Community 157 - "Runecontrols"
Cohesion: 0.23
Nodes (9): Props, Option, Options, RuneSelect(), RuneText(), RuneToggle(), toOptions(), Props (+1 more)

### Community 158 - "Frecency"
Cohesion: 0.30
Nodes (8): decayedScore(), FrecencyEntry, FrecencyMap, rankIds(), recordUse(), CommandFrecencyStore, FrecencyMapSchema, load()

### Community 159 - "Mcp Ipc Test"
Cohesion: 0.22
Nodes (8): call(), handlers, HTTP, snapshot(), SnapshotShape, StatusShape, McpServerStatus, McpSnapshot

### Community 160 - "Kanban Store"
Cohesion: 0.29
Nodes (3): deriveBoardSlug(), isValidBoardSlug(), Board

### Community 161 - "SSH Host Detect"
Cohesion: 0.31
Nodes (9): argvOf(), DetectedHost, detectSshHost(), execFileAsync, log, parseSshArgv(), processTable(), VALUE_FLAGS (+1 more)

### Community 162 - "Annotate Types"
Cohesion: 0.18
Nodes (8): AccessibilityInfo, AnnotateCompleteResponse, AnnotateMode, AnnotateStartRequest, BoxModel, ElementRect, ElementSelection, ParentContext

### Community 163 - "Imageviewerpane"
Cohesion: 0.25
Nodes (7): ChatImage(), ChatImageLightbox(), formatSize(), getBasename(), ImageViewerPane(), ImageViewerPaneProps, RemoteFileRef

### Community 164 - "Sections"
Cohesion: 0.29
Nodes (8): ChatSettingsNav(), SearchResults(), SECTION_BY_ID, CHAT_SETTINGS_INDEX, CHAT_SETTINGS_SECTIONS, ChatSettingsSection, SectionMeta, SettingsIndexEntry

### Community 166 - "Edit Match"
Cohesion: 0.36
Nodes (9): applyEdit(), byTrimmedLines(), EditOutcome, indentOf(), indentShift(), indexesOf(), lineOf(), notFound() (+1 more)

### Community 167 - "Kanban PM Digest"
Cohesion: 0.27
Nodes (6): KanbanStoreOptions, buildDigestContext(), COMPLETED, DigestInput, FAILURES, TaskEvent

### Community 168 - "Kanban Store Test"
Cohesion: 0.22
Nodes (5): SCHEMA_SQL, SCHEMA_VERSION, DB_PATH, register(), TEST_DIR

### Community 169 - "Chatmarkdown"
Cohesion: 0.27
Nodes (6): AgentMarkdown(), plugins, ChatMarkdown(), plugins, Props, sanitizeMarkdownUrl()

### Community 170 - "Auditlogview"
Cohesion: 0.27
Nodes (8): AuditLogView(), DECISION_CLASS, fmtTime(), ToolFilter, toolGroup(), ChatSettingsView(), ChatTab(), View

### Community 171 - "File Open"
Cohesion: 0.36
Nodes (8): BINARY_BLOCKLIST, getFileExtension(), getPaneTypeForFilePath(), IMAGE_EXTENSIONS, isBinaryBlockedFilePath(), MARKDOWN_EXTENSIONS, OpenablePaneType, PDF_EXTENSIONS

### Community 172 - "Expand"
Cohesion: 0.53
Nodes (5): expandArray(), expandRecord(), expandVars(), ServerEntry, McpServerConfig

### Community 175 - "Worktree Service Test"
Cohesion: 0.25
Nodes (8): mockExecInContext, mockMkdir, mockRaw, mockRm, ok(), routeGit(), wsl, wslStub

### Community 176 - "Permissionruleseditor"
Cohesion: 0.31
Nodes (7): Bucket, BUCKETS, PermissionRulesEditor(), AgentToolsSection(), asToolsMode(), TOOL_MODES, Disclosure()

### Community 177 - "Nebula"
Cohesion: 0.33
Nodes (6): createCloudCanvas(), hexToRgb(), NEBULA_COLORS, NebulaCloud, NebulaSystem, randomCloud()

### Community 180 - "Safe Bash"
Cohesion: 0.46
Nodes (6): FIND_MUTATING_FLAGS, hasUnquotedWriteMeta(), isReadOnlyBashCommand(), isReadOnlySubcommand(), SAFE_COMMANDS, SAFE_GIT_SUBCOMMANDS

### Community 181 - "Pm Paths"
Cohesion: 0.43
Nodes (5): DOC_INLINE_CAP, loadTaskDocs(), pmBoardDir(), pmDocsDir(), TEST_DIR

### Community 182 - "Kanban PM Agents"
Cohesion: 0.43
Nodes (4): autopilotSection(), buildPmAgentsMd(), memorySection(), projectsSection()

### Community 183 - "Runesecretsform"
Cohesion: 0.29
Nodes (6): RuneAdvancedAccordion(), Props, RuneSecretsForm(), LoadState, RuneSettingsEditor(), RUNE_SECRET_KEYS

### Community 185 - "Sandbox"
Cohesion: 0.43
Nodes (4): buildBwrapArgv(), isSandboxAvailable(), makeSandboxWrap(), SandboxConfig

### Community 186 - "Env Sync Crypto"
Cohesion: 0.67
Nodes (4): decrypt(), deriveKey(), encrypt(), scryptAsync

### Community 187 - "Kanban Workspace Wsl Test"
Cohesion: 0.33
Nodes (4): mockExec, mockExists, mockMkdir, mockRm

### Community 189 - "Workspace Path"
Cohesion: 0.60
Nodes (3): BootstrapWorkspaceOptions, normalizePath(), resolveBootstrapWorkspacePath()

### Community 190 - "Env D"
Cohesion: 0.50
Nodes (4): FleetApi, CSSProperties, react, Window

### Community 191 - "Extensionssection"
Cohesion: 0.40
Nodes (4): ExtensionsSection(), ExtensionsTab, TABS, SkillsTab()

### Community 193 - "Image Service Test"
Cohesion: 0.50
Nodes (3): FLEET_IMAGES_DIR, GENERATIONS_DIR, TEST_HOME

## Knowledge Gaps
- **1057 isolated node(s):** `TEST_DIR`, `CHAT_SKILLS_DIR`, `ctx`, `fakeCrypto`, `fakeSecrets` (+1052 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `KanbanStore` connect `Kanban Board Store` to `Kanban Board Contracts`, `Main Process Bootstrap`, `Kanban Dispatcher`, `Kanban Store`, `Proposal Commands Test`, `Kanban Store`, `Kanban PM Digest`, `Kanban Command Surface`, `Kanban Store Test`, `Kanban Store`, `Pr Poller`, `Kanban Git Workspace`, `Kanban Store`, `Kanban Pipeline Templates`, `Kanban Store`, `Kanban Agent Spawning`, `Kanban MCP Server`, `Kanban Store`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Why does `createLogger()` connect `Main Logger & Bridge` to `Kanban Board Contracts`, `IPC Surface & Preload`, `Env Sync Manager`, `Chat Persistence & Search`, `Learnings Distiller`, `Agent Session Store`, `Learnings MCP Registrar`, `Remote SSH Control`, `Copilot Hook Installer`, `Chat Skills Loader`, `Worktree Service`, `Annotation Store`, `Agent MCP Import`, `Pi Auth Inspector`, `Kanban Git Workspace`, `Rune Manager`, `Kanban Agent Spawning`, `Main Process Bootstrap`, `Agent OpenRouter Client`, `SSH Host Detect`, `Agent MCP Runtime`, `Learnings Embedder`, `Learnings Store & Search`, `Rune File Assist`, `Pi Env Injection`, `Agent MCP OAuth`, `Copilot Window`, `Agent Image Store`, `Agent Attachments`, `Rune Config Manager`, `Pi Config Manager`, `Kanban Pipeline Templates`, `Copilot Session Store`, `Remote SSH Transfer`, `Agent Prompt History`, `Learnings IPC`, `Cwd Poller`, `Remote SSH Service`, `Expand`, `Remote SSH Cache`, `Activity Tracker`, `Copilot Conversation Reader`, `WSL Service`, `Layout Store`, `Learnings MCP Server`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `AgentMcpSecrets` connect `Agent MCP Servers` to `Main Process Bootstrap`, `Agent MCP Runtime`, `Agent MCP Import`, `Fake Oauth Server`, `Lift`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `TEST_DIR`, `CHAT_SKILLS_DIR`, `ctx` to the rest of the system?**
  _1057 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Kanban Board Contracts` be split into smaller, more focused modules?**
  _Cohesion score 0.03766427313372172 - nodes in this community are weakly interconnected._
- **Should `IPC Surface & Preload` be split into smaller, more focused modules?**
  _Cohesion score 0.041201000834028355 - nodes in this community are weakly interconnected._
- **Should `Env Sync Manager` be split into smaller, more focused modules?**
  _Cohesion score 0.0456043956043956 - nodes in this community are weakly interconnected._