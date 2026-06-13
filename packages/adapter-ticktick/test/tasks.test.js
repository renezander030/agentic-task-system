import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, update } from '../tasks.js';

const projectId = 'project-123456789';
const taskId = 'task-123456789012';
const baseDeps = {
  isShortId: () => false,
  shortId: (id) => id.slice(0, 8),
  formatPriority: (value) => ({ 0: 'none', 5: 'high' }[value] || 'none'),
  parsePriority: (value) => ({ none: 0, high: 5 }[value]),
  parseReminder: () => 'TRIGGER:-PT1H',
};

test('create returns the complete task fields needed by the adapter contract', async () => {
  const apiRequest = async (method, endpoint, body) => {
    assert.deepEqual([method, endpoint], ['POST', '/task']);
    return {
      id: taskId,
      projectId,
      title: body.title,
      content: body.content,
      tags: body.tags,
      dueDate: body.dueDate,
      priority: body.priority,
      modifiedTime: '2026-06-12T10:00:00.000Z',
    };
  };
  const result = await create(projectId, 'Contract task', {
    content: 'body',
    tags: ['ats'],
    dueDate: '2026-06-15',
    priority: 'high',
  }, { ...baseDeps, apiRequest });
  assert.equal(result.task.fullId, taskId);
  assert.equal(result.task.fullProjectId, projectId);
  assert.equal(result.task.content, 'body');
  assert.equal(result.task.dueDate, '2026-06-15');
  assert.deepEqual(result.task.tags, ['ats']);
  assert.equal(result.task.modifiedTime, '2026-06-12T10:00:00.000Z');
});

test('create response preserves accepted fields omitted by TickTick OpenAPI', async () => {
  const apiRequest = async () => ({
    id: taskId,
    projectId,
    title: 'Sparse API response',
    modifiedTime: '2026-06-12T10:00:00.000Z',
  });
  const result = await create(projectId, 'Sparse API response', {
    content: 'body',
    dueDate: '2026-06-20',
    priority: 'high',
    tags: ['ats'],
    reminder: '1h',
  }, { ...baseDeps, apiRequest });

  assert.equal(result.task.dueDate, '2026-06-20');
  assert.equal(result.task.priority, 'high');
  assert.deepEqual(result.task.tags, ['ats']);
  assert.deepEqual(result.task.reminders, ['TRIGGER:-PT1H']);
  assert.equal(result.task.status, 'active');
});

test('update can explicitly clear content, due date, and tags', async () => {
  const calls = [];
  const apiRequest = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'GET') {
      return { id: taskId, projectId, title: 'Existing', content: 'old', tags: ['old'], dueDate: '2026-06-15' };
    }
    return { ...body, modifiedTime: '2026-06-12T11:00:00.000Z' };
  };
  const result = await update(projectId, taskId, { content: '', dueDate: '', tags: '' }, {
    ...baseDeps,
    apiRequest,
  });
  const write = calls.find((call) => call.method === 'POST');
  assert.equal(write.body.content, '');
  assert.equal(write.body.dueDate, '');
  assert.deepEqual(write.body.tags, []);
  assert.equal(result.task.content, '');
  assert.deepEqual(result.task.tags, []);
});

test('partial update preserves mutable fields omitted by the caller', async () => {
  let write;
  const apiRequest = async (method, _endpoint, body) => {
    if (method === 'GET') {
      return {
        id: taskId,
        projectId,
        title: 'Existing',
        content: 'keep body',
        dueDate: '2026-06-21',
        priority: 3,
        tags: ['keep'],
        reminders: ['TRIGGER:-PT15M'],
        repeatFlag: 'RRULE:FREQ=WEEKLY',
      };
    }
    write = body;
    return { ...body, modifiedTime: '2026-06-12T12:00:00.000Z' };
  };

  const result = await update(projectId, taskId, { priority: 'high' }, {
    ...baseDeps,
    apiRequest,
  });

  assert.equal(write.content, 'keep body');
  assert.equal(write.dueDate, '2026-06-21');
  assert.deepEqual(write.tags, ['keep']);
  assert.deepEqual(write.reminders, ['TRIGGER:-PT15M']);
  assert.equal(write.repeatFlag, 'RRULE:FREQ=WEEKLY');
  assert.equal(result.task.priority, 'high');
  assert.equal(result.task.dueDate, '2026-06-21');
});
