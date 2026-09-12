// The ONLY module in SubEtha that touches env.SEND. Nothing here chooses a recipient,
// composes a message, or reads the database: it is a transport and a transport only, so
// that "who may send, as whom, to where" is a question about the two callers below rather
// than a question about this file.
//
// The two callers:
//   inbound.js  — fan-out. Destination is always an address the OWNER put on the member
//                 list, never one that arrived in the message.
//   compose.js  — reply and compose. Destination is chosen by an authenticated caller
//                 behind Access, and is deliberately unrestricted (see wrangler.jsonc).
// inbound.js does not import compose.js and never will; that is the wall.
import { EmailMessage } from "cloudflare:email";

/** Hand one already-built RFC 5322 message to Cloudflare Email Sending. Throws on failure. */
export async function sendRaw(env, from, to, raw) {
  await env.SEND.send(new EmailMessage(from, to, raw));
}

/**
 * The same raw message to several envelope recipients — which is how Cc is delivered, since
 * an EmailMessage carries exactly one envelope recipient and the Cc: header is only a label.
 * Never rejects: each recipient's outcome is a row in the result.
 */
export async function sendRawTo(env, from, recipients, raw) {
  const out = [];
  for (const to of recipients) {
    try { await sendRaw(env, from, to, raw); out.push({ member: to, ok: true, error: null }); }
    catch (e) { out.push({ member: to, ok: false, error: String(e?.message || e).slice(0, 400) }); }
  }
  return out;
}
