import { create } from 'zustand';
import type {
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  TaskStatus,
  UpdateTaskFields
} from '../../../shared/kanban-types';

type KanbanState = {
  cards: BoardCard[];
  loaded: boolean;
  openTaskId: string | null;
  detail: TaskDetail | null;
  loadBoard: () => Promise<void>;
  openTask: (id: string) => Promise<void>;
  closeTask: () => void;
  refreshDetail: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;
  updateTask: (id: string, fields: UpdateTaskFields) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  addLink: (parentId: string, childId: string) => Promise<void>;
  removeLink: (parentId: string, childId: string) => Promise<void>;
  nudge: () => Promise<void>;
  decompose: (id: string) => Promise<void>;
  specify: (id: string) => Promise<void>;
};

export const useKanbanStore = create<KanbanState>((set, get) => ({
  cards: [],
  loaded: false,
  openTaskId: null,
  detail: null,

  loadBoard: async () => {
    const cards = await window.fleet.kanban.listBoard();
    set({ cards, loaded: true });
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
  }
}));
