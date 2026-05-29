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
import { validateAdapter, find as coreFind, similar as coreSimilar } from '@reneza/ats-core';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

function atsConfigDir() {
  const base = path.join(os.homedir(), '.config');
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
  const server = new McpServer({ name: 'ats', version: VERSION });

  server.tool(
    'find',
    'Search the task store with hybrid retrieval (dense + sparse + keyword) fused via Reciprocal Rank Fusion. Returns best-matching items with provenance (which retrievers found each). This is the right tool for "what do I have about X".',
    {
      query: z.string().describe('What to search for'),
      limit: z.number().int().positive().max(50).optional().describe('Max results (default 5)'),
    },
    async ({ query, limit }) => {
      try {
        // Prefer the adapter's enriched find (embedder + store-specific
        // branches); fall back to core's generic fan-out over the contract.
        const result = ext.tasks?.find
          ? await ext.tasks.find(query, { limit: limit ?? 5 })
          : await coreFind(query, { adapter, limit: limit ?? 5 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'get_task',
    'Fetch one item (task/note) by project id + task id, including its full body.',
    {
      projectId: z.string().describe('Project id'),
      taskId: z.string().describe('Task id'),
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
    'List the projects / folders in the store.',
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
    'Create a new item in the store. This is the agent→human write side of the two-way bus.',
    {
      title: z.string(),
      content: z.string().optional().describe('Markdown body'),
      projectId: z.string().optional().describe('Target project; omit for inbox/default'),
      tags: z.array(z.string()).optional(),
      dueDate: z.string().optional().describe('ISO 8601'),
    },
    async (input) => {
      try {
        return ok(await adapter.createTask(input));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'update_task',
    'Patch an existing item (partial update). Only the provided fields change.',
    {
      projectId: z.string(),
      taskId: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      dueDate: z.string().optional(),
    },
    async ({ projectId, taskId, ...patch }) => {
      try {
        return ok(await adapter.updateTask(projectId, taskId, patch));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'similar',
    'Find items semantically similar to a given one. Requires an embedder-backed adapter; returns a clear error otherwise.',
    {
      taskId: z.string(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ taskId, limit }) => {
      try {
        const result = ext.tasks?.findSimilar
          ? await ext.tasks.findSimilar(taskId, { limit: limit ?? 5 })
          : await coreSimilar(taskId, { limit: limit ?? 5 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    'url_for',
    'Return a paste-ready deep link to an item in its native app, so you can hand the human a clickable reference.',
    { projectId: z.string(), taskId: z.string() },
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
