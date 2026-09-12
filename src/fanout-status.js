// What the LAST fan-out attempt to a member did, and what an owner can do about it. Pure —
// node-testable — which is the point of the module existing at all: the error strings come
// from Cloudflare and from whatever server was on the other end, their wording changes
// without notice, and a classifier nobody tests is a hint nobody should trust.
//
// It classifies and nothing else. The fan-out already happened, the fanout_log row is the
// record of it, and this only turns that row into a sentence. A member with no row yet gets
// no status at all: nothing has been sent to them, which is not a failure and must not look
// like one.
const lower = (v) => String(v ?? "").trim().toLowerCase();

// Cloudflare's wording for a forward to an address that is not a verified destination is
// "destination address not verified". Matching on "verif" alone is deliberate: no other
// failure below says it, this is the one an owner WILL hit — a member is added in forward
// mode and simply never receives anything — and the cost of a false positive is a hint that
// reads oddly, against silence for a miss.
const UNVERIFIED = /verif/;
const DEST_REFUSED = /destination|recipient address|allowed destination/;
const REFUSED = /not allowed|not permitted|denied|unauthori|forbidden/;
// The account's own limits, not anything about the member's address.
const QUOTA = /quota|rate.?limit|rate exceeded|too many requests|\b429\b|sending limit|daily limit|limit exceeded|throttl/;
// A permanent refusal by the far end: an SMTP 5xx, an enhanced 5.x.x status, or plain words.
const PERMANENT = /(^|[^\d.])5\d\d([^\d.]|$)|\b5\.\d{1,3}\.\d{1,3}\b|permanent|rejected|no such user|user unknown|does not exist/;
// Worth trying again, and the next message to this member will.
const TRANSIENT = /(^|[^\d.])4\d\d([^\d.]|$)|\b4\.\d{1,3}\.\d{1,3}\b|timeout|timed out|temporar|try again|deferred|greylist|network|connection|socket|econn|unavailable|aborted/;

const HINTS = {
  unverified_destination: {
    forward: "This address is not a verified destination on the account: verify it in Email Routing, or switch this member to send.",
    other: "The send path refused this address: allow it on the send_email binding, or switch this member to forward.",
  },
  quota: {
    forward: "A limit was hit rather than anything about this address: check the account's Email Routing limits and send a test message again later.",
    other: "The account's sending quota or rate limit was hit, not this address: check Email Sending limits and send a test message again later.",
  },
  rejected: {
    forward: "The receiving server refused it permanently: check the address is spelled the way its owner spells it, because retrying will not help.",
    other: "The receiving server refused it permanently: check the address is spelled the way its owner spells it, because retrying will not help.",
  },
  transient: {
    forward: "A temporary failure at the other end: nothing here needs changing, and the next message to this member will try again.",
    other: "A temporary failure at the other end: nothing here needs changing, and the next message to this member will try again.",
  },
  unknown: {
    forward: "The error does not name a cause: read the raw text on this row, then send a test message to see whether it repeats.",
    other: "The error does not name a cause: read the raw text on this row, then send a test message to see whether it repeats.",
  },
};

/**
 * classifyFanoutError(mode, error) -> { kind, hint }
 *
 * kind is one of: unverified_destination | quota | rejected | transient | unknown.
 * hint is one short sentence an owner can act on — the raw error is always shown alongside
 * it, so the hint's job is to say what to DO, not to repeat what went wrong.
 *
 * Order matters. The account's own limits are read before the far end's status code, because
 * a quota message often carries a code too and "you have run out of quota" is the actionable
 * half of it; the permanent check runs before the transient one for the same reason.
 */
export function classifyFanoutError(mode, error) {
  const e = lower(error);
  const kind =
    UNVERIFIED.test(e) || (DEST_REFUSED.test(e) && REFUSED.test(e)) ? "unverified_destination"
    : QUOTA.test(e) ? "quota"
    : PERMANENT.test(e) ? "rejected"
    : TRANSIENT.test(e) ? "transient"
    : "unknown";
  const hint = HINTS[kind][lower(mode) === "forward" ? "forward" : "other"];
  return { kind, hint };
}

/**
 * A mailbox row as the DO returns it — its `members`, plus the `member_status` rows
 * memberStatus() produced — with the status folded onto each member as `last` and the raw
 * array dropped. Matching is by address, lowercased, because that is what the two queries
 * agree on; a status row for a member who has since been removed simply finds no member.
 */
export function withMemberStatus(box) {
  const { member_status, ...rest } = box || {};
  const by = new Map();
  for (const s of member_status || []) by.set(lower(s?.email), s);
  return {
    ...rest,
    members: (box?.members || []).map((m) => ({ ...m, last: lastAttempt(by.get(lower(m?.email))) })),
  };
}

// NULL `at` is the LEFT JOIN finding nothing, not a row with no timestamp — so it is "no
// attempt yet", and the answer is null rather than a row that would draw as a failure.
//
// `kind` and `hint` are null on a success: there is nothing to act on, and a hint on a
// delivered row is noise. `mode` comes from the attempt, not from the member's current
// setting: a row that says 'skip' is the loop guard's, and the member was never written to.
function lastAttempt(row) {
  if (!row || row.at == null) return null;
  const ok = !!row.ok;
  const mode = row.mode ?? null;
  const error = row.error ?? null;
  const c = ok ? null : classifyFanoutError(mode, error);
  return {
    mode,
    ok,
    error,
    at: Number(row.at),
    message_row: row.message_row ?? null,
    kind: c ? c.kind : null,
    hint: c ? c.hint : null,
  };
}
