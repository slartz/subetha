# Tests

## Running them

```
node --test test/*.test.mjs
```

From the project root, with any Node that has `node:test` (18+). **No dependencies and nothing
to install** — `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url` and
nothing else. There is no test runner, no config file, and no build step.

Expected: **128 tests, 128 pass, 0 fail.**

Run one file while working on it:

```
node --test test/build-mime.test.mjs
```

## What each file covers

| file | tests | covers |
|---|---|---|
| `test/build-mime.test.mjs` | 25 | the RFC 5322 builder, and the send-mode copy's sender |
| `test/html-render.test.mjs` | 26 | the reader's HTML pass and the reply quote |
| `test/fanout-status.test.mjs` | 13 | the delivery-error classifier and the member-row shaping |
| `test/parse-mail.test.mjs` | 13 | the body parser and the one text derivation |
| `test/rules.test.mjs` | 11 | mute-rule matching, and the same rule as SQL |
| `test/loop-guard.test.mjs` | 10 | both loop predicates, including the branches that must NOT fire |
| `test/perm.test.mjs` | 10 | the permission predicate: owner, member, stranger, bearer |
| `test/archive.test.mjs` | 6 | the R2 key shape and its sanitising |
| `test/structure.test.mjs` | 14 | the structural invariants — read on |

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
Member level: self, case-insensitivity, routed domains from a parsed set and from the raw var,
the empty member, and `parseDomains` normalisation.

**`archive.test.mjs`** — the `mailbox/YYYY/MM/message-id.eml` shape, zero-padded months in
UTC, path traversal and other surprises in a Message-ID being neutralised, a message with no
usable Message-ID still getting a unique key, an absurdly long Message-ID truncated rather than
rejected, and `keySafe` keeping exactly what an address needs.

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
  **migration** (the `PRAGMA table_info` guard and the three `ALTER TABLE ADD COLUMN`s), the
  `memberStatus` join, and the retroactive `UPDATE` that a new rule runs. What *can* be tested
  of those is: the predicate the UPDATE interpolates (`sqlPredicate`, in `rules.test.mjs`) and
  the shaping of what the queries return (`fanout-status.test.mjs`). The statements themselves
  are held by review and by the smoke test below.
* **No R2.** `archive()` itself is not exercised; only the pure `r2Key`/`keySafe` are.
* **No Access verification.** `access.js` is not tested — no JWT fixtures, no key fetch.
* **No HTTP routing.** `route()` is read by `structure.test.mjs` but never called; status
  codes, body validation and error mapping are untested.
* **No UI behaviour.** `ui.js` and `theme.js` produce a string; `structure.test.mjs` asserts a
  few properties of that string (the sandbox, the CSP, the remote-image flag) but nothing runs
  it in a browser. The member-status cell, the mute chooser and the rules table are drawn by
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
10. Only now add the other members.

If step 3 works but step 4 does not, the problem is sending, not receiving — check that the
destination is a verified destination address (for `forward`) or that the zone is onboarded to
Email Sending (for `send`). Nothing is lost either way: the message is stored, and the failure
is on the row.
