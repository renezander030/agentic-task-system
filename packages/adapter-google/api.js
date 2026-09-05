/**
 * Google Workspace REST + extraction helpers for @reneza/ats-adapter-google.
 *
 * Read-corpus adapter: a Google file (Sheet / Doc / Slide) is an ATS Task; the
 * doc type is the Project. Auth is OAuth as a dedicated, read-only Workspace user
 * who has only the files shared with them — limiting the blast radius if the
 * refresh token leaks.
 *
 * Zero runtime deps: global fetch (Node >= 18).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryingFetch } from '@reneza/ats-core/retry';

const googleFetch = retryingFetch((...a) => fetch(...a), { label: 'Google' });

export const DOC_TYPES = {
  sheets: {
    projectId: 'google-sheets',
    name: 'Google Sheets',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    urlBase: 'https://docs.google.com/spreadsheets/d/',
  },
  docs: {
    projectId: 'google-docs',
    name: 'Google Docs',
    mimeType: 'application/vnd.google-apps.document',
    urlBase: 'https://docs.google.com/document/d/',
  },
  slides: {
    projectId: 'google-slides',
    name: 'Google Slides',
    mimeType: 'application/vnd.google-apps.presentation',
    urlBase: 'https://docs.google.com/presentation/d/',
  },
};

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
];

export function configPath() {
  return process.env.ATS_GOOGLE_CONFIG || path.join(os.homedir(), '.config', 'ats', 'google.json');
}

export function loadConfig() {
  let file = {};
  try {
    const p = configPath();
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const docTypesEnv = process.env.ATS_GOOGLE_DOCTYPES;
  const docTypes = (docTypesEnv ? docTypesEnv.split(',') : Array.isArray(file.docTypes) ? file.docTypes : ['sheets', 'docs', 'slides'])
    .map((s) => String(s).trim())
    .filter((t) => DOC_TYPES[t]);
  return {
    clientId: process.env.ATS_GOOGLE_CLIENT_ID || file.clientId || '',
    clientSecret: process.env.ATS_GOOGLE_CLIENT_SECRET || file.clientSecret || '',
    redirectUri: process.env.ATS_GOOGLE_REDIRECT || file.redirectUri || 'http://localhost:18888/callback',
    refreshToken: process.env.ATS_GOOGLE_REFRESH_TOKEN || file.refreshToken || '',
    folderId: process.env.ATS_GOOGLE_FOLDER || file.folderId || '',
    docTypes: docTypes.length ? docTypes : ['sheets', 'docs', 'slides'],
  };
}

/** Merge a patch into the on-disk config (used to persist the refresh token). */
export function saveConfig(patch) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let file = {};
  try {
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    file = {};
  }
  const next = { ...file, ...patch };
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n');
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
  return next;
}

// ---- OAuth ------------------------------------------------------------------

export function buildAuthUrl(cfg = loadConfig()) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

/** Trade an authorization code for a refresh token and persist it. */
export async function exchangeCode(code, cfg = loadConfig()) {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${json.error_description || json.error || res.status}`);
  if (json.refresh_token) saveConfig({ refreshToken: json.refresh_token });
  return json;
}

let tokenCache = { accessToken: '', exp: 0 };

export function _resetTokenCache() {
  tokenCache = { accessToken: '', exp: 0 };
}

/** Exchange the stored refresh token for a short-lived access token (cached). */
export async function getAccessToken(cfg = loadConfig()) {
  if (!cfg.refreshToken) throw new Error('Google: not authenticated. Run `ats config use` / authLogin to grant the dedicated user.');
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.exp - 60_000 > now) return tokenCache.accessToken;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${json.error_description || json.error || res.status}`);
  tokenCache = { accessToken: json.access_token, exp: now + (json.expires_in || 3600) * 1000 };
  return tokenCache.accessToken;
}

/** Authenticated GET against a Google API, returning parsed JSON. */
export async function g(url, token, query) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  const res = await googleFetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || text || res.statusText;
    throw new Error(`Google ${res.status} on ${u.pathname}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

// ---- Drive listing ----------------------------------------------------------

/** List the files of one doc type the principal can see (only shared/owned files). */
export async function listFilesOfType(typeKey, token, cfg = loadConfig()) {
  const def = DOC_TYPES[typeKey];
  if (!def) return [];
  const clauses = [`mimeType='${def.mimeType}'`, 'trashed=false'];
  if (cfg.folderId) clauses.push(`'${cfg.folderId}' in parents`);
  const files = [];
  let pageToken;
  do {
    const page = await g('https://www.googleapis.com/drive/v3/files', token, {
      q: clauses.join(' and '),
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    for (const f of page.files || []) files.push({ ...f, typeKey });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

// ---- Per-type text extraction ----------------------------------------------

export async function extractDoc(fileId, token) {
  const doc = await g(`https://docs.googleapis.com/v1/documents/${fileId}`, token);
  const out = [];
  for (const el of doc.body?.content || []) {
    const para = el.paragraph;
    if (!para) continue;
    const line = (para.elements || []).map((e) => e.textRun?.content || '').join('');
    if (line.trim()) out.push(line.replace(/\n+$/, ''));
  }
  return out.join('\n');
}

export async function extractSlides(fileId, token) {
  const pres = await g(`https://slides.googleapis.com/v1/presentations/${fileId}`, token);
  const out = [];
  (pres.slides || []).forEach((slide, i) => {
    const lines = [];
    for (const pe of slide.pageElements || []) {
      const text = pe.shape?.text || pe.table?.tableRows;
      if (pe.shape?.text) {
        const s = (pe.shape.text.textElements || []).map((te) => te.textRun?.content || '').join('');
        if (s.trim()) lines.push(s.replace(/\n+$/, ''));
      } else if (Array.isArray(text)) {
        for (const row of text) {
          for (const cell of row.tableCells || []) {
            const s = (cell.text?.textElements || []).map((te) => te.textRun?.content || '').join('');
            if (s.trim()) lines.push(s.replace(/\n+$/, ''));
          }
        }
      }
    }
    if (lines.length) out.push(`## Slide ${i + 1}\n${lines.join('\n')}`);
  });
  return out.join('\n\n');
}

export async function extractSheet(fileId, token) {
  const meta = await g(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}`, token, {
    fields: 'sheets.properties.title',
  });
  const titles = (meta.sheets || []).map((s) => s.properties?.title).filter(Boolean);
  const blocks = [];
  for (const title of titles) {
    const range = encodeURIComponent(title);
    const data = await g(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${range}`, token);
    const rows = data.values || [];
    blocks.push(`## ${title}\n${rowsToMarkdown(rows)}`);
  }
  return blocks.join('\n\n');
}

export function rowsToMarkdown(rows) {
  if (!rows.length) return '_(empty)_';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => String(r[i] ?? '').replace(/\|/g, '\\|'));
  const header = pad(rows[0]);
  const sep = header.map(() => '---');
  const body = rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`);
  return [`| ${header.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...body].join('\n');
}

export async function extractByType(typeKey, fileId, token) {
  if (typeKey === 'docs') return extractDoc(fileId, token);
  if (typeKey === 'slides') return extractSlides(fileId, token);
  if (typeKey === 'sheets') return extractSheet(fileId, token);
  return '';
}

export function fileToTask(file, content) {
  const def = DOC_TYPES[file.typeKey];
  return {
    id: file.id,
    title: file.name || '(untitled)',
    content: content || '',
    projectId: def.projectId,
    tags: [],
    modifiedTime: file.modifiedTime || new Date(0).toISOString(),
    raw: { mimeType: file.mimeType, webViewLink: file.webViewLink, typeKey: file.typeKey },
  };
}

export function typeKeyForProject(projectId) {
  const entry = Object.entries(DOC_TYPES).find(([, d]) => d.projectId === projectId);
  return entry ? entry[0] : null;
}

export function urlForType(projectId, taskId) {
  const entry = Object.values(DOC_TYPES).find((d) => d.projectId === projectId);
  const base = entry ? entry.urlBase : 'https://drive.google.com/file/d/';
  return `${base}${taskId}/edit`;
}
