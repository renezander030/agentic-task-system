/**
 * build-fusion-demo.mjs — generates assets/demo-fusion.gif
 *
 * The cross-source fusion demo: one `ats find` query returning results from
 * GitHub + Notion + TickTick, fused and ranked by RRF in a single list — the
 * one thing no single-vendor MCP server can do. Same light-terminal style as
 * assets/demo.svg (hand-authored SVG frames → rsvg-convert → ImageMagick gif).
 *
 * Reproduce:  node assets/build-fusion-demo.mjs
 * Deps:       rsvg-convert (librsvg), convert (ImageMagick)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = 760;
const H = 372;
const OUT = path.join('assets', 'demo-fusion.gif');

const CMD = 'ats find "auth token migration"';

// Each result: index, title, rrf score, source token (colored), and provenance tail.
const RESULTS = [
  { title: 'Rotate auth tokens before the Q3 migration', rrf: '0.93', src: 'github', tail: 'issue #482 · updated 2d ago · dense #1 · keyword #1' },
  { title: 'Auth migration runbook (OAuth to PAT)', rrf: '0.87', src: 'notion', tail: 'Engineering DB · updated 5d ago · dense #2 · sparse #1' },
  { title: 'Ship the token-refresh hotfix', rrf: '0.74', src: 'ticktick', tail: 'Permanent Notes · updated 1w ago · sparse #2 · keyword #2' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame({ typed = CMD, n = 0, footer = false, mcp = false, cursor = false }) {
  const rowY = [104, 156, 208];
  const results = RESULTS.slice(0, n)
    .map((r, i) => {
      const y = rowY[i];
      return `
    <text x="24" y="${y}" fill="#7c3aed">${i + 1}.</text>
    <text x="52" y="${y}" fill="#0f172a" font-weight="bold">${esc(r.title)}</text>
    <text x="600" y="${y}" fill="#15803d">rrf ${r.rrf}</text>
    <text x="52" y="${y + 20}" font-size="12" xml:space="preserve"><tspan fill="#0d9488" font-weight="bold">${r.src} </tspan><tspan fill="#64748b">· ${esc(r.tail)}</tspan></text>`;
    })
    .join('');

  const footerEl = footer
    ? `<text x="24" y="262" fill="#64748b" font-size="12">3 results · 91ms · fused across <tspan fill="#0d9488" font-weight="bold">GitHub</tspan> + <tspan fill="#0d9488" font-weight="bold">Notion</tspan> + <tspan fill="#0d9488" font-weight="bold">TickTick</tspan> with RRF</text>`
    : '';

  const mcpEl = mcp
    ? `<text x="24" y="298" fill="#15803d">$</text>
    <text x="44" y="298" fill="#0f172a">claude mcp add ats -- ats-mcp</text>
    <text x="24" y="322" fill="#64748b" font-size="12">✓ same fused retrieval in Claude Code / Claude Desktop / Cursor</text>`
    : '';

  // cursor block drawn after the typed command (approx 8.4px per monospace char at 14px)
  const cursorEl = cursor ? `<rect x="${44 + typed.length * 8.4}" y="57" width="8" height="14" fill="#0f172a"/>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
  <defs><clipPath id="w"><rect x="0" y="0" width="${W}" height="${H}" rx="10"/></clipPath></defs>
  <g clip-path="url(#w)">
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="9.5" fill="#ffffff" stroke="#cbd5e1"/>
    <rect width="${W}" height="36" fill="#f1f5f9"/>
    <circle cx="22" cy="18" r="6" fill="#ff5f57"/>
    <circle cx="42" cy="18" r="6" fill="#febc2e"/>
    <circle cx="62" cy="18" r="6" fill="#28c840"/>
    <text x="380" y="23" fill="#64748b" font-size="12" text-anchor="middle">ats — one query, every source</text>
    <text x="24" y="68" fill="#15803d">$</text>
    <text x="44" y="68" fill="#0f172a">${esc(typed)}</text>
    ${cursorEl}${results}
    ${footerEl}
    ${mcpEl}
  </g>
</svg>`;
}

// Frame timeline: [frameSpec, delayCentiseconds]
const steps = [];
const push = (spec, delay) => steps.push([spec, delay]);

// typing
const chunks = ['ats ', 'ats find ', 'ats find "auth ', 'ats find "auth token ', CMD];
for (const c of chunks) push({ typed: c, cursor: true }, 12);
push({ typed: CMD, cursor: true }, 30); // brief pause, cursor on
// reveal results one by one
push({ n: 1 }, 75);
push({ n: 2 }, 75);
push({ n: 3 }, 80);
// footer, then mcp
push({ n: 3, footer: true }, 90);
push({ n: 3, footer: true, mcp: true }, 320); // final hold

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-'));
const pngs = [];
steps.forEach(([spec], i) => {
  const svgPath = path.join(tmp, `f${String(i).padStart(3, '0')}.svg`);
  const pngPath = path.join(tmp, `f${String(i).padStart(3, '0')}.png`);
  fs.writeFileSync(svgPath, frame(spec));
  execFileSync('rsvg-convert', ['-z', '2', svgPath, '-o', pngPath]);
  pngs.push(pngPath);
});

// assemble with per-frame delays, optimize, cap palette to shrink the flat UI
const args = ['-loop', '0'];
steps.forEach(([, delay], i) => args.push('-delay', String(delay), pngs[i]));
args.push('-layers', 'optimize', '-colors', '128', OUT);
execFileSync('convert', args);

fs.rmSync(tmp, { recursive: true, force: true });
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote ${OUT} (${steps.length} frames, ${kb} KB)`);
