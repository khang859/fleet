/**
 * A crew member's permission request, as the job records it: who asked, for
 * what, and who answered it and why.
 *
 * `admiral` waits on the Admiral's `permission_answer`, and `client` on the
 * client's card. `in_pane` is one Fleet no longer holds: the runtime stopped
 * waiting for the hook, so only its own prompt in the crew pane can answer
 * it. `void` went away without an answer through Fleet: it was answered in
 * the pane, its target changed, or its crew member or Fleet ended.
 */
export type PermissionState = 'admiral' | 'client' | 'in_pane' | 'allowed' | 'denied' | 'void';

/** The states a request is still waiting in. */
export const OPEN_PERMISSION_STATES: readonly PermissionState[] = ['admiral', 'client', 'in_pane'];

/** Who answered: the Admiral, the client, the card's expiry, or another part of Fleet, such as the copilot. */
export type PermissionAnsweredBy = 'admiral' | 'client' | 'expiry' | 'elsewhere';

export type PermissionDecision = 'allow' | 'deny';

export type AgencyPermission = {
  id: number;
  jobId: number;
  crewId: number;
  /** The crew member, as the job names it: `builder 1`. */
  crewLabel: string;
  stepId: string;
  /** The runtime's tool, such as `Bash` or `Edit`. */
  tool: string;
  /** What the tool acts on: the command, the file or the URL. A card binds to it. */
  target: string;
  state: PermissionState;
  answeredBy: PermissionAnsweredBy | null;
  /** The Admiral's reason, or what Fleet says of an answer it gave. */
  reason: string;
  /** The Admiral's few words for what the action does, for the card title. */
  summary: string | null;
  /** What the Admiral recommends on a client card. */
  recommend: PermissionDecision | null;
  createdAt: number;
  /** When the client was asked. */
  askedAt: number | null;
  /** When an unanswered client card is denied. */
  expiresAt: number | null;
  answeredAt: number | null;
};

/** The client answers a permission card; a deny may say why, which the crew member reads. */
export type PermissionAnswerRequest = { id: number; decision: PermissionDecision; reason?: string };

/** The most a client's deny reason may hold. */
export const PERMISSION_REASON_MAX_CHARS = 300;

export type PermissionAnswerResult = { ok: true } | { ok: false; reason: string };

/** How a permission request is shown to the client and the model: `p7`. */
export const permissionDisplayId = (n: number): string => `p${n}`;

/** The token a transcript row carries so the pane can find the request: `perm#7`. */
export const permissionToken = (n: number): string => `perm#${n}`;

/** The default time a client permission card waits before it is denied. */
export const PERMISSION_EXPIRY_SEC_DEFAULT = 180;
