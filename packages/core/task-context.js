import { find, loadCorpus } from './retrieval.js';
import { recordAction } from './action-ledger.js';

export const TASK_CONTEXT_VERSION = 1;
export const LINK_TYPES = Object.freeze([
  'blocks',
  'depends-on',
  'parent',
  'conflicts-with',
  'supports',
  'evidence',
  'decision',
  'output',
  'supersedes',
  'related',
]);
export const LIFECYCLE_STATUSES = Object.freeze(['active', 'archived', 'superseded']);
export const CONTENT_TRUST_LEVELS = Object.freeze(['trusted', 'untrusted', 'mixed']);
export const HIERARCHY_KINDS = Object.freeze(['unspecified', 'exploration', 'goal', 'project', 'task']);

const BLOCK_START = '<!-- ats:context -->';
const BLOCK_END = '<!-- /ats:context -->';
const BLOCK_RE = /<!-- ats:context -->\r?\n```ats\r?\n([\s\S]*?)\r?\n```\r?\n<!-- \/ats:context -->/g;

// Typed cross-task links live in a human-readable "## Related" section near the
// bottom of the task body — one bullet per link, `- <type>: [<title>](<url>)` —
// instead of inside the machine block. The link text and deep-link URL serve a
// human reader (and Obsidian-style backlink navigation); the agent reads the
// same lines. projectId/taskId are recovered from the URL, so the in-memory
// link model and everything downstream (graph/context/hierarchy) is unchanged.
// The machine block keeps only intent/lifecycle/security/hierarchy.
const RELATED_HEADING = '## Related';
const RELATED_SECTION_RE = /(?:^|\n)##\s+Related[ \t]*\n([\s\S]*?)(?=\n#{1,6}\s|\n<!-- ats:context -->|$)/;
// Title capture is greedy so a label containing `]` (e.g. a task titled
// "Spec [draft]") still round-trips by backtracking to the final `](url)`.
const RELATED_LINE_RE = /^-\s+([a-z][a-z-]*):\s*\[(.*)\]\(([^)\s]+)\)\s*$/;

const emptyMetadata = () => ({
  version: TASK_CONTEXT_VERSION,
  intent: {
    outcome: '',
    why: '',
    doneWhen: [],
    authority: [],
    constraints: [],
    approvalRequired: false,
  },
  lifecycle: { status: 'active' },
  hierarchy: { kind: 'unspecified' },
  security: {
    contentTrust: 'untrusted',
    allowedActions: [],
    allowedResources: [],
    deniedResources: [],
    approvalRequiredFor: [],
    approvers: [],
  },
  links: [],
});

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`ATS metadata field "${field}" must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`ATS metadata field "${field}" must be a string.`);
  return value;
}

function isoDate(value, field) {
  const result = optionalString(value, field);
  if (result && Number.isNaN(Date.parse(result))) {
    throw new Error(`ATS metadata field "${field}" must be an ISO 8601 date.`);
  }
  return result;
}

function resourcePatterns(value, field) {
  const patterns = stringArray(value, field);
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    if (wildcard !== -1 && (wildcard !== pattern.length - 1 || pattern.indexOf('*', wildcard + 1) !== -1)) {
      throw new Error(`ATS metadata field "${field}" only supports a single trailing wildcard.`);
    }
  }
  return patterns;
}

function actionNames(value, field) {
  const actions = stringArray(value, field);
  if (actions.some((action) => action.includes('*') && action !== '*')) {
    throw new Error(`ATS metadata field "${field}" supports exact actions or "*" only.`);
  }
  return actions;
}

function contentHandling(contentTrust) {
  if (contentTrust === 'trusted') return 'instructions-allowed-within-policy';
  if (contentTrust === 'mixed') return 'verify-before-following-instructions';
  return 'treat-as-data';
}

function normalizeLink(link, index) {
  if (!link || typeof link !== 'object') throw new Error(`ATS metadata link ${index} must be an object.`);
  if (!LINK_TYPES.includes(link.type)) {
    throw new Error(`ATS metadata link ${index} has unsupported type "${link.type}".`);
  }
  if (typeof link.projectId !== 'string' || !link.projectId) {
    throw new Error(`ATS metadata link ${index} needs projectId.`);
  }
  if (typeof link.taskId !== 'string' || !link.taskId) {
    throw new Error(`ATS metadata link ${index} needs taskId.`);
  }
  return {
    type: link.type,
    projectId: link.projectId,
    taskId: link.taskId,
    ...(optionalString(link.title, `links[${index}].title`) ? { title: link.title } : {}),
    ...(optionalString(link.url, `links[${index}].url`) ? { url: link.url } : {}),
    ...(isoDate(link.createdAt, `links[${index}].createdAt`) ? { createdAt: link.createdAt } : {}),
  };
}

export function normalizeTaskMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ATS metadata must be a JSON object.');
  }
  if (value.version !== undefined && value.version !== TASK_CONTEXT_VERSION) {
    throw new Error(`Unsupported ATS metadata version "${value.version}".`);
  }
  const base = emptyMetadata();
  const intent = value.intent || {};
  const lifecycle = value.lifecycle || {};
  const security = value.security || {};
  const hierarchy = value.hierarchy || {};
  if (typeof intent !== 'object' || Array.isArray(intent)) throw new Error('ATS metadata field "intent" must be an object.');
  if (typeof lifecycle !== 'object' || Array.isArray(lifecycle)) throw new Error('ATS metadata field "lifecycle" must be an object.');
  if (typeof security !== 'object' || Array.isArray(security)) throw new Error('ATS metadata field "security" must be an object.');
  if (typeof hierarchy !== 'object' || Array.isArray(hierarchy)) throw new Error('ATS metadata field "hierarchy" must be an object.');
  const status = lifecycle.status || 'active';
  if (!LIFECYCLE_STATUSES.includes(status)) {
    throw new Error(`ATS lifecycle status must be one of: ${LIFECYCLE_STATUSES.join(', ')}.`);
  }
  if (intent.approvalRequired !== undefined && typeof intent.approvalRequired !== 'boolean') {
    throw new Error('ATS metadata field "intent.approvalRequired" must be boolean.');
  }
  if (value.links !== undefined && !Array.isArray(value.links)) {
    throw new Error('ATS metadata field "links" must be an array.');
  }
  const contentTrust = security.contentTrust || base.security.contentTrust;
  if (!CONTENT_TRUST_LEVELS.includes(contentTrust)) {
    throw new Error(`ATS content trust must be one of: ${CONTENT_TRUST_LEVELS.join(', ')}.`);
  }
  const hierarchyKind = hierarchy.kind || base.hierarchy.kind;
  if (!HIERARCHY_KINDS.includes(hierarchyKind)) {
    throw new Error(`ATS hierarchy kind must be one of: ${HIERARCHY_KINDS.join(', ')}.`);
  }
  return {
    version: TASK_CONTEXT_VERSION,
    intent: {
      outcome: optionalString(intent.outcome, 'intent.outcome') || base.intent.outcome,
      why: optionalString(intent.why, 'intent.why') || base.intent.why,
      doneWhen: stringArray(intent.doneWhen, 'intent.doneWhen'),
      authority: stringArray(intent.authority, 'intent.authority'),
      constraints: stringArray(intent.constraints, 'intent.constraints'),
      approvalRequired: intent.approvalRequired ?? false,
    },
    lifecycle: {
      status,
      ...(isoDate(lifecycle.validFrom, 'lifecycle.validFrom') ? { validFrom: lifecycle.validFrom } : {}),
      ...(isoDate(lifecycle.validUntil, 'lifecycle.validUntil') ? { validUntil: lifecycle.validUntil } : {}),
    },
    hierarchy: { kind: hierarchyKind },
    security: {
      contentTrust,
      allowedActions: actionNames(security.allowedActions, 'security.allowedActions'),
      allowedResources: resourcePatterns(security.allowedResources, 'security.allowedResources'),
      deniedResources: resourcePatterns(security.deniedResources, 'security.deniedResources'),
      approvalRequiredFor: actionNames(security.approvalRequiredFor, 'security.approvalRequiredFor'),
      approvers: stringArray(security.approvers, 'security.approvers'),
    },
    links: (value.links || []).map(normalizeLink),
  };
}

// Recover { projectId, taskId } from a link URL. Handles the TickTick native
// deep link (…/#p/<proj>/tasks/<task>) and the generic <scheme>://<proj>/<task>
// form adapters emit from urlFor(). Returns null when neither matches — such a
// link stays visible to a human but is not added to the typed-link model.
function parseRef(url) {
  if (typeof url !== 'string' || !url) return null;
  // TickTick native deep link: …/#p/<projectId>/tasks/<taskId>
  let m = url.match(/#p\/([^/\s]+)\/tasks\/([^/?#\s)]+)/);
  if (m) return { projectId: m[1], taskId: m[2] };
  // Generic adapter deep link ending in …/<projectId>/<taskId>.
  m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
  if (!m) return null;
  const segments = m[1].split(/[?#]/)[0].split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  return { projectId: segments[segments.length - 2], taskId: segments[segments.length - 1] };
}

function parseRelatedSection(text) {
  const section = String(text || '').match(RELATED_SECTION_RE);
  if (!section) return [];
  const links = [];
  for (const raw of section[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(RELATED_LINE_RE);
    if (!m) continue;
    const [, type, title, url] = m;
    if (!LINK_TYPES.includes(type)) continue;
    const ref = parseRef(url);
    if (!ref) continue;
    links.push({ type, projectId: ref.projectId, taskId: ref.taskId, title: title.trim(), url: url.trim() });
  }
  return links;
}

function renderRelatedSection(links) {
  if (!links || links.length === 0) return '';
  const lines = links.map((link) => {
    // Prefer the adapter's real deep link; fall back to a parseable ref so a
    // link added without a url (e.g. a direct writeTaskMetadata call) still
    // round-trips its projectId/taskId.
    const href = link.url || `ats://task/${link.projectId}/${link.taskId}`;
    // Bracket chars in the label would break the markdown link, so soften them
    // to parens — keeps the link well-formed and clickable. The URL carries the
    // canonical id, so the display label can be lossy.
    const label = String(link.title || link.taskId).replace(/[[\]]/g, (ch) => (ch === '[' ? '(' : ')'));
    return `- ${link.type}: [${label}](${href})`;
  });
  return `${RELATED_HEADING}\n${lines.join('\n')}`;
}

function stripRelatedSection(text) {
  return String(text || '').replace(RELATED_SECTION_RE, (match) => (match.startsWith('\n') ? '\n' : ''));
}

function mergeLinks(primary, secondary) {
  const merged = [];
  const seen = new Set();
  for (const link of [...primary, ...secondary]) {
    if (!link || typeof link !== 'object') continue;
    const key = `${link.type}|${link.projectId}|${link.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(link);
  }
  return merged;
}

export function parseTaskMetadata(content = '') {
  const text = String(content || '');
  const matches = [...text.matchAll(BLOCK_RE)];
  const markerCount = text.split(BLOCK_START).length - 1;
  const endCount = text.split(BLOCK_END).length - 1;
  let parsed = {};
  if (markerCount !== 0 || endCount !== 0) {
    if (markerCount !== 1 || endCount !== 1 || matches.length !== 1) {
      throw new Error('Malformed ATS context block. Repair it before ATS writes metadata.');
    }
    try {
      parsed = JSON.parse(matches[0][1]);
    } catch (err) {
      throw new Error(`Malformed ATS context JSON: ${err.message}`, { cause: err });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return normalizeTaskMetadata(parsed);
  }
  // Links now live in the "## Related" section. Legacy links still inside the
  // machine block are read for back-compat and migrate to Related on next write.
  const legacyLinks = Array.isArray(parsed.links) ? parsed.links : [];
  const relatedLinks = parseRelatedSection(text);
  return normalizeTaskMetadata({ ...parsed, links: mergeLinks(relatedLinks, legacyLinks) });
}

export function writeTaskMetadata(content = '', metadata = {}) {
  const text = String(content || '');
  const current = [...text.matchAll(BLOCK_RE)];
  const markerCount = text.split(BLOCK_START).length - 1;
  const endCount = text.split(BLOCK_END).length - 1;
  if ((markerCount > 0 || endCount > 0) && (markerCount !== 1 || endCount !== 1 || current.length !== 1)) {
    throw new Error('Malformed ATS context block. Repair it before ATS writes metadata.');
  }
  const normalized = normalizeTaskMetadata(metadata);
  const { links, ...machine } = normalized;
  let body = text.replace(BLOCK_RE, '');
  body = stripRelatedSection(body).trimEnd();
  const block = `${BLOCK_START}\n\`\`\`ats\n${JSON.stringify(machine, null, 2)}\n\`\`\`\n${BLOCK_END}`;
  const related = renderRelatedSection(links);
  const parts = [];
  if (body) parts.push(body);
  if (related) parts.push(related);
  parts.push(block);
  return parts.join('\n\n');
}

export function evaluateLifecycle(metadata, { now = new Date(), supersededBy = [] } = {}) {
  const normalized = normalizeTaskMetadata(metadata);
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error('Lifecycle evaluation requires a valid date.');
  const reasons = [];
  if (normalized.lifecycle.status !== 'active') reasons.push(`status:${normalized.lifecycle.status}`);
  const from = normalized.lifecycle.validFrom && /^\d{4}-\d{2}-\d{2}$/.test(normalized.lifecycle.validFrom)
    ? new Date(`${normalized.lifecycle.validFrom}T00:00:00.000Z`)
    : normalized.lifecycle.validFrom ? new Date(normalized.lifecycle.validFrom) : null;
  const until = normalized.lifecycle.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(normalized.lifecycle.validUntil)
    ? new Date(`${normalized.lifecycle.validUntil}T23:59:59.999Z`)
    : normalized.lifecycle.validUntil ? new Date(normalized.lifecycle.validUntil) : null;
  if (from && at < from) reasons.push('not-yet-valid');
  if (until && at > until) reasons.push('expired');
  if (supersededBy.length > 0) reasons.push('superseded-by-link');
  return {
    ...normalized.lifecycle,
    valid: reasons.length === 0,
    reasons,
    supersededBy,
    evaluatedAt: at.toISOString(),
  };
}

const refKey = (projectId, taskId) => `${projectId}/${taskId}`;

function adapterLinksForTask(task) {
  if (task?.links === undefined) return [];
  if (!Array.isArray(task.links)) throw new Error('Adapter task links must be an array.');
  return task.links.map(normalizeLink);
}

export function taskMetadataForRead(task) {
  const metadata = parseTaskMetadata(task?.content || '');
  const links = [...metadata.links];
  const known = new Set(links.map((link) => `${link.type}|${link.projectId}|${link.taskId}`));
  for (const link of adapterLinksForTask(task)) {
    const key = `${link.type}|${link.projectId}|${link.taskId}`;
    if (known.has(key)) continue;
    links.push(link);
    known.add(key);
  }
  return { ...metadata, links };
}

function metadataForTask(task) {
  return taskMetadataForRead(task);
}

async function updateMetadata(adapter, projectId, taskId, mutate) {
  const task = await adapter.getTask(projectId, taskId);
  const metadata = parseTaskMetadata(task?.content || '');
  const next = normalizeTaskMetadata(await mutate(metadata, task));
  const updated = await adapter.updateTask(projectId, taskId, {
    content: writeTaskMetadata(task.content || '', next),
  });
  return { task: updated, metadata: next };
}

export async function setTaskIntent(adapter, projectId, taskId, patch) {
  return updateMetadata(adapter, projectId, taskId, (metadata) => ({
    ...metadata,
    intent: { ...metadata.intent, ...patch },
  }));
}

export async function setTaskLifecycle(adapter, projectId, taskId, patch) {
  return updateMetadata(adapter, projectId, taskId, (metadata) => ({
    ...metadata,
    lifecycle: { ...metadata.lifecycle, ...patch },
  }));
}

export async function setTaskSecurity(adapter, projectId, taskId, patch) {
  return updateMetadata(adapter, projectId, taskId, (metadata) => ({
    ...metadata,
    security: { ...metadata.security, ...patch },
  }));
}

function taskRef(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a task reference.`);
  }
  const projectId = optionalString(value.projectId, `${field}.projectId`);
  const taskId = optionalString(value.taskId, `${field}.taskId`);
  if (!projectId || !taskId) throw new Error(`${field} needs projectId and taskId.`);
  return { projectId, taskId };
}

function linkedRef(adapter, target, type, targetTask, createdAt = new Date().toISOString()) {
  // Use the resolved task's canonical ids (the adapter contract returns full
  // ids), not the raw input ref which may be a short id — the deep link must
  // carry full ids to resolve in the storage app.
  const projectId = targetTask.projectId || target.projectId;
  const taskId = targetTask.id || target.taskId;
  return {
    type,
    projectId,
    taskId,
    title: targetTask.title,
    url: adapter.urlFor({ projectId, taskId }),
    createdAt,
  };
}

export async function setTaskHierarchy(adapter, projectId, taskId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Hierarchy patch must be an object.');
  const kind = patch.kind === undefined ? undefined : optionalString(patch.kind, 'hierarchy.kind');
  if (kind !== undefined && !HIERARCHY_KINDS.includes(kind)) {
    throw new Error(`ATS hierarchy kind must be one of: ${HIERARCHY_KINDS.join(', ')}.`);
  }
  const parent = patch.parent === undefined || patch.parent === null ? patch.parent : taskRef(patch.parent, 'hierarchy.parent');
  let parentTask;
  if (parent) {
    if (parent.projectId === projectId && parent.taskId === taskId) throw new Error('A task cannot be its own parent.');
    parentTask = await adapter.getTask(parent.projectId, parent.taskId);
  }
  return updateMetadata(adapter, projectId, taskId, (metadata) => {
    let links = metadata.links;
    if (patch.parent !== undefined) {
      links = links.filter((link) => link.type !== 'parent');
      if (parent) links = [...links, linkedRef(adapter, parent, 'parent', parentTask)];
    }
    return {
      ...metadata,
      hierarchy: { kind: kind ?? metadata.hierarchy.kind },
      links,
    };
  });
}

export async function promoteExploration(adapter, source, input = {}) {
  const sourceRef = taskRef(source, 'promotion.source');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Promotion input must be an object.');
  const sourceTask = await adapter.getTask(sourceRef.projectId, sourceRef.taskId);
  const projectId = optionalString(input.projectId, 'promotion.projectId') || sourceRef.projectId;
  const outcome = optionalString(input.outcome, 'promotion.outcome');
  if (!outcome) throw new Error('Promotion requires an explicit outcome.');
  const doneWhen = stringArray(input.doneWhen, 'promotion.doneWhen');
  if (doneWhen.length === 0) throw new Error('Promotion requires at least one completion condition.');
  const kind = optionalString(input.kind, 'promotion.kind') || 'task';
  if (!['goal', 'project', 'task'].includes(kind)) throw new Error('Promotion kind must be goal, project, or task.');
  const parent = input.parent === undefined || input.parent === null ? null : taskRef(input.parent, 'promotion.parent');
  let parentTask;
  if (parent) parentTask = await adapter.getTask(parent.projectId, parent.taskId);
  const createdAt = new Date().toISOString();
  const metadata = normalizeTaskMetadata({
    hierarchy: { kind },
    intent: {
      outcome,
      why: optionalString(input.why, 'promotion.why') || '',
      doneWhen,
      authority: stringArray(input.authority, 'promotion.authority'),
      constraints: stringArray(input.constraints, 'promotion.constraints'),
      approvalRequired: input.approvalRequired ?? false,
    },
    links: [
      linkedRef(adapter, sourceRef, 'evidence', sourceTask, createdAt),
      ...(parent ? [linkedRef(adapter, parent, 'parent', parentTask, createdAt)] : []),
    ],
  });
  const task = await adapter.createTask({
    projectId,
    title: optionalString(input.title, 'promotion.title') || sourceTask.title,
    content: writeTaskMetadata(optionalString(input.content, 'promotion.content') || '', metadata),
    ...(input.tags === undefined ? {} : { tags: stringArray(input.tags, 'promotion.tags') }),
    ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  });
  return {
    source: { projectId: sourceTask.projectId, taskId: sourceTask.id, title: sourceTask.title },
    task,
    metadata,
  };
}

function matchesPattern(pattern, value) {
  if (pattern === '*') return true;
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function matchesAny(patterns, value) {
  return patterns.find((pattern) => matchesPattern(pattern, value));
}

export function evaluateTaskAccess(metadata, request = {}, { now = new Date() } = {}) {
  const input = request && typeof request === 'object' ? request : {};
  const normalized = normalizeTaskMetadata(metadata);
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  const resource = typeof input.resource === 'string' ? input.resource.trim() : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const approvals = input.approvals === undefined ? [] : stringArray(input.approvals, 'access.approvals');
  const lifecycle = evaluateLifecycle(normalized, { now });
  const policy = normalized.security;
  const reasons = [];
  if (!action) reasons.push('action-required');
  if (!resource) reasons.push('resource-required');
  if (!reason) reasons.push('reason-required');
  if (!lifecycle.valid) reasons.push('task-context-invalid');

  const actionAllowed = action && matchesAny(policy.allowedActions, action);
  if (action && !actionAllowed) reasons.push('action-not-allowed');
  const deniedPattern = resource && matchesAny(policy.deniedResources, resource);
  const allowedPattern = resource && matchesAny(policy.allowedResources, resource);
  if (deniedPattern) reasons.push('resource-denied');
  if (resource && !allowedPattern) reasons.push('resource-not-allowed');

  const approvalByPolicy = action && Boolean(matchesAny(policy.approvalRequiredFor, action));
  const approvalByIntent = normalized.intent.approvalRequired;
  const approvalByTrust = policy.contentTrust === 'untrusted'
    ? ['write', 'execute', 'network', 'secret'].includes(action)
    : policy.contentTrust === 'mixed' && ['execute', 'secret'].includes(action);
  const requiresApproval = Boolean(approvalByPolicy || approvalByIntent || approvalByTrust);
  let approvalSatisfied = !requiresApproval;
  if (requiresApproval && approvals.length > 0) {
    approvalSatisfied = policy.approvers.length === 0 || approvals.some((approval) => policy.approvers.includes(approval));
  }
  if (requiresApproval && !approvalSatisfied) reasons.push('approval-required');

  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(evaluatedAt.getTime())) throw new Error('Access evaluation requires a valid date.');
  return {
    allowed: reasons.length === 0,
    reasons,
    request: { action, resource, reason, approvals },
    contentTrust: policy.contentTrust,
    contentHandling: contentHandling(policy.contentTrust),
    requiresApproval,
    approvalSatisfied,
    matchedAllowPattern: allowedPattern || null,
    matchedDenyPattern: deniedPattern || null,
    lifecycle,
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

export async function checkTaskAccess(adapter, projectId, taskId, request, options = {}) {
  const input = request && typeof request === 'object' ? request : {};
  const task = await adapter.getTask(projectId, taskId);
  const metadata = metadataForTask(task);
  const decision = evaluateTaskAccess(metadata, input, { now: options.now });
  let audit;
  try {
    audit = recordAction({
      agent: options.agent || input.agent || process.env.ATS_AGENT_ID || 'unknown-agent',
      action: decision.allowed ? 'access.allowed' : 'access.denied',
      task: { projectId, taskId },
      sources: [`task://${projectId}/${taskId}`],
      approvals: decision.request.approvals,
      output: decision.allowed ? 'allowed' : 'denied',
      advanced: false,
      metadata: {
        access: {
          action: decision.request.action,
          resource: decision.request.resource,
          reason: decision.request.reason,
        },
        decision: {
          allowed: decision.allowed,
          reasons: decision.reasons,
          contentTrust: decision.contentTrust,
          requiresApproval: decision.requiresApproval,
        },
      },
    }, { logPath: options.logPath });
    if (!audit) throw new Error('Action ledger is disabled.');
  } catch (err) {
    throw new Error('Access denied because the decision could not be audited.', { cause: err });
  }
  return {
    task: { projectId: task.projectId, taskId: task.id, title: task.title },
    policy: metadata.security,
    decision,
    audit,
  };
}

export async function addTaskLink(adapter, source, target, type) {
  if (!LINK_TYPES.includes(type)) throw new Error(`Link type must be one of: ${LINK_TYPES.join(', ')}.`);
  const targetTask = await adapter.getTask(target.projectId, target.taskId);
  const ref = linkedRef(adapter, target, type, targetTask);
  return updateMetadata(adapter, source.projectId, source.taskId, (metadata) => {
    const duplicate = metadata.links.some((link) =>
      link.type === ref.type && link.projectId === ref.projectId && link.taskId === ref.taskId
    );
    if (duplicate) return metadata;
    return { ...metadata, links: [...metadata.links, ref] };
  });
}

export async function removeTaskLink(adapter, source, target, type) {
  if (!LINK_TYPES.includes(type)) throw new Error(`Link type must be one of: ${LINK_TYPES.join(', ')}.`);
  // Resolve the target to its canonical full ids so a short-id argument still
  // matches links stored with full ids. Fall back to the raw ref if the target
  // can no longer be fetched (e.g. it was deleted).
  let projectId = target.projectId;
  let taskId = target.taskId;
  try {
    const targetTask = await adapter.getTask(target.projectId, target.taskId);
    projectId = targetTask.projectId || projectId;
    taskId = targetTask.id || taskId;
  } catch {
    // keep the ids as given
  }
  let removed = false;
  const result = await updateMetadata(adapter, source.projectId, source.taskId, (metadata) => ({
    ...metadata,
    links: metadata.links.filter((link) => {
      const matches = link.type === type && link.projectId === projectId && link.taskId === taskId;
      if (matches) removed = true;
      return !matches;
    }),
  }));
  return { ...result, removed };
}

export async function listTaskLinks(adapter, projectId, taskId) {
  const task = await adapter.getTask(projectId, taskId);
  return { task: { id: task.id, projectId: task.projectId, title: task.title }, links: metadataForTask(task).links };
}

function inspectCorpus(corpus) {
  const tasks = new Map();
  const metadata = new Map();
  const errors = [];
  const errorsByKey = new Map();
  for (const task of corpus) {
    const key = refKey(task.projectId, task.id);
    tasks.set(key, task);
    try {
      metadata.set(key, metadataForTask(task));
    } catch (err) {
      const detail = { projectId: task.projectId, taskId: task.id, error: err.message };
      errors.push(detail);
      errorsByKey.set(key, detail);
      metadata.set(key, emptyMetadata());
    }
  }
  const incoming = new Map();
  const supersededBy = new Map();
  for (const [sourceKey, sourceMetadata] of metadata) {
    for (const link of sourceMetadata.links) {
      const targetKey = refKey(link.projectId, link.taskId);
      const edge = { sourceKey, targetKey, ...link };
      if (!incoming.has(targetKey)) incoming.set(targetKey, []);
      incoming.get(targetKey).push(edge);
      if (link.type === 'supersedes') {
        if (!supersededBy.has(targetKey)) supersededBy.set(targetKey, []);
        supersededBy.get(targetKey).push(sourceKey);
      }
    }
  }
  return { tasks, metadata, incoming, supersededBy, errors, errorsByKey };
}

function lifecycleForKey(key, state) {
  const lifecycle = evaluateLifecycle(state.metadata.get(key) || emptyMetadata(), {
    supersededBy: state.supersededBy.get(key) || [],
  });
  const metadataError = state.errorsByKey.get(key);
  if (!metadataError) return lifecycle;
  return { ...lifecycle, valid: false, reasons: ['metadata-error'], metadataError: metadataError.error };
}

function graphNode(key, state, fallback) {
  const task = state.tasks.get(key);
  const [projectId, taskId] = key.split('/');
  const metadata = state.metadata.get(key) || emptyMetadata();
  return {
    key,
    projectId: task?.projectId || fallback?.projectId || projectId,
    taskId: task?.id || fallback?.taskId || taskId,
    title: task?.title || fallback?.title || '(unresolved task)',
    missing: !task,
    intent: metadata.intent,
    hierarchy: metadata.hierarchy,
    security: { ...metadata.security, contentHandling: contentHandling(metadata.security.contentTrust) },
    lifecycle: lifecycleForKey(key, state),
  };
}

export async function buildTaskGraph(adapter, root, { depth = 2, cache = false } = {}) {
  const { corpus, fromCache, ageMs } = await loadCorpus(adapter, { cache });
  const state = inspectCorpus(corpus);
  const rootKey = refKey(root.projectId, root.taskId);
  if (!state.tasks.has(rootKey)) {
    const task = await adapter.getTask(root.projectId, root.taskId);
    state.tasks.set(rootKey, task);
    state.metadata.set(rootKey, metadataForTask(task));
  }
  const nodes = new Map();
  const edges = new Map();
  const queue = [{ key: rootKey, level: 0 }];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    nodes.set(current.key, graphNode(current.key, state));
    if (current.level >= depth) continue;
    const outgoing = state.metadata.get(current.key)?.links || [];
    const adjacent = [
      ...outgoing.map((link) => ({
        sourceKey: current.key,
        targetKey: refKey(link.projectId, link.taskId),
        ...link,
      })),
      ...(state.incoming.get(current.key) || []),
    ];
    for (const edge of adjacent) {
      const edgeKey = `${edge.sourceKey}|${edge.type}|${edge.targetKey}`;
      edges.set(edgeKey, edge);
      const nextKey = edge.sourceKey === current.key ? edge.targetKey : edge.sourceKey;
      const fallback = edge.targetKey === nextKey ? edge : undefined;
      nodes.set(nextKey, graphNode(nextKey, state, fallback));
      if (!visited.has(nextKey)) queue.push({ key: nextKey, level: current.level + 1 });
    }
  }
  return {
    root: rootKey,
    depth,
    corpus: { size: corpus.length, fromCache, ageMs },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    metadataErrors: state.errors,
  };
}

const VALID_PARENT_KINDS = Object.freeze({
  task: new Set(['project', 'goal']),
  project: new Set(['goal']),
  goal: new Set(['goal']),
  exploration: new Set(),
  unspecified: new Set(),
});

function hierarchyIssue(code, key, detail = {}) {
  return { code, key, ...detail };
}

export async function evaluateTaskHierarchy(adapter, root, { cache = false, maxDepth = 12, now = new Date() } = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) throw new Error('Hierarchy maxDepth must be an integer between 1 and 100.');
  const corpusInfo = await loadCorpus(adapter, { cache });
  const state = inspectCorpus(corpusInfo.corpus);
  const rootKey = refKey(root.projectId, root.taskId);
  if (!state.tasks.has(rootKey)) {
    const task = await adapter.getTask(root.projectId, root.taskId);
    state.tasks.set(rootKey, task);
    state.metadata.set(rootKey, metadataForTask(task));
  }

  const chain = [];
  const issues = [];
  const visited = new Set();
  let currentKey = rootKey;
  for (let level = 0; currentKey && level < maxDepth; level++) {
    if (visited.has(currentKey)) {
      issues.push(hierarchyIssue('cycle', currentKey));
      break;
    }
    visited.add(currentKey);
    const task = state.tasks.get(currentKey);
    if (!task) {
      issues.push(hierarchyIssue('missing-node', currentKey));
      break;
    }
    const metadata = state.metadata.get(currentKey) || emptyMetadata();
    const lifecycle = evaluateLifecycle(metadata, { now, supersededBy: state.supersededBy.get(currentKey) || [] });
    const parents = metadata.links.filter((link) => link.type === 'parent');
    chain.push({
      key: currentKey,
      projectId: task.projectId,
      taskId: task.id,
      title: task.title,
      kind: metadata.hierarchy.kind,
      intent: metadata.intent,
      lifecycle,
      parent: parents[0] || null,
    });
    if (metadata.hierarchy.kind === 'unspecified') issues.push(hierarchyIssue('kind-unspecified', currentKey));
    if (metadata.hierarchy.kind === 'exploration') issues.push(hierarchyIssue('not-execution-context', currentKey));
    if (!metadata.intent.outcome) issues.push(hierarchyIssue('outcome-missing', currentKey));
    if (metadata.hierarchy.kind === 'task' && metadata.intent.doneWhen.length === 0) {
      issues.push(hierarchyIssue('completion-criteria-missing', currentKey));
    }
    if (!lifecycle.valid) issues.push(hierarchyIssue('lifecycle-invalid', currentKey, { reasons: lifecycle.reasons }));
    if (parents.length > 1) issues.push(hierarchyIssue('multiple-parents', currentKey, { count: parents.length }));
    if (parents.length === 0) {
      if (['task', 'project'].includes(metadata.hierarchy.kind)) issues.push(hierarchyIssue('parent-missing', currentKey));
      currentKey = null;
      break;
    }
    const parent = parents[0];
    const parentKey = refKey(parent.projectId, parent.taskId);
    const parentTask = state.tasks.get(parentKey);
    if (!parentTask) {
      issues.push(hierarchyIssue('parent-unresolved', currentKey, { parentKey }));
      break;
    }
    const parentMetadata = state.metadata.get(parentKey) || emptyMetadata();
    if (!VALID_PARENT_KINDS[metadata.hierarchy.kind].has(parentMetadata.hierarchy.kind)) {
      issues.push(hierarchyIssue('invalid-parent-kind', currentKey, {
        childKind: metadata.hierarchy.kind,
        parentKind: parentMetadata.hierarchy.kind,
        parentKey,
      }));
    }
    currentKey = parentKey;
  }
  if (currentKey && chain.length >= maxDepth) issues.push(hierarchyIssue('max-depth-exceeded', currentKey, { maxDepth }));

  const chainKeys = new Set(chain.map((node) => node.key));
  const conflicts = new Map();
  for (const node of chain) {
    const metadata = state.metadata.get(node.key) || emptyMetadata();
    const outgoing = metadata.links
      .filter((link) => link.type === 'conflicts-with')
      .map((link) => ({ sourceKey: node.key, targetKey: refKey(link.projectId, link.taskId), direction: 'outgoing' }));
    const incoming = (state.incoming.get(node.key) || [])
      .filter((edge) => edge.type === 'conflicts-with')
      .map((edge) => ({ sourceKey: edge.sourceKey, targetKey: node.key, direction: 'incoming' }));
    for (const edge of [...outgoing, ...incoming]) {
      const otherKey = edge.sourceKey === node.key ? edge.targetKey : edge.sourceKey;
      if (chainKeys.has(otherKey)) continue;
      const otherTask = state.tasks.get(otherKey);
      if (!otherTask) {
        issues.push(hierarchyIssue('conflict-unresolved', node.key, { conflictKey: otherKey }));
        continue;
      }
      const lifecycle = evaluateLifecycle(state.metadata.get(otherKey) || emptyMetadata(), {
        now,
        supersededBy: state.supersededBy.get(otherKey) || [],
      });
      if (!lifecycle.valid) continue;
      conflicts.set(`${node.key}|${otherKey}`, {
        nodeKey: node.key,
        conflictKey: otherKey,
        projectId: otherTask.projectId,
        taskId: otherTask.id,
        title: otherTask.title,
        kind: state.metadata.get(otherKey)?.hierarchy.kind || 'unspecified',
        direction: edge.direction,
        lifecycle,
      });
    }
  }
  if (conflicts.size > 0) issues.push(hierarchyIssue('active-conflicts', rootKey, { count: conflicts.size }));

  const rootNode = chain[0];
  const supportsParent = Boolean(rootNode?.parent)
    && !issues.some((issue) => ['cycle', 'multiple-parents', 'parent-unresolved', 'invalid-parent-kind', 'outcome-missing', 'lifecycle-invalid'].includes(issue.code));
  const isTopLevelGoal = rootNode?.kind === 'goal' && !rootNode.parent;
  return {
    task: rootNode || { key: rootKey, projectId: root.projectId, taskId: root.taskId },
    aligned: Boolean((supportsParent || isTopLevelGoal) && issues.length === 0),
    supportsParent,
    chain,
    conflicts: [...conflicts.values()],
    issues,
    corpus: { size: corpusInfo.corpus.length, fromCache: corpusInfo.fromCache, ageMs: corpusInfo.ageMs },
    evaluatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

export async function contextForTask(adapter, root, { limit = 8, semanticLimit = 5, cache = false } = {}) {
  const corpusInfo = await loadCorpus(adapter, { cache });
  const corpus = corpusInfo.corpus;
  const state = inspectCorpus(corpus);
  const rootKey = refKey(root.projectId, root.taskId);
  let task = state.tasks.get(rootKey);
  if (!task) {
    task = await adapter.getTask(root.projectId, root.taskId);
    corpus.push(task);
    state.tasks.set(rootKey, task);
    state.metadata.set(rootKey, metadataForTask(task));
  }
  const rootMetadata = state.metadata.get(rootKey);
  const candidates = new Map();
  const unresolvedLinks = [];
  const addCandidate = (key, provenance) => {
    if (key === rootKey) return;
    const linkedTask = state.tasks.get(key);
    if (!linkedTask) {
      unresolvedLinks.push({ key, provenance });
      return;
    }
    const lifecycle = lifecycleForKey(key, state);
    const current = candidates.get(key) || { task: linkedTask, lifecycle, provenance: [] };
    current.provenance.push(provenance);
    candidates.set(key, current);
  };
  for (const link of rootMetadata.links) {
    addCandidate(refKey(link.projectId, link.taskId), { kind: 'typed-link', direction: 'outgoing', type: link.type });
  }
  for (const edge of state.incoming.get(rootKey) || []) {
    addCandidate(edge.sourceKey, { kind: 'typed-link', direction: 'incoming', type: edge.type });
  }

  const query = [task.title, rootMetadata.intent.outcome, rootMetadata.intent.why].filter(Boolean).join(' ');
  let retrieval = null;
  if (query) {
    retrieval = await find(query, {
      adapter,
      limit: Math.max(semanticLimit, limit),
      cache: false,
      explain: true,
      loadCorpus: async () => corpusInfo,
    });
    for (const result of retrieval.tasks || []) {
      addCandidate(refKey(result.projectId, result.id), {
        kind: 'retrieval',
        sources: result.sources || [],
        rrf: result.rrf,
        explain: result.explain,
      });
    }
  }

  const explicit = [];
  const discovered = [];
  const excluded = [];
  for (const candidate of candidates.values()) {
    if (!candidate.lifecycle.valid) {
      excluded.push({
        projectId: candidate.task.projectId,
        taskId: candidate.task.id,
        title: candidate.task.title,
        reasons: candidate.lifecycle.reasons,
      });
      continue;
    }
    const candidateMetadata = state.metadata.get(refKey(candidate.task.projectId, candidate.task.id));
    const item = {
      task: candidate.task,
      metadata: candidateMetadata,
      security: {
        ...candidateMetadata.security,
        contentHandling: contentHandling(candidateMetadata.security.contentTrust),
      },
      lifecycle: candidate.lifecycle,
      provenance: candidate.provenance,
    };
    if (candidate.provenance.some((entry) => entry.kind === 'typed-link')) explicit.push(item);
    else discovered.push(item);
  }
  const ordered = [...explicit, ...discovered].slice(0, limit);
  return {
    task,
    intent: rootMetadata.intent,
    hierarchy: rootMetadata.hierarchy,
    security: { ...rootMetadata.security, contentHandling: contentHandling(rootMetadata.security.contentTrust) },
    lifecycle: lifecycleForKey(rootKey, state),
    context: ordered,
    counts: { explicit: explicit.length, discovered: discovered.length, returned: ordered.length, excluded: excluded.length },
    excluded,
    unresolvedLinks,
    retrieval: retrieval ? { query: retrieval.query, branches: retrieval.branches, elapsedMs: retrieval.elapsedMs } : null,
    metadataErrors: state.errors,
  };
}
