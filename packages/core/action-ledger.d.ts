export interface ActionLedgerEntry {
  id?: string;
  ts?: string;
  agent?: string;
  action: string;
  task?: { projectId: string; taskId: string } | null;
  sources?: string[];
  approvals?: string[];
  output?: string | null;
  advanced?: boolean;
  metadata?: Record<string, unknown> | null;
  /** Pre-write snapshot that makes the write reversible via `revertAction`. */
  before?: TaskSnapshot | null;
}

export interface ActionLedgerRecord extends ActionLedgerEntry {
  id: string;
  ts: string;
  agent: string;
  sources: string[];
  approvals: string[];
  advanced: boolean;
}

export interface TaskSnapshot {
  title?: string;
  content?: string;
  tags?: string[];
  dueDate?: string;
}

export interface RevertResult {
  plan: { op: 'restore' | 'delete'; id: string; action: string; task: { projectId: string; taskId: string }; patch?: TaskSnapshot };
  applied: boolean;
  result?: unknown;
  compensation?: ActionLedgerRecord;
}

export function actionLogPath(): string;
export function recordAction(entry: ActionLedgerEntry, options?: { logPath?: string }): ActionLedgerRecord | null;
export function listActions(filters?: { agent?: string; action?: string; projectId?: string; taskId?: string; advanced?: boolean; limit?: number }, options?: { logPath?: string }): ActionLedgerRecord[];
export function snapshotTask(task?: unknown): TaskSnapshot;
export function findAction(id: string, options?: { logPath?: string }): ActionLedgerRecord | null;
export function mostRecentUndoable(options?: { logPath?: string }): ActionLedgerRecord | null;
export function revertAction(adapter: unknown, id?: string, options?: { logPath?: string; apply?: boolean }): Promise<RevertResult>;
