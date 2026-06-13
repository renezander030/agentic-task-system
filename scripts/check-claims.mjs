#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const roots = ['README.md', 'docs', 'packages'];
const violations = [];
const rules = [
  {
    id: 'legacy-command',
    pattern: /(?:^|[`"'(:])\s*ticktick\s+(?:auth|tasks|projects|notes|setup)\b/i,
    message: 'public ATS surfaces must not instruct users to call the legacy CLI',
  },
  {
    id: 'legacy-retrieval-env',
    pattern: /TICKTICK_(?:RELEVANCE|USAGE_LOG)/,
    message: 'use ATS_RELEVANCE / ATS_USAGE_LOG',
  },
  {
    id: 'fixed-latency-claim',
    pattern: /(?:sub-100ms|<100ms)/i,
    message: 'end-to-end latency is adapter and corpus dependent',
  },
  {
    id: 'implicit-embedding-service',
    pattern: /(?:else|without it),?\s+(?:Core\s+)?uses local nomic-embed/i,
    message: 'Core does not silently start a local embedding service',
  },
];

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'test') return [];
    return walk(path.join(target, entry.name));
  });
}

const files = roots
  .flatMap((entry) => walk(path.join(root, entry)))
  .filter((file) => file.endsWith('.md') || file.endsWith('.js') || file.endsWith('.d.ts'));

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        violations.push({ file: path.relative(root, file), line: index + 1, rule });
      }
    }
  });
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule.id}] ${violation.rule.message}`);
  }
  process.exit(1);
}

console.log(`ATS claim checks passed (${files.length} public source/document files).`);
