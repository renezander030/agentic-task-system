import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const VOLATILE_SNAPSHOT_FIELDS = new Set(['evaluatedAt', 'elapsedMs', 'ageMs', 'fromCache']);

function logicalState(value) {
  if (Array.isArray(value)) return value.map(logicalState);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_SNAPSHOT_FIELDS.has(key))
      .map(([key, child]) => [key, logicalState(child)])
  );
}

/**
 * Build a coherent, content-addressed task snapshot. `capturedAt` is metadata,
 * not part of the digest, so unchanged state keeps the same revision.
 */
export function buildReliabilitySnapshot({ context, graph, capturedAt = new Date().toISOString() }) {
  const contextTotal = (context?.counts?.explicit || 0) + (context?.counts?.discovered || 0);
  const retrievalComplete = (context?.retrieval?.branches || []).every((branch) => branch.ok !== false);
  const reasons = [];
  if (graph?.truncated) reasons.push('graph-truncated');
  if ((context?.counts?.returned || 0) < contextTotal) reasons.push('context-limit');
  if ((context?.unresolvedLinks || []).length) reasons.push('unresolved-links');
  if ((context?.metadataErrors || []).length) reasons.push('metadata-errors');
  if (!retrievalComplete) reasons.push('retrieval-degraded');
  const payload = logicalState({
    schemaVersion: 1,
    root: graph?.root || `${context?.task?.projectId || ''}/${context?.task?.id || ''}`,
    task: context?.task || null,
    intent: context?.intent || null,
    hierarchy: context?.hierarchy || null,
    lifecycle: context?.lifecycle || null,
    security: context?.security || null,
    graph: graph || null,
    context: context?.context || [],
    excluded: context?.excluded || [],
    unresolvedLinks: context?.unresolvedLinks || [],
    retrieval: context?.retrieval || null,
    facts: context?.facts,
  });
  return {
    ...payload,
    revision: stableDigest(payload),
    capturedAt,
    completeness: {
      complete: reasons.length === 0,
      reasons,
      graphNodes: graph?.nodes?.length || 0,
      graphEdges: graph?.edges?.length || 0,
      contextCandidates: contextTotal,
      contextReturned: context?.counts?.returned || 0,
    },
  };
}
