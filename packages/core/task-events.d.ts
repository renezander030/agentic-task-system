import type { Adapter } from './adapter-interface.js';

export const TASK_EVENT_STATE_VERSION: number;
export interface TaskEventRef { projectId: string; taskId: string }
export interface TaskEvent {
  id: string;
  type: 'task.created' | 'task.updated' | 'task.completed' | 'task.removed' | 'task.unblocked' | 'task.validity.changed' | 'task.due.soon';
  timestamp: string;
  task: TaskEventRef;
  beforeHash: string | null;
  afterHash: string | null;
  causationId: string | null;
  changedFields?: string[];
  dueDate?: string;
}
export interface TaskEventCheckpoint { version: number; generatedAt: string; dueWithinHours: number; cursor: string; tasks: Record<string, unknown> }
export function taskEventStatePath(): string;
export function readTaskEventCheckpoint(options?: { statePath?: string }): TaskEventCheckpoint | null;
export function writeTaskEventCheckpoint(checkpoint: TaskEventCheckpoint, options?: { statePath?: string }): { statePath: string; cursor: string; generatedAt: string; taskCount: number };
export function diffTaskEventCheckpoints(before: TaskEventCheckpoint, after: TaskEventCheckpoint, options?: { actions?: unknown[] }): TaskEvent[];
export function snapshotTaskEvents(adapter: Adapter, options?: { statePath?: string; now?: Date | string; dueWithinHours?: number }): Promise<{ statePath: string; cursor: string; generatedAt: string; taskCount: number }>;
export function collectTaskEvents(adapter: Adapter, options?: { statePath?: string; now?: Date | string; dueWithinHours?: number; actions?: unknown[] }): Promise<{ previousCursor: string; cursor: string; generatedAt: string; taskCount: number; eventCount: number; events: TaskEvent[]; checkpoint: TaskEventCheckpoint }>;
