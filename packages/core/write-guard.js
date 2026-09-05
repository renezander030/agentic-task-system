/**
 * The review gate, in one place for every write surface.
 *
 * A write whose target declares `intent.approvalRequired`, or lists the action
 * (or the generic `write`) in `security.approvalRequiredFor`, stages into the
 * review queue instead of reaching the backend; `ATS_REVIEW_ALL=1` stages every
 * write. The CLI and the MCP server both call this before an adapter write, so
 * the gate holds the same way whichever surface an agent uses.
 *
 * A create has no target metadata to consult; it stages only under
 * `ATS_REVIEW_ALL`. An unreadable target (null) is not gated by its own
 * metadata — set `ATS_REVIEW_ALL` for a hard gate.
 */
import { stageReviewItem, writeRequiresApproval } from './review-queue.js';

/**
 * Decide whether a write must stage. Returns null when it may proceed, else
 * the staged-write response the caller returns in place of a write result.
 *
 * @param {{action:string, target?:object|null, payload:object, by?:string, note?:string}} write
 * @param {{queuePath?:string, env?:object}} [opts]
 */
export function guardWrite({ action, target = null, payload, by, note }, { queuePath, env = process.env } = {}) {
  if (!action || typeof action !== 'string') throw new Error('guardWrite requires an action.');
  const forced = env.ATS_REVIEW_ALL === '1';
  if (!forced && !writeRequiresApproval(target, action)) return null;
  const item = stageReviewItem(
    {
      kind: 'task.write',
      payload: { action, ...(payload || {}) },
      by: by || env.ATS_AGENT_ID || 'unknown-agent',
      note: note || (forced ? 'staged by ATS_REVIEW_ALL' : 'approvalRequired on target'),
    },
    queuePath ? { queuePath } : {}
  );
  const short = item.id.slice(0, 8);
  return {
    staged: true,
    reviewId: item.id,
    action,
    message: `Write staged for review as ${short}. Decide with: ats review approve ${short}  (then: ats review apply --all)`,
  };
}
