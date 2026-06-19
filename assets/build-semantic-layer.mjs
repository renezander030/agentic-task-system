/**
 * build-semantic-layer.mjs — generates assets/semantic-layer.png
 *
 * A non-technical, single-image explainer: Claude's built-in memory
 * (CLAUDE.md / memory files) vs the ATS semantic layer, in terms a
 * non-engineer cares about — getting the right answer on the FIRST try, fast.
 *
 * Reproduce:  node assets/build-semantic-layer.mjs
 * Deps:       rsvg-convert (librsvg)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = 1000;
const H = 600;
const OUT = path.join('assets', 'semantic-layer.png');

const SLATE = '#0f172a';
const GRAY = '#64748b';
const TEAL = '#0d9488';
const TEAL_BG = '#d9f2ee';
const AMBER = '#c2701c';
const AMBER_BG = '#fbe8d3';

function panel(x, title, subtitle, headBg, accent, lines, mark, outcome, outcomeBg) {
  const w = 440;
  const rows = lines
    .map((t, i) => {
      const y = 214 + i * 34;
      return `<text x="${x + 22}" y="${y}" font-size="17" fill="${accent}" font-weight="bold">${mark}</text>
    <text x="${x + 48}" y="${y}" font-size="17" fill="${SLATE}">${t}</text>`;
    })
    .join('\n    ');
  return `
    <rect x="${x}" y="120" width="${w}" height="222" rx="12" fill="#ffffff" stroke="${accent}" stroke-width="1.5"/>
    <path d="M${x} 132 a12 12 0 0 1 12 -12 h416 a12 12 0 0 1 12 12 v36 h-440 z" fill="${headBg}"/>
    <text x="${x + 22}" y="148" font-size="19" font-weight="bold" fill="${SLATE}">${title}</text>
    <text x="${x + 22}" y="170" font-size="13" fill="${GRAY}">${subtitle}</text>
    ${rows}
    <rect x="${x + 22}" y="306" width="${outcome.length * 9.2 + 26}" height="26" rx="13" fill="${outcomeBg}"/>
    <text x="${x + 35}" y="324" font-size="14" font-weight="bold" fill="${accent}">${outcome}</text>`;
}

function stat(x, label, before, after) {
  const w = 440;
  return `
    <rect x="${x}" y="392" width="${w}" height="168" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>
    <text x="${x + 24}" y="428" font-size="16" fill="${GRAY}">${label}</text>
    <text x="${x + 24}" y="492" font-size="30" font-weight="bold" fill="${AMBER}" text-decoration="line-through">${before}</text>
    <path d="M${x + 200} 482 h54 m-12 -8 l12 8 l-12 8" fill="none" stroke="${GRAY}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${x + 270}" y="494" font-size="40" font-weight="bold" fill="${TEAL}">${after}</text>
    <text x="${x + 24}" y="534" font-size="13" fill="${GRAY}">built-in memory</text>
    <text x="${x + 270}" y="534" font-size="13" fill="${TEAL}" font-weight="bold">with ATS</text>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="${W / 2}" y="54" font-size="30" font-weight="bold" fill="${SLATE}" text-anchor="middle">Ask once. Get the right answer first.</text>
  <text x="${W / 2}" y="86" font-size="16" fill="${GRAY}" text-anchor="middle">The semantic layer ATS adds on top of the connectors your agent already has</text>

  ${panel(40, "Claude's built-in memory", 'CLAUDE.md + memory files', AMBER_BG, AMBER,
    ['Matches the exact words only', 'Re-reads whole files each time', 'Misses, then asks again'],
    '✗', 'Often wrong first, slow', AMBER_BG)}

  ${panel(520, 'The ATS semantic layer', 'your curated tools + hybrid RRF search', TEAL_BG, TEAL,
    ['Understands what you mean', 'Searches every tool at once', 'Right answer first, with sources'],
    '✓', 'Right first, fast', TEAL_BG)}

  ${stat(40, 'Right on the first try', '1 in 5', '3 in 5')}
  ${stat(520, 'Steps to the answer', '3–4 tries', '1')}
</svg>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-'));
const svgPath = path.join(tmp, 'semantic.svg');
fs.writeFileSync(svgPath, svg);
execFileSync('rsvg-convert', ['-z', '2', svgPath, '-o', OUT]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
