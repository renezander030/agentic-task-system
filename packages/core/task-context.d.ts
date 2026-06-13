import type { Adapter, Task } from './adapter-interface.js';

export type LinkType = 'blocks' | 'depends-on' | 'supports' | 'evidence' | 'decision' | 'output' | 'supersedes' | 'related';
export type LifecycleStatus = 'active' | 'archived' | 'superseded';

export interface TaskIntent {
  outcome: string;
  why: string;
  doneWhen: string[];
  authority: string[];
  constraints: string[];
  approvalRequired: boolean;
}

export interface TaskLifecycle {
  status: LifecycleStatus;
  validFrom?: string;
  validUntil?: string;
}

export interface TaskLink {
  type: LinkType;
  projectId: string;
  taskId: string;
  title?: string;
  url?: string;
  createdAt?: string;
}

export interface TaskMetadata {
  version: 1;
  intent: TaskIntent;
  lifecycle: TaskLifecycle;
  links: TaskLink[];
}

export const TASK_CONTEXT_VERSION: 1;
export const LINK_TYPES: readonly LinkType[];
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[];
export function normalizeTaskMetadata(value?: Partial<TaskMetadata>): TaskMetadata;
export function parseTaskMetadata(content?: string): TaskMetadata;
export function writeTaskMetadata(content: string, metadata: Partial<TaskMetadata>): string;
export function evaluateLifecycle(metadata: Partial<TaskMetadata>, options?: { now?: Date | string; supersededBy?: string[] }): TaskLifecycle & { valid: boolean; reasons: string[]; supersededBy: string[]; evaluatedAt: string };
export function setTaskIntent(adapter: Adapter, projectId: string, taskId: string, patch: Partial<TaskIntent>): Promise<{ task: Task; metadata: TaskMetadata }>;
export function setTaskLifecycle(adapter: Adapter, projectId: string, taskId: string, patch: Partial<TaskLifecycle>): Promise<{ task: Task; metadata: TaskMetadata }>;
export function addTaskLink(adapter: Adapter, source: { projectId: string; taskId: string }, target: { projectId: string; taskId: string }, type: LinkType): Promise<{ task: Task; metadata: TaskMetadata }>;
export function removeTaskLink(adapter: Adapter, source: { projectId: string; taskId: string }, target: { projectId: string; taskId: string }, type: LinkType): Promise<{ task: Task; metadata: TaskMetadata; removed: boolean }>;
export function listTaskLinks(adapter: Adapter, projectId: string, taskId: string): Promise<{ task: { id: string; projectId: string; title: string }; links: TaskLink[] }>;
export function buildTaskGraph(adapter: Adapter, root: { projectId: string; taskId: string }, options?: { depth?: number; cache?: boolean }): Promise<Record<string, unknown>>;
export function contextForTask(adapter: Adapter, root: { projectId: string; taskId: string }, options?: { limit?: number; semanticLimit?: number; cache?: boolean }): Promise<Record<string, unknown>>;
