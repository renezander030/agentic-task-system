/**
 * `ats garden` — staleness sweep over the corpus. DETECTION ONLY.
 *
 * Finds active tasks nobody has touched in `staleDays` and prints the exact
 * per-task command to archive each one. It never mutates anything itself:
 * bulk hygiene that silently edits or deletes is precisely the failure mode
 * this tool exists to avoid — the human stays the apply step.
 */

import { taskMetadataForRead } from './task-context.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function gardenSweep(corpus, { staleDays = 60, now = Date.now(), limit = 50 } = {}) {
  const cutoff = now - staleDays * DAY_MS;
  const stale = [];
  for (const task of corpus) {
    if ((task.status || 'active') === 'completed') continue;
    const modified = Date.parse(task.modifiedTime || '');
    if (!Number.isFinite(modified) || modified >= cutoff) continue;
    let lifecycle;
    try {
      lifecycle = taskMetadataForRead(task).lifecycle?.status || 'active';
    } catch {
      lifecycle = 'active';
    }
    if (lifecycle !== 'active') continue; // already archived/superseded
    stale.push({
      projectId: task.projectId,
      taskId: task.id,
      title: task.title || '',
      ageDays: Math.floor((now - modified) / DAY_MS),
      dueDate: task.dueDate || null,
    });
  }
  stale.sort((a, b) => b.ageDays - a.ageDays);
  return {
    scanned: corpus.length,
    staleDays,
    count: stale.length,
    truncated: stale.length > limit,
    stale: stale.slice(0, limit),
  };
}

export function formatGarden(report) {
  if (!report.count) {
    return `garden: nothing stale (scanned ${report.scanned}, threshold ${report.staleDays}d)`;
  }
  const shown = report.truncated ? ` (showing ${report.stale.length})` : '';
  const lines = [`garden: ${report.count} active task(s) untouched ≥${report.staleDays}d${shown}`, ''];
  for (const t of report.stale) {
    lines.push(`  ${String(t.ageDays).padStart(4)}d  ${t.projectId}/${t.taskId}  ${t.title}`);
    lines.push(`         archive: ats lifecycle set ${t.projectId} ${t.taskId} --status archived`);
  }
  lines.push('');
  lines.push('Detection only — nothing was changed. Archive per task with the printed');
  lines.push('command, or link duplicates first: ats dedup apply.');
  return lines.join('\n');
}
