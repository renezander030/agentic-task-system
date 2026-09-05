export { validateAdapter, adapterCapabilities } from './adapter-interface.js';
export { withLock, withLockSync, writeFileAtomicSync } from './fs-lock.js';
export { withRetry, retryingFetch, retryPolicy, isTransientResponse, isTransientError } from './retry.js';
export {
  REVIEW_QUEUE_VERSION,
  reviewQueuePath,
  readReviewQueue,
  stageReviewItem,
  listReviewItems,
  findReviewItem,
  decideReviewItem,
  markReviewItemApplied,
  writeRequiresApproval,
} from './review-queue.js';
export { STATE_BUNDLE_VERSION, stateFileRegistry, exportState, importState } from './state-bundle.js';
export {
  kgFactsPath,
  loadFacts,
  proposeFact,
  proposeRetract,
  ratifyFactItem,
  listKgFacts,
  askFacts,
  kgStats,
  exportFactsCypher,
} from './kg.js';
export { rrf, fuse, find, loadCorpus, similar, syncCorpusCache, RRF_K } from './retrieval.js';
export { detectDuplicates, formatDedup } from './dedup.js';
export { gardenSweep, formatGarden } from './garden.js';
export {
  read as readCorpus,
  write as writeCorpus,
  meta as corpusMeta,
  clear as clearCorpus,
} from './corpus-cache.js';
export { record as logUsage } from './usage-log.js';
export { SESSION_INDEX_VERSION, normalizeSessionIndexEntry, normalizeSessionIndex, sessionIndexTaskBody } from './session-index.js';
export { runConformance, formatConformance } from './conformance.js';
export {
  TASK_CONTEXT_VERSION,
  LINK_TYPES,
  LIFECYCLE_STATUSES,
  CONTENT_TRUST_LEVELS,
  HIERARCHY_KINDS,
  normalizeTaskMetadata,
  parseTaskMetadata,
  taskMetadataForRead,
  writeTaskMetadata,
  evaluateLifecycle,
  setTaskIntent,
  setTaskLifecycle,
  setTaskSecurity,
  setTaskHierarchy,
  promoteExploration,
  evaluateTaskAccess,
  checkTaskAccess,
  addTaskLink,
  resolveTaskLinks,
  removeTaskLink,
  listTaskLinks,
  addTaskReference,
  removeTaskReference,
  listTaskReferences,
  relateTask,
  buildTaskGraph,
  evaluateTaskHierarchy,
  contextForTask,
} from './task-context.js';
export { actionLogPath, recordAction, listActions, snapshotTask, findAction, mostRecentUndoable, revertAction } from './action-ledger.js';
export {
  TASK_EVENT_STATE_VERSION,
  TASK_EVENT_SPOOL_VERSION,
  taskEventStatePath,
  taskEventSpoolPath,
  readTaskEventCheckpoint,
  writeTaskEventCheckpoint,
  diffTaskEventCheckpoints,
  snapshotTaskEvents,
  collectTaskEvents,
  readTaskEventSpool,
  stageTaskEvents,
  listPendingTaskEvents,
  acknowledgeTaskEvents,
  collectAndSpoolTaskEvents,
} from './task-events.js';
export {
  PROGRESS_BENCHMARK_VERSION,
  scoreProgressEpisode,
  scoreProgressEpisodes,
  formatProgressBenchmark,
} from './progress-benchmark.js';
export { normalizeTaskBody, TRIAGE_TAG } from './task-format.js';
