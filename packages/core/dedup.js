/**
 * Corpus-level near-duplicate + contradiction detection.
 *
 * ATS already lets you ASSERT that two tasks conflict or supersede one another
 * (the `conflicts-with` / `supersedes` link types) — but only by hand. This
 * finds the candidates for you: clusters of tasks that look like the same thing
 * captured more than once (often the same fact re-entered across adapters), so
 * an agent can link or merge them instead of later recalling contradictory
 * copies of the same memory.
 *
 * Dependency-free and deterministic: lexical token-set (Jaccard) similarity over
 * title + content + tags. O(n^2) over the corpus — fine for the
 * thousands-of-tasks corpora ATS targets; `maxCorpus` caps the scan and sets a
 * `truncated` flag rather than silently dropping the tail.
 */

// Common words carry no dedup signal; dropping them keeps "Deploy the app" and
// "Deploy app" from scoring lower than they should.
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'is', 'it', 'this', 'that', 'at', 'by', 'be']);

function tokenSet(task) {
  const text = [task.title, task.content, ...(task.tags || [])].filter(Boolean).join(' ').toLowerCase();
  return new Set((text.match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !STOP.has(t)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function taskKey(t) {
  return t.fullId || t.id;
}

/**
 * Detect near-duplicate clusters and, within each, field-level disagreements
 * (a proxy for contradiction — the "same" task with a different status/due/etc).
 *
 * @param {Array<object>} corpus
 * @param {{threshold?:number, maxCorpus?:number, conflictFields?:string[]}} [opts]
 * @returns {{scanned:number, truncated:boolean, clusters:Array<{
 *   size:number, similarity:number,
 *   members:Array<{id:string,title:string,projectName?:string,projectId?:string}>,
 *   conflicts:Array<{field:string,values:Array}>}>}}
 */
export function detectDuplicates(corpus, { threshold = 0.6, maxCorpus = 2000, conflictFields = ['status', 'priority', 'dueDate'] } = {}) {
  const items = (corpus || []).filter((t) => taskKey(t));
  const truncated = items.length > maxCorpus;
  const scan = truncated ? items.slice(0, maxCorpus) : items;
  const sets = scan.map(tokenSet);

  // Union-find: every above-threshold pair unions two tasks; connected
  // components become clusters (so A~B and B~C group A, B, C together).
  const parent = scan.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const ri = root(i);
    const rj = root(j);
    if (ri !== rj) parent[ri] = rj;
  };
  for (let i = 0; i < scan.length; i++) {
    for (let j = i + 1; j < scan.length; j++) {
      if (jaccard(sets[i], sets[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < scan.length; i++) {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const clusters = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let maxSim = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        maxSim = Math.max(maxSim, jaccard(sets[idxs[a]], sets[idxs[b]]));
      }
    }
    const members = idxs.map((i) => ({
      id: taskKey(scan[i]),
      title: scan[i].title,
      projectName: scan[i].projectName,
      projectId: scan[i].projectId ?? scan[i].fullProjectId,
    }));
    const conflicts = [];
    for (const f of conflictFields) {
      const values = [...new Set(idxs.map((i) => scan[i][f]).filter((v) => v !== undefined && v !== null && v !== ''))];
      if (values.length > 1) conflicts.push({ field: f, values });
    }
    clusters.push({ size: idxs.length, similarity: Math.round(maxSim * 100) / 100, members, conflicts });
  }
  clusters.sort((a, b) => b.similarity - a.similarity || b.size - a.size);
  return { scanned: scan.length, truncated, clusters };
}

/** Render a dedup report as a compact, human-readable string. */
export function formatDedup(report) {
  const lines = [`# Duplicate / contradiction scan (${report.scanned} tasks scanned${report.truncated ? ', truncated at maxCorpus' : ''})`];
  if (report.clusters.length === 0) {
    lines.push('', 'No likely-duplicate clusters found.');
    return lines.join('\n');
  }
  lines.push('', `${report.clusters.length} likely-duplicate cluster(s):`, '');
  for (const c of report.clusters) {
    const flag = c.conflicts.length ? `  ⚠ conflicting: ${c.conflicts.map((x) => x.field).join(', ')}` : '';
    lines.push(`• ${c.size} tasks · similarity ${c.similarity}${flag}`);
    for (const m of c.members) {
      lines.push(`    - [${m.projectName || m.projectId || '?'}] ${m.title}  (${m.id})`);
    }
    for (const x of c.conflicts) {
      lines.push(`    ⚠ ${x.field}: ${x.values.join(' vs ')}`);
    }
    lines.push('');
  }
  lines.push('Act on these with a typed link, e.g. `ats link add <A> <B> --type supersedes` (or conflicts-with).');
  return lines.join('\n');
}
