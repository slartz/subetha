# SubEtha

A shared mailbox that runs entirely inside one Cloudflare Worker: mail arriving at an address
is **fanned out to a member list**, **kept as a stored copy** you can read in a small web UI,
and **replied to or composed from** that same address — sending natively through Cloudflare
Email Routing and Email Sending, with no build step, no framework and no dependencies. Named
for the sub-etha net: one address, everybody listening. From the outside each mailbox behaves
like an ordinary mailbox; from the inside it is ~2,800 lines of plain JavaScript and a SQLite
Durable Object.

## Why this exists

Every other Cloudflare mailbox project is a full webmail — an IMAP-shaped client, a database
schema for folders and flags, a front end to match. The projects that only fan mail out to a
group have no storage and no way to answer: the mail arrives at five inboxes and the reply
comes from whichever human happened to answer, from their own address.

The two halves cannot be split, because **an Email Routing rule can only point an address at
one target.** You cannot have a worker that archives and a second rule that forwards; whatever
the rule points at is solely responsible for that address. So the fan-out and the stored copy
and the ability to reply as the address all have to live in the same worker, which is what
this is.

## Requirements

* **Workers Paid** — Durable Objects with SQLite storage are not on the free plan.
* **Email Routing enabled** on the zone, with a rule per mailbox address pointing at this
  worker.
* **The zone onboarded to Email Sending** (public beta at the time of writing) for the
  `send_email` binding. Without it, only `forward` mode works.
* **Cloudflare Access** (Zero Trust) — the UI has no login of its own and the worker refuses
  every request that does not carry a verifiable Access JWT.
* **An R2 bucket** for the raw-message archive.

## Architecture

| module | what it is |
|---|---|
| `index.js` | the two entry points (`email()`, `fetch()`), the auth gate, the router |
| `inbound.js` | the whole `email()` path: archive, parse, store, fan out, record |
| `compose.js` | reply and compose — send as the mailbox to a **caller-chosen** address |
| `send.js` | the only module that touches `env.SEND`; a transport and nothing else |
| `build-mime.js` | the RFC 5322 builder (pure): header sanitising, address validation, quoting |
| `parse-mail.js` | body parsing (pure) — the only thing read out of the raw message |
| `mime.js` | MIME primitives (pure): anchored header lookup, part splitting, charsets |
| `mailbox-do.js` | `MailboxDO` — all state, SQLite, one instance, RPC only |
| `loop-guard.js` | the two loop predicates (pure) |
| `rules.js` | mute rules (pure): matching, validating, and the same rule as a SQL predicate |
| `fanout-status.js` | delivery status (pure): classifying a fan-out error into something to act on |
| `html-render.js` | the HTML pass (pure): `cid:` inlining, remote-image blocking, sanitising, the reply quote |
| `perm.js` | the permission predicate (pure): owner, member, neither |
| `archive.js` | R2 key shape and the one function that writes to the bucket |
| `access.js` | Cloudflare Access JWT verification |
| `ui.js` / `theme.js` | the page: one HTML document, inline CSS and JS, no external resource |

Two invariants hold the design up, and both are asserted by `test/structure.test.mjs` on
every run:

1. **`email()` never throws and never rejects.** A reject is a bounce; bounce rate is one of
   the four dials governing an account's sending quota, and that quota is shared with
   everything else the account sends. A message that cannot be parsed is still archived,
   still stored and still visible in the UI. A message that is bounced is gone, and its
   sender has been told the address is broken. `setReject` appears nowhere in the source.
2. **`compose.js` is unreachable from `email()`.** The `send_email` binding is deliberately
   unrestricted (see *Security notes*), so the compensating control is the module graph:
   `inbound.js` does not import `compose.js`, directly or transitively. The test walks the
   import graph and fails the build the day someone adds a convenient import.

## Who sees what

Two roles, decided by the `OWNERS` var and the mailbox member lists, and enforced on the server
by every route.

| | owner | member | neither |
|---|---|---|---|
| in `OWNERS`, or the `ADMIN_SECRET` bearer | yes | — | — |
| on a mailbox's member list, in either mode | — | yes | — |
| see it in the mailbox list | every mailbox | only its own | nothing |
| read, download raw, reply, compose from it | any mailbox | its own | 403 |
| see its mute rules | any mailbox | its own | 403 |
| create, edit or delete a mailbox; edit members | yes | 403 | 403 |
| create or delete a mute rule; hide or un-hide a message | yes | 403 | 403 |

Identity is the Access JWT's `email` claim, lowercased; the `ADMIN_SECRET` bearer is
owner-equivalent. Someone who is neither still gets the page at `/` — with an empty list and a
line saying they are on no mailbox — because that is a better answer to a mistyped bookmark
than a bare 403.

Addresses are compared lowercase and otherwise **literally**: Gmail dots and `+tags` are not
normalised, because two different strings are two different identities and an
address-equivalence rule that is right for one provider is wrong for the next.

**Adding someone to a member list grants them the right to send as that address**, which is what
a shared mailbox is for and why editing the list is owner-only. The UI hides what a member cannot
use; that is presentation, and every route asks the same question again on the server.

## Reading a message

The message pane shows **HTML by default** when the message has an html part, with a toggle to
the text version. What goes into the iframe is not the stored HTML — it is `html_rendered`, built
per read by `html-render.js`:

* **`cid:` images are inlined.** Outlook and Apple signatures reference their logos as
  `<img src="cid:image001.png@01D…">`: parts of the same message, not URLs. The parts are read
  out of the archived `.eml` and folded in as `data:` URIs, up to 2 MB each and 6 MB in total.
  There is deliberately **no fetch route for MIME parts** — the iframe's empty `sandbox` gives it
  an opaque origin, so a subresource request from it would not carry the Access cookie and would
  come back 401.
* **Remote images are neutralised.** A remote `<img>` in mail is a read receipt with a URL. Every
  `http(s)` src becomes `data-remote-src` behind a transparent placeholder and is counted; the
  reader offers "Load N remote images", and only that click loads them. Reopening the message
  blocks them again.
* **The markup is sanitised** — `<script>`, `on*=`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
  `<base>`, `<meta http-equiv>`, `javascript:` and `vbscript:` URLs. That is the third layer,
  under the empty `sandbox` and a CSP meta (`default-src 'none'; img-src data:; style-src
  'unsafe-inline'; font-src data:`) at the top of the srcdoc.

If the archived `.eml` cannot be read the message still opens, without its inline images, and
says so.

## How fan-out works

Each member is configured in one of two modes.

**`forward`** — `message.forward(member)`. Cloudflare handles SRS and the original `From` is
preserved, so the recipient sees a real forward from the original sender and can reply to
them directly. The destination **must be a verified destination address on the Cloudflare
account**, or the forward throws; the failure is recorded against that member's row rather
than lost.

**`send`** — a new message this worker builds and hands to Cloudflare Email Sending:

```
From:     "<sender> via <mailbox display name>" <mailbox@example.com>
Reply-To: <the original sender>
X-Subetha-Hop: 1
X-Subetha-Original-From: <the original From header, verbatim>

From: Alice <alice@example.com> — via support@example.com      ← one line, above the body

<the original body>
```

The **address** stays the mailbox's, because that is what DMARC aligns against; the **display
name** and one line at the top of the body say who actually wrote, in the two places a reading
pane will show it. (An html message keeps its own markup, with the same line in a small muted
`<div>` above it.) Without that, every message in a send-mode mailbox looks like it came from
the mailbox itself and the real sender survives only in headers nobody's client displays.

No verification of the destination is needed, so `send` reaches anyone — but it **uses the
account's sending quota**, and it **re-originates the message**. That last point matters for
DMARC: the recipient sees mail from your mailbox address, authenticated by your domain, not
mail from the original sender. It will pass DMARC where a plain forward might fail it. Pick
`forward` when you want the message to look like the sender's; pick `send` when the destination
is not a verified address or when forwarding keeps failing authentication.

Every member's outcome — delivered, failed, or skipped and why — is a row in `fanout_log`,
which the UI shows per message. **The latest outcome is also shown on the member's own row** in
the editor: `✓ delivered 20m ago`, or a red `⚠` with one sentence saying what to do about it and
the raw error in the tooltip. The failure that makes this worth having is a member added in
`forward` mode whose address is not a verified destination on the account: every message to them
fails, the other members still get theirs, and until it is on the row nothing says so.

## Loop guards

A shared mailbox that fans out is a loop generator if you let it, so there are two independent
guards, both pure and both tested.

**Message level** (suppresses the whole fan-out):

* `Auto-Submitted` present and not `no` (RFC 3834)
* `Precedence` in {`bulk`, `junk`, `list`}
* `X-Subetha-Hop` present — this worker's own mark, so a message it sent that somehow arrives
  back stops dead instead of going round again

**Member level** (skips that one member):

* the member address *is* the mailbox
* the member's domain is listed in `ROUTED_DOMAINS` — Email Routing would hand the message
  straight back to `email()`, and Cloudflare short-circuits mail addressed to a domain it
  routes, so the round trip is sub-second rather than a normal internet hop

`List-Id` is **deliberately not a guard.** A shared mailbox subscribing to a mailing list is a
normal thing to want, and suppressing on `List-Id` would break it silently.

Skips are recorded in `fanout_log` with `mode='skip'` and `ok=1`, so the UI can say *why*
nothing left rather than showing a silent 0/0. That does mean the list view's `ok/total`
counts a skip as a success; the detail pane spells out each member's outcome.

## Rules: muting

A shared address collects mail nobody wants sent on to five people — a newsletter somebody
subscribed it to, a vendor's marketing, a monitoring alert that fires every night. The member
list cannot express that: it is about *who*, and this is about *what*.

Open a message, click **Mute…**, and pick one of three offers, each prefilled from the message
and each editable:

| field | matches |
|---|---|
| `from` | the sender's address, exactly |
| `from_domain` | the sender's domain, exactly — `example.com` does **not** match `mail.example.com` |
| `subject` | the subject **contains** the pattern |
| `list_id` | the `List-Id` header **contains** the pattern |

What a mute does, and what it deliberately does not:

* **It stops the fan-out.** The rule is evaluated inside the Durable Object as the message is
  stored, so nothing is forwarded and nothing is sent. It is not a UI filter.
* **Nothing is deleted.** The raw message is still archived to R2, the row is still stored, and
  the message is still readable — tick **show muted** in the message list, where it carries a
  `muted · rule #n` badge. There is no delete in SubEtha and a rule is not a way to get one.
* **Creating a rule is retroactive**: existing stored messages that match are hidden too, and
  the UI tells you how many. **Deleting a rule is not** — messages it already muted stay muted,
  because "stop muting from now on" is what removing a rule almost always means. Un-hiding is
  per message, with **Unhide** on the message itself.
* **No regular expressions**, on purpose. Two comparisons, equals and contains. A pattern is
  typed into a small box and then runs on the inbound path inside a single-threaded object: a
  regex there is a typo away from muting everything, or from backtracking on a subject a
  stranger chose.
* **Owner-only to create or delete**, visible to anyone who can see the mailbox. A mute stops
  the mail for *every* member, so it belongs with the member list; but a member who cannot see
  the rules is a member wondering where the mail went.
* **The loop guards run first.** A message they suppress is recorded as suppressed, not as muted.

Rules live under the members editor, with each one's hit count.

## Deploy

**The order matters.** Pointing an Email Routing rule at a worker that is not deployed yet
**bounces mail**, and a bounce tells the sender your address is broken.

1. **Create the R2 bucket** named `subetha-mail` (or change `bucket_name` in
   `wrangler.jsonc` to match yours).
2. **Set the secret**: `wrangler secret put ADMIN_SECRET`. This is the bearer token for the
   `/api/*` automation path. Generate a long random value; paste it at the prompt.
3. **Deploy**: `wrangler deploy`.
4. **Create the Cloudflare Access application** over the worker's hostname. The policy must
   be an **Allow** policy, not Bypass: Bypass strips the JWT, and this worker verifies the
   JWT itself rather than trusting that Access is in front of it.
5. **Paste the application's AUD** into `ACCESS_AUD` in `wrangler.jsonc`, replacing
   `TBD-set-after-access-app-created`, and set `ACCESS_TEAM_DOMAIN` to your team domain
   (`your-team.cloudflareaccess.com`). **Deploy again.** Until this is done the worker refuses
   *everyone*, including you — the shipped placeholder matches no JWT. That is deliberate: it
   fails closed in the direction that costs you a login rather than the direction that costs
   you the mailboxes.
6. **Set `OWNERS`** to the comma-separated list of addresses that may configure mailboxes —
   your own Access email first. Left at the shipped `owner@example.com` placeholder, nobody is
   an owner and nothing can be configured.
7. **Set `ROUTED_DOMAINS`** to the comma-separated list of domains whose mail this worker
   routes, and deploy.
8. **Only now, point the Email Routing rules** for each mailbox address at the worker.
9. Open the UI, click **New mailbox…**, enter the address, set a display name and the
   members, and **Save**.

Mail that arrives for an address with no `mailboxes` row is **still stored**, marked
`unconfigured=1`, with no fan-out. The mailbox list and the message list both surface it and
the reader has an "unconfigured only" filter. Nothing is rejected and nothing is dropped.

## API reference

Every route requires authentication, checked **before any routing decision**. There is no
unauthenticated route, not even a health check.

* **Browser** — a Cloudflare Access JWT, taken from the `Cf-Access-Jwt-Assertion` header or
  the `CF_Authorization` cookie, verified against the team's signing keys and pinned to
  `ACCESS_AUD`.
* **Automation** — `Authorization: Bearer <ADMIN_SECRET>`, accepted on `/api/*` only, compared
  in constant time over SHA-256 digests. An unset `ADMIN_SECRET` authenticates nothing.

| method | path | | who |
|---|---|---|---|
| GET | `/` | the UI | anyone authenticated |
| GET | `/api/me` | `{identity, is_owner}` — what the UI draws itself from | anyone authenticated |
| GET | `/api/mailboxes` | the mailboxes **this identity may see**: address, display name, members (each with `last`), counts, `rule_count`, `muted_count` | anyone authenticated |
| PUT | `/api/mailboxes/:address` | `{display_name, members:[{email, mode}]}` — members are **replaced**, not merged; the response carries each member's `last` | owner |
| DELETE | `/api/mailboxes/:address` | removes the configuration; **stored messages are kept** | owner |
| GET | `/api/mailboxes/:address/messages?before=&limit=&hidden=` | newest first, no bodies, ≤100 per page; muted messages are excluded unless `hidden=1` | owner or member |
| POST | `/api/mailboxes/:address/send` | `{to, cc?, subject, text}` — compose from the mailbox | owner or member |
| GET | `/api/mailboxes/:address/rules` | the mute rules, oldest first, each with its `hits` | owner or member |
| POST | `/api/mailboxes/:address/rules` | `{field, pattern}` → `{rule, hidden_now}` — creates it and hides what already matches | owner |
| DELETE | `/api/mailboxes/:address/rules/:id` | deletes the rule; **messages it muted stay muted** | owner |
| GET | `/api/messages/:id` | the full row, its fan-out log, and `html_rendered` / `remote_images` / `render_note` | owner or member |
| GET | `/api/messages/:id/raw` | the archived `.eml` straight from R2 | owner or member |
| POST | `/api/messages/:id/reply` | `{text, cc?}` — reply as the mailbox | owner or member |
| POST | `/api/messages/:id/hidden` | `{hidden: 0\|1}` — hide or un-hide one message; un-hiding clears `muted_by` | owner |

Anything an identity may not reach is `403`, including a message whose mailbox it is not on.
`/api/me` and `/api/mailboxes` are identity-scoped reads rather than gated ones: they answer for
everyone, with an empty list where there is nothing to show, which is what lets the shell render
for someone who is on no mailbox.

A reply goes to the original message's `Reply-To`, else its `From`, plus any Cc. A Cc is
delivered one envelope recipient at a time (an `EmailMessage` carries exactly one; the `Cc:`
header is only a label), and each recipient's outcome is a `fanout_log` row. Both sending
routes build through `build-mime.js`, archive what was sent to R2, and store it as a
`direction='out'` row before returning.

## Limits and non-goals

This is a shared mailbox for casual addresses — `support@`, `hello@`, `bookings@`, the address
on the contact page — not a mail client, and not a helpdesk.

* **Text-only compose.** You write plain text — there is no HTML editor and no attachment on
  send. A **reply** to a message that had an html part goes out as `multipart/alternative` so the
  quoted original survives looking like itself; your half of it is the same plain text in both
  parts. A reply to a text-only message, and any new message, stays `text/plain`.
* **Attachments are listed, not stored separately.** Filename, type and size go in the row;
  the bytes stay in the `.eml` in R2, downloadable whole.
* **No read/unread state, no flags, no labels, no folders.**
* **No search.** Messages page backwards by id and that is all.
* **No threading view.** `In-Reply-To` and `References` are stored and set correctly on
  outgoing mail, but nothing groups messages into conversations.
* **No multi-tenancy.** One Durable Object instance holds every mailbox and one `OWNERS` list
  governs the lot. Owners and members scope *visibility*, not storage; this is one operator's
  install, not a service with tenants.
* **No delete.** Deleting a mailbox removes its configuration; its messages and its archive
  stay. **Muting is not deleting either** — a muted message is stored, readable and
  downloadable; what stops is the fan-out.
* **Rules mute and nothing else.** No move, no tag, no auto-reply, no forward-to-one-person, and
  no regular expressions.

If you want folders, search and threading, you want a webmail, and there are good ones.

## Security notes

**The `send_email` binding has no `allowed_destination_addresses`.** It cannot: replying to a
shared mailbox means replying to whoever wrote in, and that address cannot be enumerated in
advance. The compensating controls are:

* the module graph (see *Architecture*, invariant 2) — the send-to-anyone capability lives in
  `compose.js`, which the `email()` path cannot reach;
* `env.SEND` is touched in exactly one module, `send.js`, so "who may send, as whom, to where"
  is a question about its two callers rather than a question about the whole codebase;
* both of those are asserted by tests, not merely documented.

**Authentication is on every route**, evaluated before the router looks at the path. A worker
that can send mail as any address in your zone has nothing safe to say to an anonymous caller.

**An unset `ADMIN_SECRET` authenticates nothing** — the bearer check bails on `!env.ADMIN_SECRET`
before comparing, so a forgotten secret cannot be matched by the literal string
`Bearer undefined`.

**An attacker holding the bearer token** can read every stored message and every archived
`.eml`, change the member lists, and send mail from any configured mailbox to anyone. Treat it
as a credential of the same weight as the domain itself: rotate it with `wrangler secret put`,
and do not put it in a browser.

**Header injection** is handled in `build-mime.js`: every value that reaches a header line has
its CR, LF and control characters removed first, so a subject of `x\r\nBcc: someone@example.com`
becomes one header whose value contains the text `Bcc:` and not a `Bcc` line. Every address is
validated, and an invalid one throws rather than being silently dropped.

**R2 keys are sanitised** (`archive.js`): a Message-ID is a string a stranger chose, so
everything outside `[A-Za-z0-9@._+-]` becomes `_` before it goes anywhere near a key.

**Stored HTML is never rendered as it arrived** — not in the reader, where three layers sit
between it and the operator's browser, and not inside a reply, where the recipient's mail client
is the renderer and there is no sandbox at all. **Remote images are never loaded without a
click.**

**Permissions are checked on the server, on every route**, and the structural tests assert that
each route asks. What the UI hides is a convenience, not a control.

See `SECURITY.md` for the full threat model.

## Tests

```
node --test test/*.test.mjs
```

No dependencies and no test runner to install — `node:test`, `node:assert` and nothing else.
The suite covers the body parser, the MIME builder, the loop guards, the R2 key shape, and the
structural wall around `compose.js`. See `TESTS.md` for what each file covers and what is not
covered.

## Status

Provided as-is. Fork freely. Issues and PRs welcome but not promised.

## License

MIT — see `LICENSE`.
