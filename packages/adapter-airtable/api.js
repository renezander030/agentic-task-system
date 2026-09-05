/**
 * Airtable REST + mapping helpers for @reneza/ats-adapter-airtable.
 *
 * Mapping decision (see README): an Airtable **table** is an ATS Project and an
 * Airtable **record** is an ATS Task. projectId is the compound `baseId/tableId`;
 * taskId is the record id (`recXXXXXXXX`). The record's primary field becomes the
 * task title; the remaining fields are serialized into the markdown body so Core's
 * retrieval has text to match on.
 *
 * Zero runtime deps: uses global fetch (Node >= 18).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryingFetch } from '@reneza/ats-core/retry';

const DEFAULT_ENDPOINT = 'https://api.airtable.com';
const airFetch = retryingFetch((...a) => fetch(...a), { label: 'Airtable' });
const PAGE_SIZE = 100;

/** Per-process schema cache: baseId -> { tables, fetchedAt }. Tables rarely change within a run. */
const schemaCache = new Map();

/** Resolve config from env first, then ~/.config/ats/airtable.json. Env wins per key. */
export function loadConfig() {
  let file = {};
  const p = configPath();
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const basesEnv = process.env.ATS_AIRTABLE_BASES;
  const bases =
    (basesEnv ? basesEnv.split(',') : Array.isArray(file.bases) ? file.bases : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
  return {
    token: process.env.ATS_AIRTABLE_TOKEN || file.token || '',
    endpoint: process.env.ATS_AIRTABLE_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    bases, // optional allow-list of appXXX ids; empty = discover via Meta API
    defaultProject:
      process.env.ATS_AIRTABLE_DEFAULT_PROJECT || file.defaultProject || '',
  };
}

export function configPath() {
  return (
    process.env.ATS_AIRTABLE_CONFIG ||
    path.join(os.homedir(), '.config', 'ats', 'airtable.json')
  );
}


/**
 * Authenticated Airtable request with JSON parsing and 429 backoff.
 * @param {string} apiPath e.g. `/v0/meta/bases`
 * @param {{ method?: string, query?: Record<string,string|number|undefined>, body?: any, cfg?: object }} [opts]
 */
export async function air(apiPath, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!cfg.token) throw new Error('Airtable: no token. Set ATS_AIRTABLE_TOKEN or write ~/.config/ats/airtable.json');
  const url = new URL(cfg.endpoint.replace(/\/$/, '') + apiPath);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${cfg.token}` },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  // Airtable rate-limits at 5 req/sec/base -> 429 with Retry-After; core's retry
  // policy honors it (plus gateway 5xx and dropped connections) with jittered backoff.
  const res = await airFetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error?.type || json?.error || text || res.statusText;
    throw new Error(`Airtable ${res.status} on ${apiPath}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

/** List bases the token can see (Meta API), honoring the optional allow-list. */
export async function listBases(cfg = loadConfig()) {
  if (cfg.bases.length) return cfg.bases.map((id) => ({ id, name: id }));
  const out = [];
  let offset;
  do {
    const page = await air('/v0/meta/bases', { query: { offset }, cfg });
    for (const b of page.bases || []) out.push({ id: b.id, name: b.name || b.id });
    offset = page.offset;
  } while (offset);
  return out;
}

/** Table schema for a base, cached per process. */
export async function listTables(baseId, cfg = loadConfig()) {
  const cached = schemaCache.get(baseId);
  if (cached) return cached;
  const page = await air(`/v0/meta/bases/${baseId}/tables`, { cfg });
  const tables = page.tables || [];
  schemaCache.set(baseId, tables);
  return tables;
}

export function clearSchemaCache() {
  schemaCache.clear();
}

/** Split a compound `baseId/tableId` projectId. */
export function splitProjectId(projectId) {
  const i = String(projectId).indexOf('/');
  if (i < 0) throw new Error(`Airtable projectId must be "baseId/tableId", got "${projectId}"`);
  return { baseId: projectId.slice(0, i), tableId: projectId.slice(i + 1) };
}

export function makeProjectId(baseId, tableId) {
  return `${baseId}/${tableId}`;
}

/** Render any Airtable cell value to a short string for title/body/search. */
export function stringifyCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(stringifyCell).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    // collaborators, attachments, button, barcode, etc.
    return v.name || v.email || v.text || v.url || v.filename || v.label || JSON.stringify(v);
  }
  return String(v);
}

const isDateType = (t) => t === 'date' || t === 'dateTime';

/** Map a raw Airtable record + its table schema into an ATS Task. */
export function recordToTask(baseId, table, rec) {
  const fields = table.fields || [];
  const primary = fields.find((f) => f.id === table.primaryFieldId) || fields[0] || { name: 'Name' };
  const title = stringifyCell(rec.fields?.[primary.name]) || '(untitled)';

  const body = fields
    .filter((f) => f.id !== (primary.id ?? primary.name))
    .map((f) => {
      const val = stringifyCell(rec.fields?.[f.name]);
      return val ? `**${f.name}:** ${val}` : '';
    })
    .filter(Boolean)
    .join('\n');

  const tagsField = fields.find((f) => /^tags?$/i.test(f.name));
  const tags = tagsField ? toArray(rec.fields?.[tagsField.name]) : [];

  const dueField = fields.find((f) => isDateType(f.type) && /(due|deadline|fällig)/i.test(f.name));
  const dueRaw = dueField ? rec.fields?.[dueField.name] : undefined;

  const lastModField = fields.find((f) => f.type === 'lastModifiedTime');
  const modifiedTime =
    (lastModField && rec.fields?.[lastModField.name]) || rec.createdTime || new Date(0).toISOString();

  const task = {
    id: rec.id,
    title,
    content: body,
    projectId: makeProjectId(baseId, table.id),
    tags,
    modifiedTime,
    raw: rec,
  };
  if (dueRaw) task.dueDate = new Date(dueRaw).toISOString();
  return task;
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(stringifyCell).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Page through every record of one table. */
export async function listRecords(baseId, tableId, cfg = loadConfig()) {
  const records = [];
  let offset;
  do {
    const page = await air(`/v0/${baseId}/${encodeURIComponent(tableId)}`, {
      query: { pageSize: PAGE_SIZE, offset },
      cfg,
    });
    for (const r of page.records || []) records.push(r);
    offset = page.offset;
  } while (offset);
  return records;
}

export async function getRecord(baseId, tableId, recordId, cfg = loadConfig()) {
  return air(`/v0/${baseId}/${encodeURIComponent(tableId)}/${recordId}`, { cfg });
}

export async function createRecord(baseId, tableId, fields, cfg = loadConfig()) {
  return air(`/v0/${baseId}/${encodeURIComponent(tableId)}`, {
    method: 'POST',
    body: { fields, typecast: true },
    cfg,
  });
}

export async function updateRecord(baseId, tableId, recordId, fields, cfg = loadConfig()) {
  return air(`/v0/${baseId}/${encodeURIComponent(tableId)}/${recordId}`, {
    method: 'PATCH',
    body: { fields, typecast: true },
    cfg,
  });
}

/**
 * Build an Airtable fields payload from an ATS TaskInput/patch, given a table schema.
 * - title -> primary field
 * - content -> the first long-text (multilineText) field, or a field named Notes/Content
 * - tags -> a field named Tags (if present)
 */
export function taskInputToFields(table, input) {
  const fields = table.fields || [];
  const primary = fields.find((f) => f.id === table.primaryFieldId) || fields[0];
  const out = {};
  if (input.title !== undefined && primary) out[primary.name] = input.title;

  if (input.content !== undefined) {
    const contentField =
      fields.find((f) => f.type === 'multilineText' && f.id !== primary?.id) ||
      fields.find((f) => /^(notes?|content|body|beschreibung)$/i.test(f.name) && f.id !== primary?.id);
    if (contentField) out[contentField.name] = input.content;
  }

  if (input.tags !== undefined) {
    const tagsField = fields.find((f) => /^tags?$/i.test(f.name));
    if (tagsField) {
      out[tagsField.name] =
        tagsField.type === 'multipleSelects' ? input.tags : (input.tags || []).join(', ');
    }
  }
  return out;
}

export function urlForRecord(baseId, tableId, recordId) {
  return 'https://airtable.com/' + [baseId, tableId, recordId].filter(Boolean).join('/');
}
