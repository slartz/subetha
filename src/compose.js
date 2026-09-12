// Reply and compose: send as the mailbox, to an address the CALLER chose.
//
// This is the dangerous capability in SubEtha and the reason the send_email binding carries
// no allowed_destination_addresses. It is reachable from exactly two fetch routes, both
// behind the auth wall in index.js, and NOTHING in the email() path imports this module —
// see the banner in inbound.js and test/structure.test.mjs.
//
// Every outgoing message is archived to R2 and stored as a direction='out' row before the
// route returns, so the mailbox's history is what was actually sent, both ways.
import { buildMime, reSubject, quote, msgIds, newMessageId, domainOf, validAddr, headerValue, addrOf } from "./build-mime.js";
import { quoteHtml } from "./html-render.js";
import { sendRawTo } from "./send.js";
import { r2Key, archive } from "./archive.js";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const addrList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(","))
  .map((x) => String(x).trim().toLowerCase()).filter(Boolean);

function checkedList(v, what) {
  const list = addrList(v);
  for (const a of list) if (!validAddr(a)) fail(400, `invalid ${what} address: ${a.slice(0, 120)}`);
  return list;
}

async function deliver(env, stub, { cfg, to, cc, subject, text, html, inReplyTo, references, identity }) {
  const mailbox = cfg.address;
  const messageId = newMessageId(domainOf(mailbox));
  let raw;
  try {
    raw = buildMime({
      from: mailbox,
      fromName: cfg.display_name || mailbox.split("@")[0],
      to, cc, subject, text, html, messageId, inReplyTo, references,
    });
  } catch (e) { fail(400, String(e?.message || e)); }

  // The Cc: header is a label; delivery is one envelope recipient at a time.
  const results = (await sendRawTo(env, mailbox, [...to, ...cc], raw))
    .map((r) => ({ ...r, mode: "send" }));

  const at = Date.now();
  const key = await archive(env, r2Key(mailbox, messageId, at), raw, {
    mailbox, direction: "out", sent_by: String(identity).slice(0, 200), at: String(at),
  });

  return stub.storeOutbound({
    mailbox,
    message_id: messageId,
    in_reply_to: inReplyTo || null,
    references_hdr: references || null,
    from_addr: mailbox,
    from_name: cfg.display_name || null,
    to_addrs: to.join(", ") || null,
    cc_addrs: cc.join(", ") || null,
    subject: subject || null,
    date_hdr: new Date(at).toUTCString().replace("GMT", "+0000"),
    received_at: at,
    text,
    r2_key: key,
    size: raw.length,
    sent_by: String(identity).slice(0, 200),
    fanout: results,
  });
}

/** POST /api/messages/:id/reply — {text, cc?} */
export async function replyToMessage(env, stub, id, body, identity) {
  const msg = await stub.message(id);
  if (!msg) fail(404, "no such message");
  const cfg = await stub.config(msg.mailbox);
  // An unconfigured mailbox has no display name and no member list; it is an address the
  // routing points here that nobody has claimed. Replying AS it would be this worker
  // speaking for a mailbox its owner never set up.
  if (!cfg) fail(400, `mailbox ${msg.mailbox} is not configured — save it first`);
  const text = String(body?.text ?? "");
  if (!text.trim()) fail(400, "empty reply");

  // Reply-To when the sender asked for one, otherwise From. Anything else second-guesses a
  // header whose whole purpose is to say where the answer goes.
  const target = addrOf(msg.reply_to) || addrOf(msg.from_addr);
  if (!target) fail(400, "the original message has no usable reply address");
  // Replying to the mailbox's OWN outgoing message addresses the mailbox itself: Email
  // Routing hands it straight back to email(), it is stored again and fanned out again to
  // everybody. Never what anyone meant, and the only way to hit it is a stray click or a
  // script — so it is refused here rather than merely discouraged in the UI.
  if (target === msg.mailbox) fail(400, "that reply would be addressed to the mailbox itself");
  const cc = checkedList(body?.cc, "Cc");

  const refs = [...new Set([...msgIds(msg.references_hdr), ...msgIds(msg.message_id)])];
  const who = msg.from_name ? `${msg.from_name} <${msg.from_addr || ""}>` : (msg.from_addr || "someone");
  const quoted = `${text.replace(/\s+$/, "")}\n\n${quote(msg.text || "", { date: msg.date_hdr, from: who })}\n`;

  // An html alternative ONLY when the original had one. A text-only message answered with a
  // multipart/alternative is this worker inventing formatting nobody asked for, and the
  // author's side of the reply is a plain textarea either way — the html part exists so the
  // ORIGINAL survives the round trip looking like itself, tables, colours and all.
  return deliver(env, stub, {
    cfg, to: [target], cc,
    subject: reSubject(msg.subject || ""),
    text: quoted,
    html: msg.html ? quoteHtml(text, { date: msg.date_hdr, from: who, html: msg.html }) : null,
    inReplyTo: msg.message_id || null,
    references: refs.join(" ") || null,
    identity,
  });
}

/** POST /api/mailboxes/:address/send — {to, cc?, subject, text} */
export async function composeNew(env, stub, address, body, identity) {
  const cfg = await stub.config(address);
  if (!cfg) fail(404, `mailbox ${address} is not configured`);
  const to = checkedList(body?.to, "To");
  if (!to.length) fail(400, "no To address");
  const cc = checkedList(body?.cc, "Cc");
  const text = String(body?.text ?? "");
  if (!text.trim()) fail(400, "empty message");
  return deliver(env, stub, {
    cfg, to, cc,
    subject: headerValue(body?.subject ?? "").slice(0, 1000),
    text,
    inReplyTo: null, references: null, identity,
  });
}
