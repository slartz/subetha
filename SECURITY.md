# Security

## What this worker is, from an attacker's point of view

A program that can **send mail as any address in your zone, to anyone**, and that holds a
readable copy of everything those addresses have ever received. That is the whole threat model
in one sentence, and every control below exists because of it.

## Threat model

| threat | control |
|---|---|
| Inbound mail reaching the send-to-anyone code path | The import-graph wall: `compose.js` is not reachable from `inbound.js`. Asserted by `test/structure.test.mjs`. |
| A second place learning to send | `env.SEND` is touched in exactly one module, `send.js`. Asserted. |
| Unauthenticated access to any route | Auth gate runs before any routing decision; no exception, not even a health check. Asserted. |
| A forgotten `ADMIN_SECRET` matching `Bearer undefined` | The bearer check returns false on `!env.ADMIN_SECRET` before comparing. Asserted. |
| A valid Access JWT for a *different* app on the same team | `aud` is pinned to `ACCESS_AUD`, which is **required** — no unset escape hatch. |
| The window between deploy and the Access app existing | The shipped `ACCESS_AUD` placeholder matches no JWT, so the worker is closed until an operator pastes the real one in. Fails closed toward "costs you a login". |
| Header injection through a subject, a name, or a Cc | `build-mime.js` strips CR, LF and control characters from every header value, and validates every address. |
| Path traversal or key collision via a hostile Message-ID | `archive.js` `keySafe()` — angle brackets stripped, everything outside `[A-Za-z0-9@._+-]` replaced with `_`. |
| A mail loop burning the sending quota | Two independent guards (`loop-guard.js`), plus a refusal to reply to the mailbox's own address. |
| A bounce storm damaging the account's sending reputation | `email()` never throws and never calls `setReject`. Asserted. |
| Hostile HTML in a stored message running in the operator's browser | Three layers: an iframe with an **empty** `sandbox` attribute (no scripts, no same-origin, no forms, no navigation); a CSP meta at the top of the srcdoc (`default-src 'none'`); and a server-side sanitiser that strips `<script>`, `on*=`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<meta http-equiv>` and `javascript:`/`vbscript:` URLs. |
| Hostile HTML reaching a **recipient's** mail client inside a reply quote | The same sanitiser, plus `<style>` blocks dropped (document-wide CSS from the original would restyle the reply written above it) and `cid:` images removed. There is no sandbox out there — the recipient's client is the renderer — which is why the sanitiser exists at all rather than being left to the iframe. |
| A remote image in mail acting as a read receipt | Every `http(s)` `<img src>` is rewritten to `data-remote-src` with a transparent placeholder before the row leaves the worker, and the CSP is `img-src data:`. Loading them is one explicit click, per message, and reopening the message blocks them again. |
| A `cid:` image tempting someone to add a fetch route for MIME parts | Parts are inlined as `data:` URIs server-side instead. The sandboxed iframe has an **opaque origin**, so a subresource request from it would not carry the `CF_Authorization` cookie and would 401 — such a route would have to weaken the sandbox to work. |
| A huge inline image turning one message read into a memory event | 2 MB per image and 6 MB per message. Over either cap the `src` is left as the unresolved `cid:`; over the 20 MB parse cap the archive is not read at all. |
| One mailbox's member reading another mailbox | `perm.js`, enforced server-side on every route. See *Owners and members*. |
| A third-party script or font on the admin page | The UI loads **no external resource of any kind**. Everything is inline. |
| Memory exhaustion from a huge message | Over 20 MB the raw message is streamed straight to R2 and never held in the isolate; the body is not parsed. |

## The unrestricted send binding

`wrangler.jsonc` declares `send_email` with **no** `allowed_destination_addresses`. This is
deliberate and it is the single most sensitive fact about the project: replying to a shared
mailbox means replying to whoever wrote in, and that address cannot be enumerated in advance.

Because the binding cannot be constrained, the constraint is structural:

1. `compose.js` — the only module that sends to a **caller-chosen** address — is reachable from
   exactly two routes, both behind the auth gate.
2. `inbound.js`, the whole `email()` path, does not import `compose.js` directly or
   transitively, so the capability is not reachable from mail that arrives.
3. The fan-out in `inbound.js` does send, but only to an address the **owner** put on the
   member list, never to one that arrived in the message.
4. All of that is asserted by `test/structure.test.mjs` on every run, so the day someone adds a
   convenient import the tests say so rather than the spam.

**Any change to `inbound.js`'s imports is a change to this binding's blast radius.** Review
such a change as a security change.

## Owners and members

Authentication answers *whether*. `perm.js` answers *who*, immediately below the auth gate and
before any route runs.

* **Owner** — an address in the `OWNERS` var, or the `ADMIN_SECRET` bearer. Sees every mailbox;
  creates, edits and deletes them.
* **Member** — an address on some mailbox's member list, in either mode. Sees **that** mailbox:
  reads it, downloads its raw `.eml`, replies and composes from it. May not change any
  configuration and may not see a mailbox it is not on.
* **Neither** — 403 from every route that names a mailbox or a message. `GET /`,
  `GET /api/me` and `GET /api/mailboxes` still answer, with an empty list, so a mistyped
  bookmark gets "you are on no mailbox" rather than a bare error.

Three things about this are load-bearing:

1. **It is enforced on the server, on every route.** The UI hides what a member cannot use, and
   that is presentation only — a hidden button is not a permission. `test/structure.test.mjs`
   asserts that every mutating mailbox route calls the admin check and that every route naming a
   mailbox or a message calls the view check.
2. **Comparison is lowercase and otherwise literal.** Gmail dots and `+tags` are deliberately
   **not** normalised: two different strings are two different identities, and an
   address-equivalence rule that is right for one provider is wrong for the next. Being wrong
   here hands over a mailbox.
3. **An unconfigured mailbox has no members, so only an owner sees it.** Mail that arrived at an
   address nobody has claimed is the operator's problem, not a stranger's.

A member is trusted with the `send_email` binding for their own mailbox: they can reply and
compose as it, to anyone. That is the point of a shared mailbox, and it is why the member list is
an owner-only field. **Adding a member is granting the right to send as that address.**

`OWNERS` unset or left at the shipped `owner@example.com` placeholder means nobody is an owner
and nothing can be configured — closed in the direction that costs an edit to `wrangler.jsonc`.

## Authentication

Two paths, both mandatory, evaluated before the router looks at the path:

* **Cloudflare Access JWT** — from the `Cf-Access-Jwt-Assertion` header or the
  `CF_Authorization` cookie. `iss` is checked against `ACCESS_TEAM_DOMAIN`, `exp` against the
  clock, `aud` against `ACCESS_AUD`, and the RSA-SHA256 signature against the team's published
  keys (cached one hour).
* **`Authorization: Bearer <ADMIN_SECRET>`** — `/api/*` only. Constant-time and length-blind:
  both sides are SHA-256'd before the byte comparison.

The worker verifies the JWT **itself** rather than trusting that Access sits in front of it.
That is why the Access policy must be **Allow**, not Bypass — Bypass strips the JWT, and this
worker will then refuse everyone.

### Recommended Access policy shape

* Application type: **Self-hosted**, over the worker's hostname (the `workers.dev` name or a
  custom route), covering the whole path.
* Policy: **Allow**, with the narrowest include rule that works — specific emails, or one
  email domain plus a group. Avoid "everyone in the org" for a worker that can send as your
  domain.
* Add a second Allow policy with a **service token** only if you need the browser path for
  automation; otherwise use the `ADMIN_SECRET` bearer, which never leaves your own tooling.
* Short session duration. The JWT is the whole login; there is no second factor inside the
  worker.
* Never a **Bypass** policy on any path of this application.

### What an attacker with the bearer token can do

Everything an owner can, without a browser — the bearer is owner-equivalent by design: read
every stored message and every archived `.eml`, rewrite member lists, delete mailbox
configurations, and **send mail from any configured mailbox to any address**. It is a credential of the same weight as control of the domain.
Rotate it with `wrangler secret put ADMIN_SECRET`, keep it out of browsers, source, CI logs and
shell history, and store it in a secret manager rather than a file.

## Logging

The worker logs in JSON to `console`, which means Workers Logs / tail. What it logs:

* **Inbound**: mailbox address, row id, byte size, whether the mailbox was configured, the
  suppression reason if any, delivered count, failed count.
* **Failures**: the stage (`read`, `decode`, `parse`, `fanout_log`, `archive_failed`), the
  mailbox, the R2 key, and a truncated error string.
* **Fetch errors**: the pathname and a truncated error string.
* **Render failures**: the message row id and a truncated error string — never any of the HTML.
* **Envelope addresses** on an inbound failure (`to`, `from`), truncated to 200 characters.

What must **never** be logged, and is not:

* **Message bodies** — text or HTML, whole or excerpted.
* **Subjects**, which are content.
* **`ADMIN_SECRET`**, any Access JWT, or any part of either.
* **Attachment contents.**

Error strings are truncated (300–400 characters) before they are logged, because an error
string from a mail library can carry a fragment of the message that caused it. Keep that
truncation if you touch the log lines, and do not "improve" a log line by adding the body for
debugging — the archived `.eml` in R2 is the debugging copy, and it is behind auth.

Note that R2 custom metadata on each archived object carries the mailbox, the sender address
and a timestamp. Bucket access is therefore equivalent to mailbox access; do not make the
bucket public.

## Reporting a vulnerability

Please report privately via GitHub security advisories, not in a public issue.
