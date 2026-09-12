// The health check's shaping, and the one judgement it makes: is this install degraded?
// Pure — node-testable — because another system is built against the shape of this answer, and
// a contract that is only exercised through a route is a contract nobody tests.
//
// The counts come out of the Durable Object in one read-only call; everything below turns them
// into the document, decides `ok`, and writes the sentences a human reads.
//
// QUIET IS NOT DEGRADED. A mailbox that received nothing in a day is a mailbox nobody wrote to,
// which is the normal state of most shared addresses — an alert on it would be an alert the
// operator learns to ignore. Only two things are failures here: a fan-out that did not arrive,
// and a message stored with no copy in the archive.
import { classifyFanoutError } from "./fanout-status.js";

export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

const n = (v) => Number(v) || 0;
// "1 member" / "2 members" — the count and its noun, because every line below needs both.
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

/**
 * The short human sentences behind `ok: false`, or an empty array. At most two, because there
 * are only two failures: they are written to be read in a status page or a chat message, so
 * each one says what happened, over what window, and — for the fan-out — how many members and
 * what kind of failure, which is the difference between "one address needs verifying" and
 * "the account is out of quota".
 */
export function degradedLines(raw = {}) {
  const out = [];
  const fanout = n(raw.fanout_failures_24h);
  if (fanout > 0) {
    const members = (raw.fanout_failure_members || []).filter((m) => m && m.member);
    // The classifier is the one the member rows already use, so the words on a status page and
    // the words in the editor are the same words. Distinct kinds, in the order the DO returned
    // the members, so repeated runs read identically.
    const kinds = [];
    for (const m of members) {
      const kind = classifyFanoutError(m.mode, m.error).kind.replace(/_/g, " ");
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    const who = members.length ? ` (${plural(members.length, "member", "members")}: ${kinds.join(", ")})` : "";
    out.push(`${plural(fanout, "fan-out failure", "fan-out failures")} in 24h${who}`);
  }
  const archive = n(raw.archive_failures_24h);
  if (archive > 0) out.push(`${plural(archive, "message", "messages")} archived without R2 copy`);
  return out;
}

/**
 * The GET /api/health document, from the DO's raw counts.
 *
 * `ok` is false for exactly two reasons and no others — a fan-out attempt that failed, or a
 * message stored without its archived copy. Both are things an operator can fix and both are
 * otherwise silent; nothing else in here is a judgement, only a number.
 */
export function shapeHealth(raw = {}) {
  const fanout = n(raw.fanout_failures_24h);
  const archive = n(raw.archive_failures_24h);
  return {
    ok: fanout === 0 && archive === 0,
    checked_at: n(raw.checked_at),
    mailboxes: n(raw.mailboxes),
    unconfigured_messages: n(raw.unconfigured_messages),
    inbound_24h: n(raw.inbound_24h),
    outbound_24h: n(raw.outbound_24h),
    // Null, not 0, when nothing has ever arrived: 0 is a timestamp in 1970 and a caller that
    // renders it says so. A new install is quiet, and quiet is not a failure.
    last_inbound_at: raw.last_inbound_at == null ? null : n(raw.last_inbound_at),
    fanout_failures_24h: fanout,
    archive_failures_24h: archive,
    muted_24h: n(raw.muted_24h),
    degraded: degradedLines(raw),
  };
}
