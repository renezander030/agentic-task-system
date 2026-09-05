/**
 * Notion REST + mapping helpers for @reneza/ats-adapter-notion.
 *
 * Mapping decision (see README): a Notion **database** (data source) is an ATS
 * Project and a Notion **page** is an ATS Task. projectId is the database id;
 * taskId is the page id (UUID). The page's title-type property becomes the task
 * title; the page body (block children) is rendered to markdown so Core's
 * retrieval has text to match on.
 *
 * Zero runtime deps: uses global fetch (Node >= 18).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryingFetch } from '@reneza/ats-core/retry';

const DEFAULT_ENDPOINT = 'https://api.notion.com';
const notionFetch = retryingFetch((...a) => fetch(...a), { label: 'Notion' });
const NOTION_VERSION = '2022-06-28';
const PAGE_SIZE = 100;

/** Resolve config from env first, then ~/.config/ats/notion.json. Env wins per key. */
export function loadConfig() {
  let file = {};
  const p = configPath();
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const dbEnv = process.env.ATS_NOTION_DATABASES;
  const databases =
    (dbEnv ? dbEnv.split(',') : Array.isArray(file.databases) ? file.databases : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
  return {
    token: process.env.ATS_NOTION_TOKEN || file.token || '',
    endpoint: process.env.ATS_NOTION_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    databases, // optional allow-list of database ids; empty = discover via search
    defaultDatabase:
      process.env.ATS_NOTION_DEFAULT_DATABASE || file.defaultDatabase || '',
  };
}

export function configPath() {
  return (
    process.env.ATS_NOTION_CONFIG ||
    path.join(os.homedir(), '.config', 'ats', 'notion.json')
  );
}


/**
 * Authenticated Notion request with JSON parsing and 429 backoff.
 * @param {string} apiPath e.g. `/v1/search`
 * @param {{ method?: string, body?: any, cfg?: object }} [opts]
 */
export async function notion(apiPath, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!cfg.token) throw new Error('Notion: no token. Set ATS_NOTION_TOKEN or write ~/.config/ats/notion.json');
  const url = new URL(cfg.endpoint.replace(/\/$/, '') + apiPath);
  const init = {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  // Notion rate-limits at ~3 req/sec -> 429 with Retry-After; core's retry policy
  // honors it (plus gateway 5xx and dropped connections) with jittered backoff.
  const res = await notionFetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message || json?.code || text || res.statusText;
    throw new Error(`Notion ${res.status} on ${apiPath}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

/** Plain text from a Notion rich_text array. */
export function richTextToPlain(rt) {
  if (!Array.isArray(rt)) return '';
  return rt.map((r) => r?.plain_text ?? r?.text?.content ?? '').join('');
}

/** Title plain text from a database/page object's title array. */
export function titleOf(obj) {
  if (Array.isArray(obj?.title)) return richTextToPlain(obj.title);
  return '';
}

/** List databases the integration can see (search), honoring the optional allow-list. */
export async function listDatabases(cfg = loadConfig()) {
  if (cfg.databases.length) {
    const out = [];
    for (const id of cfg.databases) {
      try {
        const db = await retrieveDatabase(id, cfg);
        out.push({ id: db.id, name: titleOf(db) || db.id, raw: db });
      } catch {
        out.push({ id, name: id });
      }
    }
    return out;
  }
  const out = [];
  let cursor;
  do {
    const page = await notion('/v1/search', {
      method: 'POST',
      body: {
        filter: { property: 'object', value: 'database' },
        page_size: PAGE_SIZE,
        start_cursor: cursor,
      },
      cfg,
    });
    for (const db of page.results || []) {
      out.push({ id: db.id, name: titleOf(db) || db.id, raw: db });
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function retrieveDatabase(databaseId, cfg = loadConfig()) {
  return notion(`/v1/databases/${databaseId}`, { cfg });
}

/** Find the name of the title-type property in a properties map. */
export function titlePropName(properties) {
  for (const [name, def] of Object.entries(properties || {})) {
    if (def?.type === 'title') return name;
  }
  return undefined;
}

/** Read a value out of a page property object by its declared type. */
function readProp(prop) {
  if (!prop || typeof prop !== 'object') return undefined;
  switch (prop.type) {
    case 'title':
      return richTextToPlain(prop.title);
    case 'rich_text':
      return richTextToPlain(prop.rich_text);
    case 'multi_select':
      return (prop.multi_select || []).map((o) => o?.name).filter(Boolean);
    case 'select':
      return prop.select?.name || '';
    case 'date':
      return prop.date?.start || '';
    case 'number':
      return prop.number;
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url || '';
    case 'email':
      return prop.email || '';
    case 'phone_number':
      return prop.phone_number || '';
    case 'status':
      return prop.status?.name || '';
    default:
      return undefined;
  }
}

/** Map a raw Notion page into an ATS Task. `content` defaults to long-text prop or ''. */
export function pageToTask(page, content) {
  const props = page.properties || {};
  const titleName = titlePropName(props);
  const title = (titleName ? readProp(props[titleName]) : '') || '(untitled)';

  // tags: a multi_select property named Tags/tags
  let tags = [];
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === 'multi_select' && /^tags?$/i.test(name)) {
      tags = (def.multi_select || []).map((o) => o?.name).filter(Boolean);
      break;
    }
  }

  // dueDate: a date property named Due/Deadline
  let dueRaw;
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === 'date' && /(due|deadline|fällig)/i.test(name)) {
      dueRaw = def.date?.start;
      break;
    }
  }

  // content fallback for list views: first rich_text property if no body supplied
  let body = content;
  if (body === undefined) {
    body = '';
    for (const [name, def] of Object.entries(props)) {
      if (def?.type === 'rich_text' && name !== titleName) {
        const txt = readProp(def);
        if (txt) {
          body = txt;
          break;
        }
      }
    }
  }

  const task = {
    id: page.id,
    title,
    content: body || '',
    projectId: page.parent?.database_id || '',
    tags,
    modifiedTime: page.last_edited_time || new Date(0).toISOString(),
    raw: page,
  };
  if (dueRaw) task.dueDate = new Date(dueRaw).toISOString();
  return task;
}

/** Page through every page of one database. */
export async function queryDatabase(databaseId, cfg = loadConfig()) {
  const pages = [];
  let cursor;
  do {
    const page = await notion(`/v1/databases/${databaseId}/query`, {
      method: 'POST',
      body: { page_size: PAGE_SIZE, start_cursor: cursor },
      cfg,
    });
    for (const p of page.results || []) pages.push(p);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return pages;
}

export async function retrievePage(pageId, cfg = loadConfig()) {
  return notion(`/v1/pages/${pageId}`, { cfg });
}

/** Fetch a page's block children and render to markdown. Paginates via start_cursor. */
export async function pageBodyMarkdown(blockId, cfg = loadConfig()) {
  const blocks = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) qs.set('start_cursor', cursor);
    const page = await notion(`/v1/blocks/${blockId}/children?${qs.toString()}`, { cfg });
    for (const b of page.results || []) blocks.push(b);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return blocksToMarkdown(blocks);
}

/** Render an array of Notion blocks to markdown (supported types only). */
export function blocksToMarkdown(blocks) {
  const lines = [];
  for (const b of blocks || []) {
    const t = b?.type;
    const data = b?.[t] || {};
    const text = richTextToPlain(data.rich_text);
    switch (t) {
      case 'paragraph':
        lines.push(text);
        break;
      case 'heading_1':
        lines.push(`# ${text}`);
        break;
      case 'heading_2':
        lines.push(`## ${text}`);
        break;
      case 'heading_3':
        lines.push(`### ${text}`);
        break;
      case 'bulleted_list_item':
        lines.push(`- ${text}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${text}`);
        break;
      case 'to_do':
        lines.push(`- [${data.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'code':
        lines.push('```' + (data.language || '') + '\n' + text + '\n```');
        break;
      case 'quote':
        lines.push(`> ${text}`);
        break;
      default:
        if (text) lines.push(text);
        break;
    }
  }
  return lines.join('\n\n');
}

/** Build a Notion properties payload from an ATS TaskInput/patch + the db schema. */
export function taskInputToProperties(dbProperties, input) {
  const out = {};
  const titleName = titlePropName(dbProperties);
  if (input.title !== undefined && titleName) {
    out[titleName] = { title: [{ type: 'text', text: { content: String(input.title) } }] };
  }

  if (input.tags !== undefined) {
    for (const [name, def] of Object.entries(dbProperties || {})) {
      if (def?.type === 'multi_select' && /^tags?$/i.test(name)) {
        out[name] = { multi_select: (input.tags || []).map((t) => ({ name: String(t) })) };
        break;
      }
    }
  }

  if (input.dueDate !== undefined) {
    for (const [name, def] of Object.entries(dbProperties || {})) {
      if (def?.type === 'date' && /(due|deadline|fällig)/i.test(name)) {
        out[name] = { date: { start: input.dueDate } };
        break;
      }
    }
  }
  return out;
}

/** A paragraph block carrying the task body text. */
export function contentToBlocks(content) {
  const text = String(content || '');
  if (!text) return [];
  return [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
    },
  ];
}

export async function createPage(databaseId, properties, children, cfg = loadConfig()) {
  return notion('/v1/pages', {
    method: 'POST',
    body: { parent: { database_id: databaseId }, properties, children },
    cfg,
  });
}

export async function updatePage(pageId, properties, cfg = loadConfig()) {
  return notion(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties },
    cfg,
  });
}

export function urlForPage(pageId) {
  return `https://www.notion.so/${String(pageId || '').replace(/-/g, '')}`;
}
