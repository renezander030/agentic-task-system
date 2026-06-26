/**
 * build-beads-flow.mjs — generates assets/beads-flow.svg
 *
 * A simple, tutorial-style explainer for the Beads workflow:
 *   1) the three tags that steer every task (do / type / effort), and
 *   2) the start-to-finish loop — capture, tag, link dependencies, let
 *      `bd ready` surface the unblocked frontier, do the work, and watch the
 *      frontier recompute itself.
 *
 * Palette matches assets/build-semantic-layer.mjs (slate / gray / teal / amber).
 *
 * Reproduce:  node assets/build-beads-flow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const W = 1000;
const H = 560;
const OUT = path.join('assets', 'beads-flow.svg');

const SLATE = '#0f172a';
const GRAY = '#64748b';
const TEAL = '#0d9488';
const TEAL_BG = '#d9f2ee';
const AMBER = '#c2701c';
const AMBER_BG = '#fbe8d3';
const LINE = '#cbd5e1';

// A tag explainer card: the tag, the question it answers, its values.
function tagCard(x, tag, question, values) {
  const w = 292;
  const chipW = tag.length * 11 + 28;
  const vals = values
    .map((v, i) => {
      const txt = `<text x="${x + 24 + i * 0}" y="0">${v.t}</text>`; // placeholder, positioned below
      return v;
    });
  // render value pills inline
  let vx = x + 22;
  const pills = values
    .map((v) => {
      const pw = v.t.length * 8.4 + 22;
      const pill = `<rect x="${vx}" y="150" width="${pw}" height="26" rx="13" fill="${v.bg || '#f1f5f9'}"/>
    <text x="${vx + pw / 2}" y="168" font-size="13.5" font-weight="bold" fill="${v.fg || GRAY}" text-anchor="middle">${v.t}</text>`;
      vx += pw + 8;
      return pill;
    })
    .join('\n    ');
  return `
    <rect x="${x}" y="104" width="${w}" height="92" rx="12" fill="#ffffff" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="${x + 22}" y="118" width="${chipW}" height="28" rx="8" fill="${TEAL_BG}"/>
    <text x="${x + 22 + chipW / 2}" y="137" font-size="16" font-weight="bold" fill="${TEAL}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${tag}</text>
    <text x="${x + 22 + chipW + 12}" y="137" font-size="14.5" font-weight="bold" fill="${SLATE}">${question}</text>
    ${pills}`;
}

// A stage box in the pipeline. `hero` fills it teal (the bd ready frontier).
function stageBox(x, y, title, sub, hero) {
  const w = 150;
  const h = 92;
  const fill = hero ? TEAL : '#ffffff';
  const stroke = hero ? TEAL : LINE;
  const titleFill = hero ? '#ffffff' : SLATE;
  const subFill = hero ? '#d9f2ee' : GRAY;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="${hero ? 2 : 1.5}"/>
    <text x="${x + w / 2}" y="${y + 40}" font-size="16.5" font-weight="bold" fill="${titleFill}" text-anchor="middle">${title}</text>
    <text x="${x + w / 2}" y="${y + 63}" font-size="12.5" fill="${subFill}" text-anchor="middle">${sub}</text>`;
}

// Right-pointing connector arrow between two stage boxes.
function arrow(x1, x2, y) {
  return `<path d="M${x1} ${y} H${x2 - 8} m-9 -6 l9 6 l-9 6" fill="none" stroke="${GRAY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const xs = [40, 228, 416, 604, 792]; // 5 stages, width 150, gap 38
const yStage = 286;
const midY = yStage + 46;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#ffffff" stroke="${LINE}"/>

  <text x="${W / 2}" y="50" font-size="28" font-weight="bold" fill="${SLATE}" text-anchor="middle">From a pile of tasks to the next right action</text>
  <text x="${W / 2}" y="80" font-size="15.5" fill="${GRAY}" text-anchor="middle">Three tags steer every task. The dependency graph decides what's ready — so you never pick by hand.</text>

  ${tagCard(40, 'do:', 'who acts?', [{ t: 'agent', fg: TEAL, bg: TEAL_BG }, { t: 'you', fg: AMBER, bg: AMBER_BG }])}
  ${tagCard(354, 'type:', 'what kind?', [{ t: 'build' }, { t: 'research' }, { t: 'review' }])}
  ${tagCard(668, 'effort:', 'how big?', [{ t: 'S' }, { t: 'M' }, { t: 'L' }])}

  ${stageBox(xs[0], yStage, 'Capture', 'dump every task in', false)}
  ${stageBox(xs[1], yStage, 'Tag', 'do · type · effort', false)}
  ${stageBox(xs[2], yStage, 'Link deps', 'what blocks what', false)}
  ${stageBox(xs[3], yStage, 'bd ready', 'unblocked frontier', true)}
  ${stageBox(xs[4], yStage, 'Do it', 'agent, or you', false)}

  ${arrow(xs[0] + 150, xs[1], midY)}
  ${arrow(xs[1] + 150, xs[2], midY)}
  ${arrow(xs[2] + 150, xs[3], midY)}
  ${arrow(xs[3] + 150, xs[4], midY)}

  <!-- close → frontier recomputes: loop from "Do it" back up to "bd ready" -->
  <path d="M${xs[4] + 75} ${yStage + 92} V470 H${xs[3] + 75} V${yStage + 92 + 8} m-6 9 l6 -9 l6 9" fill="none" stroke="${TEAL}" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${(xs[3] + xs[4]) / 2 + 75}" y="463" font-size="13.5" font-weight="bold" fill="${TEAL}" text-anchor="middle">close it → the frontier recomputes</text>

  <text x="${W / 2}" y="520" font-size="14" fill="${GRAY}" text-anchor="middle">The agent grabs <tspan fill="${TEAL}" font-weight="bold">do:agent</tspan> work that's ready; you take <tspan fill="${AMBER}" font-weight="bold">do:human</tspan>. Mark one done and the next right thing surfaces on its own.</text>
</svg>
`;

fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
