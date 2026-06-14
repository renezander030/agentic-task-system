import type { Adapter } from './adapter-interface.js';

export const TASK_EVENT_STATE_VERSION: number;
export const TASK_EVENT_SPOOL_VERSION: number;
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
export interface PendingTaskEvent { event: TaskEvent; stagedAt: string }
export function taskEventStatePath(): string;
export function taskEventSpoolPath(): string;
export function readTaskEventCheckpoint(options?: { statePath?: string }): TaskEventCheckpoint | null;
export function writeTaskEventCheckpoint(checkpoint: TaskEventCheckpoint, options?: { statePath?: string }): { statePath: string; cursor: string; generatedAt: string; taskCount: number };
export function diffTaskEventCheckpoints(before: TaskEventCheckpoint, after: TaskEventCheckpoint, options?: { actions?: unknown[] }): TaskEvent[];
export function snapshotTaskEvents(adapter: Adapter, options?: { statePath?: string; now?: Date | string; dueWithinHours?: number }): Promise<{ statePath: string; cursor: string; generatedAt: string; taskCount: number }>;
export function collectTaskEvents(adapter: Adapter, options?: { statePath?: string; now?: Date | string; dueWithinHours?: number; actions?: unknown[] }): Promise<{ previousCursor: string; cursor: string; generatedAt: string; taskCount: number; eventCount: number; events: TaskEvent[]; checkpoint: TaskEventCheckpoint }>;
export function readTaskEventSpool(options?: { spoolPath?: string }): { version: number; updatedAt: string | null; pending: PendingTaskEvent[] };
export function stageTaskEvents(events: TaskEvent[], options?: { spoolPath?: string; now?: Date | string }): { spoolPath: string; added: string[]; addedCount: number; pendingCount: number };
export function listPendingTaskEvents(options?: { spoolPath?: string; limit?: number }): { spoolPath: string; pendingCount: number; pending: PendingTaskEvent[] };
export function acknowledgeTaskEvents(eventIds: string[], options?: { spoolPath?: string; now?: Date | string }): { spoolPath: string; acknowledgedAt: string; acknowledged: string[]; unknown: string[]; pendingCount: number };
export function collectAndSpoolTaskEvents(adapter: Adapter, options?: { statePath?: string; spoolPath?: string; now?: Date | string; dueWithinHours?: number; actions?: unknown[] }): Promise<{ previousCursor: string; cursor: string; generatedAt: string; taskCount: number; eventCount: number; events: TaskEvent[]; stagedCount: number; pendingCount: number; pending: PendingTaskEvent[] }>;
