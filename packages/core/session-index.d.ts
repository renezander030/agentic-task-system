export const SESSION_INDEX_VERSION: 1;

export interface SessionTaskRef {
  projectId: string;
  taskId: string;
  role?: string;
}

export interface SessionTokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionIndexInput {
  id: string;
  source?: string;
  title?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  startedAt: string;
  endedAt?: string;
  models?: string[];
  tools?: string[];
  files?: string[];
  tasks?: SessionTaskRef[];
  tokenStats?: Partial<SessionTokenStats>;
  outcome?: string;
  summary?: string;
}

export interface SessionIndexEntry {
  version: 1;
  id: string;
  source: string;
  title: string;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  models: string[];
  tools: string[];
  files: string[];
  taskRefs: Array<Required<SessionTaskRef>>;
  tokenStats: SessionTokenStats;
  outcome: string | null;
  summary: string | null;
}

export function normalizeSessionIndexEntry(entry: SessionIndexInput): SessionIndexEntry;
export function normalizeSessionIndex(entries: SessionIndexInput[]): SessionIndexEntry[];
export function sessionIndexTaskBody(entry: SessionIndexInput): string;
