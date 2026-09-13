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
   Everything below is SubEtha's own: one page container holding a header, a mailbox editor,
   a two-pane reader and, at the very foot, the block that removes a mailbox. Plain CSS on the
   tokens above; no framework, no build step, and not one byte fetched from anywhere.
   ====================================================================== */

/* SubEtha's own scale, layered ON the tokens above rather than edited into them: sections 1,
   1b and 2 stay verbatim so this file keeps diffing cleanly against the page it was adapted
   from, and the overrides that follow are all in one place to read.
   A plain :root loses to the dark block above (an attribute selector is one step higher), so
   every token restated here that section 1b also sets is restated AGAIN in the dark block
   below — including --lo and --lo2, which stop being a color-mix on --ink and would otherwise
   stay light-mode greys on a dark ground. */
:root {
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp6: 24px;
  /* the page's one gutter. Header, toolbar, member table, storage and the danger block all sit
     on it, and the panes run edge to edge inside the same container — one left edge, one page. */
  --gut: 24px;
  --wide: 1560px;
  /* geometry, as the board draws it: pills, cards, controls, inputs, badges */
  --rad-pill: 20px; --rad-card: 12px; --rad: 9px; --rad-in: 8px; --rad-sm: 5px;
  /* body one step up — 14 primary / 13 secondary / 12 meta / 11 field label */
  --fs: 14px;

  /* ground + ink. A near-white page with white cards on it, and a secondary ink dark enough to
     read: an earlier pass used ~#b2b6bd for labels and timestamps, which measured about 2:1. */
  --bg: #fcfcfb; --panel: #ffffff; --head: #fbfcfc; --surface: #fbfcfc;
  --ink: #17191b;
  --lo2: #41464c;   /* secondary buttons, chips, values */
  --lo:  #676c72;   /* labels and metadata — the lightest tier that is still text */
  --inert: #8d9298; /* decoration only: carets, the "owner" suffix */
  --hair:  #dfe2e5; /* control borders */
  --line:  #e9ebed; /* card and pane borders */
  --rule:  #eef0f1; /* the heavier internal divider: a table header, a pane header */
  --hair2: #f3f5f6; /* row rules */
  --hover: #f7f8f9; /* a control under the pointer */
  --sel:   #f8f9fa; /* the selected row: a neutral tint, because the accent is the rail beside it */

  /* ONE accent, and it means "the thing to press": the mark, Compose, Reply, the selected row's
     rail, the focus ring. Nothing else is filled. */
  --accent: #f6821f;
  --accent-600: #e0740f;  /* the filled button under the pointer */
  --accent-700: #b4520a;  /* accent-coloured TEXT at body size, where the fill would not pass */
  --accent-800: #8a3d06;  /* the same, one step stronger, for a hover */
  --accent-900: #241505;  /* the toast ground */
  /* Dark ink on the orange, not white: white on #f6821f measures about 2.6:1 and is a smudge. */
  --on-accent: #241505;
  --acc-w:  #fdf0e0;      /* the wash behind an active chip */
  --acc-wl: #fdf6ec;      /* the lighter one, behind a hover */
  --acc-line: #f0c79a;    /* an orange border at chip weight */

  /* the four status hues of section 1, retuned to the board. --v inbound (neutral, because a
     received message is the ordinary case), --m outbound, --a delivered, --i inert. */
  --v: #41464c; --v-t: #eff1f2;
  --m: #b4520a; --m-t: #fbe7d0;
  --a: #4f7151; --a-t: #e9efe9;
  --i: #8d9298; --i-t: #eff1f2;
  --dot-ok: #6aa06f;      /* the dot beside "delivered", one step brighter than its text */
  --seg:  #eff1f2;        /* the segmented pill's track, and a resting filter chip */
  /* send is CONFIGURATION, not a call to action, so its selected segment is a muted tan and
     never the accent. Nothing about choosing send is a thing to press twice. */
  --send: #efe2d2; --send-ink: #5b4a34;

  /* failure, in three tiers because it has three jobs */
  --bad: #a9493a;       /* the destructive control's ink and its resting border */
  --bad-600: #b3402d;   /* a destructive link under the pointer */
  --bad-700: #8a2c1b;   /* red TEXT at body size, and the danger heading */
  --bad-t: #fdf1ef;     /* the destructive hover wash */
  --bad-line: #efd9d4;  /* the danger card's border */
  --bad-hair: #d8a79e;  /* that border under the pointer */
  --bad-ring: rgba(192,57,43,.12);

  /* caution — the one thing the page cannot check for itself: whether a forward address is a
     verified destination. The same amber as the unconfigured chip; there is only one. */
  --warn: #84600f; --warn-t: #fdf6e3;

  /* Serif is for the wordmark, the pane titles and the danger heading, and NOWHERE else — not
     in a cell, not in a label, not in body text. A system stack, because this page loads no
     font from anywhere: see the banner at the top of ui.js. */
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}
:root[data-theme="dark"] {
  --bg:#17181a; --panel:#1e1f22; --head:#232427; --surface:#232427;
  --ink:#e9eaec; --lo2:#c3c7cc; --lo:#9aa0a7; --inert:#7c8289;
  --hair:#3a3d42; --line:#2e3136; --rule:#2a2d31; --hair2:#26282c;
  --hover:#25272b; --sel:#232529;
  /* the accent does not change hue in the dark: it is the one orange, and the ink on it stays
     dark for the same reason it is dark in the light theme */
  --accent:#f6821f; --accent-600:#e0740f; --accent-700:#f0a45c; --accent-800:#f8c08a;
  --accent-900:#3a2410; --on-accent:#241505;
  --acc-w:#3a2610; --acc-wl:#2d1d0c; --acc-line:#8a5a24;
  --v:#c3c7cc; --v-t:#2e3136;
  --m:#f0a45c; --m-t:#3a2610;
  --a:#8fbf95; --a-t:#222c23; --dot-ok:#6aa06f;
  --i:#8d9298; --i-t:#2e3136;
  --seg:#2a2d31; --send:#3b3227; --send-ink:#dbc9ae;
  --bad:#e79a9a; --bad-600:#f0a8a8; --bad-700:#f2b5b5; --bad-t:#2e1d1d;
  --bad-line:#4a2f2f; --bad-hair:#6a4141; --bad-ring: rgba(231,154,154,.18);
  --warn:#dfb160; --warn-t:#2f2716;
  --tip:#0e1013;
}

/* An author rule that declares display beats the UA's [hidden], and several things below do
   declare it — the reveal in the danger block is a button toggled with .hidden, and a Delete
   button that is still on the page after the confirm opened is the whole control misread. */
[hidden] { display: none !important; }

/* ── the page ──
   One container, one left edge. Everything above the panes is padded to --gut inside it and the
   panes run the full width of it, so the header, the member table and the message list cannot
   drift out of line with one another — which is what a centred header over full-width panes did. */
.page { max-width: var(--wide); margin: 0 auto; }
.bar { padding: 18px var(--gut) 0; }
.bar .head { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
/* the mark: a ring with a filled disc pushed off centre — an eclipse, in two elements and no
   SVG, because this page ships no asset of any kind */
.mark { width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid var(--accent);
        display: flex; align-items: center; justify-content: center; flex: none; }
.mark > span { width: 14px; height: 14px; border-radius: 50%; background: var(--accent);
               margin-left: 6px; margin-top: -2px; }
.brand { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.bar h1 { font-family: var(--font-serif); font-size: 21px; font-weight: 500;
          letter-spacing: -.01em; line-height: 1.15; margin: 0; }
/* one quiet line saying what this is. Sans, because the serif is the wordmark's alone. */
.tag { margin: 0; font-size: 12px; line-height: 1.3; color: var(--lo); white-space: nowrap; }
.ident { display: flex; align-items: center; gap: 14px; min-width: 0; }
.bar .who { color: var(--lo); font-size: 13px; white-space: nowrap; overflow: hidden;
            text-overflow: ellipsis; }
.sep { width: 1px; height: 14px; background: var(--line); flex: none; }
.row { display: flex; gap: var(--sp2); align-items: center; flex-wrap: wrap;
       margin-bottom: var(--sp2); }
.row:last-child { margin-bottom: 0; }
.grow { flex: 1 1 auto; min-width: 0; }
.grp { display: flex; align-items: center; gap: var(--sp1); min-width: 0; }
/* the toolbar: every control sits under its own label, and the labels bottom-align */
.bar .tools { align-items: flex-end; gap: 10px; margin-bottom: 0; }
.bar .tools .grp { flex-direction: column; align-items: stretch; gap: 5px; }
.bar .tools .grp.grow { min-width: 250px; }
.grp-in { display: flex; align-items: center; gap: var(--sp2); min-width: 0; }
label.lbl { font-size: 11px; color: var(--lo); }
#dn { width: 100%; }
#rulesnote { margin: 14px 0 0; }
#cfgerr { margin-top: 10px; }
#cfgerr:empty { display: none; }

/* ── controls ── */
input[type=text], input[type=email], select {
  height: 32px; padding: 0 11px; background: var(--panel); color: var(--ink);
  border: 1px solid var(--hair); border-radius: var(--rad); font-size: 13px;
}
textarea { background: var(--panel); color: var(--ink); border: 1px solid var(--hair);
           border-radius: var(--rad); }
input[type=checkbox], input[type=radio] { accent-color: var(--accent); margin: 0; }
input::placeholder, textarea::placeholder { color: var(--inert); }
input:disabled, select:disabled, textarea:disabled { background: var(--head); color: var(--lo); }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
/* a ring rather than the base outline: on a bordered control the two together read as a double
   line. It is drawn for the keyboard only, and it is the same accent everything else uses. */
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(246,130,31,.14);
}
textarea { width: 100%; min-height: 132px; height: auto; font-family: var(--font-mono);
           font-size: 12.5px; line-height: 1.5; padding: var(--sp2) var(--sp3); }
button {
  height: 32px; padding: 0 12px; display: inline-flex; align-items: center;
  justify-content: center; gap: 6px; background: var(--panel); color: var(--lo2);
  border: 1px solid var(--hair); border-radius: var(--rad); font-size: 13px; line-height: 1;
  box-shadow: none; cursor: pointer; white-space: nowrap;
}
button:hover { background: var(--hover); border-color: var(--acc-line); }
button:active { background: var(--acc-t); }
/* The one fill on the page, and it is the accent: Compose, Reply, and a modal's own confirm.
   Nothing else is filled, so a fill always means the same thing. */
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent);
                 font-weight: 600; box-shadow: 0 1px 2px rgba(246,130,31,.35); }
button.primary:hover { background: var(--accent-600); border-color: var(--accent-600); }
/* the modals disable their own button while the request is in flight, so the disabled look is
   not decoration: it is the only thing saying the click landed */
button:disabled { opacity: .5; cursor: default; box-shadow: none; }
button:disabled:hover { background: var(--panel); border-color: var(--hair); }
button.primary:disabled:hover { background: var(--accent); border-color: var(--accent); }
/* The destructive button is outlined rather than filled — the accent fill is reserved for the
   two things an operator is meant to press, and this is not one of them. Disabled is its
   resting state: it is armed by typing the address out, not by aiming. */
button.destructive { background: var(--panel); border-color: var(--bad-line); color: var(--bad);
                     font-weight: 500; }
button.destructive:hover { background: var(--bad-t); border-color: var(--bad-hair);
                           color: var(--bad-700); }
button.destructive:disabled:hover { background: var(--panel); border-color: var(--bad-line); }
/* The toggle carries no text: the moon and the sun are drawn below off data-theme itself, so
   the glyph is right at first paint and no script has to catch up with it. */
button.icon { width: 28px; height: 28px; padding: 0; border-radius: var(--rad-in);
              background: var(--panel); border-color: var(--hair); color: var(--lo2);
              font-size: 14px; flex: none; }
button.icon:hover { background: var(--hover); border-color: var(--accent); color: var(--ink); }
#theme::before { content: "\\263E"; }
:root[data-theme="dark"] #theme::before { content: "\\2600"; }
button.link { height: auto; padding: 0; background: none; border: none; box-shadow: none;
              color: var(--lo); font-size: 13px; border-radius: var(--rad-sm); }
button.link:hover { background: none; border-color: transparent; color: var(--bad-600); }

/* ── the member table ── */
.mcard { margin-top: 18px; background: var(--panel); border: 1px solid var(--line);
         border-radius: var(--rad-card); overflow: hidden;
         box-shadow: 0 1px 2px rgba(23,25,27,.04); }
.members { width: 100%; border-collapse: collapse; }
/* fixed only inside the card, where a colgroup sizes the four columns; the rules table below
   has no colgroup and wants its columns sized by what is in them */
.mcard .members { table-layout: fixed; }
/* 14px at the outside edges and 12px between the columns, so the card's padding reads as one
   number rather than as whatever the cell padding happened to add up to */
.members th, .members td { padding: 10px 6px; }
.members th:first-child, .members td:first-child { padding-left: 14px; }
.members th:last-child, .members td:last-child { padding-right: 14px; }
.members th { padding-top: 9px; padding-bottom: 9px; background: var(--head);
              border-bottom: 1px solid var(--rule); font: inherit; font-size: 11px;
              font-weight: 400; color: var(--lo); text-align: left; }
.members td { vertical-align: middle; font-size: 13px; border-bottom: 1px solid var(--hair2); }
.members tr:last-child > td { border-bottom: none; }
.mcard .c2 { width: 164px; } .mcard .c3 { width: 202px; } .mcard .c4 { width: 82px; }
/* The left edge of a member row is its last delivery: green delivered, red failed, grey
   deliberately skipped — and transparent, not absent, for a member nothing has been sent to
   yet, so no row shifts sideways when one of them gains a status. */
.members tr > td:first-child { border-left: 3px solid transparent; padding-left: 11px; }
.members tr.m-ok   > td:first-child { border-left-color: var(--a); }
.members tr.m-bad  > td:first-child { border-left-color: var(--bad); }
.members tr.m-skip > td:first-child { border-left-color: var(--i); }
/* The note belongs to the row above it, so it is tinted with it and ruled off after it. */
#members tr.m-warn > td { background: var(--warn-t); padding-top: 0; padding-bottom: 10px; }
#members tr.m-warn + tr > td { border-top: 1px solid var(--hair2); }
#members .m-email { width: 100%; background: var(--head); border-color: var(--line);
                    border-radius: var(--rad-in); padding: 0 10px; }
#members .m-email:focus, #members .m-email:focus-visible { background: var(--panel); }
/* The forward/send choice is one segmented pill. It is still two radios underneath — same
   name, same mutual exclusion, same keyboard — with the input laid transparently over its own
   segment, so nothing about how the value is read or set changed. */
.modes { display: inline-flex; background: var(--seg); border-radius: var(--rad-pill);
         padding: 2px; font-size: 12px; }
.modes label { display: inline-flex; position: relative; margin: 0; }
.modes input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0;
               cursor: pointer; }
.modes span { padding: 4px 12px; border-radius: 18px; color: var(--lo); line-height: 1.35;
              white-space: nowrap; }
.modes input:checked + span { background: var(--panel); color: var(--ink); font-weight: 500;
                              box-shadow: 0 1px 2px rgba(23,25,27,.08); }
.modes .m-snd:checked + span { background: var(--send); color: var(--send-ink);
                               box-shadow: 0 1px 2px rgba(23,25,27,.06); }
.modes input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
.mstat { font-size: 13px; color: var(--lo); display: inline-block; max-width: 100%;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.mstat.ok  { color: var(--a); }
.mstat.bad { color: var(--bad-700); }
.mstat.ok::before, .mstat.skip::before {
  content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dot-ok); margin-right: 6px; vertical-align: middle; position: relative;
  top: -1px;
}
.mstat.skip::before { background: var(--i); }
.m-del { width: 100%; text-align: right; justify-content: flex-end; }
.addrow { margin: 10px 0 0; gap: 14px; }
.addrow .note { margin: 0; font-size: 12px; line-height: 1.5; }
#addmember { height: 30px; padding: 0 14px; border: 1px dashed var(--hair);
             border-radius: var(--rad-pill); background: transparent; }
#addmember:hover { background: var(--acc-wl); border-color: var(--accent);
                   color: var(--accent-700); }
#fwdnotice { margin: 10px 0 0; }
#fwdnotice:empty { display: none; }
/* The rules list is a plain ruled list under its own sentence, not a card: the sentence is the
   usual state, and a card around nothing is a box asking to be filled. */
#rules td:nth-child(2), #rules td:nth-child(3) { width: 1%; white-space: nowrap; }
#rules td:last-child { width: 1%; text-align: right; }

/* ── storage and retention ── */
/* retention and the purge button answer the storage line, so the three are one block */
#storagerow { margin: 14px 0 0; padding: 12px 16px; background: var(--panel);
              border: 1px solid var(--line); border-radius: var(--rad-card);
              justify-content: space-between; gap: 16px; }
#storage { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
#storagerow .grp { gap: var(--sp2); }

/* ── the two panes ── */
/* Flush to the container's edges and divided by one rule, so the page has exactly one left
   edge from the wordmark down. */
.panes { display: grid; grid-template-columns: 392px minmax(0, 1fr); gap: 0; padding: 0;
         margin: 18px 0 0; max-width: none; border-top: 1px solid var(--line);
         background: var(--panel); }
.pane { background: none; border: 0; border-radius: 0; overflow: hidden; min-width: 0; }
.panes > .pane:first-child { border-right: 1px solid var(--line); }
/* The panes run edge to edge, but their OUTER padding is the page gutter, so "Messages" starts
   on the same line as the wordmark, the Mailbox label and the Member column, and the reader's
   right edge is the same line as the member card's. That one line is the whole point of the
   container; the divider between the two panes is the only vertical rule the page has. */
.panes > .pane:first-child > h2, .panes > .pane:first-child > .body { padding-left: var(--gut); }
.panes > .pane:first-child .msg { padding-left: calc(var(--gut) - 3px); }
.panes > .pane:last-child > h2, .panes > .pane:last-child > .body { padding-right: var(--gut); }
.pane > h2 { font-family: var(--font-serif); font-size: 16px; font-weight: 500;
             padding: 12px 16px; margin: 0; background: none;
             border-bottom: 1px solid var(--rule); display: flex; align-items: center;
             gap: var(--sp2); min-width: 0; }
.pane > h2 .note { font-family: var(--font-body); margin: 0; font-weight: 400; font-size: 12px;
                   white-space: nowrap; }
/* the subject is the pane's title and can be any length a sender chose */
#msgtitle { font-size: 17px; padding: 12px 20px; display: block; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
.pane .body { padding: 14px 20px; }
.filters { display: flex; align-items: center; gap: 6px; }
/* the two list filters are chips, and the checkbox that still does the work lies transparently
   over its own chip */
.opt { display: inline-flex; align-items: center; position: relative; margin: 0;
       font-family: var(--font-body); font-weight: 400; }
.opt input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0;
             cursor: pointer; }
.opt span { padding: 3px 10px; border: 1px solid transparent; border-radius: var(--rad-pill);
            background: var(--seg); color: var(--lo2); font-size: 12px; line-height: 1.4;
            white-space: nowrap; }
.opt:hover span { background: var(--acc-w); color: var(--accent-700); }
.opt input:checked + span { background: var(--acc-w); color: var(--accent-700);
                            border-color: var(--acc-line); }
.opt input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ── the message list ── */
.msg { display: flex; align-items: flex-start; gap: 10px; width: 100%; height: auto;
       text-align: left; background: none; border: none; box-shadow: none;
       border-bottom: 1px solid var(--hair2); border-left: 3px solid transparent;
       border-radius: 0; padding: 11px 16px 11px 13px; color: inherit; font-size: inherit; }
.msg:hover { background: var(--head); }
/* selected is a tint AND an edge: a tint alone disappears on a row that is also hovered */
.msg.sel { background: var(--sel); border-left-color: var(--accent); }
.msg:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 0; }
.msg .dir { width: 24px; height: 18px; flex: none; margin-top: 1px; display: inline-flex;
            align-items: center; justify-content: center; border-radius: var(--rad-sm);
            background: var(--v-t); color: var(--v); font-size: 9.5px; font-weight: 700;
            letter-spacing: .05em; text-transform: uppercase; }
.msg .dir.out { background: var(--m-t); color: var(--m); }
.msg .mb { flex: 1 1 auto; min-width: 0; }
.msg .l1, .msg .l2 { display: flex; justify-content: space-between; align-items: baseline;
                     gap: 10px; }
.msg .l2 { margin-top: 3px; }
/* the subject and the sender each take the free space on their line, so everything that shares
   it — the timestamp, a badge, the fan-out count — stays together on the right */
.msg .subj { flex: 1 1 auto; font-size: 14px; font-weight: 600; color: var(--ink); min-width: 0;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* an outbound row is this mailbox's own reply — present, but not the thing being scanned for */
.msg .subj.out { font-weight: 500; color: var(--lo2); }
.msg .who2 { flex: 1 1 auto; font-size: 13px; color: var(--lo); min-width: 0;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg .when { font-size: 12px; color: var(--lo); flex: none; white-space: nowrap;
             font-variant-numeric: tabular-nums; }
.msg .st { font-size: 11.5px; color: var(--a); flex: none; white-space: nowrap;
           font-variant-numeric: tabular-nums; }
.msg .st.bad { color: var(--bad-700); }

.badge { font-size: 11.5px; line-height: 1.6; padding: 1px 8px; border-radius: var(--rad-pill);
         border: 1px solid transparent; background: var(--seg); color: var(--lo2);
         white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; }
.badge.unconf { background: var(--warn-t); color: var(--warn); }
/* Muted is quiet on purpose: it is the one state the operator chose, not one that happened. */
.badge.muted { background: var(--a-t); color: var(--a); }
.badge.bad { background: var(--bad-t); color: var(--bad-700); }

/* ── the reader ── */
/* a definition grid, drawn with the table the renderer already builds: fixed columns, no rules,
   and a key column narrow enough that the values line up */
table.kv { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 0 var(--sp3);
           max-width: 760px; }
table.kv td { padding: 4px 0; vertical-align: top; border-bottom: none; font-size: 13px;
              line-height: 1.5; overflow-wrap: anywhere; }
table.kv td.k { color: var(--lo); width: 104px; white-space: nowrap; padding-right: 14px; }
table.kv td.mono { font-family: var(--font-mono); font-size: 11px; color: var(--lo); }
table.kv td.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-block; margin: 0 7px 4px 0; padding: 2px 10px; background: var(--head);
        border: 1px solid var(--line); border-radius: var(--rad-pill); font-size: 12px;
        color: var(--lo2); }
.chip .note { display: inline; margin: 0; font-size: inherit; }
h3.sec { font-size: 14px; margin: 18px 0 9px; }
h3.fan { font-family: var(--font-serif); font-size: 15px; font-weight: 500; }
/* Reply, Show HTML, Load images, Download raw, Mute: one strip of pills directly under the
   subject, with the only fill on it being Reply */
.actions { gap: 6px; margin: 0 0 14px; }
.actions button { height: 29px; padding: 0 13px; border-radius: var(--rad-pill); }
.actions a { text-decoration: none; }
.fanout { display: flex; flex-direction: column; gap: 6px; }
.fanout > div { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                padding: 8px 12px; background: var(--head); border: 1px solid var(--line);
                border-radius: 10px; font-size: 13px; color: var(--lo2); }
.fanout .fm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fanout .fs { flex: none; color: var(--a); white-space: nowrap; }
.fanout .fs.bad { color: var(--bad-700); }
#replybox:not(:empty) { border-top: 1px solid var(--hair2); margin-top: var(--sp3);
                        padding-top: var(--sp3); }
pre.text { white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono);
           font-size: 12.5px; line-height: 1.5; background: var(--head);
           border: 1px solid var(--line); border-radius: 11px; padding: var(--sp3);
           margin: 0 0 var(--sp3); max-width: 82ch; }
iframe.html { width: 100%; height: 460px; border: 1px solid var(--line); border-radius: 11px;
              background: #fff; }

/* ── modal, notes, toast ── */
.modal { position: fixed; inset: 0; background: rgba(20,20,22,.5); display: flex;
         align-items: flex-start; justify-content: center; padding: 8vh var(--sp4) var(--sp4);
         z-index: 9; overflow: auto; }
.modal .card { background: var(--panel); border: 1px solid var(--line);
               border-radius: var(--rad-card); box-shadow: var(--shadow-lg);
               padding: var(--sp4) var(--sp4) var(--sp3); width: min(680px, 100%); }
.modal .card h2 { font-size: 17px; margin: 0 0 var(--sp2); }
.modal label { display: inline-flex; align-items: center; gap: 6px; }
/* to, cc and subject start on one line rather than each after its own label */
.modal .lbl { flex: 0 0 auto; min-width: 64px; }
.note { color: var(--lo); font-size: 13px; line-height: 1.5; margin: var(--sp1) 0 var(--sp3); }
/* an empty pane says one quiet sentence in the middle of itself and nothing else */
.empty { color: var(--lo); font-size: 13px; text-align: center; }
p.empty { margin: 0; padding: var(--sp6) var(--sp2); }
.pane .body.empty { padding: var(--sp6) var(--sp4); }
.warn { color: var(--warn); font-size: 12px; line-height: 1.5; display: block; }
.err { color: var(--bad-700); font-size: 13px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
/* The one place a mailbox can be removed, and it is at the very foot of the page, below the
   mail rather than beside the settings: opened rather than fired, and armed by typing the
   address out. The sentence it opens matters more than the typing — "delete mailbox" reads
   like "delete the mail", and it deletes none. */
.danger { margin: 18px var(--gut) 22px; padding: 14px 16px; background: var(--panel);
          border: 1px solid var(--bad-line); border-radius: var(--rad-card);
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          flex-wrap: wrap; }
.danger .dz-l { max-width: 520px; min-width: 0; }
.danger .dz-r { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; }
.danger h2 { font-family: var(--font-serif); font-size: 15px; font-weight: 500;
             color: var(--bad-700); margin: 0; }
#delconfirm { display: flex; align-items: center; gap: var(--sp2); flex-wrap: wrap; }
#delwhat { margin: 3px 0 0; font-size: 13px; color: var(--lo); line-height: 1.5; }
#delwhat:empty { display: none; }
#delconf { width: 210px; max-width: 100%; background: var(--head); }
#delconf:focus, #delconf:focus-visible { border-color: var(--bad);
                                         box-shadow: 0 0 0 3px var(--bad-ring); }
/* the box is labelled for a screen reader and captioned by its own placeholder for everyone
   else: the placeholder IS the address that has to be typed, so a visible label repeats it */
label.dl { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
           overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
#toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
         background: var(--accent-900); color: #fff; padding: var(--sp2) var(--sp4);
         border-radius: var(--rad); box-shadow: var(--shadow-lg); display: none; z-index: 20;
         font-size: 13px; max-width: min(560px, 92vw); }
/* one column before the reader gets too narrow to be a reader */
@media (max-width: 900px) {
  .panes { grid-template-columns: 1fr; }
  .panes > .pane:first-child { border-right: none; border-bottom: 1px solid var(--line); }
  .panes > .pane:first-child > h2, .panes > .pane:first-child > .body,
  .panes > .pane:last-child > h2, .panes > .pane:last-child > .body {
    padding-left: var(--gut); padding-right: var(--gut);
  }
  .mcard .c2, .mcard .c3, .mcard .c4 { width: auto; }
}
@media (max-width: 700px) {
  :root { --gut: 16px; }
  .members th:nth-child(3), .members td:nth-child(3) { display: none; }
}
`;
