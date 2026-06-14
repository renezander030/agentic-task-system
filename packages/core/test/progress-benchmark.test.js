import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgressBenchmark, scoreProgressEpisode, scoreProgressEpisodes } from '../progress-benchmark.js';

const episode = {
  id: 'demo-progress',
  task: { projectId: 'demo', taskId: 'work' },
  context: {
    included: [
      { ref: 'demo/decision', tokens: 100 },
      { ref: 'demo/noise', tokens: 300 },
    ],
    relevant: ['demo/decision', 'demo/missing'],
  },
  doneWhen: ['Check passes', 'Approval recorded'],
  before: { status: 'active', blockers: ['approval', 'check'], criteriaSatisfied: [] },
  after: { status: 'active', blockers: ['approval'], criteriaSatisfied: ['Check passes'] },
  actions: [{ action: 'verification.run', advanced: true }],
  humanCorrections: 1,
};

test('scores one workflow episode with transparent progress metrics', () => {
  const score = scoreProgressEpisode(episode);
  assert.equal(score.task, 'demo/work');
  assert.equal(score.advanced, true);
  assert.equal(score.context.precision, 0.5);
  assert.equal(score.context.recall, 0.5);
  assert.equal(score.context.irrelevantTokens, 300);
  assert.equal(score.context.irrelevantTokenRate, 0.75);
  assert.equal(score.blockers.removalRate, 0.5);
  assert.equal(score.completionCriteria.satisfactionRate, 0.5);
  assert.equal(score.reopened, false);
  assert.equal(score.humanCorrections, 1);
});

test('aggregates advancement, reopen, correction, context, blocker, and criteria rates', () => {
  const completed = JSON.parse(JSON.stringify(episode));
  completed.id = 'completed';
  completed.context = { included: [{ ref: 'demo/decision', tokens: 100 }], relevant: ['demo/decision'] };
  completed.before = { status: 'completed', blockers: [], criteriaSatisfied: ['Check passes', 'Approval recorded'] };
  completed.after = { status: 'active', blockers: [], criteriaSatisfied: ['Check passes'] };
  completed.reopened = true;
  completed.humanCorrections = 0;
  const report = scoreProgressEpisodes([episode, completed]);
  assert.equal(report.episodeCount, 2);
  assert.equal(report.metrics.taskAdvancementRate, 1);
  assert.equal(report.metrics.contextPrecision, 2 / 3);
  assert.equal(report.metrics.irrelevantTokens, 300);
  assert.equal(report.metrics.reopenRate, 0.5);
  assert.equal(report.metrics.humanCorrections, 1);
  assert.match(formatProgressBenchmark(report), /Workflow Progress Benchmark/);
});

test('rejects malformed counts and references', () => {
  assert.throws(() => scoreProgressEpisode({ id: 'bad', context: { included: [{ ref: 'bad', tokens: -1 }] } }), /non-negative/);
  assert.throws(() => scoreProgressEpisode({ id: 'missing-token', context: { included: [{ ref: 'demo/a' }] } }), /token estimate/);
  assert.throws(() => scoreProgressEpisodes([]), /at least one episode/);
});

test('duplicate relevant injections do not inflate recall above one', () => {
  const score = scoreProgressEpisode({
    id: 'duplicates',
    context: {
      included: [{ ref: 'demo/a', tokens: 10 }, { ref: 'demo/a', tokens: 10 }],
      relevant: ['demo/a'],
    },
  });
  assert.equal(score.context.precision, 1);
  assert.equal(score.context.recall, 1);
});
