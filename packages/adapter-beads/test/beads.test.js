import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBeadsAdapter } from '../index.js';
import { contextForTask, runConformance } from '@reneza/ats-core';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-beads-'));
  fs.mkdirSync(path.join(root, '.beads'));
  const statePath = path.join(root, 'issues.json');
  fs.writeFileSync(statePath, JSON.stringify([
    {
      id: 'bd-a1',
      title: 'Ship bounded upload',
      description: 'Implement the upload endpoint.',
      design: 'Stream to a temporary file.',
      acceptance_criteria: 'Payloads over 10 MB return 413.',
      notes: 'Preserve the request id.',
      status: 'open',
      priority: 1,
      issue_type: 'feature',
      labels: ['api'],
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-02T00:00:00Z',
      dependencies: [{ issue_id: 'bd-a1', depends_on_id: 'bd-a2', type: 'blocks' }],
    },
    {
      id: 'bd-a2',
      title: 'Approve upload policy',
      description: 'Decision for upload limits.',
      status: 'closed',
      priority: 2,
      issue_type: 'decision',
      labels: ['policy'],
      created_at: '2026-05-30T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      dependencies: [],
    },
    {
      id: 'bd-a1.1',
      title: 'Add multipart fixture',
      description: 'Add an oversized multipart test fixture.',
      status: 'in_progress',
      priority: 2,
      issue_type: 'task',
      labels: ['test'],
      parent: 'bd-a1',
      created_at: '2026-06-02T00:00:00Z',
      updated_at: '2026-06-03T00:00:00Z',
      dependencies: [{ id: 'bd-a1', dependency_type: 'parent-child', title: 'Ship bounded upload' }],
    },
  ], null, 2));
  const binary = path.join(root, 'fake-bd.mjs');
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const statePath = process.env.FAKE_BEADS_STATE;
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = (issues) => fs.writeFileSync(statePath, JSON.stringify(issues, null, 2));
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const command = args[0];
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const output = (value) => process.stdout.write(JSON.stringify(value));
if (command === '--version') { process.stdout.write('bd version 0.test'); process.exit(0); }
const issues = read();
if (command === 'list') output(issues);
else if (command === 'show') output(issues.filter((issue) => issue.id === args[1]));
else if (command === 'create') {
  const id = 'bd-new' + (issues.length + 1);
  const now = '2026-06-15T00:00:00Z';
  const issue = {
    id, title: args[1], description: flag('--description') || '', status: 'open',
    priority: Number(flag('--priority') || 2), issue_type: 'task',
    labels: (flag('--labels') || '').split(',').filter(Boolean),
    created_at: now, updated_at: now, dependencies: [],
  };
  const due = flag('--due'); if (due) issue.due_at = due;
  issues.push(issue); write(issues); output(issue);
} else if (command === 'update') {
  const issue = issues.find((item) => item.id === args[1]);
  if (!issue) process.exit(2);
  if (flag('--title') !== undefined) issue.title = flag('--title');
  if (flag('--description') !== undefined) issue.description = flag('--description');
  if (flag('--priority') !== undefined) issue.priority = Number(flag('--priority'));
  if (flag('--set-labels') !== undefined) issue.labels = flag('--set-labels').split(',').filter(Boolean);
  if (flag('--due') !== undefined) { if (flag('--due')) issue.due_at = flag('--due'); else delete issue.due_at; }
  issue.updated_at = '2026-06-16T00:00:00Z'; write(issues); output([issue]);
} else if (command === 'close') {
  const issue = issues.find((item) => item.id === args[1]); issue.status = 'closed'; write(issues); output([issue]);
} else if (command === 'delete') {
  write(issues.filter((item) => item.id !== args[1])); output({ deleted: [args[1]] });
} else { process.stderr.write('unsupported fake command: ' + args.join(' ')); process.exit(2); }
`);
  fs.chmodSync(binary, 0o755);
  const previous = process.env.FAKE_BEADS_STATE;
  process.env.FAKE_BEADS_STATE = statePath;
  const adapter = createBeadsAdapter({ root, binary, projectId: 'demo-beads' });
  return {
    root,
    statePath,
    adapter,
    cleanup() {
      if (previous === undefined) delete process.env.FAKE_BEADS_STATE;
      else process.env.FAKE_BEADS_STATE = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('maps Beads issues, priorities, completion, and native graph edges', async () => {
  const ctx = fixture();
  try {
    const projects = await ctx.adapter.listProjects();
    assert.deepEqual(projects.map((project) => project.id), ['demo-beads']);
    const tasks = await ctx.adapter.listTasksInProject('demo-beads');
    assert.equal(tasks[0].priority, 'high');
    assert.equal(tasks[1].status, 'completed');
    assert.deepEqual(tasks[0].links.map((link) => [link.type, link.taskId]), [['depends-on', 'bd-a2']]);
    assert.ok(tasks[2].links.some((link) => link.type === 'parent' && link.taskId === 'bd-a1'));

    const context = await contextForTask(ctx.adapter, { projectId: 'demo-beads', taskId: 'bd-a1' }, { cache: false });
    assert.equal(context.context[0].task.id, 'bd-a2');
    assert.ok(context.context[0].provenance.some((entry) => entry.type === 'depends-on'));
  } finally {
    ctx.cleanup();
  }
});

test('search covers Beads description, design, acceptance criteria, notes, and labels', async () => {
  const ctx = fixture();
  try {
    assert.equal((await ctx.adapter.searchByQuery('temporary file'))[0].id, 'bd-a1');
    assert.equal((await ctx.adapter.searchByQuery('413'))[0].id, 'bd-a1');
    assert.equal((await ctx.adapter.searchByQuery('request id'))[0].id, 'bd-a1');
  } finally {
    ctx.cleanup();
  }
});

test('CRUD delegates to bd JSON commands and round-trips canonical state', async () => {
  const ctx = fixture();
  try {
    const created = await ctx.adapter.createTask({
      projectId: 'demo-beads', title: 'Add checksum', content: 'Verify the artifact.', priority: 'high', tags: ['release'], dueDate: '2026-07-01',
    });
    assert.match(created.id, /^bd-new/);
    assert.equal(created.dueDate, '2026-07-01');
    const updated = await ctx.adapter.updateTask('demo-beads', created.id, { title: 'Verify checksum', tags: [] });
    assert.equal(updated.title, 'Verify checksum');
    assert.deepEqual(updated.tags, []);
    const completed = await ctx.adapter.__ext.tasks.complete('demo-beads', created.id);
    assert.equal(completed.status, 'completed');
    await ctx.adapter.__ext.tasks.remove('demo-beads', created.id);
    await assert.rejects(ctx.adapter.getTask('demo-beads', created.id), /not found/);
  } finally {
    ctx.cleanup();
  }
});

test('passes the ATS conformance kit including writes', async () => {
  const ctx = fixture();
  try {
    const report = await runConformance(ctx.adapter, { write: true });
    assert.equal(report.ok, true);
  } finally {
    ctx.cleanup();
  }
});
