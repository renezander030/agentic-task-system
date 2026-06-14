#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatProgressBenchmark, scoreProgressEpisodes } from '../progress-benchmark.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const episodesPath = path.resolve(args.episodes || path.join(here, 'data', 'progress-episodes.jsonl'));

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    result[key] = value ?? true;
  }
  return result;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`Progress episodes file not found: ${file}`);
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid progress episode JSON at line ${index + 1}: ${error.message}`, { cause: error });
      }
    });
}

try {
  const report = scoreProgressEpisodes(readJsonl(episodesPath));
  const output = args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : formatProgressBenchmark(report);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
  }
  process.stdout.write(output);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
