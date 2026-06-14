export const PROGRESS_BENCHMARK_VERSION = 1;

function uniqueStrings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function nonNegative(value, field, fallback = 0) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a non-negative number.`);
  return number;
}

function refKey(value, field) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && value.projectId && value.taskId) {
    return `${value.projectId}/${value.taskId}`;
  }
  throw new Error(`${field} must be a stable reference string or a { projectId, taskId } object.`);
}

function referenceArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of task references.`);
  return value.map((item, index) => refKey(item, `${field}[${index}]`));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function difference(values, set) {
  return values.filter((value) => !set.has(value));
}

export function scoreProgressEpisode(input) {
  if (!input || typeof input !== 'object') throw new Error('Progress episode must be an object.');
  if (!input.id || typeof input.id !== 'string') throw new Error('Progress episode requires an id.');

  const includedInput = input.context?.included;
  if (includedInput !== undefined && !Array.isArray(includedInput)) throw new Error('context.included must be an array.');
  const included = (includedInput || []).map((item, index) => {
    if (!item || typeof item !== 'object' || item.tokens === undefined) {
      throw new Error(`context.included[${index}] requires a reference and token estimate.`);
    }
    return {
      ref: refKey(item.ref ?? item, `context.included[${index}]`),
      tokens: nonNegative(item.tokens, `context.included[${index}].tokens`),
    };
  });
  const relevant = new Set(referenceArray(input.context?.relevant, 'context.relevant'));
  const relevantInjected = included.filter((item) => relevant.has(item.ref));
  const relevantRetrieved = new Set(relevantInjected.map((item) => item.ref));
  const irrelevantInjected = included.filter((item) => !relevant.has(item.ref));
  const totalContextTokens = included.reduce((sum, item) => sum + item.tokens, 0);
  const irrelevantTokens = irrelevantInjected.reduce((sum, item) => sum + item.tokens, 0);

  const blockersBefore = uniqueStrings(input.before?.blockers, 'before.blockers');
  const blockersAfter = uniqueStrings(input.after?.blockers, 'after.blockers');
  const blockersAfterSet = new Set(blockersAfter);
  const blockersRemoved = difference(blockersBefore, blockersAfterSet);

  const doneWhen = uniqueStrings(input.doneWhen, 'doneWhen');
  const criteriaBefore = uniqueStrings(input.before?.criteriaSatisfied, 'before.criteriaSatisfied');
  const criteriaAfter = uniqueStrings(input.after?.criteriaSatisfied, 'after.criteriaSatisfied');
  const doneWhenSet = new Set(doneWhen);
  const criteriaBeforeSet = new Set(criteriaBefore);
  const satisfiedCriteria = criteriaAfter.filter((criterion) => doneWhenSet.has(criterion));
  const newlySatisfiedCriteria = satisfiedCriteria.filter((criterion) => !criteriaBeforeSet.has(criterion));

  const actions = Array.isArray(input.actions) ? input.actions : [];
  const humanCorrections = nonNegative(
    input.humanCorrections,
    'humanCorrections',
    actions.filter((action) => action?.action === 'human.correction').length
  );
  const actionAdvanced = actions.some((action) => action?.advanced === true);
  const beforeStatus = input.before?.status || 'active';
  const afterStatus = input.after?.status || 'active';
  const completed = afterStatus === 'completed';
  const reopened = input.reopened === true || (beforeStatus === 'completed' && afterStatus !== 'completed');
  const advanced = input.advanced === true || actionAdvanced || completed || blockersRemoved.length > 0 || newlySatisfiedCriteria.length > 0;

  return {
    id: input.id,
    task: input.task ? refKey(input.task, 'task') : null,
    advanced,
    completed,
    reopened,
    humanCorrections,
    supervisionFree: humanCorrections === 0,
    context: {
      injectedCount: included.length,
      relevantInjectedCount: relevantInjected.length,
      relevantRetrievedCount: relevantRetrieved.size,
      expectedRelevantCount: relevant.size,
      precision: ratio(relevantInjected.length, included.length),
      recall: ratio(relevantRetrieved.size, relevant.size),
      totalTokens: totalContextTokens,
      irrelevantTokens,
      irrelevantTokenRate: ratio(irrelevantTokens, totalContextTokens),
      missingRelevant: [...relevant].filter((ref) => !relevantInjected.some((item) => item.ref === ref)),
    },
    blockers: {
      before: blockersBefore.length,
      after: blockersAfter.length,
      removed: blockersRemoved.length,
      removalRate: ratio(blockersRemoved.length, blockersBefore.length),
      removedIds: blockersRemoved,
    },
    completionCriteria: {
      total: doneWhen.length,
      satisfied: satisfiedCriteria.length,
      newlySatisfied: newlySatisfiedCriteria.length,
      satisfactionRate: ratio(satisfiedCriteria.length, doneWhen.length),
      newlySatisfiedIds: newlySatisfiedCriteria,
    },
  };
}

function aggregateRatio(episodes, numerator, denominator) {
  const totals = episodes.reduce((sum, episode) => ({
    numerator: sum.numerator + numerator(episode),
    denominator: sum.denominator + denominator(episode),
  }), { numerator: 0, denominator: 0 });
  return ratio(totals.numerator, totals.denominator);
}

export function scoreProgressEpisodes(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Progress benchmark requires at least one episode.');
  const episodes = inputs.map(scoreProgressEpisode);
  const totalIrrelevantTokens = episodes.reduce((sum, episode) => sum + episode.context.irrelevantTokens, 0);
  const totalHumanCorrections = episodes.reduce((sum, episode) => sum + episode.humanCorrections, 0);
  return {
    version: PROGRESS_BENCHMARK_VERSION,
    episodeCount: episodes.length,
    metrics: {
      taskAdvancementRate: ratio(episodes.filter((episode) => episode.advanced).length, episodes.length),
      completionRate: ratio(episodes.filter((episode) => episode.completed).length, episodes.length),
      contextPrecision: aggregateRatio(episodes, (episode) => episode.context.relevantInjectedCount, (episode) => episode.context.injectedCount),
      contextRecall: aggregateRatio(episodes, (episode) => episode.context.relevantRetrievedCount, (episode) => episode.context.expectedRelevantCount),
      irrelevantTokens: totalIrrelevantTokens,
      averageIrrelevantTokens: totalIrrelevantTokens / episodes.length,
      irrelevantTokenRate: aggregateRatio(episodes, (episode) => episode.context.irrelevantTokens, (episode) => episode.context.totalTokens),
      blockerRemovalRate: aggregateRatio(episodes, (episode) => episode.blockers.removed, (episode) => episode.blockers.before),
      completionCriteriaRate: aggregateRatio(episodes, (episode) => episode.completionCriteria.satisfied, (episode) => episode.completionCriteria.total),
      reopenRate: ratio(episodes.filter((episode) => episode.reopened).length, episodes.length),
      humanCorrections: totalHumanCorrections,
      averageHumanCorrections: totalHumanCorrections / episodes.length,
      supervisionFreeRate: ratio(episodes.filter((episode) => episode.supervisionFree).length, episodes.length),
    },
    episodes,
  };
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatProgressBenchmark(report) {
  const metrics = report.metrics;
  const lines = [
    '# Workflow Progress Benchmark',
    '',
    `Episodes: ${report.episodeCount}`,
    '',
    '| Metric | Result | Direction |',
    '| --- | ---: | --- |',
    `| Task advancement rate | ${percent(metrics.taskAdvancementRate)} | higher |`,
    `| Completion rate | ${percent(metrics.completionRate)} | higher |`,
    `| Relevant-context precision | ${percent(metrics.contextPrecision)} | higher |`,
    `| Relevant-context recall | ${percent(metrics.contextRecall)} | higher |`,
    `| Irrelevant tokens | ${metrics.irrelevantTokens} total / ${metrics.averageIrrelevantTokens.toFixed(1)} avg | lower |`,
    `| Irrelevant-token rate | ${percent(metrics.irrelevantTokenRate)} | lower |`,
    `| Blocker removal rate | ${percent(metrics.blockerRemovalRate)} | higher |`,
    `| Completion criteria satisfied | ${percent(metrics.completionCriteriaRate)} | higher |`,
    `| Task reopen rate | ${percent(metrics.reopenRate)} | lower |`,
    `| Human corrections | ${metrics.humanCorrections} total / ${metrics.averageHumanCorrections.toFixed(2)} avg | lower |`,
    `| Supervision-free rate | ${percent(metrics.supervisionFreeRate)} | higher |`,
    '',
    '## Episodes',
    '',
    '| Episode | Advanced | Completed | Context precision | Irrelevant tokens | Blockers removed | Criteria | Reopened | Corrections |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const episode of report.episodes) {
    lines.push(
      `| ${episode.id} | ${episode.advanced ? 'yes' : 'no'} | ${episode.completed ? 'yes' : 'no'} | ` +
      `${percent(episode.context.precision)} | ${episode.context.irrelevantTokens} | ` +
      `${episode.blockers.removed}/${episode.blockers.before} | ` +
      `${episode.completionCriteria.satisfied}/${episode.completionCriteria.total} | ` +
      `${episode.reopened ? 'yes' : 'no'} | ${episode.humanCorrections} |`
    );
  }
  return `${lines.join('\n')}\n`;
}
