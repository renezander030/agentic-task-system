/**
 * `ats doctor` — environment + adapter diagnostics.
 *
 * Answers "why isn't retrieval working?" without a stack trace: resolves the
 * active adapter, validates the contract, checks auth, reports optional
 * capabilities + corpus-cache state, and confirms core retrieval can run.
 * Adapter-specific probes (e.g. a vector index) are surfaced opportunistically
 * if the adapter exposes them, but nothing here is store-specific.
 */
import { validateAdapter, adapterCapabilities, find as coreFind } from '@reneza/ats-core';
import { meta as corpusMeta } from '@reneza/ats-core/corpus-cache';

const pass = (detail) => ({ status: 'pass', detail });
const warn = (detail) => ({ status: 'warn', detail });
const fail = (detail) => ({ status: 'fail', detail });
const info = (detail) => ({ status: 'info', detail });

/**
 * @param {object} args
 * @param {() => Promise<object>} args.loadAdapter - resolves + imports the active adapter
 * @param {{ pkg: string, origin: string }} args.adapterSource
 * @param {string} args.configPath
 * @param {string} args.nodeVersion
 * @returns {Promise<{ ok: boolean, checks: Array<{ id, label, status, detail }> }>}
 */
export async function runDoctor({ loadAdapter, adapterSource, configPath, nodeVersion }) {
  const checks = [];
  const add = (id, label, result) => checks.push({ id, label, ...result });

  add('node', 'Node.js runtime', info(nodeVersion));
  add(
    'adapter-config',
    'Active adapter resolution',
    pass(`${adapterSource.pkg}  (from ${adapterSource.origin})`)
  );
  add('config-path', 'Config file', info(configPath));

  let adapter = null;
  try {
    adapter = await loadAdapter();
    add('adapter-load', 'Adapter import', pass(`imported ${adapterSource.pkg}`));
  } catch (e) {
    add('adapter-load', 'Adapter import', fail(e?.message || String(e)));
  }

  if (adapter) {
    try {
      validateAdapter(adapter);
      add('adapter-shape', 'Adapter implements the contract', pass('all required methods present'));
    } catch (e) {
      add('adapter-shape', 'Adapter implements the contract', fail(e?.message || String(e)));
    }

    // Auth.
    try {
      const status = await adapter.authStatus();
      if (status?.authenticated) {
        add('auth', 'Authentication', pass(status.expiresIn ? `valid (expires ${status.expiresIn})` : 'authenticated'));
      } else {
        add('auth', 'Authentication', warn(status?.message || 'not authenticated — run `ats auth login`'));
      }
    } catch (e) {
      add('auth', 'Authentication', warn(`authStatus() threw: ${e?.message || e}`));
    }

    // Optional capabilities.
    const caps = adapterCapabilities(adapter);
    const on = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
    add('capabilities', 'Optional capabilities', info(on.length ? on.join(', ') : 'none (keyword + RRF only)'));

    // Adapter-specific vector index, if the adapter exposes one.
    const vectorStatus = adapter.__ext?.tasks?.vectorStatus;
    if (typeof vectorStatus === 'function') {
      try {
        const vs = await vectorStatus();
        const n = vs?.count ?? vs?.points ?? vs?.indexed;
        add('vector-index', 'Vector index', n != null ? pass(`${n} embedded item(s)`) : info(JSON.stringify(vs)));
      } catch (e) {
        add('vector-index', 'Vector index', warn(`unreachable: ${e?.message || e}`));
      }
    }

    // Core retrieval reachability — a cheap, short-budget query.
    try {
      const res = await coreFind('the', { adapter, limit: 1, budgetMs: 4000, cache: false });
      add('retrieval', 'Core retrieval', res?.mode === 'find' ? pass(`fan-out OK (${res.branches.map((b) => b.name).join('+')})`) : warn(`mode=${res?.mode}`));
    } catch (e) {
      add('retrieval', 'Core retrieval', warn(e?.message || String(e)));
    }
  }

  // Corpus cache state (independent of adapter).
  try {
    const m = corpusMeta();
    if (!m.exists) {
      add('cache', 'Corpus cache', info(`empty (${m.path || 'default path'})`));
    } else {
      const ageS = m.ageMs != null ? Math.round(m.ageMs / 1000) : '?';
      add('cache', 'Corpus cache', info(`${m.count ?? '?'} item(s), ${ageS}s old${m.stale ? ' (stale)' : ''}`));
    }
  } catch (e) {
    add('cache', 'Corpus cache', info(`unavailable: ${e?.message || e}`));
  }

  const ok = !checks.some((c) => c.status === 'fail');
  return { ok, checks };
}

/** Render a doctor report as a readable string. */
export function formatDoctor(report) {
  const mark = { pass: '✔', warn: '!', fail: '✗', info: '·' };
  const lines = report.checks.map((c) => `  ${mark[c.status] || '·'} ${c.label}: ${c.detail}`);
  const verdict = report.ok
    ? 'All systems go.'
    : 'Problems found — see ✗ above.';
  return ['ats doctor', ...lines, '', verdict].join('\n');
}
