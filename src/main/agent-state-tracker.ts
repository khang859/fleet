import { EventBus } from './event-bus';
import type { AgentVisualState } from '../shared/types';

// Duplicated from jsonl-watcher.ts to avoid circular dependency issues
export type JsonlRecord = {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: unknown;
    }>;
  };
  data?: {
    type?: string;
    parentToolUseID?: string;
  };
  [key: string]: unknown;
};

const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit']);
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'NotebookRead']);

type AgentEntry = {
  paneId: string;
  label: string;
  state: AgentVisualState['state'];
  currentTool?: string;
  subAgents: Map<string, AgentEntry>;
  createdAt: number;
  lastActivity: number;
};

export class AgentStateTracker {
  private agents = new Map<string, AgentEntry>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private hasJsonlData = new Set<string>();

  constructor(private eventBus: EventBus) {
    eventBus.on('pane-created', (event) => {
      this.agents.set(event.paneId, {
        paneId: event.paneId,
        label: event.paneId,
        state: 'not-agent',
        subAgents: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      this.fallbackTimers.set(
        event.paneId,
        setTimeout(() => {
          if (!this.hasJsonlData.has(event.paneId)) {
            // Degraded mode — PTY patterns will serve as fallback
          }
          this.fallbackTimers.delete(event.paneId);
        }, 30_000),
      );
    });

    eventBus.on('pane-closed', (event) => {
      this.agents.delete(event.paneId);
      this.hasJsonlData.delete(event.paneId);
      const idleTimer = this.idleTimers.get(event.paneId);
      if (idleTimer) {
        clearTimeout(idleTimer);
        this.idleTimers.delete(event.paneId);
      }
      const fallbackTimer = this.fallbackTimers.get(event.paneId);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        this.fallbackTimers.delete(event.paneId);
      }
    });

    eventBus.on('notification', (event) => {
      if (event.level === 'permission') {
        this.updateState(event.paneId, 'needs-permission');
      }
    });
  }

  handleJsonlRecord(paneId: string, record: JsonlRecord): void {
    const agent = this.agents.get(paneId);
    if (!agent) return;

    this.hasJsonlData.add(paneId);

    if (agent.state === 'not-agent') {
      agent.state = 'idle';
    }

    // Check for sub-agent progress records
    if (
      record.type === 'progress' &&
      record.data?.type === 'agent_progress' &&
      record.data?.parentToolUseID
    ) {
      const subId = record.data.parentToolUseID;
      const toolName = this.extractToolName(record);
      const subState = this.classifyTool(toolName);

      if (!agent.subAgents.has(subId)) {
        agent.subAgents.set(subId, {
          paneId: `${paneId}:sub:${subId}`,
          label: `sub-agent`,
          state: subState,
          currentTool: toolName,
          subAgents: new Map(),
          createdAt: Date.now(),
          lastActivity: Date.now(),
        });
      } else {
        const sub = agent.subAgents.get(subId)!;
        sub.state = subState;
        sub.currentTool = toolName;
        sub.lastActivity = Date.now();
      }

      this.emitChange(paneId);
      return;
    }

    // Regular tool use
    if (record.type === 'assistant') {
      const toolName = this.extractToolName(record);
      if (toolName) {
        const newState = this.classifyTool(toolName);
        agent.state = newState;
        agent.currentTool = toolName;
        agent.lastActivity = Date.now();
        this.resetIdleTimer(paneId);
        this.emitChange(paneId);
      }
    }
  }

  setLabel(paneId: string, label: string): void {
    const agent = this.agents.get(paneId);
    if (agent) agent.label = label;
  }

  getState(paneId: string): AgentVisualState | undefined {
    const agent = this.agents.get(paneId);
    if (!agent) return undefined;
    return this.toVisualState(agent);
  }

  getAllStates(): AgentVisualState[] {
    return Array.from(this.agents.values()).map((a) => this.toVisualState(a));
  }

  private updateState(paneId: string, state: AgentVisualState['state']): void {
    const agent = this.agents.get(paneId);
    if (agent) {
      agent.state = state;
      agent.lastActivity = Date.now();
      this.emitChange(paneId);
    }
  }

  private extractToolName(record: JsonlRecord): string | undefined {
    const content = record.message?.content;
    if (!Array.isArray(content)) return undefined;
    const toolUse = content.find((c) => c.type === 'tool_use');
    return toolUse?.name;
  }

  private classifyTool(toolName?: string): AgentVisualState['state'] {
    if (!toolName) return 'idle';
    if (WRITING_TOOLS.has(toolName)) return 'working';
    if (READING_TOOLS.has(toolName)) return 'reading';
    return 'working';
  }

  private resetIdleTimer(paneId: string): void {
    const existing = this.idleTimers.get(paneId);
    if (existing) clearTimeout(existing);

    this.idleTimers.set(
      paneId,
      setTimeout(() => {
        this.updateState(paneId, 'idle');
        this.idleTimers.delete(paneId);
      }, 5000),
    );
  }

  private emitChange(paneId: string): void {
    const state = this.getState(paneId);
    if (state) {
      this.eventBus.emit('agent-state-change', {
        type: 'agent-state-change',
        paneId,
        state: state.state,
        tool: state.currentTool,
      });
    }
  }

  private toVisualState(agent: AgentEntry): AgentVisualState {
    return {
      paneId: agent.paneId,
      label: agent.label,
      state: agent.state,
      currentTool: agent.currentTool,
      subAgents: Array.from(agent.subAgents.values()).map((s) => this.toVisualState(s)),
      uptime: Date.now() - agent.createdAt,
    };
  }
}
