# Design

Read this before changing anything. Several things that look like omissions are decisions.

## Module map

```
index.js ──┬─ inbound.js ──┬─ archive.js ──── R2
 (email)   │   (email path)│─ parse-mail.js ─ mime.js
 (fetch)   │               │─ build-mime.js
           │               │─ loop-guard.js ─ build-mime.js
           │               └─ send.js ─────── env.SEND
           │
           ├─ compose.js ──┬─ build-mime.js        ← NOT reachable from inbound.js
           │  (fetch only) │─ html-render.js
           │               │─ send.js
           │               └─ archive.js
           ├─ html-render.js ─ mime.js / build-mime.js
           ├─ perm.js          who may see and change which mailbox
           ├─ rules.js ─────── build-mime.js   mute matching, and the same rule as SQL
           ├─ access.js        Access JWT verification
           ├─ ui.js ────────── theme.js / html-render.js
           └─ mailbox-do.js ── fanout-status.js / rules.js   (the MailboxDO class)
```

| module | pure? | responsibility |
|---|---|---|
| `index.js` | no | `email()` and `fetch()` entry points, the auth gate, the router |
| `inbound.js` | no | the whole `email()` path, start to finish |
| `compose.js` | no | reply and compose: send as the mailbox to a caller-chosen address |
| `send.js` | no | the **only** module that touches `env.SEND`; a transport, nothing else |
| `mailbox-do.js` | no | `MailboxDO`: all state, SQLite, RPC surface only |
| `archive.js` | half | R2 key shape (pure) and the one `put` (never throws) |
| `build-mime.js` | yes | RFC 5322 builder, address validation, header sanitising, quoting |
| `parse-mail.js` | yes | body parsing — the only thing read out of the raw message |
| `mime.js` | yes | MIME primitives: anchored header lookup, part splitting, charsets |
| `loop-guard.js` | yes | `loopReason` (message level) and `memberSkip` (member level) |
| `rules.js` | yes | mute rules: matching, normalising, validating, and the SQL predicate |
| `fanout-status.js` | yes | classifying a fan-out error, and folding it onto a member row |
| `html-render.js` | yes | the HTML pass: `cid:` inlining, remote-image blocking, sanitising, the reply quote |
| `perm.js` | yes | `canAdmin` / `canView` / `visibleMailboxes` — the permission predicate |
| `access.js` | no | Access JWT extraction and verification |
| `ui.js` / `theme.js` | yes | the page as one string: markup + inline CSS + inline JS |

Purity is not aesthetic: a module that imports `cloudflare:*` cannot be loaded by `node --test`,
so every decision worth asserting lives in a module that does not. `test/structure.test.mjs`
asserts that `cloudflare:workers` appears only in `mailbox-do.js` and `cloudflare:email` only
in `send.js`.

### The two invariants

1. **`email()` never throws and never rejects.** `index.js` wraps `handleInbound` in a
   try/catch that only logs; `inbound.js` catches around every fallible step; `archive.js`
   returns `null` instead of throwing. `setReject` appears nowhere.
2. **`compose.js` is unreachable from `email()`.** The `send_email` binding is unrestricted,
   so the control against "send to anyone" being inside the inbound path is the import graph,
   not a comment.

Both are asserted by `test/structure.test.mjs` on every run.

## Durable Object schema

One instance, reached by `idFromName("subetha")`. A shared mailbox is a handful of messages a
day, so a single object makes "list every mailbox" one query instead of a fan-in. The schema
is created idempotently inside `blockConcurrencyWhile`, so no RPC can reach a half-built
schema:

```sql
CREATE TABLE IF NOT EXISTS mailboxes (
  address TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER)

CREATE TABLE IF NOT EXISTS members (
  mailbox TEXT, email TEXT, mode TEXT CHECK(mode IN ('forward','send')),
  added_at INTEGER, PRIMARY KEY (mailbox, email))

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT, message_id TEXT, in_reply_to TEXT, references_hdr TEXT,
  direction TEXT CHECK(direction IN ('in','out')),
  from_addr TEXT, from_name TEXT, reply_to TEXT, to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, date_hdr TEXT, received_at INTEGER,
  text TEXT, html TEXT, r2_key TEXT, size INTEGER, attachments_json TEXT,
  unconfigured INTEGER DEFAULT 0, sent_by TEXT,
  list_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, muted_by INTEGER)

CREATE INDEX IF NOT EXISTS messages_box ON messages(mailbox, id)

CREATE TABLE IF NOT EXISTS fanout_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row INTEGER, member TEXT, mode TEXT, ok INTEGER, error TEXT, at INTEGER)

CREATE INDEX IF NOT EXISTS fanout_row ON fanout_log(message_row)

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('from','from_domain','subject','list_id')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'mute' CHECK(action IN ('mute')),
  created_by TEXT, created_at INTEGER, hits INTEGER NOT NULL DEFAULT 0)

CREATE INDEX IF NOT EXISTS rules_box ON rules(mailbox)
```

### Migrations

The object is **live**: it holds every mailbox's mail and it is receiving while you deploy.
There is no window in which it is offline, so a migration has exactly two safe shapes, and both
run in the same `blockConcurrencyWhile` as the original DDL:

* **A new table** — `CREATE TABLE IF NOT EXISTS`, which is idempotent by construction.
* **A new column** — `ALTER TABLE … ADD COLUMN`, which is **not**: adding a column that already
  exists throws, and a throw in the constructor is an object that fails every RPC afterwards —
  on this path, mail arriving at a Durable Object that cannot start. So the columns are read
  first with `PRAGMA table_info(messages)` and each `ALTER` is skipped if its column is there.

The three columns (`list_id`, `hidden`, `muted_by`) are also in the `CREATE TABLE` above, so a
**new** object gets them in one statement and an **existing** one is brought to the same shape by
the guarded `ALTER`s; the two paths converge. Changes are additive only. Nothing is renamed,
nothing is dropped, `NOT NULL` carries a `DEFAULT`, and there is no version number to get out of
step with the code — the schema describes itself.

Notes that are not obvious from the DDL:

* **`mailboxes` and `messages` are joined by address, not by a foreign key.** Mail can arrive
  for an address with no `mailboxes` row; `mailboxes()` therefore lists the UNION of
  configured addresses and addresses that have only ever received, so the operator sees
  exactly the case they need to act on.
* **Members are replaced, not merged**, by `upsertMailbox`: the editor posts the whole list,
  so an address missing from it is a removal. Merging would make removal impossible from the
  UI.
* **Deleting a mailbox keeps its messages.** They are the mailbox's history; removing a
  configuration is an administrative act, not a decision to destroy mail.
* **`fanout_log` records skips too**, with `mode='skip'` and `ok=1`, so the UI can explain why
  nothing left rather than showing a silent 0/0. A muted message gets the same treatment with
  `mode='rule'`.
* **`fanout_log` has no mailbox column.** "The last attempt to this member" therefore joins
  through `messages` to scope by mailbox — without it, a member on two mailboxes would be shown
  the other mailbox's result on both rows. Latest is by `id`, not by `at`: one `recordFanout()`
  call stamps a whole batch with the same millisecond.
* **`hidden` is a message property, `rules` is configuration.** A rule can be deleted without
  un-hiding anything, and a message can be un-hidden without touching the rule — which is why
  `muted_by` is nullable and cleared on an un-hide rather than being a foreign key.

## Request flow: inbound

```
Cloudflare Email Routing
   └─ email(message, env, ctx)            index.js — try/catch, log only, never rethrow
        └─ handleInbound()                inbound.js
             1. r2Key(mailbox, message-id, now)
                └─ archive to R2          BEFORE parsing; a failed put returns null
                   · size > 20 MB  → stream message.raw straight to the bucket, no parse
                   · otherwise     → read to an ArrayBuffer, put, keep the bytes
             2. parseBody(raw)            body only; every header comes from message.headers
             3. stub.inbound(row)         ONE DO call: insert + return members  ← hop 1
                  firstMatch(rules, row)  a mute rule? → hidden=1, muted_by, hits+1,
                                          and NO members handed back
             4. fan out, OUTSIDE the DO
                  loopReason(headers)     suppress the lot?  → one skip row
                  muted_by                muted?             → one 'rule' row
                  memberSkip(...)         skip this member?  → one skip row
                  mode 'forward'          message.forward(member)
                  mode 'send'             buildMime(...) → sendRaw(env, ...)
             5. stub.recordFanout(...)    ONE DO call, via ctx.waitUntil  ← hop 2
```

Order is the design. **Archive first** so a parser bug costs a body and never the original.
**Headers from `message.headers`**, which Cloudflare has already parsed, so a parser bug cannot
cost a header either. **`waitUntil` is used for step 5 and nothing else** — the archive and the
insert are awaited, because a message that is not stored is a message lost.

### The hop-minimising rule

A Durable Object has a single thread. A DO call that blocks on Cloudflare Email Sending holds
that thread, and every other mailbox's inbound message queues behind it. So:

> **The object does state and nothing else. It never sends, never forwards, never waits on the
> network.**

Which fixes the inbound path at exactly two DO calls: `inbound()` inserts the row and hands
back the member list in one round trip, the worker performs the forwards and sends outside the
object, and `recordFanout()` writes down what happened.

**Mute rules are evaluated inside `inbound()`, and that is why the count is still two.** The
call already knows the mailbox, has the row in hand and is about to return the member list, so
matching costs one more local query rather than a hop. A match writes the row `hidden=1` with
its `muted_by`, bumps the rule's `hits`, and hands the worker **no members** — which is what
makes "muted" mean *nothing was forwarded* rather than *the UI filters it afterwards*.

## The send-mode copy's sender

A `forward` keeps the original `From`; Cloudflare rewrites the envelope and handles SRS. A
`send` cannot: it is a new message, and its `From` **address** must stay the mailbox's or the
domain's DMARC alignment goes with it. Left there, every message in a send-mode mailbox looks
like it came from the mailbox itself, and the real sender survives only in `Reply-To` and
`X-Subetha-Original-From` — neither of which a reading pane shows.

So the sender is said twice, in the two places a client actually renders:

```
From: "Alice via Support" <support@example.com>      ← viaName(): name only, address unchanged
…
From: Alice <alice@example.com> — via support@example.com     ← viaLine(), above the body
                                                                (and viaHtml() above the html)
```

Both live in `build-mime.js`, which is where every other header value is sanitised and every
non-ASCII display name becomes an encoded word; the attribution line is escaped before it goes
anywhere near the html alternative, because it carries a `From` header a stranger wrote. The
sender's half of the display name is capped and the mailbox's half never is — a display name is
a string a stranger chose. `Reply-To` and `X-Subetha-Original-From` are unchanged, and **forward
mode is untouched**: Cloudflare preserves the original there, and only `X-` headers may be added
to a forward at all.

## Per-member delivery status

A member added in `forward` mode whose address is not a verified destination fails on **every**
message: `message.forward()` throws, the per-member `try/catch` writes `ok=0` with the error into
`fanout_log`, and the other members still get theirs. Correct — and, until it is said somewhere,
silent. The place it belongs is the member row, which is the thing that can be fixed.

```
memberStatus(mailbox)     DO, read-only: the latest fanout_log row per member of this mailbox
classifyFanoutError(…)    pure: an error string → { kind, hint }
withMemberStatus(box)     pure: members + those rows → members[].last
```

* **No schema change.** The rows are already in `fanout_log`; this is one query, and it is the
  DO's existing per-mailbox member query with a `LEFT JOIN` beside it.
* **The merge happens inside `mailboxes()` and `upsertMailbox()`**, via the pure module, so the
  list and the `PUT` response carry it in the round trip they already make. `config()` is left
  lean: `mayView()` and `compose.js` call it on every read and neither needs the status.
* **`last` is `null` for a member nothing has been sent to yet** — an absent status is not a
  failure, and it must not draw as one.
* **`kind` and `hint` are null on a success.** A hint on a delivered row is noise.
* **The classifier is loose on purpose** around the one failure an owner will actually hit:
  anything saying "verif" is `unverified_destination`, and the hint names the two ways out
  (verify it in Email Routing, or switch the member to `send`). The raw error is shown beside
  the hint, always — the hint says what to *do*, not what happened.
* **An `ok` row whose mode is `skip` is not drawn as "delivered".** `fanout_log` records skips
  as `ok=1`; claiming a delivery that never happened is the one lie worth avoiding here.

## Mute rules

A shared mailbox accumulates mail nobody wants forwarded to five people: a newsletter somebody
subscribed it to, a vendor's marketing, a monitoring alert that fires nightly. The member list
cannot express that — it is about *who*, and this is about *what*.

```
rules(mailbox)            every rule, oldest first — which is matching order
addRule(...)              insert, then hide what already matches, then add those to hits
deleteRule(...)           the rule goes; what it hid stays hidden
setHidden(id, 0|1)        one message, by hand; un-hiding clears muted_by
```

The decisions worth writing down:

* **Mute only.** A rule hides a message and stops its fan-out. It does not delete, move, tag or
  auto-reply. Everything is still archived to R2, still stored, still readable under *show
  muted*, and still downloadable as the original `.eml`. "No message deletion" is a requirement,
  not an oversight, and a rule that deleted would be the way round it.
* **No regular expressions.** Four fields and two comparisons: equals (`from`, `from_domain`)
  and contains (`subject`, `list_id`). A pattern is typed into a small box by a person and then
  runs inside the Durable Object on the inbound path, where a typo becomes either a rule that
  silently matches everything or a backtracking regex chewing the object's single thread on a
  subject a stranger chose.
* **`from_domain` is exact.** A rule for `example.com` does not match `mail.example.com`.
  The loose version ("ends with") also mutes `notexample.com`, and the tight version needs a
  label-boundary comparison nobody would predict from reading the rule in the UI. v2's problem.
* **The oldest matching rule wins**, and it is the only one credited: a message is muted *by* a
  rule, and `hits` has to add up to something an owner can reason about.
* **Creating one is retroactive.** The rule you add is almost always the rule you wanted an hour
  ago, and the newsletter is sitting in the list as you type. One `UPDATE` in SQL over the
  stored rows — not a read-modify-write per row, on a thread shared with every mailbox's inbound
  mail. Rows already hidden are left alone so the rule that muted them first keeps the
  attribution. The predicate is built by `sqlPredicate()` with `%` and `_` escaped and the value
  **bound**, never interpolated.
* **Deleting one is not retroactive.** Un-hiding on delete would be a second bulk action — the
  opposite one — hiding inside a delete. An owner who removes a rule means "stop muting from now
  on" far more often than "resurface three months of newsletters". Un-hiding is per message.
* **Rules are owner-only to create and delete, and visible to anyone who may view the mailbox.**
  A mute stops the fan-out for *every* member, so it is the member list's kind of question; but
  a member who cannot see the rules is a member wondering where the mail went.
* **Live matching and the retroactive pass differ in one way**, deliberately: SQLite's `lower()`
  folds ASCII only, so a retroactive `subject` match is case-sensitive for non-ASCII text while
  live matching in JS folds everything. The alternative is reading every stored row into the
  isolate to compare it in JS.
* **The loop guard still runs first.** It is about the account's sending quota; a mute is about
  one team's attention. A message that trips both is recorded as suppressed.
* **Rules apply to `direction='in'` only.** The mailbox's own outbound copies are not muted, and
  the retroactive `UPDATE` says so in its `WHERE`.

## Request flow: reply (and compose)

```
POST /api/messages/:id/reply
   └─ fetch()                             index.js
        auth gate                         BEFORE any routing decision
        └─ replyToMessage()               compose.js
             stub.message(id)             the original row
             stub.config(mailbox)         refuse if the mailbox is unconfigured
             target = Reply-To ?? From    refuse if it is the mailbox itself (instant loop)
             quote the original, Re: the subject, thread via In-Reply-To/References
             └─ deliver()
                  buildMime(...)          throws on any invalid address → 400
                  sendRawTo(env, ...)     one envelope recipient at a time (To + Cc)
                  archive(...)            the sent .eml to R2
                  stub.storeOutbound(...) direction='out' row + its fanout rows
```

`composeNew` is the same `deliver()` with a caller-supplied To/Cc/Subject and no threading
headers. Both return the stored row, so the caller sees what was actually sent.

Refusing to reply to the mailbox's own address is not politeness: that reply would be handed
straight back to `email()` by Email Routing, stored again, and fanned out again to everybody.

### The reply's html alternative

A reply becomes `multipart/alternative` **when, and only when, the original had an html part**.
The author's side is a plain textarea either way; the html part exists so the ORIGINAL survives
the round trip looking like itself — tables, colours, the lot — instead of coming back as the
flattened text derivation.

```
text/plain   the author's text + quote(msg.text)          ← unchanged
text/html    <div white-space:pre-wrap>escaped author text</div>
             <div>On DATE, FROM wrote:</div>
             <blockquote type=cite>sanitised original</blockquote>
```

The original inside the blockquote goes through the same sanitiser the reader uses, with two
differences, both deliberate:

* **`cid:` images are REMOVED, not inlined.** A reply must stay self-contained and small, a
  `cid:` pointing into the message being quoted resolves to nothing in the recipient's client,
  and inlining would mail the sender 2 MB of their own signature artwork back.
* **Remote images are left exactly as they were.** They are the original's, and the recipient's
  own mail client decides whether to load them.
* **`<style>` blocks are dropped**, though the reader keeps them. A style block is document-wide
  wherever the recipient's client honours it, so the original's CSS would restyle the reply
  written above it. Inline `style=` attributes stay: those are scoped to their element, and they
  are how mail is laid out in the clients that strip `<style>` anyway.

`composeNew` — new mail, not a reply — stays `text/plain`. There is one builder: `build-mime.js`
already grew an html alternative for send-mode fan-out, and the reply reuses it.

### One text derivation

`stripHtml()` in `mime.js` has two readers — the stored `text` of an html-only message, and the
original quoted inside a plain-text reply — so it is one implementation and what it does to a
marketing signature is not a cosmetic question. A link keeps its target (`text (url)`), because
a reader of a quote cannot hover. An image contributes nothing at all: an `alt` in a signature
is `image001.png` and a `data:` src is a screenful of base64. The end of a block is ONE newline
and never two — Gmail wraps each individual line in a `<div>`, and a blank line per block would
send the quote back at twice the length it was written.

## The reader's HTML pass

`GET /api/messages/:id` returns the stored row plus three fields the reader uses and the
database does not hold: `html_rendered`, `remote_images` and `render_note`. They are computed on
every read rather than at parse time, for two reasons: a `cid:` image lives in a MIME part that
never enters the row, and a sanitiser is a moving target that has to apply to mail which arrived
before it was written.

```
GET /api/messages/:id
  └─ stub.message(id)                     the row
     mayView(...)                         403 unless owner or member
     └─ withRenderedHtml()                only when row.html is non-null
          env.MAIL.get(r2_key)            the archived .eml
          inlineParts(raw)                parts with a Content-ID / Location / filename
          renderHtml(html, {parts})       one pass:
             cid:  src / url(cid:)  → data:<type>;base64,…   (2 MB each, 6 MB total)
             http(s) <img src>      → data-remote-src + a 1x1 placeholder, counted
             script / on* / iframe / object / embed / form / base /
             meta http-equiv / javascript: / vbscript:  → gone
```

**There is no fetch route for parts, and there must not be one.** The reader's iframe carries an
**empty `sandbox`** attribute, which gives it an opaque origin; a subresource request from it
would not carry the `CF_Authorization` cookie and would come back 401. Inlining is not a
shortcut around that — it is the only thing that works without weakening the sandbox.

**Remote images are never loaded by default.** A remote `<img>` in mail is a read receipt with a
URL, and the sender chose it. The reader shows "Load N remote images"; clicking it re-renders
with `data-remote-src` restored and the CSP widened to `img-src data: https:`. Reopening the
message blocks them again.

The reader stacks three layers and relies on the first two:

1. **the empty `sandbox`** — no scripts, no same-origin, no forms, no navigation;
2. **a CSP meta at the top of the srcdoc** — `default-src 'none'; img-src data:; style-src
   'unsafe-inline'; font-src data:`. `<style>` survives because that is how mail is laid out;
3. **the sanitiser**, which is depth here and the *only* defence in the reply quote, where the
   recipient's mail client is the renderer and there is no sandbox at all.

Over either inline cap the `src` is left as the `cid:` it was: unresolved and visibly broken
beats a response nobody can load. If the archive cannot be read the message still opens, without
its inline images, and `render_note` says so.

## The permission model

Two roles and no third, decided by `perm.js` and enforced on the server by every route.

| | owner | member | neither |
|---|---|---|---|
| listed in `OWNERS`, or the `ADMIN_SECRET` bearer | yes | — | — |
| on some mailbox's `members`, either mode | — | yes | — |
| `GET /` | shell | shell | shell, empty list |
| `GET /api/mailboxes` | every mailbox | only its own | `[]` |
| read, download raw, reply, compose | any mailbox | its own | 403 |
| see a mailbox's mute rules | any mailbox | its own | 403 |
| create / edit / delete a mailbox, edit members | yes | 403 | 403 |
| create or delete a mute rule; hide or un-hide a message | yes | 403 | 403 |

Identity is the Access JWT's `email` claim, lowercased. `identity === "bearer"` is
owner-equivalent: it is the operator's own automation credential and could already reach every
route, so locking it out would be a permission model with the hole somewhere else instead.

Comparison is lowercase and otherwise **literal**. Gmail dots and `+tags` are not normalised:
two different strings are two different identities, and an address-equivalence rule that is right
for one provider is wrong for the next — and being wrong here hands over a mailbox.

`GET /api/mailboxes` and `GET /api/me` are identity-scoped reads and return an empty list / an
`is_owner: false` rather than 403, which is what lets the shell render "you are on no mailbox"
instead of a bare error. Everything that names a mailbox or a message is 403.

An **unconfigured** mailbox has no `mailboxes` row and therefore no members, so only an owner can
see it. That is the right answer: mail that arrived at an address nobody has claimed is the
operator's problem, not a stranger's.

Membership costs one extra DO call per request, and that is fine — the hop-minimising rule is
about the object's single thread under *inbound mail*, and these are fetch routes with a human
on the other end.

The UI asks `GET /api/me` once and hides what a member cannot use. **That is presentation, not
permission**: every route asks `perm.js` the same question again, and
`test/structure.test.mjs` asserts that each one does.

## R2 key shape

```
<mailbox>/<YYYY>/<MM>/<message-id>.eml
```

Mailbox first, so `list` with a prefix is "everything this mailbox ever received". Month next,
so a year is a handful of prefixes rather than one flat bucket. Both segments pass through
`keySafe()`, which strips angle brackets and replaces everything outside `[A-Za-z0-9@._+-]`
with `_` — a Message-ID is a string a stranger chose. A message with no usable Message-ID gets
`crypto.randomUUID()` instead, so two anonymous messages cannot collide. Outbound mail uses
the same function, so the two directions can never drift into different key shapes for the
same mailbox.

The object carries `contentType: message/rfc822` and custom metadata (`mailbox`, `from` or
`direction`, `at`). `archive()` never throws: a failed put is logged and the row is stored
with `r2_key = null`, which is how the UI knows there is no archived copy to download.

## Auth ordering

In `route()`, in this order, before the path is examined:

1. If the path starts with `/api/` **and** the `Authorization: Bearer` value matches
   `ADMIN_SECRET`, identity is `"bearer"`. The comparison is constant-time and length-blind:
   both sides are SHA-256'd first, so it is always over 32 bytes. It bails immediately on
   `!env.ADMIN_SECRET`, so an unset secret authenticates nothing.
2. Otherwise, if the Access JWT verifies, identity is the JWT's `email` claim (or `"access"`
   for a service token). Verification checks `iss` against `ACCESS_TEAM_DOMAIN`, `exp`,
   `aud` against `ACCESS_AUD` — required, never optional — and the RSA signature against the
   team's published keys, cached for an hour.
3. No identity → `401`. There is no unauthenticated route, not even a health check.

`test/structure.test.mjs` asserts that nothing returns a `Response` above the gate.

Authentication answers *whether*; **`perm.js` answers *who***, immediately below the gate and
before any route runs. See *The permission model*.

The identity is carried into `compose.js` and stored on the outgoing row as `sent_by`, so the
mailbox's history says who spoke for it.
