import type { Adapter, AdapterCapabilities } from './adapter-interface.js';

export type ConformanceStatus = 'pass' | 'fail' | 'skip';

export interface ConformanceCheck {
  id: string;
  label: string;
  status: ConformanceStatus;
  detail: string;
}

export interface ConformanceReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  capabilities: AdapterCapabilities;
  checks: ConformanceCheck[];
}

export interface ConformanceOptions {
  /** Also exercise createTask/updateTask. Leaves a probe item behind. Default false. */
  write?: boolean;
  /** Project to create the write-probe in. Defaults to the first project. */
  probeProjectId?: string;
  /** Progress callback fired after each check. */
  onCheck?: (stage: string, result: ConformanceCheck) => void;
}

export function runConformance(adapter: Adapter, opts?: ConformanceOptions): Promise<ConformanceReport>;
export function formatConformance(report: ConformanceReport): string;
