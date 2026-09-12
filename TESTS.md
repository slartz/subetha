# Tests

## Running them

```
node --test test/*.test.mjs
```

From the project root, with any Node that has `node:test` (18+). **No dependencies and nothing
to install** — `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url` and
nothing else. There is no test runner, no config file, and no build step.

Expected: **45 tests, 45 pass, 0 fail.**

Run one file while working on it:

```
node --test test/build-mime.test.mjs
```

## What each file covers

| file | tests | covers |
|---|---|---|
| `test/build-mime.test.mjs` | 16 | the RFC 5322 builder |
| `test/parse-mail.test.mjs` | 6 | the body parser, on the shapes that actually arrive |
| `test/loop-guard.test.mjs` | 10 | both loop predicates, including the branches that must NOT fire |
| `test/archive.test.mjs` | 6 | the R2 key shape and its sanitising |
| `test/structure.test.mjs` | 7 | the structural invariants — read on |

**`build-mime.test.mjs`** — two of these are security tests and the rest correctness. Header
injection through the Subject and through the display name is neutralised; an invalid address
is refused rather than silently dropped; `validAddr` is deliberately strict; RFC 2047 encoding
of non-ASCII subjects and display names round-trips; threading headers; `Re:` added once;
header folding; the body surviving intact including non-ASCII; `multipart/alternative` when
HTML is present; extra headers name-sanitised and CRLF-stripped; `msgIds`, `addrOf`,
`headerValue`, and the quote block.

Note: this file contains a **literal NUL byte** in one fixture (`headerValue("a\0b")` must
return `"ab"`). That is deliberate and must not be "cleaned up" — but it does mean `grep -r`
treats the whole file as binary and silently skips it. Search it with a tool that reads UTF-8
explicitly.

**`parse-mail.test.mjs`** — non-multipart `text/plain`; `multipart/alternative` keeping both
parts and not listing the container as an attachment; `multipart/mixed` **listing** the
attachment rather than decoding it into the row; an HTML-only message still yielding text so a
reply has something to quote; a malformed message losing its body and never the caller. The
fourth test is the important one: it carries an ARC-Message-Signature whose `h=` field
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

If you change the module layout, these are the tests that will fail first, and they are
supposed to.

## What is NOT covered

Be honest about the shape of the hole:

* **`email()` is never executed.** There is no Workers runtime in the suite, no
  `ForwardableEmailMessage`, no `message.forward()`. The inbound path is verified
  *structurally* (invariants above) and *by parts* (the parser, the builder, the guards, the
  key shape are each pure and tested directly), never end to end.
* **The Durable Object is never instantiated.** No SQLite, no `blockConcurrencyWhile`, no RPC.
  The schema and the queries in `mailbox-do.js` are unverified by tests.
* **No R2.** `archive()` itself is not exercised; only the pure `r2Key`/`keySafe` are.
* **No Access verification.** `access.js` is not tested — no JWT fixtures, no key fetch.
* **No HTTP routing.** `route()` is read by `structure.test.mjs` but never called; status
  codes, body validation and error mapping are untested.
* **No UI.** `ui.js` and `theme.js` produce a string that nothing asserts on.
* **No `compose.js` behaviour.** Only its position in the import graph.

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
4. **Check the fan-out.** The row should show `fan-out 1/1`, and the message should have
   arrived in your own inbox. In `forward` mode it appears from the original sender; in `send`
   mode it appears from the mailbox with `Reply-To` the original sender.
5. **Reply from the UI.** Type a reply, send it. Confirm it arrives at the original sender,
   that the `From` is the mailbox, that the original is quoted underneath, and that a
   `direction=out` row now exists with your identity in `sent by`.
6. **Compose from the UI.** New message from the mailbox to yourself; confirm delivery and the
   stored outgoing row.
7. **Check the loop guards did not fire wrongly** — a normal message must show a real fan-out,
   not `skip`.
8. Only now add the other members.

If step 3 works but step 4 does not, the problem is sending, not receiving — check that the
destination is a verified destination address (for `forward`) or that the zone is onboarded to
Email Sending (for `send`). Nothing is lost either way: the message is stored, and the failure
is on the row.
