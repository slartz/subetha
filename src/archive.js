// Where a message lives in R2, and the one function that puts it there. Pure enough to test
// (r2Key takes no bindings); shared by the inbound path and the outbound one so the two can
// never drift into two different key shapes for the same mailbox.
//
// Key: <mailbox>/<YYYY>/<MM>/<message-id>.eml — the mailbox first so `list` with a prefix is
// "everything this mailbox ever received", and the month next so a year is a handful of
// prefixes rather than one flat bucket.
export const keySafe = (s, max = 120) =>
  String(s ?? "").replace(/^<|>$/g, "").replace(/[^A-Za-z0-9@._+-]/g, "_").slice(0, max);

export function r2Key(mailbox, messageId, at = new Date()) {
  const d = new Date(at);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const stem = keySafe(messageId) || crypto.randomUUID();
  return `${keySafe(mailbox, 200) || "unknown"}/${yyyy}/${mm}/${stem}.eml`;
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
