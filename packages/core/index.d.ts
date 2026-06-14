export { validateAdapter, adapterCapabilities } from './adapter-interface.js';
export type {
  Task,
  TaskInput,
  TaskPatch,
  Project,
  AuthStatus,
  Adapter,
  AdapterCapabilities,
} from './adapter-interface.js';

export { rrf, fuse, find, loadCorpus, similar, RRF_K } from './retrieval.js';
export type {
  RankedDoc,
  FusedDoc,
  Branch,
  CorpusResult,
  Embedder,
  Retriever,
  FindOptions,
  FindResult,
  BranchSummary,
} from './retrieval.js';

export {
  read as readCorpus,
  write as writeCorpus,
  meta as corpusMeta,
  clear as clearCorpus,
} from './corpus-cache.js';

export { record as logUsage } from './usage-log.js';

export { runConformance, formatConformance } from './conformance.js';
export type {
  ConformanceStatus,
  ConformanceCheck,
  ConformanceReport,
  ConformanceOptions,
} from './conformance.js';

export {
  TASK_CONTEXT_VERSION,
  LINK_TYPES,
  LIFECYCLE_STATUSES,
  CONTENT_TRUST_LEVELS,
  normalizeTaskMetadata,
  parseTaskMetadata,
  writeTaskMetadata,
  evaluateLifecycle,
  setTaskIntent,
  setTaskLifecycle,
  setTaskSecurity,
  evaluateTaskAccess,
  checkTaskAccess,
  addTaskLink,
  removeTaskLink,
  listTaskLinks,
  buildTaskGraph,
  contextForTask,
} from './task-context.js';
export type { LinkType, LifecycleStatus, ContentTrust, TaskIntent, TaskLifecycle, TaskSecurity, TaskAccessRequest, TaskAccessDecision, TaskLink, TaskMetadata } from './task-context.js';

export { actionLogPath, recordAction, listActions } from './action-ledger.js';
export type { ActionLedgerEntry, ActionLedgerRecord } from './action-ledger.js';

export {
  TASK_EVENT_STATE_VERSION,
  taskEventStatePath,
  readTaskEventCheckpoint,
  writeTaskEventCheckpoint,
  diffTaskEventCheckpoints,
  snapshotTaskEvents,
  collectTaskEvents,
} from './task-events.js';
export type { TaskEventRef, TaskEvent, TaskEventCheckpoint } from './task-events.js';

export {
  PROGRESS_BENCHMARK_VERSION,
  scoreProgressEpisode,
  scoreProgressEpisodes,
  formatProgressBenchmark,
} from './progress-benchmark.js';
export type { ProgressTaskRef, ProgressEpisode, ProgressEpisodeScore, ProgressBenchmarkReport } from './progress-benchmark.js';
