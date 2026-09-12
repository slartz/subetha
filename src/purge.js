// The one place in SubEtha that deletes stored mail, and the only reason it exists is that the
// deletion has TWO halves in two different systems — the R2 object and the row that names it —
// and the order they go in is the whole design.
//
// R2 FIRST, THEN THE ROW. A row whose archived copy is gone still says so (`r2_key` points at
// nothing and the UI stops offering the download); an object whose row is gone is an orphan
// nobody can find, name, or bill. So a failed R2 delete SKIPS its row: the message stays whole
// and the next purge tries again, which is why `r2_failed` is in the answer rather than in a log.
//
// This module does not decide WHAT to delete — retention.js does, once, for both callers — and
// it does not decide WHO may. That is the route's question and the DO's is only the rows.
import { cutoffAt, purgeSummary, dryRunSummary } from "./retention.js";

// At most this many messages per call. An R2 delete is a subrequest and a Worker has a fixed
// budget of those per invocation; a mailbox with a year of mail in it would spend the lot and
// fail halfway, which on this path means objects deleted whose rows survived. Whatever is left
// goes on the next run — the scheduled one is daily, and the owner's button can be pressed again.
export const PURGE_BATCH = 500;

const log = (o) => console.error(JSON.stringify({ evt: "subetha.purge", ...o }));

/**
 * Delete this mailbox's mail older than `days`, in both directions, with its fan-out rows and
 * its archived copies. `{deleted, bytes, r2_failed}` — or the same shape with `dry_run: true`
 * and nothing touched.
 *
 * The dry run counts EVERYTHING older than the cutoff, not just the batch the real call would
 * take: it is what the confirm step shows a person, and a confirm that undercounts is a confirm
 * that lies in the direction of "that was smaller than I thought".
 */
export async function purgeOlderThan(env, stub, address, days, dryRun) {
  const cutoff = cutoffAt(days, Date.now());
  if (dryRun) return dryRunSummary(await stub.purgePreview(address, cutoff));

  const rows = await stub.purgeCandidates(address, cutoff, PURGE_BATCH);
  const gone = [];
  let failed = 0;
  for (const r of rows) {
    if (r.r2_key) {
      try {
        await env.MAIL.delete(r.r2_key);
      } catch (e) {
        // The row is left exactly as it was. Nothing is lost, nothing is orphaned, and the
        // count comes back in the answer so the caller knows the sweep was not complete.
        failed++;
        log({ stage: "r2_delete", mailbox: address, id: r.id, error: String(e?.message || e).slice(0, 300) });
        continue;
      }
    }
    gone.push(r);
  }
  if (gone.length) await stub.purgeRows(address, gone.map((r) => r.id));
  return purgeSummary(gone, failed);
}
