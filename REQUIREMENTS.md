# Requirements

What SubEtha must do, and — just as load-bearing — what it must not grow into.

## The problem

A small group wants a shared address: `support@`, `hello@`, `bookings@`. Everyone in the group
should see what arrives, anyone should be able to answer *as the address*, and the history
should survive people joining and leaving. Consumer mail providers solve this with a paid
shared-inbox product; Cloudflare Email Routing solves half of it (forward to several people)
and stores nothing.

An Email Routing rule can point an address at exactly **one** target. That single constraint
is why the fan-out, the stored copy and the ability to reply from the address all have to be
one program.

## Must do

1. **Accept every message routed to it without ever rejecting one.** A reject is a bounce and
   a bounce tells the sender the address is broken. Unparseable, oversized, malformed,
   addressed to an unconfigured mailbox — all are accepted.
2. **Archive the raw message to R2 before parsing it**, so no parser change can ever lose an
   original.
3. **Store a parsed row** — headers, body text, HTML, attachment manifest — in durable
   storage, queryable by mailbox, newest first.
4. **Fan a copy out to a member list** configured per mailbox, in one of two modes per member
   (see below).
5. **Record the outcome of every fan-out attempt**, including deliberate skips and why — and
   **show each member their own latest outcome** on the row that can fix it, because a member
   whose every delivery fails is otherwise a silent failure.
6. **Let an owner mute mail that should not be fanned out**, by sender, sender domain, subject
   or `List-Id`. A muted message is still archived, still stored and still readable; what stops
   is the fan-out. Muting is not deleting, and there is no rule action that is.
7. **Let an authenticated operator**, through a web UI and an equivalent HTTP API:
   create and edit mailboxes and their member lists; read stored mail; download the raw
   `.eml`; reply as the mailbox; compose new mail from the mailbox; add and remove mute rules.
8. **Scope what each identity may see and do**, on the server, on every route: an **owner**
   (an address in `OWNERS`, or the `ADMIN_SECRET` bearer) sees and configures every mailbox; a
   **member** sees only the mailboxes their address is on and may read, reply and compose from
   them but change nothing; anybody else is refused everything that names a mailbox or a
   message.
9. **Show a stored HTML message safely, and looking like itself.** Inline `cid:` images
   resolved from the archive, remote images never loaded without an explicit click, the markup
   sanitised, and the whole thing inside a sandboxed iframe under a restrictive CSP.
10. **Carry the original HTML into a reply**, so a formatted message quoted back to its sender
    still looks like what they sent.
11. **Guard against mail loops** at both the message level and the member level.
12. **Authenticate every request** — browser and automation alike — before any routing
    decision.
13. **Run with no build step and no dependencies**, so the source that is read is the source
    that runs.

## Fan-out semantics

Membership is per mailbox. Each member carries a mode:

* **`forward`** — hand the original message to Cloudflare's forwarder. SRS is handled by
  Cloudflare and the original `From` survives, so the recipient sees a genuine forward and can
  reply to the original sender directly. Requires the destination to be a **verified
  destination address** on the Cloudflare account; if it is not, the attempt fails and the
  failure is recorded against that member.
* **`send`** — build a new message and send it natively: `From` is the mailbox (with its
  display name), `Reply-To` is the original sender, and `X-Subetha-Hop` plus
  `X-Subetha-Original-From` are added. No verification needed, reaches anyone, consumes the
  account's sending quota, and re-originates the message — so it is authenticated by your
  domain rather than the sender's.

Rules that hold in both modes:

* One member's failure never stops the others.
* A member is skipped, with a recorded reason, when the member address is the mailbox itself
  or when its domain is one this worker routes.
* The whole fan-out is suppressed, with a recorded reason, when the message is
  machine-generated (`Auto-Submitted` ≠ `no`, `Precedence: bulk|junk|list`) or already carries
  this worker's own hop marker.
* `List-Id` is **not** a suppression reason: a shared mailbox may legitimately subscribe to a
  mailing list. It is, however, stored on the row and **mutable by rule**, which is the
  difference between "this worker decided" and "an owner decided".
* Mail for an address with no configuration is stored and marked `unconfigured`; nothing is
  fanned out and nothing is rejected.
* A message matching a mute rule is stored `hidden`, attributed to the rule that matched it,
  and fanned out to nobody. The loop guards are evaluated first: a message they suppress is
  recorded as suppressed rather than as muted.

## Must not do (non-goals)

These are decisions, not missing features. A PR that adds one of them is out of scope.

* **Not a mail client.** No folders, labels, flags, read/unread state, or conversation
  threading view. Mute rules are the one exception and they are deliberately the smallest one:
  a single action (mute), four fields, two comparisons, **no regular expressions**, and no
  action that moves, tags, replies to or deletes anything.
* **No search.** Paging backwards by id is the whole retrieval story.
* **No rich compose.** You write plain text: no HTML editor, no attachments on send. A reply to
  a message that HAD an html part goes out as `multipart/alternative` so the quoted original
  survives looking like itself — but the author's half is the same plain text in both parts, and
  a reply to a text-only message, like any new message, stays `text/plain`.
* **No attachment extraction.** Attachments are listed (filename, type, size); the bytes stay
  in the archived `.eml`.
* **No multi-tenancy.** One Durable Object instance holds every mailbox and one `OWNERS` list
  governs the lot. Owners and members scope *visibility*, not storage: this is one operator's
  install with some colleagues on it, not a service with tenants. There are two roles and there
  will not be a third, no per-mailbox admin delegation, and no groups.
* **No message deletion.** Removing a mailbox removes its configuration only; the stored rows
  and the R2 archive are untouched. Muting hides a row and stops its fan-out — it is not a
  delete wearing a different word, and no rule action may become one.
* **No dependencies, no build step, no framework** — including in the UI.
* **No external resource loaded by the UI** — no font CDN, no script tag, no icon sprite. The
  Access login is the only thing between this page and every mailbox in the zone. The reader's
  iframe extends this to the MAIL as well: no remote image loads until the operator asks.
* **No fetch route for MIME parts.** Inline images are resolved server-side into the HTML. A
  route would have to weaken the reader's empty `sandbox` to be reachable at all.

## Constraints

* Cloudflare Workers Paid plan (SQLite-backed Durable Objects).
* Email Routing enabled on the zone; Email Sending onboarded for `send` mode.
* Cloudflare Access in front of the UI, with the worker verifying the JWT itself.
* Account sending quota is shared with everything else the account sends; bounce rate is one
  of the dials that governs it.
