// Retention: the only thing in SubEtha that deletes mail, and therefore the part written most
// carefully. Pure — node-testable — because the alternative is a predicate that selects rows
// for deletion and is only ever exercised by deleting rows.
//
// Two callers, one predicate. An owner pressing "delete older than…" and the daily scheduled
// run applying a mailbox's standing retention take the SAME path: the fixed set of choices
// below, the same cutoff arithmetic, and the same SQL fragment. A second way to choose what to
// delete is a second way to delete the wrong thing.
//
// The choices are a SET, not a number the caller picks. "older_than_days: 1" is a plausible
// typo for "older than a year" and it would take the mailbox with it; five round choices cannot
// be typed wrong in a way that destroys anything the owner did not mean.
export const RETENTION_DAYS = [30, 60, 90, 180, 365];

export const isRetention = (v) =>
  (typeof v === "number" || typeof v === "string") && RETENTION_DAYS.includes(Number(v));

/** The number of days to purge behind, or null when the value is not one of the choices. */
export const purgeDays = (v) => (isRetention(v) ? Number(v) : null);

/**
 * What PUT /api/mailboxes/:address stores. `{days}` or `{error}`.
 *
 * Null, undefined and "" all mean KEEP FOREVER — and that is deliberate on a route where the
 * editor posts the whole configuration: a caller that has never heard of retention turns it
 * OFF rather than leaving a standing deletion in place it does not know about. The safe
 * direction here is the one where nothing is deleted.
 */
export function retentionValue(v) {
  if (v == null || v === "") return { days: null };
  if (!isRetention(v)) return { error: `retention_days must be null or one of ${RETENTION_DAYS.join(", ")}` };
  return { days: Number(v) };
}

/** The instant a purge deletes behind. Days are 24 hours here — no calendar, no timezone. */
export const cutoffAt = (days, at) => Number(at) - Number(days) * 24 * 60 * 60 * 1000;

/**
 * The rows a purge selects, as SQL, bound `(mailbox, cutoff)` in that order. The fragment is a
 * constant rather than a string the DO builds, so the predicate that is tested here is the
 * predicate that runs.
 *
 * BOTH DIRECTIONS. An outbound reply is as old as the message it answered and belongs to the
 * same conversation; keeping the mailbox's own half of a thread while deleting the other half
 * is a history that reads as if nobody ever replied.
 *
 * STRICTLY OLDER. A message exactly on the cutoff is kept: the boundary moves with the clock,
 * and the one direction to round in is the one that keeps mail.
 */
export const PURGE_WHERE = "mailbox = ? AND received_at < ?";

/**
 * What a purge actually did. `rows` are the ones whose archived copy is gone (or was never
 * there) and which were therefore handed to the DO to delete; `r2Failed` is the count that
 * were skipped because R2 refused. `bytes` is the sum of the stored `size` of what went.
 */
export function purgeSummary(rows, r2Failed) {
  const list = rows || [];
  return {
    deleted: list.length,
    bytes: list.reduce((sum, r) => sum + (Number(r?.size) || 0), 0),
    r2_failed: Number(r2Failed) || 0,
  };
}

/**
 * The same shape from a dry run, plus `dry_run: true` — the flag is not decoration: a caller
 * that cannot tell a rehearsal from the real thing is a caller that will one day report the
 * rehearsal's numbers as a deletion, or repeat the real one thinking it was a rehearsal.
 */
export const dryRunSummary = (preview) => ({
  deleted: Number(preview?.messages) || 0,
  bytes: Number(preview?.bytes) || 0,
  r2_failed: 0,
  dry_run: true,
});
