// Where a message lives in R2, and the one function that puts it there. Pure enough to test
// (r2Key takes no bindings); shared by the inbound path and the outbound one so the two can
// never drift into two different key shapes for the same mailbox.
//
// Key: <mailbox>/<YYYY>/<MM>/<message-id>.eml — the mailbox first so `list` with a prefix is
// "everything this mailbox ever received", and the month next so a year is a handful of
// prefixes rather than one flat bucket.
export const keySafe = (s, max = 120) =>
  String(s ?? "").replace(/^<|>$/g, "").replace(/[^A-Za-z0-9@._+-]/g, "_").slice(0, max);

// The daily configuration snapshot lives here, beside the mail rather than in a second bucket:
// one thing to back up, one thing to lose. The prefix cannot collide with a mailbox's, because
// a mailbox's first segment is an email address and an address carries an @ — but the guard in
// r2Key() below makes that a property of the code instead of an argument about addresses.
export const CONFIG_DIR = "_config";
export const CONFIG_LATEST = `${CONFIG_DIR}/latest.json`;
// UTC, because every other date in this worker is: a snapshot named for the operator's local
// day would change name when they travel.
export const configKey = (at = Date.now()) => `${CONFIG_DIR}/${new Date(at).toISOString().slice(0, 10)}.json`;

export function r2Key(mailbox, messageId, at = new Date()) {
  const d = new Date(at);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const stem = keySafe(messageId) || crypto.randomUUID();
  const box = keySafe(mailbox, 200) || "unknown";
  return `${box === CONFIG_DIR ? `${box}_` : box}/${yyyy}/${mm}/${stem}.eml`;
}

/** Never throws: a failed archive is logged and the caller carries on with a null key. */
export async function archive(env, key, value, meta) {
  try {
    await env.MAIL.put(key, value, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: meta,
    });
    return key;
  } catch (e) {
    console.error(JSON.stringify({ evt: "subetha.archive_failed", key, error: String(e?.message || e).slice(0, 300) }));
    return null;
  }
}

/**
 * The config snapshot. Its own function rather than archive()'s third argument because the two
 * disagree about everything that matters: this is JSON and not a message, it is written by a
 * cron and not by an arriving mail, and it carries no custom metadata — there is no sender and
 * no mailbox to put in it. Never throws, for the same reason archive() does not.
 */
export async function putJson(env, key, value) {
  try {
    await env.MAIL.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  } catch (e) {
    console.error(JSON.stringify({ evt: "subetha.snapshot_failed", key, error: String(e?.message || e).slice(0, 300) }));
    return null;
  }
}
