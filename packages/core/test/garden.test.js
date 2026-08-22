/**
 * gardenSweep: stale-but-active tasks surface with per-task archive commands;
 * completed and already-archived tasks stay out. Detection only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gardenSweep, formatGarden } from '../garden.js';
import { parseTaskMetadata, writeTaskMetadata } from '../task-context.js';

const NOW = Date.parse('2026-08-22T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function archivedContent() {
  const defaults = parseTaskMetadata('');
  return writeTaskMetadata('Body.', { ...defaults, lifecycle: { ...defaults.lifecycle, status: 'archived' } });
}

const corpus = [
  { id: 'fresh', projectId: 'p1', title: 'recent work', modifiedTime: daysAgo(3), status: 'active' },
  { id: 'old-active', projectId: 'p1', title: 'forgotten thing', modifiedTime: daysAgo(120), status: 'active' },
  { id: 'old-done', projectId: 'p1', title: 'finished long ago', modifiedTime: daysAgo(200), status: 'completed' },
  { id: 'old-archived', projectId: 'p1', title: 'already parked', modifiedTime: daysAgo(200), status: 'active', content: archivedContent() },
  { id: 'older-active', projectId: 'p2', title: 'ancient item', modifiedTime: daysAgo(300), status: 'active' },
];

test('only stale ACTIVE tasks are reported, oldest first', () => {
  const report = gardenSweep(corpus, { staleDays: 60, now: NOW });
  assert.deepEqual(report.stale.map((t) => t.taskId), ['older-active', 'old-active']);
  assert.equal(report.count, 2);
  assert.equal(report.scanned, 5);
});

test('threshold moves the line', () => {
  const report = gardenSweep(corpus, { staleDays: 250, now: NOW });
  assert.deepEqual(report.stale.map((t) => t.taskId), ['older-active']);
});

test('format prints a per-task archive command and the nothing-changed note', () => {
  const text = formatGarden(gardenSweep(corpus, { staleDays: 60, now: NOW }));
  assert.ok(text.includes('ats lifecycle set p2 older-active --status archived'));
  assert.ok(text.includes('Detection only'));
});

test('a clean corpus reports nothing stale', () => {
  const text = formatGarden(gardenSweep([corpus[0]], { staleDays: 60, now: NOW }));
  assert.ok(text.includes('nothing stale'));
});
