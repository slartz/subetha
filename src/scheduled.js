// The daily run: a snapshot of the configuration into R2, and the standing retention each
// mailbox asked for.
//
// THIS MODULE MUST NOT IMPORT compose.js OR send.js. A cron trigger is an unauthenticated
// caller in every sense that matters — nobody is behind it, nothing checked a JWT, and it fires
// whether or not anyone is watching. Keeping the send path out of its import graph is the same
// wall email() sits behind, for the same reason, and test/structure.test.mjs asserts it.
//
// NOTHING HERE THROWS. A scheduled() that throws is a cron run recorded as failed with nobody
// to tell, and the two halves are independent: a bucket that refuses the snapshot must not also
// cost the mailboxes their retention, and a retention sweep that fails must not cost the backup.
import { purgeOlderThan } from "./purge.js";
import { purgeDays } from "./retention.js";
import { configKey, CONFIG_LATEST, putJson } from "./archive.js";

const log = (o) => console.log(JSON.stringify({ evt: "subetha.scheduled", ...o }));
const err = (o) => console.error(JSON.stringify({ evt: "subetha.scheduled_failed", ...o }));

/**
 * The config snapshot: exactly the document GET /api/export returns, written twice — once under
 * the day it was taken and once as `latest.json`. The dated copy is the history (a member
 * removed by mistake three weeks ago is still in one of them); `latest.json` is the one a
 * restore script reads without having to list the bucket.
 *
 * It is the DO's own export method, not a second query, so the file on disk and the file behind
 * the route cannot drift.
 */
export async function snapshotConfig(env, stub, at) {
  const doc = await stub.exportConfig();
  const dated = await putJson(env, configKey(at), doc);
  const latest = await putJson(env, CONFIG_LATEST, doc);
  log({ stage: "snapshot", key: dated, latest: !!latest, mailboxes: (doc?.mailboxes || []).length });
}

/**
 * Standing retention, one mailbox at a time. Only mailboxes that asked for it — a null
 * `retention_days` is "keep forever", which is the default and the state of every mailbox that
 * has never been told otherwise.
 *
 * One mailbox's failure must not stop the next one's: these are independent deletions on
 * independent mailboxes, and the loop is the only thing that would connect them.
 */
export async function applyRetention(env, stub) {
  for (const box of await stub.retentionMailboxes()) {
    // Validated again on the way out, not only on the way in. The stored value decides what is
    // deleted with nobody watching, and the cost of a wrong one — a stray 1 from an older
    // client, a hand-edited row — is a mailbox emptied overnight. A value that is not one of
    // the offered periods is ignored rather than rounded to the nearest.
    const days = purgeDays(box.retention_days);
    if (!days) {
      err({ stage: "retention", mailbox: box.address, error: `ignored retention_days: ${String(box.retention_days).slice(0, 20)}` });
      continue;
    }
    try {
      const r = await purgeOlderThan(env, stub, box.address, days, false);
      // Counts only. Which mailbox, how much, and whether the archive refused anything — never
      // a subject, a sender or a key, because a retention log is read far more often than it
      // is trimmed.
      if (r.deleted || r.r2_failed)
        log({ stage: "retention", mailbox: box.address, days, ...r });
    } catch (e) {
      err({ stage: "retention", mailbox: box.address, error: String(e?.message || e).slice(0, 300) });
    }
  }
}

/** The whole daily run. Never throws: each half is wrapped, and index.js wraps this too. */
export async function runScheduled(env, stub, at = Date.now()) {
  try { await snapshotConfig(env, stub, at); }
  catch (e) { err({ stage: "snapshot", error: String(e?.message || e).slice(0, 300) }); }
  try { await applyRetention(env, stub); }
  catch (e) { err({ stage: "retention", error: String(e?.message || e).slice(0, 300) }); }
}
