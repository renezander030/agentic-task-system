export const PROGRESS_BENCHMARK_VERSION: 1;
export type ProgressTaskRef = string | { projectId: string; taskId: string };
export interface ProgressEpisode {
  id: string;
  task?: ProgressTaskRef;
  context?: { included?: Array<{ ref: ProgressTaskRef; tokens: number }>; relevant?: ProgressTaskRef[] };
  doneWhen?: string[];
  before?: { status?: string; blockers?: string[]; criteriaSatisfied?: string[] };
  after?: { status?: string; blockers?: string[]; criteriaSatisfied?: string[] };
  actions?: Array<{ action?: string; advanced?: boolean }>;
  advanced?: boolean;
  reopened?: boolean;
  humanCorrections?: number;
}
export interface ProgressEpisodeScore {
  id: string;
  task: string | null;
  advanced: boolean;
  completed: boolean;
  reopened: boolean;
  humanCorrections: number;
  supervisionFree: boolean;
  context: {
    injectedCount: number; relevantInjectedCount: number; relevantRetrievedCount: number;
    expectedRelevantCount: number; precision: number | null; recall: number | null;
    totalTokens: number; irrelevantTokens: number; irrelevantTokenRate: number | null;
    missingRelevant: string[];
  };
  blockers: { before: number; after: number; removed: number; removalRate: number | null; removedIds: string[] };
  completionCriteria: { total: number; satisfied: number; newlySatisfied: number; satisfactionRate: number | null; newlySatisfiedIds: string[] };
}
export interface ProgressBenchmarkReport {
  version: number;
  episodeCount: number;
  metrics: {
    taskAdvancementRate: number | null; completionRate: number | null;
    contextPrecision: number | null; contextRecall: number | null;
    irrelevantTokens: number; averageIrrelevantTokens: number; irrelevantTokenRate: number | null;
    blockerRemovalRate: number | null; completionCriteriaRate: number | null;
    reopenRate: number | null; humanCorrections: number; averageHumanCorrections: number;
    supervisionFreeRate: number | null;
  };
  episodes: ProgressEpisodeScore[];
}
export function scoreProgressEpisode(input: ProgressEpisode): ProgressEpisodeScore;
export function scoreProgressEpisodes(inputs: ProgressEpisode[]): ProgressBenchmarkReport;
export function formatProgressBenchmark(report: ProgressBenchmarkReport): string;
