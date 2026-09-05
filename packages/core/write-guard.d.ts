export interface GuardedWrite {
  action: string;
  /** The current task (with its metadata) the write targets; null for a create. */
  target?: object | null;
  /** What to stage: the arguments the eventual apply needs. */
  payload: object;
  by?: string;
  note?: string;
}

export interface StagedWrite {
  staged: true;
  reviewId: string;
  action: string;
  message: string;
}

/** Null when the write may proceed; the staged-write response when it must wait for review. */
export function guardWrite(write: GuardedWrite, opts?: { queuePath?: string; env?: Record<string, string | undefined> }): StagedWrite | null;
