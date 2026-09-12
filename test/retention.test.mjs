// Retention and purging — the only thing in SubEtha that deletes mail, which is why the
// failure to design against here is not "it did not run" but "it ran and took more than the
// owner meant". Every test below is a way that could happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_DAYS, isRetention, purgeDays, retentionValue, cutoffAt,
  PURGE_WHERE, purgeSummary, dryRunSummary,
} from "../src/retention.js";

const DAY = 24 * 60 * 60 * 1000;
const AT = 1700000000000;

test("the periods are a fixed set, not a number the caller picks", () => {
  assert.deepEqual(RETENTION_DAYS, [30, 60, 90, 180, 365]);
  for (const d of RETENTION_DAYS) assert.equal(purgeDays(d), d);
  // "1" is a plausible slip for "365" and it would take the whole mailbox with it. Every one
  // of these is refused rather than rounded to the nearest offered period.
  for (const bad of [0, 1, 7, 29, 31, 45, 364, 366, -30, 30.5, Infinity, NaN])
    assert.equal(purgeDays(bad), null, `${bad} must not be accepted as a period`);
});

test("a period from a form arrives as a string and still has to be one of the five", () => {
  assert.equal(purgeDays("30"), 30);
  assert.equal(purgeDays(" 365 "), 365);
  assert.equal(purgeDays("45"), null);
  // Number() says 30 to all of these and none of them is a period anybody typed.
  for (const bad of [[30], { valueOf: () => 30 }, true, null, undefined, "", [], {}])
    assert.equal(isRetention(bad), false, `${JSON.stringify(bad)} must not pass as a period`);
});

test("retention absent is KEEP FOREVER, and that is the safe direction", () => {
  // PUT posts the whole configuration, so a client that has never heard of retention turns a
  // standing deletion OFF rather than leaving one running that it cannot see.
  assert.deepEqual(retentionValue(undefined), { days: null });
  assert.deepEqual(retentionValue(null), { days: null });
  assert.deepEqual(retentionValue(""), { days: null });
  assert.deepEqual(retentionValue(90), { days: 90 });
  assert.deepEqual(retentionValue("90"), { days: 90 });
});

test("a retention that is not one of the periods is refused, never rounded", () => {
  const r = retentionValue(45);
  assert.equal(r.days, undefined);
  assert.match(r.error, /30, 60, 90, 180, 365/);
  assert.equal(retentionValue(0).error !== undefined, true, "0 days would delete everything");
  assert.equal(retentionValue(-1).error !== undefined, true);
  assert.equal(retentionValue("all").error !== undefined, true);
});

test("the cutoff is the instant a purge deletes behind", () => {
  assert.equal(cutoffAt(30, AT), AT - 30 * DAY);
  assert.equal(cutoffAt(365, AT), AT - 365 * DAY);
  assert.equal(cutoffAt("90", AT), AT - 90 * DAY, "a string period measures the same");
  assert.ok(cutoffAt(30, AT) < AT, "the cutoff is always in the past");
});

test("the selection predicate: both directions, strictly older, everything bound", () => {
  // The DO interpolates this fragment into its statements, so the thing asserted here is the
  // thing that runs. A message exactly on the cutoff is KEPT — the boundary moves with the
  // clock, and the one direction to round in is the one that keeps mail.
  assert.equal(PURGE_WHERE, "mailbox = ? AND received_at < ?");
  assert.equal((PURGE_WHERE.match(/\?/g) || []).length, 2, "two placeholders, both bound");
  assert.equal(/<=/.test(PURGE_WHERE), false, "a message ON the cutoff is kept");
  assert.equal(/direction/.test(PURGE_WHERE), false,
    "both directions: keeping the mailbox's own half of a thread is a history that reads as if nobody replied");
  assert.equal(/hidden|unconfigured|muted/.test(PURGE_WHERE), false,
    "age is the only question a purge asks");
});

test("what a purge did is counted from the rows that actually went", () => {
  const rows = [{ id: 1, size: 1000 }, { id: 2, size: 2500 }, { id: 3, size: 0 }];
  assert.deepEqual(purgeSummary(rows, 0), { deleted: 3, bytes: 3500, r2_failed: 0 });
  // A row whose archived copy R2 refused to delete is NOT in the list: it was skipped, the
  // message is still whole, and the count of them is the answer's third field.
  assert.deepEqual(purgeSummary(rows.slice(0, 2), 1), { deleted: 2, bytes: 3500, r2_failed: 1 });
  assert.deepEqual(purgeSummary([], 4), { deleted: 0, bytes: 0, r2_failed: 4 });
  assert.deepEqual(purgeSummary(null, null), { deleted: 0, bytes: 0, r2_failed: 0 });
  assert.deepEqual(purgeSummary([{ id: 9 }, { id: 10, size: null }], 0),
    { deleted: 2, bytes: 0, r2_failed: 0 }, "a row with no stored size counts as a row, not as NaN");
});

test("a dry run says so, in the field a caller cannot miss", () => {
  // A caller that cannot tell a rehearsal from the real thing will one day report the
  // rehearsal's numbers as a deletion, or repeat the real one thinking it was a rehearsal.
  assert.deepEqual(dryRunSummary({ messages: 12, bytes: 34567 }),
    { deleted: 12, bytes: 34567, r2_failed: 0, dry_run: true });
  assert.deepEqual(dryRunSummary({ messages: 0, bytes: 0 }),
    { deleted: 0, bytes: 0, r2_failed: 0, dry_run: true });
  assert.deepEqual(dryRunSummary(), { deleted: 0, bytes: 0, r2_failed: 0, dry_run: true });
  assert.equal("dry_run" in purgeSummary([], 0), false, "and a real purge does not claim to be one");
});
