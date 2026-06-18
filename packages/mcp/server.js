#!/usr/bin/env node
/**
 * ats-mcp — Model Context Protocol server for the Agentic Task System.
 *
 * Exposes the active ATS adapter (the task app you already use) to any MCP
 * client (Claude Desktop, Cursor, …) as a small set of tools backed by
 * @reneza/ats-core's hybrid + RRF retrieval. Storage-agnostic: works over ANY
 * adapter that satisfies the ATS contract — generic adapters get keyword +
 * native + RRF for free; embedder-backed adapters (e.g. TickTick) get the full
 * dense/sparse hybrid.
 *
 * Adapter resolution mirrors the CLI: ATS_ADAPTER env, else
 * ~/.config/ats/adapter (one line: the adapter package name), else
 * @reneza/ats-adapter-ticktick.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  validateAdapter,
  find as coreFind,
  similar as coreSimilar,
  logUsage,
  parseTaskMetadata,
  taskMetadataForRead,
  setTaskIntent,
  setTaskLifecycle,
  setTaskSecurity,
  setTaskHierarchy,
  promoteExploration,
  checkTaskAccess,
  addTaskLink,
  removeTaskLink,
  addTaskReference,
  removeTaskReference,
  listTaskReferences,
  buildTaskGraph,
  evaluateTaskHierarchy,
  contextForTask,
  recordAction,
  listActions,
  snapshotTaskEvents,
  collectAndSpoolTaskEvents,
  listPendingTaskEvents,
  acknowledgeTaskEvents,
} from '@reneza/ats-core';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

function atsConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const cur = path.join(base, 'ats');
  const legacy = path.join(base, 'akb');
  return !fs.existsSync(cur) && fs.existsSync(legacy) ? legacy : cur;
}

export async function loadAdapter() {
  let pkg = process.env.ATS_ADAPTER;
  const configPath = path.join(atsConfigDir(), 'adapter');
  if (!pkg && fs.existsSync(configPath)) pkg = fs.readFileSync(configPath, 'utf8').trim();
  if (!pkg) pkg = '@reneza/ats-adapter-ticktick';
  const mod = await import(pkg);
  return { adapter: validateAdapter(mod.default || mod), pkg };
}

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (err) => ({
  content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
  isError: true,
});

function taskRefFromResult(result, fallback = {}) {
  const task = result?.task || result || {};
  return {
    projectId: task.fullProjectId || task.projectId || fallback.projectId,
    taskId: task.fullId || task.id || fallback.taskId,
  };
}

function auditWrite(action, result, fallback, agent, metadata, advanced = false) {
  const task = taskRefFromResult(result, fallback);
  if (!task.projectId || !task.taskId) return;
  try {
    recordAction({ agent: agent || process.env.ATS_AGENT_ID || 'ats-mcp', action, task, advanced, metadata });
  } catch (err) {
    console.error(`[ats-mcp] action ledger warning: ${err.message}`);
  }
}

/**
 * Register the ATS tool set on a fresh McpServer for the given adapter.
 * Pure (no I/O until a tool is called) so it can be unit-tested with a fake
 * adapter and no transport.
 *
 * @param {object} adapter - an object satisfying the ATS adapter contract
 * @returns {McpServer}
 */
export function createServer(adapter) {
  const ext = adapter.__ext || {};
  const server = new McpServer({ name: 'ats', version: VERSION }, {
    instructions: [
      'ATS manages three regions of a task body, and you should keep them current as you work — add-only.',
      '1) YAML frontmatter at the top: intent (outcome/why/done-when), plus lifecycle/security/hierarchy.',
      '2) A "## Related" section: typed links to other ACTIVE or note tasks. This graph complements `find`',
      '   (semantic/keyword search) and helps a human navigate — so populate it from what you discover.',
      '3) A "## References" section: external URLs and reference notes the task consults.',
      '',
      'Default workflow when given a task to work on:',
      '- Read first with `context_for_task` (returns intent, related links, and references).',
      '- Refine intent with `set_task_intent`. Discover related work with `find`/`similar`, then record it:',
      '  `add_task_link` for relationships to active tasks (use `related` for a plain/up-link, or a typed',
      '  relation like supports/depends-on/parent), and `add_task_reference` for URLs and notes you consulted.',
      '- These tools auto-create the sections on a new task, so the pattern grows into existing tasks over time.',
      '',
      'Add-only and conflict-safe — never destroy human or historical context:',
      '- Never remove a Related link just because its target was completed; completed links stay.',
      '- Never drop a row a human added by hand; ATS preserves rows it does not manage.',
      '- Only remove a row on an explicit request, via `remove_task_link` / `remove_task_reference`.',
      '- A completed task cannot be ADDED as a Related link (Related is active/note tasks only).',
      '- Prefer these typed tools over `update_task(content=...)`, which bypasses this management and can clobber metadata.',
    ].join('\n'),
  });

  server.tool(
    'find',
    'Read-only. Search the task store by free-text QUERY using available adapter signals plus Core keyword retrieval, fused via Reciprocal Rank Fusion. Adapters with embeddings add dense+sparse hybrid retrieval. Returns best-matching items with provenance. Use this for "what do I have about X". To find items like a KNOWN item instead, use `similar`. Read-only: never writes.',
    {
      query: z.string().describe('Free-text search string, e.g. "auth retry logic" or "Q3 roadmap". Matched against titles and bodies.'),
      limit: z.number().int().positive().max(50).optional().describe('Maximum number of results to return. Default 5, hard cap 50.'),
      explain: z
        .boolean()
        .optional()
        .describe(
          'Attach a per-result ranking breakdown: for each retriever that surfaced a result, its rank and RRF contribution (1/(k+rank)), which sum to the fused score. Use to justify why a result ranked where it did.'
        ),
    },
    async ({ query, limit, explain }) => {
      try {
        // Prefer the adapter's enriched find (embedder + store-specific
        // branches); fall back to core's generic fan-out over the contract.
        const opts = { limit: limit ?? 5, explain: !!explain };
        const result = ext.tasks?.find
          ? await ext.tasks.find(query, opts)
          : await coreFind(query, { adapter, ...opts, log: logUsage });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'get_task',
    'Read-only. Fetch one item (task/note) by its project id + task id, including the full markdown body, tags, and due date. Use after `find`/`list_projects` give you the ids. Returns the single item object, or an error if not found.',
    {
      projectId: z.string().describe('Id of the project/folder the item lives in (from `find` results or `list_projects`).'),
      taskId: z.string().describe('Id of the item to fetch (from `find` results).'),
    },
    async ({ projectId, taskId }) => {
      try {
        return ok(await adapter.getTask(projectId, taskId));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'list_projects',
    'Read-only. List the projects / folders in the store, each with its id and name. Call this first to discover the projectId you need for `get_task`, `create_task`, or `update_task`. Returns an array of { id, name }.',
    {},
    async () => {
      try {
        return ok(await adapter.listProjects());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'create_task',
    'WRITE. Creates a new item (task/note) in the store — the agent→human write side of the two-way bus. Use to hand the human a note, action, or reminder. Side effect: a new item appears in their task app immediately. Returns the created item including its new id. To change an existing item instead, use `update_task`.',
    {
      title: z.string().describe('Short title / headline for the new item. Required.'),
      content: z.string().optional().describe('Markdown body of the item. Optional.'),
      projectId: z.string().optional().describe('Id of the target project (from `list_projects`). Omit to drop into the inbox/default project.'),
      tags: z.array(z.string()).optional().describe('Tags/labels to attach, without a leading "#", e.g. ["agent", "review"].'),
      dueDate: z.string().optional().describe('Due date as an ISO 8601 string, e.g. "2026-06-15" or "2026-06-15T09:00:00Z".'),
      agent: z.string().optional().describe('Agent identity for the append-only ATS action ledger.'),
    },
    async ({ agent, ...input }) => {
      try {
        const result = await adapter.createTask(input);
        auditWrite('task.created', result, { projectId: input.projectId }, agent, { title: input.title });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'update_task',
    'WRITE. Patches an existing item (partial update) — only the fields you provide change; omitted fields are left untouched. Side effect: the item is modified in the human\'s task app. Requires the item\'s projectId + taskId (get them from `find` or `list_projects`). Returns the updated item. To create a new item instead, use `create_task`.',
    {
      projectId: z.string().describe('Id of the project the item lives in (from `find`/`list_projects`).'),
      taskId: z.string().describe('Id of the item to update (from `find`).'),
      title: z.string().optional().describe('New title. Omit to leave the title unchanged.'),
      content: z.string().optional().describe('New markdown body. Omit to leave the body unchanged. Note: replaces the body, does not append.'),
      tags: z.array(z.string()).optional().describe('Replacement tag set (without leading "#"). Omit to leave tags unchanged.'),
      dueDate: z.string().optional().describe('New due date as an ISO 8601 string. Omit to leave the due date unchanged.'),
      agent: z.string().optional().describe('Agent identity for the append-only ATS action ledger.'),
    },
    async ({ projectId, taskId, agent, ...patch }) => {
      try {
        const result = await adapter.updateTask(projectId, taskId, patch);
        auditWrite('task.updated', result, { projectId, taskId }, agent, { fields: Object.keys(patch) });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'set_task_intent',
    'WRITE. Adds or updates portable execution intent inside the task body: desired outcome, why it matters, completion conditions, authority, constraints, and approval requirement. Preserves the human-authored body and works through every ATS adapter.',
    {
      projectId: z.string(),
      taskId: z.string(),
      outcome: z.string().optional(),
      why: z.string().optional(),
      doneWhen: z.array(z.string()).optional(),
      authority: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      approvalRequired: z.boolean().optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, agent, ...patch }) => {
      try {
        const result = await setTaskIntent(adapter, projectId, taskId, patch);
        auditWrite('task.intent.updated', result, { projectId, taskId }, agent, { fields: Object.keys(patch) });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'set_task_lifecycle',
    'WRITE. Sets portable lifecycle state and validity windows. Archived, expired, future, and superseded tasks are excluded by context assembly.',
    {
      projectId: z.string(),
      taskId: z.string(),
      status: z.enum(['active', 'archived', 'superseded']).optional(),
      validFrom: z.string().optional(),
      validUntil: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, agent, ...patch }) => {
      try {
        const result = await setTaskLifecycle(adapter, projectId, taskId, patch);
        auditWrite('task.lifecycle.updated', result, { projectId, taskId }, agent, { fields: Object.keys(patch) });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'promote_exploration',
    'WRITE. Creates a committed execution item from exploratory material. The source body is not copied; the new item receives explicit outcome/completion metadata and an evidence link back to the source.',
    {
      sourceProjectId: z.string(),
      sourceTaskId: z.string(),
      targetProjectId: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      kind: z.enum(['goal', 'project', 'task']).optional(),
      outcome: z.string(),
      why: z.string().optional(),
      doneWhen: z.array(z.string()).min(1),
      authority: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      approvalRequired: z.boolean().optional(),
      parentProjectId: z.string().optional(),
      parentTaskId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      dueDate: z.string().optional(),
      priority: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ sourceProjectId, sourceTaskId, targetProjectId, parentProjectId, parentTaskId, agent, ...input }) => {
      try {
        if (Boolean(parentProjectId) !== Boolean(parentTaskId)) throw new Error('parentProjectId and parentTaskId must be provided together.');
        const result = await promoteExploration(adapter, { projectId: sourceProjectId, taskId: sourceTaskId }, {
          ...input,
          projectId: targetProjectId,
          ...(parentProjectId ? { parent: { projectId: parentProjectId, taskId: parentTaskId } } : {}),
        });
        auditWrite('task.promoted', result, { projectId: result.task.projectId, taskId: result.task.id }, agent, {
          source: result.source,
          kind: result.metadata.hierarchy.kind,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'get_task_hierarchy',
    'Read-only. Returns the item role and its explicit parent relationship. Roles are exploration, goal, project, task, or unspecified.',
    { projectId: z.string(), taskId: z.string() },
    async ({ projectId, taskId }) => {
      try {
        const task = await adapter.getTask(projectId, taskId);
        const metadata = taskMetadataForRead(task);
        return ok({
          task: { projectId: task.projectId, taskId: task.id, title: task.title },
          hierarchy: metadata.hierarchy,
          parent: metadata.links.find((link) => link.type === 'parent') || null,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'set_task_hierarchy',
    'WRITE. Assigns an exploration/goal/project/task role and optionally replaces or clears the single explicit parent relationship.',
    {
      projectId: z.string(),
      taskId: z.string(),
      kind: z.enum(['exploration', 'goal', 'project', 'task']).optional(),
      parentProjectId: z.string().optional(),
      parentTaskId: z.string().optional(),
      clearParent: z.boolean().optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, kind, parentProjectId, parentTaskId, clearParent, agent }) => {
      try {
        if (clearParent && (parentProjectId || parentTaskId)) throw new Error('clearParent cannot be combined with parent fields.');
        if (Boolean(parentProjectId) !== Boolean(parentTaskId)) throw new Error('parentProjectId and parentTaskId must be provided together.');
        const patch = {};
        if (kind !== undefined) patch.kind = kind;
        if (clearParent) patch.parent = null;
        else if (parentProjectId) patch.parent = { projectId: parentProjectId, taskId: parentTaskId };
        if (Object.keys(patch).length === 0) throw new Error('A hierarchy field is required.');
        const result = await setTaskHierarchy(adapter, projectId, taskId, patch);
        auditWrite('task.hierarchy.updated', result, { projectId, taskId }, agent, { fields: Object.keys(patch) });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'evaluate_task_hierarchy',
    'Read-only. Deterministically checks whether a task still supports its parent objective and reports invalid role ordering, missing intent, cycles, invalid lifecycle state, and active explicit conflicts.',
    {
      projectId: z.string(),
      taskId: z.string(),
      maxDepth: z.number().int().min(1).max(100).optional(),
    },
    async ({ projectId, taskId, maxDepth }) => {
      try {
        return ok(await evaluateTaskHierarchy(adapter, { projectId, taskId }, { maxDepth: maxDepth ?? 12 }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'get_task_security',
    'Read-only. Returns the portable trust, action, resource, denial, approval, and approver policy for one task. Unconfigured tasks default to untrusted content and no granted access.',
    {
      projectId: z.string(),
      taskId: z.string(),
    },
    async ({ projectId, taskId }) => {
      try {
        const task = await adapter.getTask(projectId, taskId);
        return ok({ task: { projectId: task.projectId, taskId: task.id, title: task.title }, security: parseTaskMetadata(task.content).security });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'set_task_security',
    'WRITE. Sets a portable task security policy. This policy is a decision point for cooperating clients; it does not sandbox unrelated external tools.',
    {
      projectId: z.string(),
      taskId: z.string(),
      contentTrust: z.enum(['trusted', 'untrusted', 'mixed']).optional(),
      allowedActions: z.array(z.string()).optional(),
      allowedResources: z.array(z.string()).optional(),
      deniedResources: z.array(z.string()).optional(),
      approvalRequiredFor: z.array(z.string()).optional(),
      approvers: z.array(z.string()).optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, agent, ...patch }) => {
      try {
        const result = await setTaskSecurity(adapter, projectId, taskId, patch);
        auditWrite('task.security.updated', result, { projectId, taskId }, agent, { fields: Object.keys(patch) });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'check_task_access',
    'WRITE/AUDIT. Evaluates one task-scoped access request and appends an allow or deny record. Requires an action, resource, and reason. Denial wins over allowance; untrusted high-risk actions and configured boundaries require approval. Fails closed if auditing fails.',
    {
      projectId: z.string(),
      taskId: z.string(),
      action: z.string(),
      resource: z.string(),
      reason: z.string(),
      approvals: z.array(z.string()).optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, ...request }) => {
      try {
        return ok(await checkTaskAccess(adapter, projectId, taskId, request));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'add_task_link',
    'WRITE. Adds a typed relationship from one task to another. Types express dependencies, evidence, decisions, outputs, supersession, support, or a general relation.',
    {
      sourceProjectId: z.string(),
      sourceTaskId: z.string(),
      targetProjectId: z.string(),
      targetTaskId: z.string(),
      type: z.enum(['blocks', 'depends-on', 'parent', 'conflicts-with', 'supports', 'evidence', 'decision', 'output', 'supersedes', 'related']),
      agent: z.string().optional(),
    },
    async ({ sourceProjectId, sourceTaskId, targetProjectId, targetTaskId, type, agent }) => {
      try {
        const result = await addTaskLink(
          adapter,
          { projectId: sourceProjectId, taskId: sourceTaskId },
          { projectId: targetProjectId, taskId: targetTaskId },
          type
        );
        auditWrite('task.link.added', result, { projectId: sourceProjectId, taskId: sourceTaskId }, agent, {
          type,
          target: { projectId: targetProjectId, taskId: targetTaskId },
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'remove_task_link',
    'WRITE. Removes one exact typed relationship from a source task. Returns removed=false when the relationship was already absent.',
    {
      sourceProjectId: z.string(),
      sourceTaskId: z.string(),
      targetProjectId: z.string(),
      targetTaskId: z.string(),
      type: z.enum(['blocks', 'depends-on', 'parent', 'conflicts-with', 'supports', 'evidence', 'decision', 'output', 'supersedes', 'related']),
      agent: z.string().optional(),
    },
    async ({ sourceProjectId, sourceTaskId, targetProjectId, targetTaskId, type, agent }) => {
      try {
        const result = await removeTaskLink(
          adapter,
          { projectId: sourceProjectId, taskId: sourceTaskId },
          { projectId: targetProjectId, taskId: targetTaskId },
          type
        );
        auditWrite('task.link.removed', result, { projectId: sourceProjectId, taskId: sourceTaskId }, agent, {
          type,
          target: { projectId: targetProjectId, taskId: targetTaskId },
          removed: result.removed,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'add_task_reference',
    'WRITE. Adds a resource the task consults (an external URL or a reference note) to its "## References" section. Use this for links and supporting notes; use add_task_link for relationships to other active tasks. Re-adding the same url updates its title/desc.',
    {
      projectId: z.string(),
      taskId: z.string(),
      url: z.string(),
      title: z.string().optional(),
      desc: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, url, title, desc, agent }) => {
      try {
        const result = await addTaskReference(adapter, { projectId, taskId }, { url, title, desc });
        auditWrite('task.reference.added', result, { projectId, taskId }, agent, { url });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'remove_task_reference',
    'WRITE. Removes a reference (by url) from a task\'s "## References" section. Returns removed=false when the url was already absent.',
    {
      projectId: z.string(),
      taskId: z.string(),
      url: z.string(),
      agent: z.string().optional(),
    },
    async ({ projectId, taskId, url, agent }) => {
      try {
        const result = await removeTaskReference(adapter, { projectId, taskId }, url);
        auditWrite('task.reference.removed', result, { projectId, taskId }, agent, { url, removed: result.removed });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'list_task_references',
    'Read-only. Lists the resources (external URLs and reference notes) in a task\'s "## References" section.',
    {
      projectId: z.string(),
      taskId: z.string(),
    },
    async ({ projectId, taskId }) => {
      try {
        return ok(await listTaskReferences(adapter, projectId, taskId));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'task_graph',
    'Read-only. Traverses typed incoming and outgoing task relationships around one task. Returns nodes, edges, lifecycle validity, and unresolved references.',
    {
      projectId: z.string(),
      taskId: z.string(),
      depth: z.number().int().min(0).max(10).optional(),
    },
    async ({ projectId, taskId, depth }) => {
      try {
        return ok(await buildTaskGraph(adapter, { projectId, taskId }, { depth: depth ?? 2 }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'context_for_task',
    'Read-only. Builds execution context for a task. Typed relationships come first, retrieval adds candidates, invalid lifecycle items are excluded, and every included item carries provenance.',
    {
      projectId: z.string(),
      taskId: z.string(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ projectId, taskId, limit }) => {
      try {
        return ok(await contextForTask(adapter, { projectId, taskId }, { limit: limit ?? 8 }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'record_action',
    'WRITE. Appends an auditable agent action or outcome to the local ATS JSONL ledger, including sources, approvals, output, and whether the task advanced.',
    {
      projectId: z.string(),
      taskId: z.string(),
      action: z.string(),
      agent: z.string().optional(),
      sources: z.array(z.string()).optional(),
      approvals: z.array(z.string()).optional(),
      output: z.string().optional(),
      advanced: z.boolean().optional(),
    },
    async ({ projectId, taskId, ...entry }) => {
      try {
        return ok(recordAction({ ...entry, task: { projectId, taskId } }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'list_actions',
    'Read-only. Lists action-ledger records, optionally filtered by task, agent, action, or advancement.',
    {
      projectId: z.string().optional(),
      taskId: z.string().optional(),
      agent: z.string().optional(),
      action: z.string().optional(),
      advanced: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    async (filters) => {
      try {
        return ok(listActions(filters));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'snapshot_task_events',
    'WRITE/LOCAL. Creates or replaces the local corpus-diff event checkpoint. This only observes task state; it never launches an agent or performs an external action.',
    {
      dueWithinHours: z.number().nonnegative().optional().describe('Horizon for future task.due.soon events. Default 24 hours.'),
    },
    async ({ dueWithinHours }) => {
      try {
        return ok(await snapshotTaskEvents(adapter, { dueWithinHours: dueWithinHours ?? 24 }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'poll_task_events',
    'WRITE/LOCAL. Diffs the current task corpus, durably stages deterministic event envelopes, then advances the checkpoint. Returns newly observed events plus the unacknowledged pending spool. Events are observation-only and must be acted on separately under normal ATS intent and security checks.',
    {
      dueWithinHours: z.number().nonnegative().optional().describe('Override the task.due.soon horizon stored in the checkpoint.'),
    },
    async ({ dueWithinHours }) => {
      try {
        return ok(await collectAndSpoolTaskEvents(adapter, {
          dueWithinHours,
          actions: listActions({ limit: 500 }),
        }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'list_pending_task_events',
    'Read-only. Lists durable task-event envelopes that have not been acknowledged by a consumer. Task bodies are not stored in the spool.',
    {
      limit: z.number().int().positive().max(1000).optional(),
    },
    async ({ limit }) => {
      try {
        return ok(listPendingTaskEvents({ limit }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'acknowledge_task_events',
    'WRITE/LOCAL. Explicitly acknowledges one or more durable task-event ids and removes them from the pending spool. Unknown ids are reported without failing known acknowledgements.',
    {
      eventIds: z.array(z.string().min(1)).min(1).max(1000),
    },
    async ({ eventIds }) => {
      try {
        return ok(acknowledgeTaskEvents(eventIds));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'similar',
    'Read-only. Find items semantically similar to a KNOWN item, given its id (not a text query — for text search use `find`). Useful for "show me related notes to this one" or dedupe. Requires an embedder-backed adapter (e.g. TickTick); returns a clear error on adapters without embeddings. Returns an array of items ranked by similarity.',
    {
      taskId: z.string().describe('Id of the reference item to find neighbours for (from `find` results).'),
      limit: z.number().int().positive().max(50).optional().describe('Maximum number of similar items to return. Default 5, hard cap 50.'),
    },
    async ({ taskId, limit }) => {
      try {
        const result = ext.tasks?.findSimilar
          ? await ext.tasks.findSimilar(taskId, { limit: limit ?? 5 })
          : await coreSimilar(taskId, { adapter, limit: limit ?? 5, log: logUsage });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'url_for',
    'Read-only. Build a paste-ready deep link (a URL string) to an item in its native app, so you can hand the human a clickable reference. Does not open anything or write — pure id→URL construction. Returns the URL as a string.',
    {
      projectId: z.string().describe('Id of the project the item lives in (from `find`/`list_projects`).'),
      taskId: z.string().describe('Id of the item to link to (from `find`).'),
    },
    async ({ projectId, taskId }) => {
      try {
        return ok(adapter.urlFor({ projectId, taskId }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

/** Boot the stdio server against the configured adapter. */
export async function startStdio() {
  const { adapter, pkg } = await loadAdapter();
  const server = createServer(adapter);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel and must not be polluted.
  console.error(`[ats-mcp ${VERSION}] connected — adapter: ${pkg}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startStdio().catch((err) => {
    console.error(`[ats-mcp] fatal: ${err?.stack || err}`);
    process.exit(1);
  });
}
