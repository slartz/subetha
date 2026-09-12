# Backlog

## Current cycle — first deployment
- [x] Bucket, secret, deploy, Access application, AUD set, redeploy. Both hostnames verified: **401** before the Access app, **302 to the team login** after.
- [x] First mailbox configured, routing repointed, real mail stored + forwarded, reply from the UI delivered; three members (two forward, one send) all `ok`.
- [x] HTML by default; inline `cid:` images; HTML quotes in replies; owners/members; per-member delivery status; send-mode sender attribution; Rules v1 (mute). 128 tests. First schema migration verified on live data.
- [x] `GET /api/health` (watched by the operator's monitor); `GET /api/export` + daily `_config/` snapshot to R2; storage counter, one-shot purge with dry-run, standing `retention_days`; loop-guard corrections. 159 tests. Live 2026-09-13.
- [ ] In progress: design pass — "pleasing, comfortable, fine", not a redesign — and an inline-SVG favicon (envelope with a forward arrow, legible at 16px).
- [ ] Publish decision: flip the GitHub repo public once the README reads right; keep Issues/PRs enabled.
- [ ] Operators embedding this in a private infrastructure repo: keep your real `wrangler` config **outside** the copy/subtree so upstream merges never conflict on vars.

## Bugs
_(none known)_

## Next
- [ ] Rules: `from_domain` matching subdomains as an option; a "Hide this message" button (API already takes `{hidden:1}`); per-member "hide for me" if a member ever asks.
- [ ] Rules: retroactive subject match is ASCII-case-insensitive only (SQLite `lower()`); decide whether to fold in JS for non-ASCII mailboxes.
- [x] Loop guards: `X-Autoreply`/`X-Autorespond` added; send-mode copies stamped `Auto-Submitted: auto-replied`. **Deliberately not adopted** from `mailflare`: `X-Auto-Response-Suppress` and the `no-reply@`/`postmaster@` sender list — those mean "don't auto-reply to me", not "don't forward me", and a shared address exists to receive exactly that mail. Asserted as omissions in tests.
- [x] Forward errors classified (unverified destination / quota / rejected / transient) with a hint on the member row. [ ] A retry affordance for transient ones.
- [ ] Runtime smoke test of the inbound path under `wrangler dev` (structural tests only, today).
- [ ] **Attachments on reply/compose**: `multipart/mixed` with base64 parts in `build-mime.js`, a file input on the reply and compose forms, size cap per Email Sending's message limit (check the docs before setting it). No schema or binding change — outbound is archived raw already. Interim: reply from the forwarded copy in a normal client.
- [ ] Watch the first week of a new mailbox's traffic: automated registration/confirmation mail often carries `Auto-Submitted` or `Precedence: bulk` and is stored-but-not-forwarded by design; if that turns out to be most of the traffic, narrow the guard to replies to our own outbound.
- [ ] `ROUTED_DOMAINS` is a manual list; it must be updated the day a new zone's routing points at the worker. Consider deriving it from the zones whose rules target this worker.

## Roadmap (explicitly parked — this is not a mail client)
- Additional zones (each needs Email Sending onboarding to send *from* it).
- Attachments rendered in the UI (they are archived in R2 today; "download raw" gets them).
- Sending-quota awareness: send-mode fan-out draws on the account's daily sending cap shared with everything else that sends; a per-mailbox cap or an alert.
- Not planned: HTML compose, read state, search, threading view, reply-to-list, live updates.
