/**
 * ats workstream — work streams: one parent task + 2-3 verified sub-tasks.
 *
 * The human's capacity to process information is limited, so anything that
 * reaches them must be small, scannable, dated, and already verified. This
 * command makes that structural rather than a matter of agent discipline.
 *
 * It owns no storage of its own. Everything lives in ATS primitives:
 *   - membership      real sub-tasks (adapter parentId) + hierarchy metadata
 *   - outcome/done    intent metadata (frontmatter), not a private body format
 *   - the verify log  the append-only action ledger
 *   - the review date the task due date
 * so `ats intent get`, `ats hierarchy get`, `ats ledger list` and `ats undo`
 * all see a work stream as an ordinary ATS task graph.
 */

import {
  parseTaskMetadata,
  writeTaskMetadata,
  recordAction,
  listActions,
} from '@reneza/ats-core';

// --- the hard numbers ------------------------------------------------------
export const MAX_ITEMS = 3;   // "two to three work items max per work stream"
const MIN_ITEMS = 1;
const TITLE_MAX = 70;         // a title that still reads on one line
const STREAM_TAG = 'wstream';
const VERIFY_ACTION = 'workstream.verify';

// A title built on one of these names an activity, not an outcome.
const CONTAINER_VERBS = [
  'do', 'work on', 'explore', 'check in on', 'look into', 'think about',
  'review', 'investigate', 'research', 'continue', 'start', 'handle',
  'deal with', 'sort out', 'figure out', 'touch base', 'follow up on',
];

export const EXIT_OK = 0;
export const EXIT_ERR = 1;
export const EXIT_GATE = 2;

// ---------------------------------------------------------------------------
// readability — ::colon highlight:: is the primary marker, one per section
// ---------------------------------------------------------------------------

/**
 * Colour is DERIVED from gate state, never chosen by an agent or a human.
 * That is the whole reason the rule survives: every colour below is a state
 * this command already computes, so nothing has to be remembered or picked,
 * and a body re-renders to the same colours every time.
 *
 *   outcome  what must become true      the thing being aimed at
 *   date     the review date            when it lands in front of the human
 *   pass     verified with evidence     safe to hand back
 *   fail     failed or blocked          needs a decision
 *
 * Blue and purple are deliberately left unassigned. An unused colour keeps its
 * signal; spending all six on nothing in particular is how a scheme goes numb.
 *
 * MARKUP is the single place to change once TickTick's per-colour syntax is
 * confirmed from the app. Until then every role renders as the plain
 * double-colon highlight, which is what shipped and what already reads well.
 */
const MARKUP = {
  // `::x::` is the uncoloured highlight already in wide use. A colour is the
  // `=={#hex}x==` form, confirmed against the TickTick editor 2026-09-07.
  plain: '::{}::',
  outcome: process.env.ATS_HL_OUTCOME || '=={#57DEE2}{}==',  // cyan
  date: process.env.ATS_HL_DATE || '=={#FFE500}{}==',        // yellow
  pass: process.env.ATS_HL_PASS || '=={#6FF143}{}==',        // green
  fail: process.env.ATS_HL_FAIL || '=={#FD848D}{}==',        // red
};

const clean = (text) => String(text).trim().replace(/:+$/, '');

/** hl(text) keeps the plain marker; hl(text, 'pass') asks for a gate colour. */
const hl = (text, role = 'plain') => {
  const tmpl = process.env.ATS_WORKSTREAM_HIGHLIGHT || MARKUP[role] || MARKUP.plain;
  // Only the empty `{}` placeholder is substituted, never the `{#hex}` colour
  // token that sits beside it.
  return tmpl.replace('{}', clean(text));
};
const bold = (text) => `**${text}**`;
const code = (text) => '`' + String(text).replace(/`/g, "'") + '`';

function renderStreamBody(spec, streamId) {
  const { stream, items } = spec;
  const lines = [
    '## Outcome',
    `> ${hl(stream.outcome, 'outcome')}`,
    '',
    `## Work items ${hl(`${items.length} of max ${MAX_ITEMS}`)}`,
  ];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${bold(item.title)} ${hl(`review ${day(item.review)}`, 'date')}`);
  });
  lines.push(
    '',
    '## Ready gate',
    `Back to the human only when ${code(`ats workstream ready ${streamId || '<stream>'}`)} exits 0.`,
    `Every item needs ${hl('a review date and a PASS with evidence')}.`,
  );
  return lines.join('\n');
}

function renderItemBody(item, n, total, log) {
  const last = log[log.length - 1];
  const status = !last
    ? hl('NOT VERIFIED YET')
    : last.advanced ? hl('VERIFIED', 'pass') : hl('VERIFICATION FAILED', 'fail');
  const lines = [
    status,
    '',
    '## Outcome',
    `> ${item.outcome}`,
    '',
    '## Done when',
    hl(item.done_when, 'outcome'),
    '',
    '## Verification',
    code(item.verify),
    '',
    `## Review ${hl(day(item.review), 'date')}`,
    '',
    '## Log',
  ];
  if (!log.length) lines.push('- [ ] not verified yet');
  else {
    for (const entry of log) {
      lines.push(`- [${entry.advanced ? 'x' : ' '}] ${entry.ts.slice(0, 16).replace('T', ' ')} `
        + `${bold(entry.advanced ? 'PASS' : 'FAIL')} - ${entry.output || ''}`);
    }
  }
  if (item.notes) lines.push('', '## Notes', item.notes);
  lines.push('', `_item ${n}/${total} of this work stream_`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// dates — TickTick silently ignores a bare YYYY-MM-DD, so always send full ISO
// ---------------------------------------------------------------------------

function toIso(value, hour = 9) {
  const v = String(value || '').trim();
  if (!v) throw new Error('empty date');
  let dt;
  const rel = v.match(/^\+(\d+)$/);
  if (rel) dt = new Date(Date.now() + Number(rel[1]) * 864e5);
  else if (v.toLowerCase() === 'today') dt = new Date();
  else if (v.toLowerCase() === 'tomorrow') dt = new Date(Date.now() + 864e5);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dt = new Date(`${v}T00:00:00`);
  else {
    dt = new Date(v);
    if (Number.isNaN(dt.getTime())) throw new Error(`unparseable date: ${v}`);
    return isoStamp(dt);
  }
  dt.setHours(hour, 0, 0, 0);
  return isoStamp(dt);
}

function isoStamp(dt) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
    + `T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}.000`
    + `${sign}${pad(off / 60 | 0)}${pad(off % 60)}`;
}

function day(value) {
  try { return toIso(value).slice(0, 10); } catch { return String(value); }
}

function isPast(value) {
  const d = new Date(toIso(value));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d < today;
}

// ---------------------------------------------------------------------------
// the strict template + its gate
// ---------------------------------------------------------------------------

export const TEMPLATE = {
  stream: {
    title: '<outcome-shaped stream title>',
    project: 'inbox',
    outcome: '<one sentence, observable when it is true>',
    review: '<YYYY-MM-DD - when the human reviews the whole stream>',
    tags: [STREAM_TAG],
  },
  items: [1, 2].map(() => ({
    title: '<outcome-shaped item title>',
    outcome: '<the deliverable this item produces>',
    done_when: '<the observable state that means done>',
    verify: '<the exact command or reading that proves it>',
    review: '<YYYY-MM-DD - required>',
    notes: '',
  })),
};

export function lint(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object' || !spec.stream || !spec.items) {
    return ["spec needs a 'stream' object and an 'items' list - see: ats workstream template"];
  }
  const s = spec.stream;
  for (const f of ['title', 'outcome', 'review']) {
    const v = String(s[f] ?? '').trim();
    if (!v) errs.push(`stream.${f} is required`);
    else if (v.startsWith('<')) errs.push(`stream.${f} is still the template placeholder`);
  }
  if (String(s.title ?? '').length > TITLE_MAX) {
    errs.push(`stream.title is ${s.title.length} chars, max ${TITLE_MAX} - it must read on one line`);
  }
  errs.push(...containerCheck('stream.title', s.title));
  errs.push(...dateCheck('stream.review', s.review));

  if (!Array.isArray(spec.items)) return errs.concat('items must be a list');
  if (spec.items.length > MAX_ITEMS) {
    errs.push(`HARD CAP: ${spec.items.length} work items, max ${MAX_ITEMS} per stream. `
      + 'Split the rest into a second stream.');
  }
  if (spec.items.length < MIN_ITEMS) errs.push(`a stream needs at least ${MIN_ITEMS} work item`);

  const seen = new Set();
  spec.items.forEach((item, idx) => {
    const i = idx + 1;
    for (const f of ['title', 'outcome', 'done_when', 'verify', 'review']) {
      const v = String(item[f] ?? '').trim();
      if (!v) errs.push(`items[${i}].${f} is required`);
      else if (v.startsWith('<')) errs.push(`items[${i}].${f} is still the template placeholder`);
    }
    const t = String(item.title ?? '');
    if (t.length > TITLE_MAX) errs.push(`items[${i}].title is ${t.length} chars, max ${TITLE_MAX}`);
    if (seen.has(t.toLowerCase())) errs.push(`items[${i}].title duplicates an earlier item`);
    seen.add(t.toLowerCase());
    errs.push(...containerCheck(`items[${i}].title`, t));
    errs.push(...dateCheck(`items[${i}].review`, item.review));
  });
  return errs;
}

function containerCheck(field, title) {
  const low = String(title ?? '').trim().toLowerCase();
  for (const v of CONTAINER_VERBS) {
    if (low.startsWith(`${v} `)) {
      return [`${field} starts with the container verb '${v}' - name the outcome, not the activity`];
    }
  }
  return [];
}

function dateCheck(field, value) {
  const v = String(value ?? '').trim();
  if (!v || v.startsWith('<')) return [];
  try {
    toIso(v);
  } catch (err) {
    return [`${field}: ${err.message}`];
  }
  return isPast(v) ? [`${field} is in the past (${day(v)}) - a review date must be reachable`] : [];
}

// ---------------------------------------------------------------------------
// reading a stream back out of ATS — no local state, the tasks are the truth
// ---------------------------------------------------------------------------

async function readTask(adapter, t, projectId, taskId, live = true) {
  if (t?.get) return t.get(projectId, taskId, ...(live ? [{ live: true }] : []));
  return adapter.getTask(projectId, taskId);
}

async function loadStream(adapter, t, projectId, streamId) {
  const parent = await readTask(adapter, t, projectId, streamId);
  const childIds = parent.childIds || parent.task?.childIds || [];
  if (!childIds.length) {
    throw new Error(`task ${streamId} has no sub-tasks - is it a work stream? `
      + 'Create one with: ats workstream create <spec.json>');
  }
  const items = await Promise.all(childIds.map((id) => readTask(adapter, t, projectId, id)));
  // childIds order is not creation order, and `verify <n>` addresses an item by
  // position - an unstable order would verify the wrong item. Creation order is
  // spec order, because create writes the items in sequence.
  items.sort((a, b) => String(a.createdTime || a.fullId || a.id)
    .localeCompare(String(b.createdTime || b.fullId || b.id)));
  return { parent, items };
}

function verifyLog(projectId, taskId) {
  // The ledger filter keys are projectId/taskId. Re-assert the match locally so
  // a filter that silently stops matching can never let one item's PASS count
  // for another - a gate that passes when it should fail is the one bug this
  // command exists to prevent.
  return listActions({ projectId, taskId, action: VERIFY_ACTION })
    .filter((a) => a.action === VERIFY_ACTION
      && a.task?.projectId === projectId
      && a.task?.taskId === taskId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

function collect(projectId, parent, items) {
  const rows = [];
  let ok = true;
  const capOk = items.length <= MAX_ITEMS;
  ok = ok && capOk;
  rows.push({ label: 'cap', detail: `${items.length} of max ${MAX_ITEMS} work items`, ok: capOk });

  items.forEach((item, idx) => {
    const id = item.fullId || item.id;
    const log = verifyLog(projectId, id);
    const last = log[log.length - 1];
    const due = item.dueDate;
    const passed = Boolean(last && last.advanced);
    const rowOk = Boolean(due) && passed;
    ok = ok && rowOk;
    const detail = `review ${due ? String(due).slice(0, 10) : 'NO REVIEW DATE'} | `
      + (passed ? `verified: ${String(last.output || '').slice(0, 60)}`
        : last ? `FAILED: ${String(last.output || '').slice(0, 60)}`
          : 'NOT VERIFIED');
    rows.push({ label: `${idx + 1}/${items.length} ${String(item.title).slice(0, 38)}`, detail, ok: rowOk });
  });

  const streamDue = Boolean(parent.dueDate);
  ok = ok && streamDue;
  rows.push({ label: 'stream review', detail: parent.dueDate ? String(parent.dueDate).slice(0, 10) : 'NONE', ok: streamDue });
  return { rows, ok };
}

function renderCheck(rows) {
  const w = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => `  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.label.padEnd(w)}  ${r.detail}`).join('\n');
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

export async function runWorkstream({
  adapter, args, readSpec, urlFor, log = console.log, err = console.error,
}) {
  const sub = args.subcommand;
  const t = adapter.__ext?.tasks;
  const rest = args.positional;

  switch (sub) {
    case 'template':
      log(JSON.stringify(TEMPLATE, null, 2));
      return EXIT_OK;

    case 'agent-brief':
      log(BRIEF);
      return EXIT_OK;

    case 'lint': {
      const spec = readSpec(rest[0]);
      const errs = lint(spec);
      if (errs.length) {
        log(`LINT: ${errs.length} problem(s)`);
        errs.forEach((e) => log(`  x ${e}`));
        return EXIT_GATE;
      }
      log(`LINT: clean - ${spec.items.length} work item(s), all review dates set, `
        + 'all verifications named');
      return EXIT_OK;
    }

    case 'create': {
      const spec = readSpec(rest[0]);
      const errs = lint(spec);
      if (errs.length) {
        log('REFUSED - spec does not pass lint:');
        errs.forEach((e) => log(`  x ${e}`));
        return EXIT_GATE;
      }
      if (args.options['dry-run'] === true) {
        log('DRY RUN - nothing written\n');
        log(`STREAM: ${spec.stream.title}`);
        log(renderStreamBody(spec, ''));
        spec.items.forEach((item, i) => {
          log(`\nITEM ${i + 1}: ${item.title}`);
          log(renderItemBody(item, i + 1, spec.items.length, []));
        });
        return EXIT_OK;
      }

      const projectId = spec.stream.project || 'inbox';
      const tags = spec.stream.tags?.length ? spec.stream.tags : [STREAM_TAG];

      const parent = await createOne(adapter, t, projectId, {
        title: spec.stream.title,
        content: withMetadata(renderStreamBody(spec, ''), {
          intent: { outcome: spec.stream.outcome, approvalRequired: true },
          hierarchy: { kind: 'project' },
        }),
        dueDate: toIso(spec.stream.review),
        tags,
        priority: 'high',
      });
      const streamId = parent.fullId || parent.id;
      const streamProject = parent.fullProjectId || parent.projectId || projectId;

      const made = [];
      for (const [idx, item] of spec.items.entries()) {
        const child = await createOne(adapter, t, streamProject, {
          title: item.title,
          parentId: streamId,
          content: withMetadata(renderItemBody(item, idx + 1, spec.items.length, []), {
            intent: {
              outcome: item.outcome,
              doneWhen: [item.done_when],
              authority: [item.verify],
              approvalRequired: true,
            },
            hierarchy: { kind: 'task' },
          }),
          dueDate: toIso(item.review),
          tags,
        });
        made.push(child);
        recordAction({
          action: 'workstream.item.created',
          task: { projectId: streamProject, taskId: child.fullId || child.id },
          sources: [streamId],
          output: item.title,
          advanced: true,
        });
      }

      // The stream body can only name its own gate command once it has an id.
      await updateOne(adapter, t, streamProject, streamId, {
        content: withMetadata(renderStreamBody(spec, streamId), {
          intent: { outcome: spec.stream.outcome, approvalRequired: true },
          hierarchy: { kind: 'project' },
        }),
      });

      log(`STREAM  ${spec.stream.title}`);
      log(`        ${urlFor(streamProject, streamId)}`);
      made.forEach((child, i) => {
        log(`  ${i + 1}/${made.length}  ${spec.items[i].title}`);
        log(`        review ${day(spec.items[i].review)}  `
          + `${urlFor(streamProject, child.fullId || child.id)}`);
      });
      log(`\nstream id: ${streamId}`);
      log(`next: do the work, then \`ats workstream verify ${streamId} <n> --evidence "..."\` per item,`);
      log(`      then \`ats workstream ready ${streamId}\` before anything goes back to the human.`);
      return EXIT_OK;
    }

    case 'verify': {
      const [streamId, nRaw] = rest;
      const n = Number(nRaw);
      const evidence = args.options.evidence;
      if (!streamId || !Number.isInteger(n)) {
        err('Usage: ats workstream verify STREAM_ID ITEM_N --evidence "..." [--fail]');
        return EXIT_ERR;
      }
      if (!evidence || typeof evidence !== 'string') {
        err('--evidence is required: name the reading that proves it, not an opinion');
        return EXIT_ERR;
      }
      const projectId = args.options.project || (await projectOf(adapter, t, streamId));
      const { items } = await loadStream(adapter, t, projectId, streamId);
      const item = items[n - 1];
      if (!item) { err(`stream ${streamId} has no item ${n}`); return EXIT_ERR; }
      const itemId = item.fullId || item.id;
      const advanced = args.options.fail !== true;

      recordAction({
        action: VERIFY_ACTION,
        task: { projectId, taskId: itemId },
        sources: [streamId],
        output: evidence,
        advanced,
      });

      const spec = specFromTask(item, items.length, n);
      await updateOne(adapter, t, projectId, itemId, {
        content: withMetadata(
          renderItemBody(spec, n, items.length, verifyLog(projectId, itemId)),
          metadataOf(item),
        ),
      });
      log(`item ${n}/${items.length}  ${advanced ? 'PASS' : 'FAIL'}  ${item.title}`);
      log(`evidence: ${evidence}`);
      log(urlFor(projectId, itemId));
      return EXIT_OK;
    }

    case 'check':
    case 'ready': {
      const streamId = rest[0];
      if (!streamId) { err(`Usage: ats workstream ${sub} STREAM_ID`); return EXIT_ERR; }
      const projectId = args.options.project || (await projectOf(adapter, t, streamId));
      const { parent, items } = await loadStream(adapter, t, projectId, streamId);
      const { rows, ok } = collect(projectId, parent, items);
      if (args.options.format === 'json') {
        log(JSON.stringify({ ready: ok, checks: rows }, null, 2));
        return ok ? EXIT_OK : EXIT_GATE;
      }
      log(renderCheck(rows));
      if (sub === 'ready') {
        log('');
        log(ok
          ? 'READY - every work item has a review date and a recorded PASS.\nThis stream may go back to the human.'
          : 'NOT READY - do not hand this back yet.');
      }
      return ok ? EXIT_OK : EXIT_GATE;
    }

    case 'redate': {
      const [streamId, which, when] = rest;
      if (!streamId || !which || !when) {
        err('Usage: ats workstream redate STREAM_ID <item-n|stream> YYYY-MM-DD');
        return EXIT_ERR;
      }
      if (isPast(when)) { err(`${day(when)} is in the past - a review date must be reachable`); return EXIT_ERR; }
      const projectId = args.options.project || (await projectOf(adapter, t, streamId));
      const iso = toIso(when);
      if (which === 'stream') {
        await updateOne(adapter, t, projectId, streamId, { dueDate: iso });
        log(`stream review -> ${day(when)}  ${urlFor(projectId, streamId)}`);
        return EXIT_OK;
      }
      const n = Number(which);
      const { items } = await loadStream(adapter, t, projectId, streamId);
      const item = items[n - 1];
      if (!item) { err(`stream ${streamId} has no item ${n}`); return EXIT_ERR; }
      const itemId = item.fullId || item.id;
      const spec = specFromTask(item, items.length, n);
      spec.review = when;
      await updateOne(adapter, t, projectId, itemId, {
        dueDate: iso,
        content: withMetadata(
          renderItemBody(spec, n, items.length, verifyLog(projectId, itemId)),
          metadataOf(item),
        ),
      });
      log(`item ${n} review -> ${day(when)}  ${urlFor(projectId, itemId)}`);
      return EXIT_OK;
    }

    case 'rerender': {
      // Bodies are rendered, never hand-authored, so a template change (a new
      // highlight colour, a new section) is applied here rather than by editing
      // tasks in the app. Everything it needs is already on the tasks.
      const streamId = rest[0];
      if (!streamId) { err('Usage: ats workstream rerender STREAM_ID'); return EXIT_ERR; }
      const projectId = args.options.project || (await projectOf(adapter, t, streamId));
      const { parent, items } = await loadStream(adapter, t, projectId, streamId);
      const parentMeta = metadataOf(parent);
      const specItems = items.map((item, i) => specFromTask(item, items.length, i + 1));

      await updateOne(adapter, t, projectId, streamId, {
        content: withMetadata(renderStreamBody({
          stream: {
            outcome: parentMeta.intent?.outcome || '',
            review: parent.dueDate || '',
          },
          items: specItems,
        }, streamId), parentMeta),
      });
      for (const [idx, item] of items.entries()) {
        const itemId = item.fullId || item.id;
        await updateOne(adapter, t, projectId, itemId, {
          content: withMetadata(
            renderItemBody(specItems[idx], idx + 1, items.length, verifyLog(projectId, itemId)),
            metadataOf(item),
          ),
        });
      }
      log(`re-rendered ${items.length + 1} task(s)`);
      log(urlFor(projectId, streamId));
      return EXIT_OK;
    }

    case 'show': {
      const streamId = rest[0];
      if (!streamId) { err('Usage: ats workstream show STREAM_ID'); return EXIT_ERR; }
      const projectId = args.options.project || (await projectOf(adapter, t, streamId));
      const { parent, items } = await loadStream(adapter, t, projectId, streamId);
      log(`STREAM  ${parent.title}`);
      log(`        ${urlFor(projectId, streamId)}`);
      items.forEach((item, i) => {
        const id = item.fullId || item.id;
        const last = verifyLog(projectId, id).slice(-1)[0];
        const state = item.status === 'completed' || item.status === 2 ? 'done' : 'open';
        log(`  ${i + 1}  [${state}/${last ? (last.advanced ? 'pass' : 'fail') : 'unverified'}] ${item.title}`);
        log(`     review ${item.dueDate ? String(item.dueDate).slice(0, 10) : 'none'}  ${urlFor(projectId, id)}`);
      });
      return EXIT_OK;
    }

    case 'list': {
      const entries = listActions({ action: 'workstream.item.created' });
      const streams = new Map();
      for (const a of entries) for (const s of a.sources || []) {
        streams.set(s, (streams.get(s) || 0) + 1);
      }
      if (!streams.size) { log('no work streams scaffolded yet'); return EXIT_OK; }
      for (const [id, n] of streams) log(`${id}  ${n} item(s)`);
      return EXIT_OK;
    }

    default:
      err(`Unknown workstream subcommand: ${sub || '(none)'}`);
      err("Run 'ats workstream --help'.");
      return EXIT_ERR;
  }
}

// --- helpers ---------------------------------------------------------------

function withMetadata(body, patch) {
  return writeTaskMetadata(body, patch);
}

function metadataOf(task) {
  const meta = parseTaskMetadata(task.content || '');
  return meta || {};
}

/** Rebuild the render inputs from what ATS already stores on the task. */
function specFromTask(task, total, n) {
  const meta = parseTaskMetadata(task.content || '') || {};
  const intent = meta.intent || {};
  return {
    title: task.title,
    outcome: intent.outcome || '',
    done_when: (intent.doneWhen || [])[0] || '',
    verify: (intent.authority || [])[0] || '',
    review: task.dueDate || '',
    notes: '',
    _n: n,
    _total: total,
  };
}

async function createOne(adapter, t, projectId, input) {
  if (t?.create) {
    const r = await t.create(projectId, input.title, input);
    return r.task || r;
  }
  return adapter.createTask({ ...input, projectId });
}

async function updateOne(adapter, t, projectId, taskId, patch) {
  if (t?.update) return t.update(projectId, taskId, patch, { live: true });
  return adapter.updateTask(projectId, taskId, patch);
}

/** Resolve which project a stream lives in without touching any cache file. */
async function projectOf(adapter, t, taskId) {
  for (const ref of ['inbox']) {
    try {
      const task = await readTask(adapter, t, ref, taskId);
      if (task) return task.fullProjectId || task.projectId || ref;
    } catch { /* fall through to the project scan */ }
  }
  const projects = await adapter.listProjects();
  for (const p of projects) {
    try {
      const task = await readTask(adapter, t, p.id, taskId);
      if (task) return task.fullProjectId || task.projectId || p.id;
    } catch { /* not in this lane */ }
  }
  throw new Error(`could not locate task ${taskId} - pass --project <id>`);
}

export const BRIEF = `ats workstream - the contract for any agent

WHY: the human's capacity to process information is limited. A work stream that
lands in the task app must be small, scannable, dated, and already verified.

THE FIVE RULES - all enforced, none optional:
  1. MAX ${MAX_ITEMS} work items per stream. A fourth is refused. Split instead.
  2. Every work item has a REVIEW DATE, re-read live from the store on every
     check, so a date cleared in the app turns the gate red.
  3. Every work item names its VERIFICATION - the exact command or reading
     that proves it - decided BEFORE the work starts.
  4. Titles name an OUTCOME, not an activity. Container verbs are rejected.
  5. Bodies are RENDERED from the spec, never hand-authored.

THE LOOP:
  ats workstream template > stream.json
  ats workstream lint stream.json          # exit 2 until the spec is clean
  ats workstream create stream.json        # parent + 2-3 real sub-tasks
  ... do the work ...
  ats workstream verify <stream> <n> --evidence "<what you observed>"
  ats workstream ready <stream>            # exit 0 ONLY when every item passed
  # exit 0 is the permission to go back to the human. Nothing else is.

WHERE THE STATE LIVES: nowhere private. Membership is real sub-tasks, the
outcome and done-when are intent metadata, the verification log is the ATS
action ledger, the review date is the task due date. 'ats intent get',
'ats hierarchy get', 'ats ledger list' and 'ats undo' all work on these tasks.

EVIDENCE means a reading, not an opinion. "tests pass" is not evidence;
"pytest -q -> 34 passed in 2.1s" is. A --fail verification is a legitimate
outcome; it keeps 'ready' red until the work is actually done.`;
