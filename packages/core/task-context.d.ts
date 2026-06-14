import type { Adapter, Task } from './adapter-interface.js';

export type LinkType = 'blocks' | 'depends-on' | 'supports' | 'evidence' | 'decision' | 'output' | 'supersedes' | 'related';
export type LifecycleStatus = 'active' | 'archived' | 'superseded';
export type ContentTrust = 'trusted' | 'untrusted' | 'mixed';

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

export interface TaskSecurity {
  contentTrust: ContentTrust;
  allowedActions: string[];
  allowedResources: string[];
  deniedResources: string[];
  approvalRequiredFor: string[];
  approvers: string[];
}

export interface TaskAccessRequest {
  action: string;
  resource: string;
  reason: string;
  approvals?: string[];
  agent?: string;
}

export interface TaskAccessDecision {
  allowed: boolean;
  reasons: string[];
  request: Required<Omit<TaskAccessRequest, 'agent'>>;
  contentTrust: ContentTrust;
  contentHandling: string;
  requiresApproval: boolean;
  approvalSatisfied: boolean;
  matchedAllowPattern: string | null;
  matchedDenyPattern: string | null;
  lifecycle: TaskLifecycle & { valid: boolean; reasons: string[] };
  evaluatedAt: string;
}

export interface TaskMetadata {
  version: 1;
  intent: TaskIntent;
  lifecycle: TaskLifecycle;
  security: TaskSecurity;
  links: TaskLink[];
}

export const TASK_CONTEXT_VERSION: 1;
export const LINK_TYPES: readonly LinkType[];
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[];
export const CONTENT_TRUST_LEVELS: readonly ContentTrust[];
export function normalizeTaskMetadata(value?: Partial<TaskMetadata>): TaskMetadata;
export function parseTaskMetadata(content?: string): TaskMetadata;
export function taskMetadataForRead(task: { content?: string; links?: TaskLink[] }): TaskMetadata;
export function writeTaskMetadata(content: string, metadata: Partial<TaskMetadata>): string;
export function evaluateLifecycle(metadata: Partial<TaskMetadata>, options?: { now?: Date | string; supersededBy?: string[] }): TaskLifecycle & { valid: boolean; reasons: string[]; supersededBy: string[]; evaluatedAt: string };
export function setTaskIntent(adapter: Adapter, projectId: string, taskId: string, patch: Partial<TaskIntent>): Promise<{ task: Task; metadata: TaskMetadata }>;
export function setTaskLifecycle(adapter: Adapter, projectId: string, taskId: string, patch: Partial<TaskLifecycle>): Promise<{ task: Task; metadata: TaskMetadata }>;
export function setTaskSecurity(adapter: Adapter, projectId: string, taskId: string, patch: Partial<TaskSecurity>): Promise<{ task: Task; metadata: TaskMetadata }>;
export function evaluateTaskAccess(metadata: Partial<TaskMetadata>, request: Partial<TaskAccessRequest>, options?: { now?: Date | string }): TaskAccessDecision;
export function checkTaskAccess(adapter: Adapter, projectId: string, taskId: string, request: TaskAccessRequest, options?: { now?: Date | string; agent?: string; logPath?: string }): Promise<{ task: { projectId: string; taskId: string; title: string }; policy: TaskSecurity; decision: TaskAccessDecision; audit: unknown }>;
export function addTaskLink(adapter: Adapter, source: { projectId: string; taskId: string }, target: { projectId: string; taskId: string }, type: LinkType): Promise<{ task: Task; metadata: TaskMetadata }>;
export function removeTaskLink(adapter: Adapter, source: { projectId: string; taskId: string }, target: { projectId: string; taskId: string }, type: LinkType): Promise<{ task: Task; metadata: TaskMetadata; removed: boolean }>;
export function listTaskLinks(adapter: Adapter, projectId: string, taskId: string): Promise<{ task: { id: string; projectId: string; title: string }; links: TaskLink[] }>;
export function buildTaskGraph(adapter: Adapter, root: { projectId: string; taskId: string }, options?: { depth?: number; cache?: boolean }): Promise<Record<string, unknown>>;
export function contextForTask(adapter: Adapter, root: { projectId: string; taskId: string }, options?: { limit?: number; semanticLimit?: number; cache?: boolean }): Promise<Record<string, unknown>>;
