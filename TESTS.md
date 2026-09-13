# Tests

## Running them

```
node --test test/*.test.mjs
```

From the project root, with any Node that has `node:test` (18+). **No dependencies and nothing
to install** — `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url` and
nothing else. There is no test runner, no config file, and no build step.

Expected: **181 tests, 181 pass, 0 fail.**

Run one file while working on it:

```
node --test test/build-mime.test.mjs
```

## What each file covers

| file | tests | covers |
|---|---|---|
| `test/html-render.test.mjs` | 26 | the reader's HTML pass and the reply quote |
| `test/build-mime.test.mjs` | 25 | the RFC 5322 builder, and the send-mode copy's sender |
| `test/structure.test.mjs` | 21 | the structural invariants — read on |
| `test/ui.test.mjs` | 16 | the page's two client-side rules, and that the page uses them |
| `test/loop-guard.test.mjs` | 14 | both loop predicates, including the branches that must NOT fire |
| `test/fanout-status.test.mjs` | 13 | the delivery-error classifier and the member-row shaping |
| `test/parse-mail.test.mjs` | 13 | the body parser and the one text derivation |
| `test/rules.test.mjs` | 11 | mute-rule matching, and the same rule as SQL |
| `test/health.test.mjs` | 10 | the health document, `ok`, and the degraded sentences |
| `test/perm.test.mjs` | 10 | the permission predicate: owner, member, stranger, bearer |
| `test/archive.test.mjs` | 8 | the R2 key shape, its sanitising, and the config-snapshot prefix |
| `test/retention.test.mjs` | 8 | the purge period set, the cutoff, the selection predicate, the summaries |

**`ui.test.mjs`** — the page is a string, and almost all of it is only verified by the smoke
test. Two rules inside it are not, because getting either wrong is silent: `confirmsDelete()`,
which arms the mailbox delete, and `needsForwardWarning()`, which decides whether a member row
carries the note about unverified destination addresses. Both are exported from `ui.js` and
**interpolated into the client script as source**, so there is one copy and the suite asserts the
text the browser runs; the last three tests exist to keep that true — that both functions reach
the page, that the delete path asks `confirmsDelete()` again on the click rather than trusting the
disabled attribute and never reaches a `window.confirm`, and that the delete button sits inside
the block `applyRole()` hides from a member.

One of these encodes a decision rather than a fact. A `skip` is recorded in `fanout_log` as
`ok=1` although nothing was sent, so the rule is `last.ok && last.mode !== "skip"`: only a real
delivery clears the warning, and a member whose only fan-out row is a skip keeps it. This matches
the member row, which never draws a skip as "delivered". The test names the decision.

**`build-mime.test.mjs`** — two of these are security tests and the rest correctness. Header
injection through the Subject and through the display name is neutralised; an invalid address
is refused rather than silently dropped; `validAddr` is deliberately strict; RFC 2047 encoding
of non-ASCII subjects and display names round-trips; threading headers; `Re:` added once;
header folding; the body surviving intact including non-ASCII; `multipart/alternative` when
HTML is present, **and a reply in that shape keeping its threading headers**; an empty or absent
html alternative leaving the message `text/plain`; extra headers name-sanitised and
CRLF-stripped; `msgIds`, `addrOf`, `headerValue`, `attribution` and the quote block.

It also covers **the send-mode copy's sender** — the display name (`"Alice via Support"`, the
local part when the original carried no name, and the mailbox's name alone when there is
nothing to say about the sender), a non-ASCII sender name surviving as one encoded-word run
that decodes back, a CRLF in that name being unable to write a header, a 400-character name
being cut without ever cutting the mailbox's half, and the attribution line sitting above the
body in **both** alternatives with the original markup unchanged underneath it.

**`fanout-status.test.mjs`** — the classifier that turns a fan-out error into a sentence an
owner acts on. Cloudflare's own wording for the failure that matters (`destination address not
verified`) and the loose variants around it; the forward-mode hint naming Email Routing and the
send-mode one naming the binding instead; quota and rate-limit wording; a 5xx as permanent and a
4xx, a timeout or a socket error as transient; an error that says nothing classified as
`unknown` rather than guessed at; and every kind carrying exactly one short sentence. Then the
shaping: **a member nothing has been sent to yet has no status at all** and must not draw as
broken, a delivered member carrying the time and no hint, a failed one carrying the raw error
*and* the classification, a `skip` never reading as a delivery, matching by lowercased address,
and the raw status array not going out on the wire.

**`rules.test.mjs`** — mute-rule matching, where the failure to design against is a rule that
matches MORE than the person who typed it expected. `from` as the whole address; **`from_domain`
as an exact domain, with `mail.example.com` and `notexample.com` both asserted NOT to match**;
`subject` and `list_id` as contains, either case; a rule with no pattern or an unknown field
matching nothing at all; `firstMatch` returning the oldest match so `hits` add up; what the
owner typed being reduced (`"Alice" <A@B.com>` → the address, `@example.com` → the domain);
a rule that could never match refused at the door. Then the same rule as SQL: exactly one bound
placeholder and the value never in the statement, `%` and `_` in a pattern escaped so they match
themselves with `ESCAPE` declared, and the `instr(from_addr,'@') > 0` guard without which a
malformed sender equal to the domain would match a domain rule.

Note: this file contains a **literal NUL byte** in one fixture (`headerValue("a\0b")` must
return `"ab"`). That is deliberate and must not be "cleaned up" — but it does mean `grep -r`
treats the whole file as binary and silently skips it. Search it with a tool that reads UTF-8
explicitly.

**`html-render.test.mjs`** — two of these are security tests and the rest correctness.
`inlineParts` finding what a `cid:` reference can point at; a `cid:` image inlined as a `data:`
URI with the angle brackets stripped and the case ignored; `Content-Location` and filename as
the fallback; a `cid:` that matches nothing left exactly as it was; the **2 MB per-image and
6 MB total caps** leaving an over-cap `src` unresolved, and the same `cid:` twice costing the
budget once; `url(cid:)` in CSS; **a remote image never loaded** — parked in `data-remote-src`
behind a placeholder, counted, `srcset` dropped so it cannot override the placeholder, and the
reader's two string replacements restoring it exactly; http, https and protocol-relative all
counting as remote; **the sanitiser fixture** — script (terminated and not), `on*=` handlers,
iframe, object, embed, form, base, `meta http-equiv`, `javascript:` and `vbscript:` including an
entity-obfuscated one — with the message's own text, ordinary attributes, `<meta charset>` and
`<style>` surviving; and the reply quote: its structure, the author's text escaped, **`cid:`
images removed rather than inlined**, remote images left as the original had them, a `<style>`
block dropped from the quote though the reader keeps it, and the sanitiser applied inside the
blockquote because there is no sandbox in a mail client.

**`perm.test.mjs`** — `parseOwners` normalisation; an owner by any case; the bearer as
owner-equivalent and `"bearer"` never matching a member list as if it were an address; a member
seeing its own mailboxes and no others and administering nothing; a stranger and a service-token
`"access"` identity seeing nothing; an empty identity never being anybody; an unconfigured
mailbox (`config()` → `null`) visible only to an owner; either member mode counting; **Gmail
dots and `+tags` deliberately not normalised**; and `visibleMailboxes` filtering.

**`parse-mail.test.mjs`** — non-multipart `text/plain`; `multipart/alternative` keeping both
parts and not listing the container as an attachment; `multipart/mixed` **listing** the
attachment rather than decoding it into the row; an HTML-only message still yielding text so a
reply has something to quote; a malformed message losing its body and never the caller. It also
covers the **one text derivation**, `stripHtml`, which has two readers — the stored text of an
html-only message and the original quoted inside a plain-text reply: a link keeping its target as
`text (url)` and not repeating itself when the text already IS the url, a link with nothing
actionable (`#`, `cid:`, `javascript:`) keeping only its text, **images contributing nothing at
all** — no alt, no base64, no placeholder — and the end of a block being ONE newline and never
two, because Gmail wraps each individual line in a `<div>`.

The ARC test is still the important one: it carries an ARC-Message-Signature whose `h=` field
literally contains the text `content-type:content-transfer-encoding:`, which is the shape that
makes an *unanchored* header lookup return garbage and silently eat the body. If someone
"tidies" the anchored regexes in `mime.js`, this is the test that says so.

**`loop-guard.test.mjs`** — `Auto-Submitted` (and that `no` means a person sent it),
`Precedence` (bulk/junk/list and nothing else), `X-Subetha-Hop` outranking everything, an
ordinary message not being suppressed, a plain object read as happily as a `Headers`, and
**`List-Id` deliberately not being a guard** — asserted so the omission reads as a decision.
Then the two pre-RFC spellings: `X-Autoreply` and `X-Autorespond` suppressing on **any** value,
an empty value reading as absent exactly as `X-Subetha-Hop` does, and `Auto-Submitted` being named
before them when a message carries both. Then the test that pins the design — **"do not auto-reply
to me" is NOT "do not forward me"**: `X-Auto-Response-Suppress` does **not** suppress (Exchange puts
it on ordinary notification mail), and neither does any of the eight machine local parts
(`mailer-daemon@`, `no-reply@`, `bounces@`, … including the bracketed and
`MAILER-DAEMON@mx… (Mail Delivery System)` shapes), because that is exactly the mail a shared
address exists to receive and forwarding it to a person cannot loop. Both were implemented and
removed, so they are asserted as omissions rather than left as gaps — alongside a bounce that
*does* mark itself still being stopped, by its mark rather than by its address. Finally, a send-mode
fan-out copy's own headers fed back through the guard, so the loop is asserted closed from both
ends: `X-Subetha-Hop` alone stops it, and `Auto-Submitted: auto-replied` alone stops it too.
Member level: self, case-insensitivity, routed domains from a parsed set and from the raw var,
the empty member, and `parseDomains` normalisation.

**`archive.test.mjs`** — the `mailbox/YYYY/MM/message-id.eml` shape, zero-padded months in
UTC, path traversal and other surprises in a Message-ID being neutralised, a message with no
usable Message-ID still getting a unique key, an absurdly long Message-ID truncated rather than
rejected, and `keySafe` keeping exactly what an address needs. Then the config snapshot's corner of
the same bucket: `configKey` dated in UTC (a snapshot taken late on the 31st is named for the 31st
wherever the operator is), `latest.json` stable, and **no mailbox key able to land under the
`_config/` prefix** — `_config`, `_config@example.com`, `_config/2026-09-12.json` and `../_config`
all asserted, because sharing the bucket is only safe while that prefix is exclusive.

**`health.test.mjs`** — the contract, field by field and in order, because another system is built
against it: the exact document, the exact key list, and `fanout_failure_members` (which carries
member addresses) **not** being in it. Then the judgement: **quiet is not degraded** — no inbound,
no outbound, an empty install, all `ok: true` with `last_inbound_at: null` rather than `0`; an
unconfigured message and a muted message being a to-do and a decision rather than failures; `ok:
false` for a fan-out failure and for an archive failure, with the exact degraded sentences and their
singular and plural forms; both at once listing both, fan-out first; the fan-out line naming how
many members and which distinct kinds, each once, in the order the DO returned them, and **never an
address**; a failure count with no member rows still saying so, because the count is the authority;
and nothing in the document ever being `undefined`, whatever the DO left out.

**`retention.test.mjs`** — the one thing in SubEtha that deletes mail, so every test is a way it
could take more than the owner meant. The periods as a fixed set with `0`, `1`, `7`, `45`, `364`,
`-30`, `30.5`, `Infinity` and `NaN` all refused rather than rounded; a period from a form arriving as
a string and still having to be one of the five, while `[30]`, `{valueOf: () => 30}` and `true` —
all of which `Number()` says `30` to — are refused; **retention absent meaning keep forever**, which
is the safe direction on a route that posts the whole configuration; the cutoff arithmetic; and the
selection predicate itself — the constant the DO interpolates, asserted to bind both values, to be
strictly `<` so a message on the boundary is kept, to name no direction, and to ask about age and
nothing else. Then the shaping: what a purge did counted from the rows that actually went, a row
whose R2 delete failed being absent from that list and present in `r2_failed`, a row with no stored
size counting as a row and not as `NaN`, and a dry run carrying `dry_run: true` while a real purge
does not.

## The structural invariants

`test/structure.test.mjs` does not exercise behaviour. It **reads the source** and asserts
properties of the module graph, which is how the two design invariants are enforced rather than
merely documented. Whole-line comments are stripped before matching, so the assertions are
about code and not about the prose that discusses it.

1. **`compose.js` is NOT reachable from the email() path** — the import graph is walked from
   `inbound.js`; `compose.js` must not appear, directly or transitively.
2. **`email()` calls `handleInbound` and nothing else** — and names none of
   `replyToMessage`, `composeNew`, `sendRaw`, `env.SEND`. Also: **`setReject` appears in no
   source file at all.**
3. **`compose.js` is imported by `index.js` and by nothing else.**
4. **`env.SEND` is touched in exactly one module** — `send.js`.
5. **`cloudflare:` built-ins are imported only where they must be** — `cloudflare:workers` in
   `mailbox-do.js`, `cloudflare:email` in `send.js`, nowhere else; anything else would make a
   module untestable under Node.
6. **Every route sits behind the auth check** — nothing returns a `Response` above the gate in
   `route()`.
7. **An unset `ADMIN_SECRET` cannot authenticate anything** — the `!env.ADMIN_SECRET` guard
   must be present.

And, since the permission model is only as good as the routes that ask it:

8. **Every mutating mailbox route checks the admin permission before it mutates** —
   `stub.upsertMailbox` and `stub.deleteMailbox` each have exactly one call site, and
   `canAdmin(identity, owners)` appears between the route's branch and it.
9. **Every non-mutating mailbox route checks the view permission** — `mayView(...)` between the
   branch and `stub.messages` / `composeNew`.
10. **The message routes resolve the row and ask about ITS mailbox first** — nothing (`GET`,
    the raw download, the reply) is reached above `mayView(stub, identity, owners, m.mailbox)`.
11. **The mailbox list is filtered by identity, never handed over whole** — `stub.mailboxes()`
    may not reach a caller except through `visibleMailboxes`.
12. **A reply carries an html alternative only when the original had one** — and `composeNew`
    names no html at all. Also: exactly two modules call `buildMime({…})`, so the html
    alternative reused the builder instead of growing a second one.
13. **The reader never shows a message without the empty sandbox and the CSP** — both branches
    of the srcdoc assignment, the stored html never going in unrendered, and exactly one thing
    in `ui.js` able to set `loadRemote = true`.
14. **Muting is administration** — `stub.addRule`, `stub.deleteRule` and `stub.setHidden` each
    have exactly one call site with `canAdmin(identity, owners)` above it, because a mute stops
    the fan-out for every member of the mailbox and hiding a message hides it from everybody;
    and `stub.rules` sits behind the view check, because a member who cannot see the rules is a
    member wondering where the mail went.

And the four added with the health check, the snapshot and retention:

15. **`compose.js` is not reachable from `scheduled()` either** — the import graph is walked from
    `scheduled.js`; neither `compose.js` nor `send.js` may appear. A cron fires with nobody behind
    it and nothing having checked a JWT, so it sits behind the same wall `email()` does. Plus:
    `scheduled()` hands off to `runScheduled` and names none of the send path, and it is wrapped in
    a `try`.
16. **Deleting mail is owner-only and there is exactly one thing that deletes it** —
    `purgeOlderThan(env, stub` has one call site with `canAdmin` above it and takes its period
    through `purgeDays(...)`; `DELETE FROM messages` has exactly **one** call site in
    `mailbox-do.js`; and inside `purgeRows` the `fanout_log` delete comes before the `messages`
    delete, because a fan-out row whose message is gone is an orphan nothing can explain.
17. **The health route is not special-cased** — it is matched below the auth gate, it answers on the
    same line it is matched on (so there is no permission branch to drift), `stub.health()` has one
    call site, and `shapeHealth(await stub.health())` appears exactly once, so `ok`/`degraded` is
    derived in one place. The export route, by contrast, **is** guarded: `canAdmin` between its
    branch and `stub.exportConfig()`, whose only two callers are `index.js` and `scheduled.js` — one
    document, so the file in the bucket and the file behind the route cannot drift — and its DO
    method names no message column.
18. **The migration is additive, PRAGMA-guarded and inside `blockConcurrencyWhile`** — exactly one
    `ALTER TABLE` in the file, inside the concurrency block, guarded by `if (!have.has(name))` off a
    `PRAGMA table_info(${table})` read; no `DROP COLUMN`, `DROP TABLE`, `RENAME TO` or
    `RENAME COLUMN` anywhere; every migrated column (`list_id`, `hidden`, `muted_by`,
    `retention_days`) present in **both** the `CREATE TABLE` and the migration list, so a new object
    and an existing one converge; and `retention_days` declared with no default, because a default
    would start deleting mail on deploy.

Also structural, and about mail rather than modules:

19. **A send-mode fan-out copy is marked machine-generated and a human's reply is not** —
    `Auto-Submitted: auto-replied` appears in `inbound.js` beside the hop header on the built copy,
    and the string appears nowhere in `compose.js`.

If you change the module layout, these are the tests that will fail first, and they are
supposed to.

## What is NOT covered

Be honest about the shape of the hole:

* **`email()` is never executed.** There is no Workers runtime in the suite, no
  `ForwardableEmailMessage`, no `message.forward()`. The inbound path is verified
  *structurally* (invariants above) and *by parts* (the parser, the builder, the guards, the
  key shape are each pure and tested directly), never end to end.
* **The Durable Object is never instantiated.** No SQLite, no `blockConcurrencyWhile`, no RPC.
  The schema and the queries in `mailbox-do.js` are unverified by tests — including the
  **migration** (the `PRAGMA table_info` guards and the `ALTER TABLE ADD COLUMN`s), the
  `memberStatus` join, the retroactive `UPDATE` that a new rule runs, the nine aggregates in
  `health()`, the `exportConfig()` projection, the storage sub-selects, and the three purge
  statements. What *can* be tested of those is: the predicates they interpolate (`sqlPredicate` in
  `rules.test.mjs`, `PURGE_WHERE` in `retention.test.mjs`), the shaping of what they return
  (`fanout-status.test.mjs`, `health.test.mjs`, `retention.test.mjs`), and their **structure** —
  `structure.test.mjs` reads the file and asserts the migration's shape and that exactly one
  statement deletes a message. The statements themselves are held by review and by the smoke test
  below.
* **`scheduled()` is never executed.** There is no cron in the suite, no `ScheduledEvent`, and no
  R2, so neither the snapshot write nor the retention sweep runs. What is verified is structural
  (the import graph, the hand-off, the wrapping) and by parts (`configKey`, the period set, the
  cutoff, the predicate, the summaries). The order R2 and the rows are deleted in — the one thing
  that decides whether a failure leaves an orphan — is asserted only as the order of two statements
  in `purgeRows` and by reading `purge.js`.
* **No purge against a real bucket.** `env.MAIL.delete` is never called, so the `r2_failed` path is
  exercised by reading it and by the smoke test, not by a test.
* **No R2.** `archive()` itself is not exercised; only the pure `r2Key`/`keySafe` are.
* **No Access verification.** `access.js` is not tested — no JWT fixtures, no key fetch.
* **No HTTP routing.** `route()` is read by `structure.test.mjs` but never called; status
  codes, body validation and error mapping are untested.
* **No UI behaviour.** `ui.js` and `theme.js` produce a string; `structure.test.mjs` asserts a
  few properties of that string (the sandbox, the CSP, the remote-image flag) and `ui.test.mjs`
  asserts the two rules it exports, but nothing runs it in a browser. There is no DOM in the
  suite, so the wiring around those rules — that the note is appended under the right row, that
  the input enables the button, that `applyRole()` actually hides the block it is told to — is
  read, not executed. The member-status cell, the mute chooser and the rules table are drawn by
  that client script and are exercised only by the smoke test.
* **No `compose.js` behaviour.** Only its position in the import graph and, structurally, that
  it passes an html alternative exactly when the original had one. It imports `send.js`, which
  imports `cloudflare:email`, so it cannot be loaded under Node at all — which is why
  `quoteHtml` lives in the pure `html-render.js` and is tested directly.
* **No `withRenderedHtml`.** The R2 read and the `render_note` fallbacks in `index.js` are
  unexercised; `inlineParts` and `renderHtml`, which do the work, are tested exhaustively.

Adding `vitest` + `@cloudflare/vitest-pool-workers` would close most of this. It would also add
a dependency and a build step, which is a non-goal (see `REQUIREMENTS.md`). The trade is
deliberate: everything that can be made pure is pure and tested exhaustively, everything else
is held by structure.

## Smoke test after a deploy

The parts the suite cannot reach are the parts to check by hand, once, after the first deploy
and after any change to the inbound path.

1. **Configure a mailbox.** Open the UI (Access should challenge you; if it does not, stop and
   check the policy is Allow and not Bypass). Click **New mailbox…**, enter an address that has
   an Email Routing rule pointing at the worker, add **yourself as the only member**, pick a
   mode, and Save.
2. **Send a real message to it** from an outside address (a personal account, not one on a
   routed domain).
3. **Check the stored copy.** It should appear in the message list within seconds, with the
   right subject and sender. Open it: the body renders, headers look right, attachments are
   listed. Click **Download raw** and confirm the `.eml` comes back from R2.
   * Send one **from Outlook or Apple Mail with a signature logo**, and confirm the message
     opens on the HTML view with the logo showing. A broken-image icon means the `cid:` did not
     resolve — check `render_note` and that `r2_key` is set.
   * Send one from a marketing tool or a newsletter and confirm the images do **not** load until
     you click **Load N remote images**, and that they are blocked again when you reopen it.
4. **Check the fan-out.** The row should show `fan-out 1/1`, and the message should have
   arrived in your own inbox. In `forward` mode it appears from the original sender; in `send`
   mode it appears from the mailbox, as **`"<sender> via <mailbox name>"`**, with `Reply-To` the
   original sender and one attribution line above the body.
   * **Check the member row.** It should now say `✓ delivered just now`, with a green left edge.
     Add a **second member in `forward` mode whose address is NOT a verified destination**, send
     another message, and confirm that member's row turns red with `⚠ This address is not a
     verified destination…`, that the raw error is in its tooltip, and that the first member
     still received their copy. That is the whole point of the status: the failure is per
     member and it used to be silent.
5. **Reply from the UI.** Type a reply, send it. Confirm it arrives at the original sender,
   that the `From` is the mailbox, that the original is quoted underneath, and that a
   `direction=out` row now exists with your identity in `sent by`, badged **`sent 1/1`** rather
   than `fan-out 1/1`. Reply to the **formatted** message too: the copy that arrives should be
   `multipart/alternative`, the quote should look like the original rather than flattened, and
   it should carry no inline images.
6. **Compose from the UI.** New message from the mailbox to yourself; confirm delivery and the
   stored outgoing row.
7. **Check the loop guards did not fire wrongly** — a normal message must show a real fan-out,
   not `skip`.
8. **Mute something, and check it stayed.** Open a stored message and click **Mute…**. Take the
   subject option, shorten the pattern to a word or two, and confirm the toast says how many
   existing messages it hid; the row should vanish from the list, come back under **show muted**
   with a `muted · rule #n` badge, and the rule should appear under the members editor with a
   hit count. Then send **another** message that matches and confirm three things: it is stored,
   it is muted, and **nothing arrived in your own inbox** — the mute happens in the Durable
   Object before the fan-out, not in the UI. Open it and click **Unhide**: it returns to the
   default list and its `muted_by` clears, while the rule stays in force for the next one.
   Finally **remove** the rule and confirm the messages it muted stay muted — un-hiding is per
   message, on purpose. Sign in as a member (step 9) and confirm the rules list is visible and
   has no **remove** button, and that `POST /api/mailboxes/<box>/rules` by hand is `403`.
9. **Check the permission model with a second identity.** Add a colleague (or a second Access
   identity of your own) to one mailbox's member list and nothing else, then sign in as them:
   the mailbox selector should show that mailbox and no other, there should be no **New
   mailbox…**, **Save**, **Delete mailbox** or **+ member**, the display name and member rows
   should be read-only, and they should still be able to open, reply and compose. Then try
   `GET /api/mailboxes/<another-mailbox>/messages` by hand and confirm it is `403`. Sign in as
   somebody on no list at all and confirm the page loads, says so, and 403s everything else.
10. **Check the health route.** `curl -H "Authorization: Bearer $ADMIN_SECRET" https://<host>/api/health`
    — it should answer `ok: true` with `inbound_24h` matching what you have just sent and
    `degraded: []`. Then ask for it with **no** credential at all and confirm it is `401`: there is
    no unauthenticated route here and a health check is the one somebody eventually opens up. Sign
    in as the member from step 9 and confirm they get the same document rather than a 403.
    * With the unverified `forward` member from step 4 still failing, send one more message and
      confirm `ok` turns **false** with `fanout_failures_24h` and a `degraded` line naming the count
      and the kind — and that the line contains no address.
11. **Check the export and the snapshot.** `GET /api/export` as the owner should return every
    mailbox with its members and rules and **no messages**; as the member from step 9 it must be
    `403`. Then either wait for 03:17 UTC or run the trigger by hand
    (`wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled"`), and confirm
    `_config/latest.json` and `_config/<today>.json` exist in the bucket with the same document, and
    that no mailbox's keys have landed under `_config/`.
12. **Check storage and retention, on a mailbox you do not mind emptying.** The owner panel should
    show `N messages · X MB · oldest <date>`; a member should see none of that row. Press **Delete
    older than…**, pick a period, and confirm the confirm states a count that matches what you
    expect — cancel it once, and confirm nothing was deleted. Then run it for real and confirm the
    answer's `deleted`/`bytes`, that the rows are gone from the list, and that
    `GET /api/messages/<id>/raw` for one of them is now `404` (the R2 object went too). Finally set
    **Retention** to a period, save, reload, and confirm it comes back selected — then that the
    daily run logs `stage: "retention"` with the counts it removed.
    * Try `POST …/purge {"older_than_days": 45}` by hand and confirm `400`; try it as the member
      from step 9 and confirm `403`.
13. Only now add the other members.

If step 3 works but step 4 does not, the problem is sending, not receiving — check that the
destination is a verified destination address (for `forward`) or that the zone is onboarded to
Email Sending (for `send`). Nothing is lost either way: the message is stored, and the failure
is on the row.
