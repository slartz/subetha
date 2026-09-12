// Adapted from an earlier worker by the same author; see LICENSE: its sections 1 (tokens) and
// 2 (base) verbatim, so the two admin pages read as one system. The original's component
// sections belong to its own pages and are NOT copied — SubEtha's own components are in the
// section further down this file.
//
// CHANGED from the original, in two places, both of them deliberate:
//
// 1. The Google Fonts @import is dropped. SubEtha's UI loads NO external resource of any kind
// (the Access page is the only thing between this worker and the mailboxes, and a font CDN is
// a needless third party on it), so the font stacks fall through to their system-ui
// fallbacks, which is what they were written to do.
//
// 2. Section 1b no longer answers prefers-color-scheme. SubEtha is a light page unless the
// operator says otherwise: the same dark values now hang off html[data-theme="dark"] alone,
// set by the toggle in the bar and re-applied from localStorage before first paint. An OS
// that happens to be dark does not get a vote, and neither does anything else automatic.
export const CSS = `
/* ── 1. tokens ──────────────────────────────────────────────────────────── */
:root {
  /* ground + ink */
  --bg:        #f2f2f3;
  --panel:     #ffffff;   /* table, cards, sticky header */
  --head:      #ededef;   /* table header row, card header strips */
  --surface:   #e9e9ea;   /* group header rows */
  --ink:       #1d1f20;
  --lo:        color-mix(in srgb, var(--ink) 42%, transparent);  /* 2nd lines, icons */
  --lo2:       color-mix(in srgb, var(--ink) 60%, transparent);  /* guessed values, labels */
  --hair:      color-mix(in srgb, var(--ink) 13%, transparent);  /* borders */
  --hair2:     color-mix(in srgb, var(--ink) 7%,  transparent);  /* row rules */
  --dot:       #b7b7ba;   /* dotted underline under a guessed value */

  /* accent — one steel blue, used only for state */
  --accent:    #5980a6;
  --accent-700:#416180;   /* accent-coloured TEXT at body size (contrast) */
  --accent-800:#2c455d;   /* text on an accent tint */
  --accent-900:#1d2d3d;   /* toast ground */
  --acc-t:     color-mix(in srgb, var(--accent) 13%, transparent); /* bulk bar, processed btn */
  --sel:       color-mix(in srgb, var(--accent) 14%, transparent); /* checked row */
  --hover:     color-mix(in srgb, var(--accent) 7%,  transparent); /* focused/hovered row */

  /* four status hues — one each, equal weight, all derived off the accent. SubEtha uses
     three: --v inbound, --m outbound, --i unconfigured. */
  --v:   #3f6a94;  --v-t: color-mix(in srgb, #3f6a94 11%, transparent);
  --m:   #6d5d8c;  --m-t: color-mix(in srgb, #6d5d8c 11%, transparent);
  --a:   #41705d;  --a-t: color-mix(in srgb, #41705d 11%, transparent);
  --i:   #7a7a7d;  --i-t: color-mix(in srgb, #7a7a7d 11%, transparent);

  --tip: #2b2b2d;  /* tooltip ground */

  /* type */
  --font-heading: "Barlow Condensed", system-ui, "Segoe UI", sans-serif;
  --font-body:    "Barlow", system-ui, "Segoe UI", "Noto Sans Hebrew", sans-serif;
  --font-mono:    ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* scale: 28 h1 · 19 h2 · 15 lead · 13.5 body/cell · 13 2nd line · 12 meta · 11 column label */

  /* spacing (0.85× density scale) */
  --s1: 3px; --s2: 7px; --s3: 10px; --s4: 14px; --s6: 20px; --s8: 27px;

  /* geometry */
  --r:  7px;   /* everything: buttons, chips, inputs, cards, table, pre */
  --r-sm: 5px; /* inner segments, kbd, vendor mark */
  --rp: 6px;   /* row padding — compact is the DEFAULT; 9px = comfortable */
  --fs: 13.5px;

  --shadow-sm: 0 1px 2px rgba(43,43,45,.14);
  --shadow-lg: 0 12px 32px rgba(43,43,45,.22);
}

/* comfortable: add class="comfortable" to <html> (or a user preference cookie) */
html.comfortable { --rp: 9px; --fs: 14px; }

/* ── 1b. dark ─────────────────────────────────────────────────────────────
   Explicit only: nothing here fires off prefers-color-scheme. color-scheme is declared so the
   native controls — the selects, the checkboxes, the scrollbars — follow the page rather than
   the operating system, which is the half of "light by default" that CSS variables cannot do. */
:root { color-scheme: light; }
/* set data-theme="dark" on <html>; the toggle in the bar does, and so does the head script */
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg:#15171a; --panel:#1b1e22; --head:#232529; --surface:#1e2126;
  --ink:#e7e8ea;
  --hair:rgba(231,232,234,.16); --hair2:rgba(231,232,234,.085);
  --dot:#7a7a7d;
  --accent:#8fb0d0; --accent-700:#a8c6e0; --accent-800:#dbeaf7; --accent-900:#0f1d2a;
  --v:#8db2d6; --v-t:color-mix(in srgb,#8db2d6 15%,transparent);
  --m:#b3a5d0; --m-t:color-mix(in srgb,#b3a5d0 15%,transparent);
  --a:#83b8a2; --a-t:color-mix(in srgb,#83b8a2 15%,transparent);
  --i:#9b9ba0; --i-t:color-mix(in srgb,#9b9ba0 15%,transparent);
  --tip:#0e1013;
}

/* ── 2. base ────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: hidden; }           /* the PAGE never scrolls sideways */
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--font-body); font-size: var(--fs); line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
main { padding: var(--s4) var(--s4) 64px; max-width: 1560px; margin: 0 auto; }
input, button, select, textarea { font: inherit; color: inherit; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: var(--r); }
::selection { background: var(--acc-t); }
a { color: var(--accent-700); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { color: var(--accent-800); }

/* Barlow Condensed is for headings and column labels ONLY — never inside a cell */
h1, h2, h3 { font-family: var(--font-heading); font-weight: 600; line-height: 1.14; margin: 0 0 var(--s2); letter-spacing: 0; }
h1 { font-size: 28px; } h2 { font-size: 19px; } h3 { font-size: 16px; }

kbd {
  font-family: var(--font-body); font-size: 11px; line-height: 1.4;
  border: 1px solid var(--hair); border-radius: 4px; padding: 1px 5px;
  background: var(--panel); color: var(--lo);
}


/* ── SubEtha ─────────────────────────────────────────────────────────────
   Everything below is SubEtha's own: a top bar, a mailbox editor, a two-pane
   reader. Plain CSS on the tokens above; no framework, no build step.
   ====================================================================== */

/* SubEtha's own scale, layered ON the tokens above rather than edited into them: sections 1,
   1b and 2 stay verbatim so this file keeps diffing cleanly against the page it was adapted
   from, and the overrides that follow are all in one place to read.
   A plain :root loses to the dark block above (an attribute selector is one step higher), so
   the warmer ground below is the light page's, and dark restates the same four tokens. */
:root {
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp6: 24px;
  --rad: 6px; --rad-sm: 4px;
  --wide: 1560px;
  /* the same greys, a few degrees warmer — the page is read all day */
  --bg: #f3f2f0; --head: #edecea; --surface: #e8e7e4;
  /* failure, as one token: #b00 is unreadable on a dark panel and was written out five times */
  --bad: #b00000; --bad-t: color-mix(in srgb, #b00000 12%, transparent);
  /* ink for text ON the accent: white in light, where the accent is dark — and the reverse in
     dark, where the accent is a pale blue and white on it is not text, it is a smudge */
  --on-accent: #ffffff;
}
:root[data-theme="dark"] {
  --bg:#191918; --panel:#1f1f1e; --head:#262624; --surface:#222221;
  --bad:#e79a9a; --bad-t: color-mix(in srgb, #e79a9a 14%, transparent);
  --on-accent: var(--accent-900);
}

/* ── the bar ── */
.bar { background: var(--panel); border-bottom: 1px solid var(--hair);
       padding: var(--sp3) var(--sp4) var(--sp2); }
/* the bar has no wrapper of its own, so every child is its own centred column — that is what
   keeps its left edge on the same line as the panes below it on a wide screen */
.bar > * { max-width: var(--wide); margin-inline: auto; }
.bar .head { display: flex; align-items: baseline; gap: var(--sp3); margin-bottom: var(--sp3); }
.bar h1 { font-size: 20px; margin: 0; }
.bar .who { color: var(--lo); font-size: 12px; white-space: nowrap; }
.row { display: flex; gap: var(--sp2); align-items: center; flex-wrap: wrap;
       margin-bottom: var(--sp2); }
.row:last-child { margin-bottom: 0; }
.grow { flex: 1 1 auto; min-width: 0; }
/* a group is a label and the control it names, or two buttons that act on the same thing:
   4px inside a group, 8px between groups, so the bar reads as clusters rather than a queue */
.grp { display: flex; align-items: center; gap: var(--sp1); min-width: 0; }
label.lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--lo2); }
/* retention and the purge button answer the storage line, so the three are one block */
#storagerow { border-top: 1px solid var(--hair2); margin-top: var(--sp1); padding-top: var(--sp3); }
#storage { margin: 0; font-variant-numeric: tabular-nums; }
#rulesnote { margin: 0; }

/* ── controls ── */
input[type=text], input[type=email], textarea, select {
  background: var(--panel); color: var(--ink); border: 1px solid var(--hair);
  border-radius: var(--rad); padding: 6px 9px; font-size: var(--fs);
}
input[type=checkbox], input[type=radio] { accent-color: var(--accent); margin: 0; }
input::placeholder, textarea::placeholder { color: var(--lo); }
input:disabled, select:disabled, textarea:disabled { background: var(--head); color: var(--lo2); }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
/* a ring rather than the base outline: on a bordered control the two together read as a double
   line. It is drawn for the keyboard only, and it is the same accent everything else uses. */
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 26%, transparent);
}
textarea { width: 100%; min-height: 132px; font-family: var(--font-mono); font-size: 12.5px;
           line-height: 1.5; padding: var(--sp2) var(--sp3); }
button {
  background: var(--panel); border: 1px solid var(--hair); border-radius: var(--rad);
  padding: 6px 12px; cursor: pointer; box-shadow: var(--shadow-sm); line-height: 1.35;
  color: var(--ink);
}
button:hover { background: var(--hover); border-color: color-mix(in srgb, var(--accent) 38%, var(--hair)); }
button:active { background: var(--acc-t); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover { background: var(--accent-700); border-color: var(--accent-700); }
/* the modals disable their own button while the request is in flight, so the disabled look is
   not decoration: it is the only thing saying the click landed */
button:disabled { opacity: .5; cursor: default; box-shadow: none; }
button:disabled:hover { background: var(--panel); border-color: var(--hair); }
button.primary:disabled:hover { background: var(--accent); border-color: var(--accent); }
button.link { background: none; border: none; box-shadow: none; color: var(--accent-700);
              padding: 2px 6px; border-radius: var(--rad-sm); }
button.link:hover { background: var(--hover); color: var(--accent-800); border-color: transparent; }

/* ── the two panes ── */
.panes { display: grid; grid-template-columns: minmax(300px, 36%) 1fr; gap: var(--sp4);
         padding: var(--sp4); align-items: start; max-width: var(--wide); margin: 0 auto; }
.pane { background: var(--panel); border: 1px solid var(--hair); border-radius: var(--rad);
        overflow: hidden; }
.pane > h2 { font-size: 15px; padding: var(--sp2) var(--sp3); margin: 0; background: var(--head);
             border-bottom: 1px solid var(--hair); display: flex; align-items: center;
             gap: var(--sp2); min-width: 0; }
.pane > h2 .note { margin: 0; font-weight: 400; font-size: 12px; white-space: nowrap; }
/* the subject is the pane's title and can be any length a sender chose */
#msgtitle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane .body { padding: var(--sp3); }
.opt { font-family: var(--font-body); font-size: 12px; color: var(--lo2); white-space: nowrap;
       display: inline-flex; align-items: center; gap: 5px; margin: 0; font-weight: 400; }

/* ── the message list ── */
/* --rp is the density token the base sets (compact by default, comfortable on a class), so the
   rows stay on it rather than on a number of their own */
.msg { display: block; width: 100%; text-align: left; background: none; border: none;
       box-shadow: none; border-bottom: 1px solid var(--hair2);
       border-left: 3px solid transparent; border-radius: 0;
       padding: calc(var(--rp) + 3px) var(--sp3); }
.msg:hover { background: var(--hover); }
/* selected is a tint AND an edge: a tint alone disappears on a row that is also hovered */
.msg.sel { background: var(--sel); border-left-color: var(--accent); }
.msg.sel .subj { color: var(--accent-800); }
.msg:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 0; }
.msg .l1 { display: flex; gap: var(--sp2); align-items: baseline; }
.msg .subj { font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; }
.msg .l2 { color: var(--lo); font-size: 12px; display: flex; gap: var(--sp2);
           align-items: baseline; margin-top: 3px; }
.msg .l2 .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg .when { white-space: nowrap; font-variant-numeric: tabular-nums; }

.badge { font-size: 10.5px; line-height: 1.75; padding: 0 6px; border-radius: var(--rad-sm);
         border: 1px solid var(--hair); color: var(--lo2); white-space: nowrap;
         font-variant-numeric: tabular-nums; }
.badge.in  { background: var(--v-t); color: var(--v); border-color: transparent; }
.badge.out { background: var(--m-t); color: var(--m); border-color: transparent; }
.badge.unconf { background: var(--i-t); color: var(--i); border-color: transparent; }
/* Muted is quiet on purpose: it is the one state the operator chose, not one that happened. */
.badge.muted { background: var(--a-t); color: var(--a); border-color: transparent; }
.badge.bad { background: var(--bad-t); color: var(--bad); border-color: transparent; }

/* ── the reader ── */
table.kv { width: 100%; border-collapse: collapse; margin: 0 0 var(--sp3); max-width: 760px; }
table.kv td { padding: 5px 0; vertical-align: top; border-bottom: 1px solid var(--hair2);
              font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
table.kv td.k { color: var(--lo2); width: 104px; white-space: nowrap; padding-right: var(--sp3); }
table.kv tr:last-child td { border-bottom: none; }
h3.sec { font-size: 14px; margin: var(--sp3) 0 var(--sp2); }
/* Reply, Show HTML, Load images, Download raw, Mute: one strip, ruled off from the body below */
.actions { margin: 0 0 var(--sp3); padding-bottom: var(--sp3); border-bottom: 1px solid var(--hair2); }
.actions a { text-decoration: none; }
#replybox:not(:empty) { border-top: 1px solid var(--hair2); margin-top: var(--sp3);
                        padding-top: var(--sp3); }
pre.text { white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono);
           font-size: 12.5px; line-height: 1.5; background: var(--bg);
           border: 1px solid var(--hair2); border-radius: var(--rad); padding: var(--sp3);
           margin: 0 0 var(--sp3); max-width: 82ch; }
iframe.html { width: 100%; height: 460px; border: 1px solid var(--hair); border-radius: var(--rad);
              background: #fff; }

/* ── members and rules ── */
.members { width: 100%; border-collapse: collapse; }
.members td { padding: var(--sp1) var(--sp2); vertical-align: middle; font-size: 12.5px;
              border-bottom: 1px solid var(--hair2); }
.members tr:last-child > td { border-bottom: none; }
/* The left edge of a member row is its last delivery: green delivered, red failed, grey
   deliberately skipped — and transparent, not absent, for a member nothing has been sent to
   yet, so no row shifts sideways when one of them gains a status. */
.members tr > td:first-child { border-left: 3px solid transparent; padding-left: var(--sp2); }
.members tr.m-ok   > td:first-child { border-left-color: var(--a); }
.members tr.m-bad  > td:first-child { border-left-color: var(--bad); }
.members tr.m-skip > td:first-child { border-left-color: var(--i); }
/* Four columns, sized rather than left to whatever the longest address happens to be: the two
   tbodies are the only handle the markup gives, and they are enough. */
#members td:first-child { width: 42%; }
#members td:nth-child(2) { width: 1%; white-space: nowrap; }
#members td:last-child { width: 1%; text-align: right; }
#members .m-email { width: 100%; max-width: 300px; }
#members label { display: inline-flex; align-items: center; gap: 5px; margin-right: var(--sp2);
                 color: var(--lo2); }
#rules td:first-child { width: 55%; }
#rules td:nth-child(2), #rules td:nth-child(3) { white-space: nowrap; }
#rules td:last-child { width: 1%; text-align: right; }
.mstat { font-size: 11.5px; color: var(--lo); display: inline-block; max-width: 460px;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.mstat.ok  { color: var(--a); }
.mstat.bad { color: var(--bad); }

/* ── modal, notes, toast ── */
.modal { position: fixed; inset: 0; background: rgba(20,20,22,.5); display: flex;
         align-items: flex-start; justify-content: center; padding: 8vh var(--sp4) var(--sp4);
         z-index: 9; overflow: auto; }
.modal .card { background: var(--panel); border: 1px solid var(--hair); border-radius: var(--rad);
               box-shadow: var(--shadow-lg); padding: var(--sp4) var(--sp4) var(--sp3);
               width: min(680px, 100%); }
.modal .card h2 { font-size: 17px; margin: 0 0 var(--sp2); }
.modal label { display: inline-flex; align-items: center; gap: 6px; }
/* to, cc and subject start on one line rather than each after its own label */
.modal .lbl { flex: 0 0 auto; min-width: 64px; }
.note { color: var(--lo); font-size: 12px; line-height: 1.5; margin: var(--sp1) 0 var(--sp3); }
/* an empty pane says one quiet sentence in the middle of itself and nothing else */
.empty { color: var(--lo); font-size: 12.5px; text-align: center; }
p.empty { margin: 0; padding: var(--sp6) var(--sp2); }
.pane .body.empty { padding: var(--sp6) var(--sp4); }
.err  { color: var(--bad); font-size: 12.5px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
#toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
         background: var(--accent-900); color: #fff; padding: var(--sp2) var(--sp4);
         border-radius: var(--rad); box-shadow: var(--shadow-lg); display: none; z-index: 20;
         font-size: 13px; max-width: min(560px, 92vw); }
/* one column before the reader gets too narrow to be a reader */
@media (max-width: 900px) {
  .panes { grid-template-columns: 1fr; padding: var(--sp3); gap: var(--sp3); }
  #members td:first-child { width: auto; }
}
`;
