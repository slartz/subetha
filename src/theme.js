// Adapted from an earlier worker by the same author; see LICENSE: its sections 1 (tokens),
// 1b (dark) and 2 (base) verbatim, so the two admin pages read as one system. The original's
// component sections belong to its own pages and are NOT copied — SubEtha's own components
// are in the section further down this file.
//
// CHANGED from the original: the Google Fonts @import is dropped. SubEtha's UI loads NO
// external resource of any kind (the Access page is the only thing between this worker and
// the mailboxes, and a font CDN is a needless third party on it), so the font stacks fall
// through to their system-ui fallbacks, which is what they were written to do.
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

/* ── 1b. dark ───────────────────────────────────────────────────────────── */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
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
}
/* explicit override, same values — set data-theme="dark" on <html> */
:root[data-theme="dark"] {
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
.bar { background: var(--panel); border-bottom: 1px solid var(--hair); padding: var(--s3) var(--s4); }
.bar h1 { font-size: 20px; display: inline-block; margin: 0 var(--s4) 0 0; }
.bar .who { color: var(--lo); font-size: 12px; float: right; }
.row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; margin-bottom: var(--s2); }
.grow { flex: 1 1 auto; min-width: 0; }
label.lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--lo2); }

input[type=text], input[type=email], textarea, select {
  background: var(--panel); color: var(--ink); border: 1px solid var(--hair);
  border-radius: var(--r); padding: 5px 8px; font-size: var(--fs);
}
textarea { width: 100%; min-height: 120px; font-family: var(--font-mono); font-size: 12.5px; }
button {
  background: var(--panel); border: 1px solid var(--hair); border-radius: var(--r);
  padding: 5px 11px; cursor: pointer; box-shadow: var(--shadow-sm);
}
button:hover { background: var(--hover); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { background: var(--accent-700); }
button.link { background: none; border: none; box-shadow: none; color: var(--accent-700); padding: 2px 4px; }

.panes { display: grid; grid-template-columns: minmax(280px, 38%) 1fr; gap: var(--s4);
         padding: var(--s4); align-items: start; }
.pane { background: var(--panel); border: 1px solid var(--hair); border-radius: var(--r);
        overflow: hidden; }
.pane > h2 { font-size: 15px; padding: var(--s2) var(--s3); margin: 0; background: var(--head);
             border-bottom: 1px solid var(--hair); }
.pane .body { padding: var(--s3); }

.msg { display: block; width: 100%; text-align: left; background: none; border: none;
       box-shadow: none; border-bottom: 1px solid var(--hair2); padding: var(--rp) var(--s3);
       border-radius: 0; }
.msg:hover { background: var(--hover); }
.msg.sel { background: var(--sel); }
.msg .l1 { display: flex; gap: var(--s2); align-items: baseline; }
.msg .subj { font-weight: 500; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg .l2 { color: var(--lo); font-size: 12px; display: flex; gap: var(--s2); }

.badge { font-size: 11px; padding: 0 6px; border-radius: var(--r-sm); border: 1px solid var(--hair);
         color: var(--lo2); white-space: nowrap; }
.badge.in  { background: var(--v-t); color: var(--v); border-color: transparent; }
.badge.out { background: var(--m-t); color: var(--m); border-color: transparent; }
.badge.unconf { background: var(--i-t); color: var(--i); border-color: transparent; }
/* Muted is quiet on purpose: it is the one state the operator chose, not one that happened. */
.badge.muted { background: var(--a-t); color: var(--a); border-color: transparent; }
.badge.bad { background: color-mix(in srgb, #b00 12%, transparent); color: #b00; border-color: transparent; }

table.kv { width: 100%; border-collapse: collapse; margin-bottom: var(--s3); }
table.kv td { padding: 2px 6px; vertical-align: top; border-bottom: 1px solid var(--hair2); font-size: 12.5px; }
table.kv td.k { color: var(--lo2); width: 92px; white-space: nowrap; }
pre.text { white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono);
           font-size: 12.5px; background: var(--bg); border: 1px solid var(--hair2);
           border-radius: var(--r); padding: var(--s3); margin: 0 0 var(--s3); }
iframe.html { width: 100%; height: 460px; border: 1px solid var(--hair); border-radius: var(--r);
              background: #fff; }

.members { width: 100%; border-collapse: collapse; }
.members td { padding: 2px 4px; }
/* The left edge of a member row is its last delivery: green delivered, red failed, grey
   deliberately skipped — and transparent, not absent, for a member nothing has been sent to
   yet, so no row shifts sideways when one of them gains a status. */
.members tr > td:first-child { border-left: 3px solid transparent; padding-left: var(--s2); }
.members tr.m-ok   > td:first-child { border-left-color: var(--a); }
.members tr.m-bad  > td:first-child { border-left-color: #b00; }
.members tr.m-skip > td:first-child { border-left-color: var(--i); }
.mstat { font-size: 11px; color: var(--lo); display: inline-block; max-width: 460px; }
.mstat.ok  { color: var(--a); }
.mstat.bad { color: #b00; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex;
         align-items: flex-start; justify-content: center; padding: 6vh var(--s4); z-index: 9; }
.modal .card { background: var(--panel); border-radius: var(--r); box-shadow: var(--shadow-lg);
               padding: var(--s4); width: min(680px, 100%); }
.note { color: var(--lo); font-size: 12px; margin: var(--s1) 0 var(--s3); }
.err  { color: #b00; font-size: 12.5px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
#toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
         background: var(--accent-900); color: #fff; padding: 7px 14px; border-radius: var(--r);
         box-shadow: var(--shadow-lg); display: none; z-index: 20; }
@media (max-width: 780px) { .panes { grid-template-columns: 1fr; } }
`;
