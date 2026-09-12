# Contributing to SubEtha

Rules for anyone — human or agent — changing this code. They are short because the project is
small, and they are strict because it sends mail as your domain.

**Read `DESIGN.md` before changing anything.** Several things that look like omissions are
decisions, and the rationale is written down next to them.

## The two invariants

Both are enforced by `test/structure.test.mjs`, not by review. If a change makes one of them
false, the tests fail, and that is the tests working.

1. **`email()` must never throw and must never reject.** No `setReject`, anywhere, under any
   condition. A reject is a bounce, bounce rate governs the account's sending quota, and a
   bounce tells the sender the address is broken. Every fallible step in the inbound path is
   already wrapped; keep it that way. A message that cannot be parsed is still archived, still
   stored, and still visible.
2. **`compose.js` must stay unreachable from `email()`.** `inbound.js` must not import it,
   directly or transitively. This is the compensating control for a `send_email` binding with
   no `allowed_destination_addresses`. Any change to `inbound.js`'s imports is a change to
   that binding's blast radius — treat it as a security change.

## Hard rules

* **No dependencies.** Not a runtime one, not a dev one, not a test runner. No `package.json`
  with a dependency list, no lockfile, no `node_modules`. `node:` built-ins and the Workers
  runtime only.
* **No build step.** The source in `src/` is the source that runs. No bundler, no transpiler,
  no framework, no JSX.
* **No external resource in the UI.** No font CDN, no script tag, no icon sprite, no
  stylesheet URL. Everything is inline. The Access login is the only thing between that page
  and every mailbox in the zone.
* **`env.SEND` is touched in `send.js` and nowhere else.** If you need to send from a new
  place, call `send.js` — do not reach for the binding. Asserted.
* **`cloudflare:` imports only where they are unavoidable** — `cloudflare:workers` in
  `mailbox-do.js`, `cloudflare:email` in `send.js`. Such an import makes a module untestable
  under Node, so keep logic worth asserting in a module that has none. Asserted.
* **The Durable Object does state and nothing else.** It never sends, never forwards, never
  waits on the network. Its thread is shared by every mailbox.
* **Every header value goes through `headerValue()` and every address through `validAddr()`.**
  Do not build a header line by concatenation.
* **Never log a message body, a subject, a secret, or a token.** See `SECURITY.md`.

## Tests

```
node --test test/*.test.mjs
```

**Must be 128/128 before you open a PR**, and a PR that changes behaviour adds tests. See
`TESTS.md` for what each file covers and what is deliberately not covered.

Note that `test/build-mime.test.mjs` contains a literal NUL byte in one fixture — it is meant
to be there, and it means `grep -r` skips that file as binary. Do not "fix" it.

## Scope

**The non-goals in `REQUIREMENTS.md` are non-goals, not a backlog.** No folders, no search, no
threading view, no read state, no rich compose, no attachment extraction, no multi-tenancy.
This is a shared mailbox for casual addresses, and staying under 2,000 lines with no
dependencies is the feature. A PR that adds one of those will be declined, however good it is
— fork instead, and enjoy it.

Bug fixes, portability fixes, clearer documentation, and tests for what is currently untested
are all welcome.

Two files, `src/mime.js` and `src/access.js`, are adapted from an earlier worker by the same
author. A fix in one wants the same fix in the other; keep them easy to diff.

## Style

* Match the surrounding code. It has a house style: whole-line comments, small pure modules,
  early returns, no classes where a function will do.
* **Comments explain *why*, not *what*.** The existing ones carry rationale that took real
  incidents to learn; do not delete one because the code "is obvious". If you disagree with a
  comment, argue with it in the PR rather than deleting it.
* Whole-line comments only — `test/structure.test.mjs` strips lines that start with `//`
  before matching, so a trailing comment mentioning `env.SEND` or `setReject` will break the
  structural assertions.
* No emoji in source, comments, or commit messages.

## Commit messages

Plain and descriptive. A short imperative subject line, a blank line, and the reasoning if the
change is not self-evident. No prefixes, no tags, no generated trailers, no emoji.

```
Anchor the Content-Disposition lookup

An unanchored match hits the ARC h= list, which contains the literal
text "content-disposition:", and every attachment was being missed.
```
