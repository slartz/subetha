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
import { normaliseRule, ruleError } from "./rules.js";
import { inlineParts, renderHtml } from "./html-render.js";
import { shapeHealth } from "./health.js";
import { purgeDays, retentionValue, RETENTION_DAYS } from "./retention.js";
import { purgeOlderThan } from "./purge.js";
import { runScheduled } from "./scheduled.js";
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

  // The daily run: a snapshot of the configuration to R2, and the standing retention each
  // mailbox asked for. Wrapped like email() is, and for a related reason — there is nobody on
  // the other end of a cron to tell, so a throw here is a failure that only a dashboard would
  // ever show. runScheduled() wraps each half again so one cannot cost the other.
  //
  // It reaches the DO and R2 and NOTHING ELSE. scheduled.js does not import compose.js or
  // send.js: a cron is an unauthenticated caller in every sense that matters, and the send path
  // stays on the far side of the same wall email() sits behind. Asserted.
  async scheduled(event, env, ctx) {
    try {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName("subetha"));
      await runScheduled(env, stub, event?.scheduledTime || Date.now());
    } catch (e) {
      console.error(JSON.stringify({
        evt: "subetha.scheduled_failed",
        cron: String(event?.cron || "").slice(0, 40),
        error: String(e?.message || e).slice(0, 400),
      }));
    }
  },
};

export async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // AUTH FIRST, on every path, before any routing decision. Access will 302 a browser once
  // the Access app exists; until then — and for anything that reaches the worker around
  // Access — this is the wall. There is no unauthenticated route: /api/health included, and
  // that is the whole reason it is named here — a health endpoint is the one route a person
  // reaches for an exception for, and a worker that can send mail as any mailbox in the zone
  // has nothing safe to say to an anonymous caller, not even how busy it has been.
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

  // Health. ANY authenticated identity may read it and the numbers are account-wide — there is
  // no per-identity view of "is this install working", and the counts leak nothing an owner
  // would mind a member seeing: how many mailboxes exist, how much arrived, what failed. Not
  // an address, not a subject, not who wrote. It is deliberately NOT owner-only, so a member
  // watching a mailbox that has gone quiet can tell "nothing arrived" from "nothing works".
  if (path === "/api/health" && request.method === "GET") return json(shapeHealth(await stub.health()));

  // The configuration, whole, as a file to keep. OWNER-ONLY: it is every mailbox, every member
  // address and every rule in one response, which is the member list's kind of question rather
  // than the reader's — and a member is on one mailbox, not on this. No messages are in it.
  if (path === "/api/export" && request.method === "GET") {
    if (!canAdmin(identity, owners)) return forbidden();
    return json(await stub.exportConfig());
  }

  // /api/mailboxes …
  if (seg[0] === "api" && seg[1] === "mailboxes") {
    if (seg.length === 2 && request.method === "GET")
      return json(visibleMailboxes(await stub.mailboxes(), identity, owners));

    const address = String(seg[2] || "").trim().toLowerCase();
    // One mailbox, in the same shape the list gives it — members with their last delivery, the
    // counts, and what it is costing in storage. A view question, like every other route that
    // names a mailbox and does not change it.
    if (seg.length === 3 && request.method === "GET") {
      if (!(await mayView(stub, identity, owners, address))) return forbidden();
      const box = await stub.mailbox(address);
      return box ? json(box) : json({ error: "not found" }, 404);
    }
    if (seg.length === 3 && request.method === "PUT") {
      if (!canAdmin(identity, owners)) return forbidden();
      if (!validAddr(address)) return json({ error: "invalid mailbox address" }, 400);
      const body = await request.json().catch(() => ({}));
      const display_name = String(body?.display_name ?? "").slice(0, 200) || null;
      // Null — keep forever — unless the caller names one of the offered periods. Anything else
      // is refused rather than rounded to the nearest one: this setting deletes mail.
      const retention = retentionValue(body?.retention_days);
      if (retention.error) return json({ error: retention.error }, 400);
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
      return json(await stub.upsertMailbox(address, display_name, members, retention.days));
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
      // Muted mail is excluded unless asked for. It is stored, it is not deleted, and
      // ?hidden=1 is the whole of "show me it anyway".
      const includeHidden = url.searchParams.get("hidden") === "1";
      return json(await stub.messages(address, before, limit, includeHidden));
    }
    if (seg.length === 4 && seg[3] === "send" && request.method === "POST") {
      if (!(await mayView(stub, identity, owners, address))) return forbidden();
      const body = await request.json().catch(() => ({}));
      return json(await composeNew(env, stub, address, body, identity));
    }

    // Rules. Anyone who may see the mailbox may see why its mail is being muted — a member
    // who cannot is a member wondering where the mail went. Creating and deleting one is
    // OWNER-ONLY: a mute stops the fan-out for EVERY member, not just for the person adding it.
    if (seg.length === 4 && seg[3] === "rules" && request.method === "GET") {
      if (!(await mayView(stub, identity, owners, address))) return forbidden();
      return json(await stub.rules(address));
    }
    if (seg.length === 4 && seg[3] === "rules" && request.method === "POST") {
      if (!canAdmin(identity, owners)) return forbidden();
      if (!validAddr(address)) return json({ error: "invalid mailbox address" }, 400);
      const body = await request.json().catch(() => ({}));
      const rule = normaliseRule(body?.field, body?.pattern);
      const bad = ruleError(rule);
      if (bad) return json({ error: bad }, 400);
      return json(await stub.addRule(address, rule.field, rule.pattern, identity));
    }
    if (seg.length === 5 && seg[3] === "rules" && request.method === "DELETE") {
      if (!canAdmin(identity, owners)) return forbidden();
      return json(await stub.deleteRule(address, Number(seg[4]) || 0));
    }

    // The one route that destroys mail, and the only one. OWNER-ONLY, and deliberately hard to
    // trip: the period must be one of five, not any number of days, because "1" is a plausible
    // slip for "365" and it would take the mailbox with it. `?dry_run=1` answers with the counts
    // and touches nothing, which is what the confirm step in the UI is written from.
    if (seg.length === 4 && seg[3] === "purge" && request.method === "POST") {
      if (!canAdmin(identity, owners)) return forbidden();
      if (!validAddr(address)) return json({ error: "invalid mailbox address" }, 400);
      const body = await request.json().catch(() => ({}));
      const days = purgeDays(body?.older_than_days);
      if (!days) return json({ error: `older_than_days must be one of ${RETENTION_DAYS.join(", ")}` }, 400);
      return json(await purgeOlderThan(env, stub, address, days, url.searchParams.get("dry_run") === "1"));
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
    // Hiding and un-hiding one message by hand. Owner-only, like the rules it overrides: what
    // is visible in a shared mailbox is the same question either way, and a member who could
    // hide a message could hide it from everybody.
    if (seg.length === 4 && seg[3] === "hidden" && request.method === "POST") {
      if (!canAdmin(identity, owners)) return forbidden();
      const body = await request.json().catch(() => ({}));
      return json(await stub.setHidden(id, body?.hidden ? 1 : 0));
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
