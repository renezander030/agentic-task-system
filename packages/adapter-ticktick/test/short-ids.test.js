import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { update, create } from '../tasks.js';
import { parsePriority } from '../api.js';

const P1 = 'projA1-long-identifier';
const P2 = 'projA2-long-identifier';
const T1 = 'taskB1-long-identifier';
const T2 = 'taskB2-long-identifier';

function fakeApi({ projects, tasksByProject = {}, completed = [] }) {
  const calls = [];
  const apiRequest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/project') return projects;
    const data = /^\/project\/([^/]+)\/data$/.exec(path);
    if (method === 'GET' && data) return { tasks: tasksByProject[decodeURIComponent(data[1])] || [] };
    if (method === 'POST' && path === '/task/completed') return completed;
    const one = /^\/project\/([^/]+)\/task\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) return { id: decodeURIComponent(one[2]), projectId: decodeURIComponent(one[1]), title: 'Old' };
    if (method === 'POST') return { ...body };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { apiRequest, calls };
}

test('a project prefix shared by two projects is refused', async () => {
  const { apiRequest } = fakeApi({ projects: [{ id: P1 }, { id: P2 }] });
  await assert.rejects(update('projA', T1, { title: 'x' }, { apiRequest }), /Ambiguous project id "projA": 2 matches/);
});

test('a unique project prefix still resolves', async () => {
  const { apiRequest } = fakeApi({ projects: [{ id: P1 }, { id: P2 }] });
  const res = await update('projA1', T1, { title: 'x' }, { apiRequest });
  assert.equal(res.task.fullProjectId, P1);
});

test('a task prefix matching two tasks in the named project is refused before any write', async () => {
  const { apiRequest, calls } = fakeApi({ projects: [{ id: P1 }], tasksByProject: { [P1]: [{ id: T1 }, { id: T2 }] } });
  await assert.rejects(update(P1, 'taskB', { title: 'x' }, { apiRequest }), /Ambiguous task id "taskB": 2 matches \(taskB1/);
  assert.ok(!calls.some((c) => c.startsWith('POST /task/')), 'no write was sent');
});

test('outside the named project, a task prefix shared by two projects is refused, not resolved to the first', async () => {
  const P3 = 'projC3-long-identifier';
  const { apiRequest } = fakeApi({ projects: [{ id: P1 }, { id: P2 }, { id: P3 }], tasksByProject: { [P2]: [{ id: T1 }], [P3]: [{ id: T2 }] } });
  await assert.rejects(update(P1, 'taskB', { title: 'x' }, { apiRequest }), /Ambiguous task id "taskB": 2 matches/);
});

test('inside the named project a prefix unique there resolves, even if another project shares it', async () => {
  const { apiRequest } = fakeApi({ projects: [{ id: P1 }, { id: P2 }], tasksByProject: { [P1]: [{ id: T1 }], [P2]: [{ id: T2 }] } });
  assert.equal((await update(P1, 'taskB', { title: 'x' }, { apiRequest })).task.fullId, T1);
});

test('a unique task prefix resolves; a completed task still resolves through the completed listing', async () => {
  const open = fakeApi({ projects: [{ id: P1 }], tasksByProject: { [P1]: [{ id: T1 }, { id: T2 }] } });
  assert.equal((await update(P1, 'taskB1', { title: 'x' }, { apiRequest: open.apiRequest })).task.fullId, T1);
  const done = fakeApi({ projects: [{ id: P1 }], completed: [{ id: T2 }] });
  assert.equal((await update(P1, 'taskB2', { title: 'x' }, { apiRequest: done.apiRequest })).task.fullId, T2);
});

test('numeric priorities use TickTick levels; other numbers are refused', async () => {
  assert.equal(parsePriority(5), 5);
  assert.equal(parsePriority('3'), 3);
  assert.equal(parsePriority(0), 0);
  assert.equal(parsePriority('high'), 5);
  assert.equal(parsePriority(undefined), undefined);
  assert.throws(() => parsePriority(2), /Invalid priority "2"/);
  const { apiRequest } = fakeApi({ projects: [{ id: P1 }] });
  const res = await create(P1, 'New', { priority: 3 }, { apiRequest });
  assert.equal(res.task.priority, 'medium');
});

test('a repeat rule is sent as an RRULE, none clears it, anything else is refused', async () => {
  const { apiRequest, calls } = fakeApi({ projects: [{ id: P1 }] });
  const sent = [];
  const recording = async (method, path, body, deps) => { if (method === 'POST') sent.push(body); return apiRequest(method, path, body, deps); };
  const made = await create(P1, 'Weekly review', { repeat: 'FREQ=WEEKLY;BYDAY=MO' }, { apiRequest: recording });
  assert.equal(sent[0].repeatFlag, 'RRULE:FREQ=WEEKLY;BYDAY=MO');
  assert.equal(made.task.repeatFlag, 'RRULE:FREQ=WEEKLY;BYDAY=MO');
  await update(P1, T1, { repeat: 'none' }, { apiRequest: recording });
  assert.equal(sent[1].repeatFlag, '');
  await update(P1, T1, { title: 'kept' }, { apiRequest: recording, existingTask: { title: 'Old', repeatFlag: 'RRULE:FREQ=DAILY' } });
  assert.equal(sent[2].repeatFlag, 'RRULE:FREQ=DAILY');
  await assert.rejects(create(P1, 'x', { repeat: 'every monday' }, { apiRequest: recording }), /Invalid repeat rule/);
  assert.ok(calls.length > 0);
});
