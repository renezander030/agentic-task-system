import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function actionLogPath() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return process.env.ATS_ACTION_LOG || path.join(configBase, 'ats', 'action-log.jsonl');
}

export function recordAction(entry, { logPath = actionLogPath() } = {}) {
  if (process.env.ATS_ACTION_DISABLE === '1') return null;
  if (!entry || typeof entry !== 'object') throw new Error('Action ledger entry must be an object.');
  if (!entry.action || typeof entry.action !== 'string') throw new Error('Action ledger entry requires an action.');
  if (entry.task !== undefined && entry.task !== null && (
    typeof entry.task !== 'object' || !entry.task.projectId || !entry.task.taskId
  )) throw new Error('Action ledger task requires projectId and taskId.');
  if (entry.sources !== undefined && (!Array.isArray(entry.sources) || entry.sources.some((item) => typeof item !== 'string'))) {
    throw new Error('Action ledger sources must be an array of strings.');
  }
  if (entry.approvals !== undefined && (!Array.isArray(entry.approvals) || entry.approvals.some((item) => typeof item !== 'string'))) {
    throw new Error('Action ledger approvals must be an array of strings.');
  }
  if (entry.output !== undefined && entry.output !== null && typeof entry.output !== 'string') {
    throw new Error('Action ledger output must be a string.');
  }
  if (entry.advanced !== undefined && typeof entry.advanced !== 'boolean') {
    throw new Error('Action ledger advanced must be boolean.');
  }
  const record = {
    id: entry.id || randomUUID(),
    ts: entry.ts || new Date().toISOString(),
    agent: entry.agent || process.env.ATS_AGENT_ID || 'unknown-agent',
    action: entry.action,
    task: entry.task || null,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    approvals: Array.isArray(entry.approvals) ? entry.approvals : [],
    output: entry.output || null,
    advanced: entry.advanced === true,
    metadata: entry.metadata || null,
  };
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  fs.chmodSync(logPath, 0o600);
  return record;
}

export function listActions(filters = {}, { logPath = actionLogPath() } = {}) {
  if (!fs.existsSync(logPath)) return [];
  const records = fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); } catch (err) {
        throw new Error(`Malformed action ledger JSON at line ${index + 1}.`, { cause: err });
      }
    })
    .filter((entry) => !filters.agent || entry.agent === filters.agent)
    .filter((entry) => !filters.action || entry.action === filters.action)
    .filter((entry) => !filters.projectId || entry.task?.projectId === filters.projectId)
    .filter((entry) => !filters.taskId || entry.task?.taskId === filters.taskId)
    .filter((entry) => filters.advanced === undefined || entry.advanced === filters.advanced)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const limit = Number.parseInt(filters.limit, 10);
  return Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;
}
