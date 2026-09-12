// SubEtha — shared mailboxes on Cloudflare. Named for the sub-etha net: everybody's mail,
// one address, and whoever is listening hears it.
//
// Each configured mailbox (support@example.com, …) has an Email Routing rule pointing at
// this worker. Every inbound message is archived to R2 whole, parsed and stored in the
// MailboxDO, and fanned out to that mailbox's members. The UI behind Access lets the owner
// manage mailboxes and members, read the stored mail, reply AS the mailbox, and compose new
// mail from it. From the outside, each mailbox behaves like an ordinary mailbox.
//
// Modules:
//   inbound.js  the whole email() path      compose.js  reply + compose (fetch only)
//   send.js     the only env.SEND toucher   build-mime.js  the message builder (pure)
//   mailbox-do.js  all state (SQLite DO)    parse-mail.js  body parsing (pure)
//   loop-guard.js  the loop predicates      archive.js  R2 keys
//   ui.js / theme.js  the page              mime.js / access.js  adapted, see LICENSE
//
// THE WALL: inbound.js does not import compose.js, so the "send to an address of the
// caller's choosing" capability is not reachable from email(). test/structure.test.mjs
// asserts it on every run.
import { handleInbound, RAW_PARSE_MAX } from "./inbound.js";
import { replyToMessage, composeNew, HttpError } from "./compose.js";
import { accessOk, accessEmail } from "./access.js";
import { validAddr } from "./build-mime.js";
import { canAdmin, canView, parseOwners, visibleMailboxes } from "./perm.js";
import { inlineParts, renderHtml } from "./html-render.js";
import { renderUi } from "./ui.js";
export { MailboxDO } from "./mailbox-do.js";

const json = (o, status = 200) => Response.json(o, { status });
const forbidden = () => json({ error: "forbidden" }, 403);
const MODES = new Set(["forward", "send"]);

// Constant-time, and length-blind: both sides are hashed first, so the comparison is always
// over 32 bytes whatever the candidate's length was.
async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function bearerOk(request, env) {
  // An unset secret must never authenticate anything — without this guard the comparison
  // would succeed against the literal string "Bearer undefined".
  if (!env.ADMIN_SECRET) return false;
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const [a, b] = await Promise.all([sha(h.slice(7)), sha(env.ADMIN_SECRET)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  // Inbound. Wrapped so nothing can escape: a throw out of email() is a rejected message,
  // which Cloudflare records as a bounce, and bounce rate is one of the four dials that
  // govern this account's sending quota — the quota every other thing the account sends
  // rides on too. setReject is never called here, for the same reason, under any condition.
  async email(message, env, ctx) {
    try {
      await handleInbound(message, env, ctx);
    } catch (e) {
      console.error(JSON.stringify({
        evt: "subetha.email_failed",
        to: String(message?.to || "").slice(0, 200),
        from: String(message?.from || "").slice(0, 200),
        size: Number(message?.rawSize) || 0,
        error: String(e?.message || e).slice(0, 400),
      }));
    }
  },

  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const msg = String(e?.message || e).slice(0, 300);
      console.error(JSON.stringify({ evt: "subetha.fetch_error", path: new URL(request.url).pathname, error: msg }));
      return json({ error: msg }, 500);
    }
  },
};

export async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // AUTH FIRST, on every path, before any routing decision. Access will 302 a browser once
  // the Access app exists; until then — and for anything that reaches the worker around
  // Access — this is the wall. There is no unauthenticated route, not even a health check:
  // a worker that can send mail as any mailbox in the zone has nothing safe to say.
  let identity = null;
  if (path.startsWith("/api/") && await bearerOk(request, env)) identity = "bearer";
  else if (await accessOk(request, env)) identity = accessEmail(request) || "access";
  if (!identity) return json({ error: "unauthorized" }, 401);

  // WHO, not just whether. An owner sees every mailbox and may configure them; a member sees
  // only the mailboxes their address is on; anyone else gets 403 from every route that names
  // one. The shell at GET / still renders — see perm.js for why.
  const owners = parseOwners(env.OWNERS);
  const admin = canAdmin(identity, owners);
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName("subetha"));
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (path === "/" && request.method === "GET") {
    return new Response(renderUi({ identity }), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // The UI asks this once, to decide whether to draw the editor at all. The SERVER decides
  // whether to honour what the editor posts; this is only what the page is told.
  if (path === "/api/me" && request.method === "GET") return json({ identity, is_owner: admin });

  // /api/mailboxes …
  if (seg[0] === "api" && seg[1] === "mailboxes") {
    if (seg.length === 2 && request.method === "GET")
      return json(visibleMailboxes(await stub.mailboxes(), identity, owners));

    const address = String(seg[2] || "").trim().toLowerCase();
    if (seg.length === 3 && request.method === "PUT") {
      if (!canAdmin(identity, owners)) return forbidden();
      if (!validAddr(address)) return json({ error: "invalid mailbox address" }, 400);
      const body = await request.json().catch(() => ({}));
      const display_name = String(body?.display_name ?? "").slice(0, 200) || null;
      const raw = Array.isArray(body?.members) ? body.members : [];
      if (raw.length > 200) return json({ error: "too many members" }, 400);
      const seen = new Set();
      const members = [];
      for (const m of raw) {
        const email = String(m?.email ?? "").trim().toLowerCase();
        const mode = String(m?.mode ?? "").trim().toLowerCase();
        if (!validAddr(email)) return json({ error: `invalid member address: ${email.slice(0, 120)}` }, 400);
        if (!MODES.has(mode)) return json({ error: `invalid mode for ${email.slice(0, 120)}: ${mode.slice(0, 40)}` }, 400);
        if (seen.has(email)) continue;
        seen.add(email);
        members.push({ email, mode });
      }
      return json(await stub.upsertMailbox(address, display_name, members));
    }
    if (seg.length === 3 && request.method === "DELETE") {
      if (!canAdmin(identity, owners)) return forbidden();
      if (!validAddr(address)) return json({ error: "invalid mailbox address" }, 400);
      return json(await stub.deleteMailbox(address));
    }
    if (seg.length === 4 && seg[3] === "messages" && request.method === "GET") {
      if (!(await mayView(stub, identity, owners, address))) return forbidden();
      const before = Number(url.searchParams.get("before")) || 0;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
      return json(await stub.messages(address, before, limit));
    }
    if (seg.length === 4 && seg[3] === "send" && request.method === "POST") {
      if (!(await mayView(stub, identity, owners, address))) return forbidden();
      const body = await request.json().catch(() => ({}));
      return json(await composeNew(env, stub, address, body, identity));
    }
  }

  // /api/messages … A message belongs to a mailbox, so the row is fetched FIRST and the
  // permission question is asked about its mailbox before anything is answered.
  if (seg[0] === "api" && seg[1] === "messages" && seg[2]) {
    const id = Number(seg[2]) || 0;
    const m = await stub.message(id);
    if (!m) return json({ error: "not found" }, 404);
    if (!(await mayView(stub, identity, owners, m.mailbox))) return forbidden();
    if (seg.length === 3 && request.method === "GET") {
      return json(await withRenderedHtml(env, m));
    }
    if (seg.length === 4 && seg[3] === "raw" && request.method === "GET") {
      if (!m?.r2_key) return json({ error: "no archived copy of this message" }, 404);
      const obj = await env.MAIL.get(m.r2_key);
      if (!obj) return json({ error: "archived copy is gone from R2" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": "message/rfc822",
          "content-disposition": `attachment; filename="message-${id}.eml"`,
        },
      });
    }
    if (seg.length === 4 && seg[3] === "reply" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return json(await replyToMessage(env, stub, id, body, identity));
    }
  }

  return json({ error: "not found" }, 404);
}

// Membership is a property of the mailbox's configuration, so answering costs one DO call.
// That is the FETCH path: the hop-minimising rule is about the object's single thread under
// inbound mail, and this is a person clicking. An address with no configuration has no
// members, so only an owner can see it — which is the right answer for mail that arrived at
// an address nobody has claimed.
async function mayView(stub, identity, owners, address) {
  if (canAdmin(identity, owners)) return true;
  return canView(identity, owners, await stub.config(address));
}

// html_rendered: what the reader actually puts in its iframe — cid: images inlined from the
// archived .eml, remote images neutralised, markup sanitised. Built HERE, per read, and not
// at parse time: a cid: image lives in a part that never enters the row, and a sanitiser is a
// moving target that has to apply to mail which arrived before it was written.
//
// Never fails the read. A message whose archive is gone still opens; it opens without its
// inline images and says so in render_note.
async function withRenderedHtml(env, m) {
  if (!m.html) return m;
  let parts = [];
  let note = null;
  if (!m.r2_key) note = "no archived copy of this message — inline images were not resolved";
  else if (Number(m.size) > RAW_PARSE_MAX) note = "the archived copy is over the parse cap — inline images were not resolved";
  else {
    try {
      const obj = await env.MAIL.get(m.r2_key);
      if (!obj) note = "the archived copy is gone from R2 — inline images were not resolved";
      else parts = inlineParts(new Uint8Array(await obj.arrayBuffer()));
    } catch (e) {
      note = "the archived copy could not be read — inline images were not resolved";
      console.error(JSON.stringify({ evt: "subetha.render_failed", id: m.id, error: String(e?.message || e).slice(0, 300) }));
    }
  }
  try {
    const r = renderHtml(m.html, { parts });
    return { ...m, html_rendered: r.html, remote_images: r.remote_images, render_note: note };
  } catch {
    // The sandbox and the CSP the reader prepends are the defence; the sanitiser is depth. So
    // the fallback is the stored html, unrendered, rather than a message that will not open.
    return { ...m, html_rendered: m.html, remote_images: 0, render_note: "the html could not be rendered — shown as it was stored" };
  }
}
