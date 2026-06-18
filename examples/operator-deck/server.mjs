// Always-on backend for the HITL operator deck.
// Serves a small JSON API that the (CF Pages) deck calls:
//   GET  /api/suggestions            -> ranked cards derived from the live ATS corpus
//   POST /api/suggestions/:id/approve -> execute the action against ATS
//   POST /api/suggestions/:id/reject  -> remember the dismissal, never re-offer
// Also serves ./web for local single-origin dev. Zero runtime deps (Node http).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSuggestions, executeSuggestion } from './suggest.mjs';
import { DEMO_SUGGESTIONS } from './demo-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.OPERATOR_PORT || 8094);
const TOKEN = process.env.OPERATOR_TOKEN || ''; // when set, required as Bearer on writes
const DEMO = process.env.DECK_DEMO === '1'; // serve curated demo cards, never touch the real corpus
const DRYRUN = DEMO || process.env.DECK_DRYRUN === '1'; // demo always dry-runs; approve never mutates
const ALLOW_ORIGIN = process.env.OPERATOR_ORIGIN || '*';
const DISMISS_FILE = process.env.OPERATOR_DISMISS_FILE || path.join(os.homedir(), '.config', 'ats', 'operator-dismissed.json');

let adapter;
async function getAdapter() {
  if (adapter) return adapter;
  const pkg = process.env.ATS_ADAPTER || '@reneza/ats-adapter-ticktick';
  const mod = await import(pkg);
  adapter = mod.default || mod;
  return adapter;
}

function loadDismissed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(DISMISS_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}
function saveDismissed(set) {
  fs.mkdirSync(path.dirname(DISMISS_FILE), { recursive: true });
  fs.writeFileSync(DISMISS_FILE, JSON.stringify([...set]));
}

const byId = new Map(); // last-built suggestions, so approve/reject can resolve by id

async function suggestionsPayload() {
  if (DEMO) {
    byId.clear();
    for (const s of DEMO_SUGGESTIONS) byId.set(s.id, s);
    return { suggestions: DEMO_SUGGESTIONS, corpus: { size: 1470, active: 1470, demo: true }, dryRun: true, demo: true };
  }
  const a = await getAdapter();
  const { suggestions, corpus } = await buildSuggestions(a, { dismissed: loadDismissed() });
  byId.clear();
  for (const s of suggestions) byId.set(s.id, s);
  return { suggestions, corpus, dryRun: DRYRUN };
}

async function resolve(id) {
  if (byId.has(id)) return byId.get(id);
  await suggestionsPayload(); // rebuild once (server may have restarted)
  return byId.get(id) || null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...headers,
  });
  res.end(data);
}

function authed(req) {
  if (!TOKEN) return true; // open in local dev when no token configured
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && url.pathname === '/api/suggestions') {
      return send(res, 200, await suggestionsPayload(), { 'Content-Type': 'application/json' });
    }

    const approve = url.pathname.match(/^\/api\/suggestions\/(.+)\/approve$/);
    const reject = url.pathname.match(/^\/api\/suggestions\/(.+)\/reject$/);

    if (req.method === 'POST' && (approve || reject)) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' }, { 'Content-Type': 'application/json' });
      const id = decodeURIComponent((approve || reject)[1]);
      const s = await resolve(id);
      if (!s) return send(res, 410, { error: 'suggestion no longer available' }, { 'Content-Type': 'application/json' });

      if (reject) {
        if (!DEMO) {
          const set = loadDismissed();
          set.add(id);
          saveDismissed(set);
        }
        byId.delete(id);
        return send(res, 200, { ok: true, dismissed: id }, { 'Content-Type': 'application/json' });
      }
      // approve
      if (DRYRUN) return send(res, 200, { ok: true, dryRun: true, summary: s.kind === 'archive' ? 'Archived' : 'Linked' }, { 'Content-Type': 'application/json' });
      const result = await executeSuggestion(await getAdapter(), s);
      byId.delete(id);
      return send(res, 200, { ok: true, ...result }, { 'Content-Type': 'application/json' });
    }

    // Static (local dev): serve ./web
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(__dirname, 'web', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (full.startsWith(path.join(__dirname, 'web')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    }
    return send(res, 404, { error: 'not found' }, { 'Content-Type': 'application/json' });
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) }, { 'Content-Type': 'application/json' });
  }
});

server.listen(PORT, () => {
  console.log(`operator-deck backend on http://localhost:${PORT}  (dryRun=${DRYRUN}, auth=${TOKEN ? 'on' : 'off'})`);
});
