// Always-on backend for the HITL operator deck.
//   GET  /api/suggestions             -> a PAGE of up to BATCH pre-built cards from the queue
//   POST /api/refill {have:[ids]}      -> the next page (buffer the cron/async keeps topped) — lazy-load
//   POST /api/suggestions/:id/approve  -> execute the action against ATS
//   POST /api/suggestions/:id/reject   -> skip (feeds attention decay), drop from queue
//   POST /api/suggestions/:id/modify   -> record the operator's note for the agent
// Suggestions are pre-computed by the cadence (cadence.mjs) into a queue file and
// ranked/decayed by the recommendation model (state.mjs) — nothing is built on load.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { executeSuggestion, recordModify } from './suggest.mjs';
import { DEMO_SUGGESTIONS } from './demo-data.mjs';
import { loadQueue, saveQueue, buildBatch, BATCH } from './cadence.mjs';
import { loadState, saveState, recordImpression, recordSkip } from './state.mjs';

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.OPERATOR_PORT || 8094);
const TOKEN = process.env.OPERATOR_TOKEN || '';
const DEMO = process.env.DECK_DEMO === '1';
const DRYRUN = DEMO || process.env.DECK_DRYRUN === '1';
const ALLOW_ORIGIN = process.env.OPERATOR_ORIGIN || '*';
const DISMISS_FILE = process.env.OPERATOR_DISMISS_FILE || path.join(os.homedir(), '.config', 'ats', 'operator-dismissed.json');
const BUFFER = 2 * BATCH; // keep roughly two pages buffered so refill is instant

let adapter;
async function getAdapter() {
  if (adapter) return adapter;
  const mod = await import(process.env.ATS_ADAPTER || '@reneza/ats-adapter-ticktick');
  adapter = mod.default || mod;
  return adapter;
}

function loadDismissed() { try { return new Set(JSON.parse(fs.readFileSync(DISMISS_FILE, 'utf-8'))); } catch { return new Set(); } }
function saveDismissed(set) { fs.mkdirSync(path.dirname(DISMISS_FILE), { recursive: true }); fs.writeFileSync(DISMISS_FILE, JSON.stringify([...set])); }

const taskOf = (card) => card?.exec?.source?.taskId || card.id;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let building = false;
async function ensureBuffer({ wait = false } = {}) {
  if (DEMO) return;
  if (building) { if (wait) { while (building) await sleep(150); } return; } // wait for the in-flight build to land
  if (loadQueue().length >= BUFFER) return;
  building = true;
  try {
    const q = loadQueue();
    const batch = await buildBatch(await getAdapter(), { existingIds: new Set(q.map((c) => c.id)), dismissed: loadDismissed(), limit: BUFFER - q.length });
    saveQueue([...loadQueue(), ...batch.filter((b) => !loadQueue().some((c) => c.id === b.id))]);
  } catch (e) { console.error('[cadence] buildBatch failed:', e.message); } finally { building = false; }
}

function noteImpressions(cards) {
  if (DEMO || cards.length === 0) return;
  const st = loadState();
  const now = Date.now();
  for (const c of cards) recordImpression(st, taskOf(c), now);
  saveState(st);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', ...headers });
  res.end(data);
}
function authed(req) { if (!TOKEN) return true; return (req.headers.authorization || '') === `Bearer ${TOKEN}`; }
const JSONH = { 'Content-Type': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    // A page of suggestions.
    if (req.method === 'GET' && url.pathname === '/api/suggestions') {
      if (DEMO) return send(res, 200, { suggestions: DEMO_SUGGESTIONS, dryRun: true, demo: true }, JSONH);
      let q = loadQueue();
      if (q.length === 0) { await ensureBuffer({ wait: true }); q = loadQueue(); }
      const page = q.slice(0, BATCH);
      noteImpressions(page);
      ensureBuffer(); // async top-up
      return send(res, 200, { suggestions: page, dryRun: DRYRUN }, JSONH);
    }

    // Lazy-load: the next page (the buffer beyond what the deck already has).
    if (req.method === 'POST' && url.pathname === '/api/refill') {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' }, JSONH);
      if (DEMO) return send(res, 200, { suggestions: [] }, JSONH);
      let have;
      try { have = new Set((JSON.parse((await readBody(req)) || '{}').have) || []); } catch { have = new Set(); }
      let next = loadQueue().filter((c) => !have.has(c.id)).slice(0, BATCH);
      if (next.length < BATCH) { await ensureBuffer({ wait: true }); next = loadQueue().filter((c) => !have.has(c.id)).slice(0, BATCH); }
      noteImpressions(next);
      ensureBuffer();
      return send(res, 200, { suggestions: next, dryRun: DRYRUN }, JSONH);
    }

    const m = url.pathname.match(/^\/api\/suggestions\/(.+)\/(approve|reject|modify)$/);
    if (req.method === 'POST' && m) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' }, JSONH);
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const card = DEMO ? DEMO_SUGGESTIONS.find((c) => c.id === id) : loadQueue().find((c) => c.id === id);

      if (action === 'modify') {
        let note = '';
        try { note = String(JSON.parse((await readBody(req)) || '{}').note || '').slice(0, 1000); } catch { /* none */ }
        if (!DEMO) { saveQueue(loadQueue().filter((c) => c.id !== id)); recordModify(id, note); }
        return send(res, 200, { ok: true, modified: id, note }, JSONH);
      }

      if (action === 'reject') {
        if (!DEMO) {
          const d = loadDismissed(); d.add(id); saveDismissed(d);
          const st = loadState(); if (card) recordSkip(st, taskOf(card)); saveState(st);
          saveQueue(loadQueue().filter((c) => c.id !== id));
        }
        return send(res, 200, { ok: true, dismissed: id }, JSONH);
      }

      // approve
      if (!card) return send(res, 410, { error: 'suggestion no longer available' }, JSONH);
      if (DRYRUN) { if (!DEMO) saveQueue(loadQueue().filter((c) => c.id !== id)); return send(res, 200, { ok: true, dryRun: true, summary: `Would ${card.kind}` }, JSONH); }
      const result = await executeSuggestion(await getAdapter(), card);
      saveQueue(loadQueue().filter((c) => c.id !== id));
      return send(res, 200, { ok: true, ...result }, JSONH);
    }

    // Static (local dev): serve ./web
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(__dirname, 'web', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (full.startsWith(path.join(__dirname, 'web')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    }
    return send(res, 404, { error: 'not found' }, JSONH);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) }, JSONH);
  }
});

server.listen(PORT, () => console.log(`operator-deck backend on :${PORT} (demo=${DEMO}, dryRun=${DRYRUN}, auth=${TOKEN ? 'on' : 'off'})`));
