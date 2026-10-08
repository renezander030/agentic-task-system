import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableDigest, withLockSync } from '@reneza/ats-core';

export function readStructuredInput(file, { allowed = [], required = [], stdin = 0 } = {}) {
  if (!file || file === true) throw new Error('--input requires a JSON file path or - for stdin.');
  let raw;
  try {
    raw = file === '-' ? fs.readFileSync(stdin, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read structured input ${file}: ${error.message}`, { cause: error });
  }
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    throw new Error(`Structured input is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Structured input must be one JSON object.');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Structured input has unknown field(s): ${unknown.join(', ')}.`);
  const missing = required.filter((key) => value[key] === undefined || value[key] === null || value[key] === '');
  if (missing.length) throw new Error(`Structured input is missing required field(s): ${missing.join(', ')}.`);
  return value;
}

export function parseBatchInput(file, { stdin = 0 } = {}) {
  if (!file || file === true) throw new Error('Batch input requires a JSON/JSONL file path or - for stdin.');
  const raw = file === '-' ? fs.readFileSync(stdin, 'utf8') : fs.readFileSync(file, 'utf8');
  let values;
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = raw.split('\n').filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new Error(`Batch input line ${index + 1} is not valid JSON: ${error.message}`, { cause: error });
      }
    });
  }
  const ids = new Set();
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Batch item ${index + 1} must be an object.`);
    if (!value.id || typeof value.id !== 'string') throw new Error(`Batch item ${index + 1} requires a stable string id.`);
    if (ids.has(value.id)) throw new Error(`Batch item id ${value.id} is duplicated.`);
    if (!value.op || typeof value.op !== 'string') throw new Error(`Batch item ${value.id} requires an op.`);
    ids.add(value.id);
    return value;
  });
}

export function readBatchJournal(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const completed = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter((value) => value.trim())) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.id !== 'string' || typeof entry.status !== 'string') throw new Error('invalid journal entry');
      completed.set(entry.id, entry);
    } catch (error) {
      throw new Error(`Batch journal ${file} is invalid: ${error.message}`, { cause: error });
    }
  }
  return completed;
}

function writeBatchJournal(file, outcome) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ ...outcome, recordedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function appendBatchJournal(file, outcome) {
  if (!file) return;
  withLockSync(file, () => writeBatchJournal(file, outcome), { label: 'batch journal' });
}

/** Claim before a side effect; an unfinished claim is never automatically retried. */
export function claimBatchItem(file, item, scope) {
  if (!file) return null;
  const digest = stableDigest({ scope, item });
  return withLockSync(file, () => {
    const prior = readBatchJournal(file).get(item.id);
    if (prior) {
      if (prior.digest !== digest) throw new Error(`Batch precondition failed: item ${item.id} has no matching payload/source binding.`);
      if (['applied', 'staged'].includes(prior.status)) return { replayed: true, digest };
      if (['applying', 'failed'].includes(prior.status)) throw new Error(`Batch precondition failed: item ${item.id} has an uncertain or in-flight outcome; inspect the backend before using a fresh journal.`);
    }
    const claim = { id: item.id, op: item.op, status: 'applying', digest, token: randomUUID() };
    writeBatchJournal(file, claim);
    return claim;
  }, { label: 'batch journal' });
}

export function finishBatchItem(file, claim, outcome) {
  if (!file || !claim) return;
  withLockSync(file, () => {
    const current = readBatchJournal(file).get(outcome.id);
    if (current?.token !== claim.token || current?.status !== 'applying') throw new Error('Batch precondition failed: applying claim changed.');
    writeBatchJournal(file, { ...outcome, digest: claim.digest, token: claim.token });
  }, { label: 'batch journal' });
}

export function withTimeout(promise, timeoutMs, label = 'operation') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms.`);
        error.code = 'ATS_TIMEOUT';
        error.exitCode = 6;
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

export function classifyError(error) {
  const message = error?.message || String(error);
  const code = error?.code || 'ATS_ERROR';
  if (code === 'ATS_SEPARATION') {
    return { kind: 'policy', code, retryable: false, exitCode: 4 };
  }
  if (error?.exitCode === 3 || /precondition|if-match|changed since/i.test(message)) {
    return { kind: 'precondition', code: 'ATS_PRECONDITION', retryable: true, exitCode: 3 };
  }
  if (code === 'ATS_TIMEOUT' || /timed? out|timeout/i.test(message)) {
    return { kind: 'timeout', code: 'ATS_TIMEOUT', retryable: true, exitCode: 6 };
  }
  if (/auth|token|credential|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(message)) {
    return { kind: 'authentication', code: 'ATS_AUTH', retryable: false, exitCode: 4 };
  }
  if (/ECONN|ENOTFOUND|network|socket|fetch failed|transport/i.test(message)) {
    return { kind: 'transport', code: 'ATS_TRANSPORT', retryable: true, exitCode: 7 };
  }
  if (/requires? (?:a value|an?|JSON)|required|unknown field|invalid|usage|must be|cannot read structured input/i.test(message)) {
    return { kind: 'validation', code: 'ATS_VALIDATION', retryable: false, exitCode: 2 };
  }
  return { kind: 'internal', code, retryable: false, exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1 };
}

export function errorEnvelope(error) {
  const classified = classifyError(error);
  return {
    ok: false,
    error: {
      kind: classified.kind,
      code: classified.code,
      message: error?.message || String(error),
      retryable: classified.retryable,
    },
  };
}

export function mutationReceipt({ operation, action, requested, observed, verified, target }) {
  return {
    operation,
    target,
    actionId: action?.id || null,
    revision: action?.revision || action?.id || null,
    verified: verified === true,
    requested,
    observed,
  };
}
