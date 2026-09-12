// The health check. Another system is built against the shape of this answer, so the shape is
// asserted field by field — and so is the one judgement it makes, because a monitor that cries
// wolf is a monitor somebody mutes, and a monitor that stays quiet through a failure is worse.
//
// The DO's half (nine aggregates) cannot be loaded under node; what is tested here is
// everything that decides what the numbers MEAN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeHealth, degradedLines, HEALTH_WINDOW_MS } from "../src/health.js";

const AT = 1700000000000;
// What the DO hands over on a healthy, busy install.
const RAW = {
  checked_at: AT,
  mailboxes: 3,
  unconfigured_messages: 0,
  inbound_24h: 12,
  outbound_24h: 1,
  last_inbound_at: AT,
  fanout_failures_24h: 0,
  archive_failures_24h: 0,
  muted_24h: 0,
  fanout_failure_members: [],
};

test("the document is exactly the contract, in order, with no extra field", () => {
  const h = shapeHealth(RAW);
  assert.deepEqual(h, {
    ok: true,
    checked_at: AT,
    mailboxes: 3,
    unconfigured_messages: 0,
    inbound_24h: 12,
    outbound_24h: 1,
    last_inbound_at: AT,
    fanout_failures_24h: 0,
    archive_failures_24h: 0,
    muted_24h: 0,
    degraded: [],
  });
  assert.deepEqual(Object.keys(h), [
    "ok", "checked_at", "mailboxes", "unconfigured_messages", "inbound_24h", "outbound_24h",
    "last_inbound_at", "fanout_failures_24h", "archive_failures_24h", "muted_24h", "degraded",
  ]);
  // The raw member rows are the classifier's input, not part of the answer: they carry member
  // addresses, and the degraded line says what is wrong without naming anyone.
  assert.equal("fanout_failure_members" in h, false);
});

test("QUIET IS NOT DEGRADED", () => {
  // The normal state of most shared addresses is that nobody wrote today. An install that has
  // never received anything at all is not broken either — it is new.
  const quiet = shapeHealth({ ...RAW, inbound_24h: 0, outbound_24h: 0, last_inbound_at: null });
  assert.equal(quiet.ok, true);
  assert.deepEqual(quiet.degraded, []);
  assert.equal(quiet.last_inbound_at, null, "null, never 0 — 0 is a timestamp in 1970");
  const empty = shapeHealth({ checked_at: AT });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.degraded, []);
  assert.equal(empty.mailboxes, 0);
});

test("a mailbox nobody has configured is a to-do, not a failure", () => {
  const h = shapeHealth({ ...RAW, unconfigured_messages: 4, muted_24h: 9 });
  assert.equal(h.ok, true, "mail for an unclaimed address is stored, and storing it is the design");
  assert.equal(h.unconfigured_messages, 4);
  assert.equal(h.muted_24h, 9, "a mute is a decision an owner made, not something that went wrong");
  assert.deepEqual(h.degraded, []);
});

test("ok is false for a fan-out failure, and for nothing else it did not count", () => {
  const bad = shapeHealth({
    ...RAW,
    fanout_failures_24h: 2,
    fanout_failure_members: [{ member: "x@example.com", mode: "forward", error: "destination address not verified" }],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.degraded, ["2 fan-out failures in 24h (1 member: unverified destination)"]);
});

test("ok is false for a message stored without its archived copy", () => {
  const bad = shapeHealth({ ...RAW, archive_failures_24h: 1 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.degraded, ["1 message archived without R2 copy"]);
  assert.deepEqual(shapeHealth({ ...RAW, archive_failures_24h: 3 }).degraded,
    ["3 messages archived without R2 copy"]);
});

test("both at once lists both, fan-out first", () => {
  const bad = shapeHealth({
    ...RAW,
    fanout_failures_24h: 1,
    archive_failures_24h: 2,
    fanout_failure_members: [{ member: "x@example.com", mode: "send", error: "rate limit exceeded" }],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.degraded, [
    "1 fan-out failure in 24h (1 member: quota)",
    "2 messages archived without R2 copy",
  ]);
});

test("the degraded line names how many members and what kind, never who", () => {
  const line = degradedLines({
    fanout_failures_24h: 7,
    fanout_failure_members: [
      { member: "a@example.com", mode: "forward", error: "destination address not verified" },
      { member: "b@example.com", mode: "forward", error: "550 no such user" },
      { member: "c@example.com", mode: "send", error: "destination address not verified" },
    ],
  })[0];
  assert.equal(line, "7 fan-out failures in 24h (3 members: unverified destination, rejected)",
    "distinct kinds, in the order the members came back, and each kind said once");
  for (const addr of ["a@example.com", "b@example.com", "c@example.com"])
    assert.equal(line.includes(addr), false, "a status line is read by anyone who may read it");
});

test("a failure count with no member rows still says so", () => {
  // The rows are a second query and the count is the authority: if they ever disagree, the
  // count wins and the line simply says less.
  assert.deepEqual(degradedLines({ fanout_failures_24h: 2 }), ["2 fan-out failures in 24h"]);
  assert.deepEqual(degradedLines({ fanout_failures_24h: 1, fanout_failure_members: [{ member: null }] }),
    ["1 fan-out failure in 24h"]);
});

test("nothing in the document is ever undefined, whatever the DO left out", () => {
  const h = shapeHealth({});
  for (const [k, v] of Object.entries(h)) {
    assert.notEqual(v, undefined, `${k} is undefined`);
    if (k === "ok") assert.equal(v, true);
    else if (k === "degraded") assert.deepEqual(v, []);
    else if (k === "last_inbound_at") assert.equal(v, null);
    else assert.equal(v, 0, `${k} should fall back to 0`);
  }
  assert.deepEqual(shapeHealth(), shapeHealth({}), "called with nothing at all");
});

test("the window is 24 hours and the DO and the wording agree on it", () => {
  assert.equal(HEALTH_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.match(degradedLines({ fanout_failures_24h: 1 })[0], /in 24h$/);
});
