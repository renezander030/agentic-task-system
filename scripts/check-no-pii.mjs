#!/usr/bin/env node
/**
 * check-no-pii.mjs — the publish-safety gate.
 *
 * A strict, deterministic guard against leaking personal / private data into
 * either public surface this repo exposes:
 *
 *   • the GitHub surface  — every git-tracked file        (default mode)
 *   • the npm surface     — exactly what `npm publish` ships, per package,
 *                           resolved via `npm pack --dry-run --json`
 *
 * The thesis behind ATS is "your task app is your agent's memory" — which means
 * real names of projects, clients, and income channels live one note away from
 * this code. A leaked example or a stray absolute path would expose them. This
 * gate makes that a build failure, not a matter of vigilance.
 *
 * It fails (exit 1) on any of:
 *   - secrets (private keys, Bearer tokens, sk-/ghp_/AKIA/xox- keys, an
 *     assigned TICKTICK_API_TOKEN value)
 *   - personal absolute home paths (/Users/<name>/, /home/<name>/) that aren't
 *     generic placeholders
 *   - real e-mail addresses (example.com / test.com doc domains are allowed)
 *   - any literal term listed in scripts/.pii-denylist (gitignored) — put your
 *     real trunk / client / project names there; the file never ships and the
 *     gate fails if any of them appear in a public surface
 *
 * Usage:
 *   node scripts/check-no-pii.mjs            # scan git-tracked files
 *   node scripts/check-no-pii.mjs --npm      # scan the npm publish surface of every package
 *   node scripts/check-no-pii.mjs --self     # scan the npm publish surface of the package in CWD
 *
 * Wired into: root `npm test` (git surface) and each package's
 * `prepublishOnly` (its own npm surface) — so a leak blocks both test and publish.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files we never scan: lockfiles (huge, full of hashes), binaries, and the
// denylist itself (it *contains* the sensitive terms on purpose).
const SKIP_BASENAMES = new Set(['package-lock.json', '.pii-denylist']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.mp4', '.mov',
]);

// Absolute-home-path usernames that are obviously placeholders, not a person.
const PLACEHOLDER_USERS = new Set([
  'you', 'user', 'username', 'youruser', 'your-user', 'me', 'name', 'path',
  'home', 'someone', 'example',
]);
// E-mail domains that are documentation placeholders, not real addresses.
const ALLOWED_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com']);

const PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: 'github-token', re: /\bgh[posu]_[A-Za-z0-9]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // A Bearer header followed by something that looks like a real token (not a
  // shell variable like `Bearer $TOKEN` or a doc placeholder `Bearer <token>`).
  { id: 'bearer-token', re: /Bearer\s+(?!\$|["'`]?\$|<)[A-Za-z0-9._-]{20,}/g },
  // TICKTICK_API_TOKEN assigned an inline literal value.
  { id: 'ticktick-token', re: /TICKTICK_API_TOKEN\s*[:=]\s*["'`]?[A-Za-z0-9._-]{16,}/g },
];

/** Read scripts/.pii-denylist if present → array of lowercased literal terms. */
function loadDenylist() {
  const p = path.join(REPO_ROOT, 'scripts', '.pii-denylist');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((l) => l.toLowerCase());
}

/** Scan one file's text for findings. Returns [{pattern, match, line}]. */
function scanText(rel, text, denylist) {
  const findings = [];
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;

  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({ pattern: id, match: redact(m[0]), line: lineAt(m.index) });
    }
  }

  // Personal home paths: /Users/<name>/ or /home/<name>/, name not a placeholder.
  for (const m of text.matchAll(/\/(Users|home)\/([A-Za-z0-9._-]+)\//g)) {
    if (PLACEHOLDER_USERS.has(m[2].toLowerCase())) continue;
    findings.push({ pattern: 'home-path', match: `/${m[1]}/${m[2]}/`, line: lineAt(m.index) });
  }

  // Real e-mail addresses (skip allowed doc domains).
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    if (ALLOWED_EMAIL_DOMAINS.has(m[1].toLowerCase())) continue;
    findings.push({ pattern: 'email', match: redact(m[0]), line: lineAt(m.index) });
  }

  // Local denylist terms (real project/client names).
  if (denylist.length) {
    const lower = text.toLowerCase();
    for (const term of denylist) {
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(term, from)) !== -1) {
        findings.push({ pattern: 'denylist-term', match: redact(term), line: lineAt(idx) });
        from = idx + term.length;
      }
    }
  }

  return findings;
}

/** Show enough of a hit to locate it without re-printing the whole secret. */
function redact(s) {
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

function isScannable(rel) {
  const base = path.basename(rel);
  if (SKIP_BASENAMES.has(base)) return false;
  if (base.startsWith('.pii-denylist')) return false; // the list + its .example template hold sample terms

  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return false;
  if (rel.includes('node_modules/')) return false;
  return true;
}

/** Read a file as UTF-8; return null if it isn't text. */
function readTextOrNull(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null; // NUL byte → binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Git-tracked files, repo-relative. */
function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** Publishable workspace package dirs (those with a private:false / no-private package.json and a name). */
function publishablePackages() {
  const pkgsDir = path.join(REPO_ROOT, 'packages');
  return fs
    .readdirSync(pkgsDir)
    .map((d) => path.join(pkgsDir, d))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')))
    .filter((d) => {
      const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      return p.name && !p.private;
    });
}

/** Exact file list `npm publish` would ship for the package at `dir`. */
function npmSurface(dir) {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  return (parsed[0]?.files || []).map((f) => f.path);
}

function scanFileList(files, baseDir, label, denylist) {
  const results = [];
  for (const rel of files) {
    if (!isScannable(rel)) continue;
    const text = readTextOrNull(path.join(baseDir, rel));
    if (text == null) continue;
    const findings = scanText(rel, text, denylist);
    if (findings.length) results.push({ surface: label, file: rel, findings });
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--npm') ? 'npm' : args.includes('--self') ? 'self' : 'git';
  const denylist = loadDenylist();

  let results = [];
  let scanned = 0;

  if (mode === 'git') {
    const files = gitTrackedFiles();
    scanned = files.length;
    results = scanFileList(files, REPO_ROOT, 'git', denylist);
  } else if (mode === 'self') {
    const dir = process.cwd();
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    const files = npmSurface(dir);
    scanned = files.length;
    results = scanFileList(files, dir, `npm:${name}`, denylist);
  } else {
    for (const dir of publishablePackages()) {
      const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
      const files = npmSurface(dir);
      scanned += files.length;
      results.push(...scanFileList(files, dir, `npm:${name}`, denylist));
    }
  }

  const denyNote = denylist.length
    ? `${denylist.length} denylist term(s) loaded`
    : 'no scripts/.pii-denylist (term-matching skipped — structural checks still enforced)';

  if (results.length === 0) {
    console.log(`✓ check-no-pii [${mode}]: ${scanned} file(s) clean — ${denyNote}`);
    process.exit(0);
  }

  console.error(`\n✗ check-no-pii [${mode}]: possible personal-data disclosure\n  (${denyNote})\n`);
  for (const r of results) {
    console.error(`  ${r.surface}  ${r.file}`);
    for (const f of r.findings) {
      console.error(`    L${f.line}  ${f.pattern}: ${f.match}`);
    }
  }
  console.error(
    '\nReplace real data with generic demo data (writing / client-work / side-project),\n' +
    'or move false positives into the allowlists in scripts/check-no-pii.mjs.\n'
  );
  process.exit(1);
}

main();
