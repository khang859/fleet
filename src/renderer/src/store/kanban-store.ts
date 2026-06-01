import { create } from 'zustand';
import type {
  Board,
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  TaskStatus,
  UpdateTaskFields,
  ScheduleInput,
  SwarmInput,
  SwarmCreated,
  Task
} from '../../../shared/kanban-types';
import type { KanbanArtifactPreviewResponse } from '../../../shared/ipc-api';

/** A pending "use artifact as input" request, consumed by the board's create form / swarm modal. */
export type ArtifactSeed = {
  artifact: { id: string; filename: string };
  target: 'task' | 'swarm';
};

type KanbanState = {
  cards: BoardCard[];
  loaded: boolean;
  openTaskId: string | null;
  detail: TaskDetail | null;
  boards: Board[];
  activeBoardSlug: string;
  loadBoard: () => Promise<void>;
  loadBoards: () => Promise<void>;
  switchBoard: (slug: string) => Promise<void>;
  createBoard: (name: string) => Promise<void>;
  renameBoard: (slug: string, name: string) => Promise<void>;
  deleteBoard: (slug: string) => Promise<void>;
  openTask: (id: string) => Promise<void>;
  closeTask: () => void;
  refreshDetail: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;
  createSwarm: (input: SwarmInput) => Promise<SwarmCreated>;
  updateTask: (id: string, fields: UpdateTaskFields) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  replyAndResume: (taskId: string, body: string) => Promise<void>;
  addLink: (parentId: string, childId: string) => Promise<void>;
  removeLink: (parentId: string, childId: string) => Promise<void>;
  nudge: () => Promise<void>;
  decompose: (id: string) => Promise<void>;
  specify: (id: string) => Promise<void>;
  setSchedule: (taskId: string, input: ScheduleInput) => Promise<void>;
  clearSchedule: (taskId: string) => Promise<void>;
  pauseSchedule: (taskId: string) => Promise<void>;
  resumeSchedule: (taskId: string) => Promise<void>;
  uploadAttachments: (taskId: string, sourcePaths: string[]) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  saveAttachmentCopy: (id: string) => Promise<void>;
  discardArtifact: (id: string) => Promise<void>;
  restoreArtifact: (id: string) => Promise<void>;
  removeArtifact: (id: string) => Promise<void>;
  saveArtifactCopy: (id: string) => Promise<void>;
  revealArtifact: (id: string) => Promise<void>;
  readArtifactPreview: (id: string) => Promise<KanbanArtifactPreviewResponse>;
  createTaskFromArtifact: (artifactId: string, input: CreateTaskInput) => Promise<Task>;
  createSwarmFromArtifact: (artifactId: string, input: SwarmInput) => Promise<SwarmCreated>;
  revealTaskWorkspace: (taskId: string) => Promise<void>;
  discardTaskWorkspaceLeftovers: (taskId: string) => Promise<void>;
  seed: ArtifactSeed | null;
  requestSeed: (artifact: { id: string; filename: string }, target: 'task' | 'swarm') => void;
  clearSeed: () => void;
  unreadCount: number;
  incrementUnread: () => void;
  markSeen: () => void;
};

export const useKanbanStore = create<KanbanState>((set, get) => ({
  cards: [],
  loaded: false,
  openTaskId: null,
  detail: null,
  boards: [],
  activeBoardSlug: localStorage.getItem('fleet.kanban.activeBoard') ?? 'default',
  seed: null,
  unreadCount: 0,

  loadBoard: async () => {
    const cards = await window.fleet.kanban.listBoard(get().activeBoardSlug);
    set({ cards, loaded: true });
  },
  loadBoards: async () => {
    const boards = await window.fleet.kanban.listBoards();
    // If the active board vanished (e.g. deleted in another window), fall back.
    const active = get().activeBoardSlug;
    if (!boards.some((b) => b.slug === active)) {
      localStorage.setItem('fleet.kanban.activeBoard', 'default');
      set({ boards, activeBoardSlug: 'default' });
      await get().loadBoard();
      return;
    }
    set({ boards });
  },
  switchBoard: async (slug) => {
    localStorage.setItem('fleet.kanban.activeBoard', slug);
    set({ activeBoardSlug: slug, openTaskId: null, detail: null, seed: null });
    await get().loadBoard();
  },
  createBoard: async (name) => {
    const board = await window.fleet.kanban.createBoard(name);
    await get().loadBoards();
    await get().switchBoard(board.slug);
  },
  renameBoard: async (slug, name) => {
    await window.fleet.kanban.renameBoard({ slug, name });
    await get().loadBoards();
  },
  deleteBoard: async (slug) => {
    await window.fleet.kanban.deleteBoard(slug);
    if (get().activeBoardSlug === slug) {
      await get().switchBoard('default');
    }
    await get().loadBoards();
  },
  openTask: async (id) => {
    const detail = await window.fleet.kanban.getTask(id);
    set({ openTaskId: id, detail });
  },
  closeTask: () => set({ openTaskId: null, detail: null }),
  refreshDetail: async () => {
    const id = get().openTaskId;
    if (!id) return;
    const detail = await window.fleet.kanban.getTask(id);
    set({ detail });
  },
  createTask: async (input) => {
    await window.fleet.kanban.createTask(input);
    await get().loadBoard();
  },
  createSwarm: async (input) => {
    const created = await window.fleet.kanban.createSwarm(input);
    await get().loadBoard();
    return created;
  },
  updateTask: async (id, fields) => {
    await window.fleet.kanban.updateTask({ id, fields });
    await get().loadBoard();
    await get().refreshDetail();
  },
  setStatus: async (id, status) => {
    await window.fleet.kanban.setStatus({ id, status });
    await get().loadBoard();
    await get().refreshDetail();
  },
  addComment: async (taskId, body) => {
    await window.fleet.kanban.addComment({ taskId, body });
    await get().refreshDetail();
  },
  replyAndResume: async (taskId, body) => {
    await window.fleet.kanban.replyAndResume({ taskId, body });
    await get().loadBoard();
    await get().refreshDetail();
  },
  addLink: async (parentId, childId) => {
    await window.fleet.kanban.addLink({ parentId, childId });
    await get().loadBoard();
    await get().refreshDetail();
  },
  removeLink: async (parentId, childId) => {
    await window.fleet.kanban.removeLink({ parentId, childId });
    await get().loadBoard();
    await get().refreshDetail();
  },
  nudge: async () => {
    await window.fleet.kanban.nudge();
  },
  decompose: async (id) => {
    await window.fleet.kanban.decompose(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  specify: async (id) => {
    await window.fleet.kanban.specify(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  setSchedule: async (taskId, input) => {
    await window.fleet.kanban.setSchedule({ taskId, input });
    await get().loadBoard();
    await get().refreshDetail();
  },
  clearSchedule: async (taskId) => {
    await window.fleet.kanban.clearSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
  pauseSchedule: async (taskId) => {
    await window.fleet.kanban.pauseSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
  resumeSchedule: async (taskId) => {
    await window.fleet.kanban.resumeSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
  uploadAttachments: async (taskId, sourcePaths) => {
    for (const p of sourcePaths) {
      await window.fleet.kanban.addAttachment({ taskId, sourcePath: p });
    }
    await get().refreshDetail();
  },
  removeAttachment: async (id) => {
    await window.fleet.kanban.removeAttachment(id);
    await get().refreshDetail();
  },
  saveAttachmentCopy: async (id) => {
    await window.fleet.kanban.saveAttachmentCopy(id);
  },
  discardArtifact: async (id) => {
    await window.fleet.kanban.discardArtifact(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  restoreArtifact: async (id) => {
    await window.fleet.kanban.restoreArtifact(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  removeArtifact: async (id) => {
    await window.fleet.kanban.removeArtifact(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  saveArtifactCopy: async (id) => {
    await window.fleet.kanban.saveArtifactCopy(id);
  },
  revealArtifact: async (id) => {
    await window.fleet.kanban.revealArtifact(id);
  },
  readArtifactPreview: async (id) => window.fleet.kanban.readArtifactPreview({ id }),
  createTaskFromArtifact: async (artifactId, input) => {
    const task = await window.fleet.kanban.createTaskFromArtifact({ artifactId, input });
    await get().loadBoard();
    return task;
  },
  createSwarmFromArtifact: async (artifactId, input) => {
    const created = await window.fleet.kanban.createSwarmFromArtifact({ artifactId, input });
    await get().loadBoard();
    return created;
  },
  revealTaskWorkspace: async (taskId) => {
    await window.fleet.kanban.revealTaskWorkspace(taskId);
  },
  discardTaskWorkspaceLeftovers: async (taskId) => {
    await window.fleet.kanban.discardTaskWorkspaceLeftovers(taskId);
    await get().refreshDetail();
  },
  requestSeed: (artifact, target) => set({ seed: { artifact, target } }),
  clearSeed: () => set({ seed: null }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  markSeen: () => set({ unreadCount: 0 })
}));
