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
}

export interface ActionLedgerRecord extends ActionLedgerEntry {
  id: string;
  ts: string;
  agent: string;
  sources: string[];
  approvals: string[];
  advanced: boolean;
}

export function actionLogPath(): string;
export function recordAction(entry: ActionLedgerEntry, options?: { logPath?: string }): ActionLedgerRecord | null;
export function listActions(filters?: { agent?: string; action?: string; projectId?: string; taskId?: string; advanced?: boolean; limit?: number }, options?: { logPath?: string }): ActionLedgerRecord[];
