// Body parsing. Pure — node-testable — and deliberately the ONLY thing read out of the raw
// message: every header SubEtha stores comes from message.headers, which Cloudflare has
// already parsed. A parser bug here therefore costs a body, never a header, and never the
// original: the archive write to R2 happens before this function is called.
//
// Attachments are LISTED, not decoded into storage: filename, type, size. The bytes stay in
// the .eml in R2, which is where a shared mailbox's attachments belong — one copy, the
// original, downloadable whole.
import { parseParts, decodeBody, decodeText, decodeWords, hdr, stripHtml } from "./mime.js";

/** raw: the message as a byte-transparent string (see mime.js bytesToLatin1). */
export function parseBody(raw) {
  const out = { text: null, html: null, attachments: [] };
  let parts;
  try { parts = parseParts(String(raw ?? "")); } catch { return out; }
  for (const p of parts) {
    // The container part: its "body" is every other part concatenated. Its children are
    // already in this list (parseParts recurses into nested multiparts).
    if (/^multipart\//i.test(p.mime)) continue;
    const disp = hdr(p.head || "", "content-disposition").toLowerCase();
    const filename = decodeWords(/filename="?([^";\r\n]+)"?/i.exec(p.head || "")?.[1] || "") || p.name || "";
    const attached = /^attachment/.test(disp) || !!filename;
    // RFC 2045: a part with no Content-Type is text/plain.
    const mime = p.mime || "text/plain";
    let bytes;
    try { bytes = decodeBody(p); } catch { continue; }
    if (!attached && mime === "text/plain" && out.text == null) {
      out.text = decodeText(bytes, p.charset);
      continue;
    }
    if (!attached && mime === "text/html" && out.html == null) {
      out.html = decodeText(bytes, p.charset);
      continue;
    }
    if (!attached && (mime === "text/plain" || mime === "text/html")) continue; // a duplicate alternative
    out.attachments.push({ filename: filename || null, type: mime, size: bytes.length });
  }
  // A message with only an HTML part still needs something to show in the reader and
  // something to quote in a reply. The derived text is marked as derived nowhere, because
  // it is indistinguishable in use from a text/plain part the sender chose not to send.
  if (out.text == null && out.html != null) out.text = stripHtml(out.html);
  return out;
}
