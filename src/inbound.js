// The whole of the email() path: archive, parse, store, fan out, record.
//
// THIS MODULE MUST NOT IMPORT compose.js, EVER. compose.js is "send as this mailbox to an
// address of the caller's choosing", it is reachable only from a fetch route behind Access,
// and keeping it out of this module's import graph is what makes that structural rather
// than a matter of care. (test/structure.test.mjs asserts it.)
//
// Nothing in here may throw and nothing may reject the message. A reject is a BOUNCE, and
// bounce rate is one of the four dials governing this account's sending quota — the quota
// every other thing the account sends depends on too. A message this worker cannot parse is still
// archived, still stored, and still visible in the UI; a message it bounces is gone and the
// sender has been told the address is broken.
import { bytesToLatin1, decodeWords } from "./mime.js";
import { parseBody } from "./parse-mail.js";
import { buildMime, addrOf, headerValue } from "./build-mime.js";
import { loopReason, memberSkip, parseDomains } from "./loop-guard.js";
import { sendRaw } from "./send.js";
import { r2Key, archive } from "./archive.js";

// Above this, the message is streamed to R2 and never held in memory: a 25 MB attachment
// decoded into a latin1 string is 25 MB of string plus the parser's copies, against a
// 128 MB isolate. Headers are kept (Cloudflare parsed those for us), the body is not.
export const RAW_PARSE_MAX = 20 * 1024 * 1024;

const log = (o) => console.error(JSON.stringify({ evt: "subetha.inbound", ...o }));

export async function handleInbound(message, env, ctx) {
  const h = message.headers;
  const mailbox = String(message.to || "").trim().toLowerCase();
  const receivedAt = Date.now();
  const messageId = headerValue(h.get("message-id")).slice(0, 400);
  const key = r2Key(mailbox, messageId, receivedAt);
  const size = Number(message.rawSize) || 0;

  // 1. ARCHIVE FIRST, before anything is parsed. A parser bug must never lose the original.
  const meta = { mailbox, from: String(message.from || "").slice(0, 200), at: String(receivedAt) };
  let raw = null;
  let oversize = false;
  let storedKey = null;
  if (size && size > RAW_PARSE_MAX) {
    // Straight from the socket to the bucket: never held whole in the isolate.
    oversize = true;
    storedKey = await archive(env, key, message.raw, meta);
  } else {
    let buf = null;
    try { buf = await new Response(message.raw).arrayBuffer(); }
    catch (e) { log({ stage: "read", mailbox, error: String(e?.message || e).slice(0, 300) }); }
    if (buf) {
      storedKey = await archive(env, key, buf, meta);
      // Parse from the bytes already in hand even when the bucket write failed — the row is
      // still worth having, and r2_key stays null to say the archive has no copy.
      try { raw = bytesToLatin1(new Uint8Array(buf)); }
      catch (e) { log({ stage: "decode", mailbox, error: String(e?.message || e).slice(0, 300) }); }
    }
  }

  // 2. Parse the BODY only. Every header below comes from message.headers.
  let body = { text: null, html: null, attachments: [] };
  if (oversize) {
    body.attachments = [{
      filename: null, type: "note", size,
      note: `raw message is ${size} bytes, over the ${RAW_PARSE_MAX}-byte parse cap — archived to R2 whole, body not parsed`,
    }];
  } else if (raw != null) {
    try { body = parseBody(raw); } catch (e) {
      log({ stage: "parse", mailbox, key, error: String(e?.message || e).slice(0, 300) });
    }
  }

  const fromHdr = headerValue(h.get("from"));
  const row = {
    mailbox,
    message_id: messageId || null,
    in_reply_to: headerValue(h.get("in-reply-to")).slice(0, 400) || null,
    references_hdr: headerValue(h.get("references")).slice(0, 2000) || null,
    from_addr: addrOf(fromHdr) || null,
    from_name: decodeWords(/^\s*"?([^"<]*?)"?\s*</.exec(fromHdr)?.[1] || "").trim() || null,
    reply_to: addrOf(h.get("reply-to")) || null,
    to_addrs: headerValue(h.get("to")).slice(0, 2000) || null,
    cc_addrs: headerValue(h.get("cc")).slice(0, 2000) || null,
    subject: decodeWords(headerValue(h.get("subject"))).slice(0, 1000) || null,
    date_hdr: headerValue(h.get("date")).slice(0, 200) || null,
    received_at: receivedAt,
    text: body.text ?? null,
    html: body.html ?? null,
    r2_key: storedKey,
    size,
    attachments_json: JSON.stringify(body.attachments || []),
  };

  // 3. ONE DO call: insert, and get the member list back.
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName("subetha"));
  const stored = await stub.inbound(row);

  // 4. Fan out, OUTSIDE the object.
  const results = [];
  const suppressed = loopReason(h);
  if (!stored.configured) {
    log({ stage: "unconfigured", mailbox, id: stored.id, note: "stored, no fan-out — no mailboxes row" });
  } else if (suppressed) {
    // One row so the UI can say why nothing left, rather than showing a silent 0/0.
    results.push({ member: null, mode: "skip", ok: true, error: `loop guard: ${suppressed} — fan-out suppressed` });
  } else {
    const routed = parseDomains(env.ROUTED_DOMAINS);
    for (const m of stored.members) {
      const skip = memberSkip(m.email, mailbox, routed);
      if (skip) { results.push({ member: m.email, mode: "skip", ok: true, error: `skipped: ${skip}` }); continue; }
      try {
        if (m.mode === "forward") {
          // Cloudflare handles SRS and preserves the original From; the destination must be
          // a verified address on the account or this throws, which is the error the
          // operator needs to see on the row.
          await message.forward(m.email);
        } else {
          await sendRaw(env, mailbox, m.email, buildMime({
            from: mailbox,
            fromName: stored.display_name || mailbox.split("@")[0],
            to: m.email,
            replyTo: addrOf(fromHdr) || undefined,
            subject: row.subject || "",
            text: row.text || "",
            html: row.html || null,
            headers: {
              "X-Subetha-Hop": "1",
              "X-Subetha-Original-From": fromHdr,
            },
          }));
        }
        results.push({ member: m.email, mode: m.mode, ok: true, error: null });
      } catch (e) {
        // One member's failure must not stop the others.
        results.push({ member: m.email, mode: m.mode, ok: false, error: String(e?.message || e).slice(0, 400) });
      }
    }
  }

  // 5. ONE more DO call. waitUntil is for this and nothing else — the archive and the
  //    insert are awaited above, because a message that is not stored is a message lost.
  if (results.length) {
    const p = stub.recordFanout(stored.id, results).catch((e) =>
      log({ stage: "fanout_log", mailbox, id: stored.id, error: String(e?.message || e).slice(0, 300) }));
    if (ctx?.waitUntil) ctx.waitUntil(p); else await p;
  }

  console.log(JSON.stringify({
    evt: "subetha.received", mailbox, id: stored.id, size,
    configured: stored.configured, suppressed: suppressed || null,
    delivered: results.filter((r) => r.ok && r.mode !== "skip").length,
    failed: results.filter((r) => !r.ok).length,
  }));
  return stored;
}
