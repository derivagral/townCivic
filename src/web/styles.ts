export const STYLES = /* css */ `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1a1a19;
  --muted: #6b6b66;
  --line: #e4e1db;
  --accent: #1f5f4f;
  --accent-soft: #e8f1ee;
  --warn-bg: #fdf3d8;
  --warn-line: #e6cf8f;
  --warn-ink: #6b5514;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14150f;
    --panel: #1c1e18;
    --ink: #ecebe4;
    --muted: #9d9c92;
    --line: #2e3129;
    --accent: #7fc3ac;
    --accent-soft: #1f2b26;
    --warn-bg: #2d2717;
    --warn-line: #5c4f26;
    --warn-ink: #e2cf95;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: inherit; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px 64px; }

header.site { border-bottom: 1px solid var(--line); background: var(--panel); }
header.site .wrap { padding-top: 22px; padding-bottom: 0; }
.brand { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.brand h1 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
.brand h1 a { text-decoration: none; }
.brand .tag { color: var(--muted); font-size: 13px; }
.brand .spacer { flex: 1; }
.brand .util { font-size: 13px; color: var(--muted); display: flex; gap: 14px; }

/*
 * The town switcher. Deliberately quieter than the channel tabs below it and
 * visually above them: which town you are in is a bigger question than which
 * channel, and asking it twice a session should not compete with the content.
 */
nav.towns { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 0; font-size: 13px; }
nav.towns a { color: var(--muted); text-decoration: none; }
nav.towns a:hover { color: var(--ink); text-decoration: underline; }
nav.towns a.on { color: var(--ink); font-weight: 600; }

nav.primary { display: flex; gap: 22px; margin-top: 20px; border-bottom: 1px solid var(--line); }
nav.primary a {
  padding: 0 1px 10px; color: var(--muted); text-decoration: none; font-size: 15px; font-weight: 600;
  border-bottom: 3px solid transparent; margin-bottom: -1px;
}
nav.primary a:hover { color: var(--ink); }
nav.primary a.on { color: var(--accent); border-bottom-color: var(--accent); }

nav.channels { display: flex; gap: 4px; flex-wrap: wrap; margin: 10px 0 0; }
nav.channels a {
  padding: 7px 12px; font-size: 13.5px; text-decoration: none; color: var(--muted);
  border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0;
}
nav.channels a:hover { color: var(--ink); }
nav.channels a.on {
  color: var(--ink); background: var(--bg); border-color: var(--line);
  margin-bottom: -1px; padding-bottom: 8px; font-weight: 600;
}

.banner {
  background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink);
  border-radius: var(--radius); padding: 11px 14px; margin: 20px 0 0; font-size: 13.5px;
}
.banner strong { font-weight: 700; }

.layout { display: grid; grid-template-columns: 232px 1fr; gap: 34px; margin-top: 26px; align-items: start; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; gap: 20px; } }

aside .group { margin-bottom: 24px; }
aside h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--muted); margin: 0 0 8px;
}
aside ul { list-style: none; margin: 0; padding: 0; }
aside li { margin: 0 0 1px; }
aside li a {
  display: flex; justify-content: space-between; gap: 8px; text-decoration: none;
  padding: 4px 8px; border-radius: 6px; font-size: 13.5px; color: var(--muted);
}
aside li a:hover { background: var(--panel); color: var(--ink); }
aside li a.on { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
aside li a .n { font-variant-numeric: tabular-nums; opacity: 0.65; }
aside li.more { padding: 5px 8px; font-size: 12.5px; color: var(--muted); opacity: 0.8; }

form.search { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 22px; }
form.search input[type="search"] {
  flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink);
}
label.derivedtoggle {
  flex-basis: 100%; display: flex; gap: 7px; align-items: flex-start;
  font-size: 12px; color: var(--muted); line-height: 1.35; cursor: pointer;
}
label.derivedtoggle input { margin: 2px 0 0; }
form.search button, form.search select {
  padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink);
}

.view-intro { padding: 24px 0 18px; }
.view-intro h1 { font-size: clamp(24px, 4vw, 34px); letter-spacing: -0.025em; margin: 1px 0 4px; line-height: 1.2; }
.view-intro p { max-width: 720px; margin: 0; color: var(--muted); }
.view-intro p.eyebrow, .eyebrow {
  color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; font-weight: 700; margin: 0 0 4px;
}

.toolbar {
  display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  padding-bottom: 12px; margin-bottom: 6px; border-bottom: 1px solid var(--line);
}
.toolbar .count { font-size: 13px; color: var(--muted); }
.toolbar .modes { margin-left: auto; display: flex; gap: 10px; font-size: 13px; }
.toolbar .modes a { color: var(--muted); text-decoration: none; }
.toolbar .modes a.on { color: var(--ink); font-weight: 600; }

.daygroup { margin-top: 26px; }
.daygroup > h3 {
  font-size: 12.5px; font-weight: 600; color: var(--muted); margin: 0 0 10px;
  letter-spacing: 0.02em; display: flex; align-items: center; gap: 10px;
}
.daygroup > h3::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.daygroup.upcoming > h3 { color: var(--accent); }

article.event {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 13px 15px; margin-bottom: 8px;
}
article.event.p-low { opacity: 0.72; }
article.event h4 { margin: 0 0 5px; font-size: 15.5px; font-weight: 600; line-height: 1.35; }
article.event h4 a { text-decoration: none; }
article.event h4 a:hover { text-decoration: underline; }
article.event p.summary { margin: 0 0 8px; font-size: 13.5px; color: var(--muted); }
.search-evidence {
  margin: 8px 0 10px; padding: 8px 10px; border-left: 2px solid var(--accent);
  border-radius: 0 6px 6px 0; background: var(--accent-soft); color: var(--ink); font-size: 13px;
}
.search-evidence > span { display: block; color: var(--muted); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.search-evidence mark { background: #f2d574; color: #27210e; padding: 0 1px; border-radius: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.meta .dot { color: var(--line); }
.meta a { color: var(--muted); }

.badge {
  display: inline-block; padding: 1.5px 7px; border-radius: 999px; font-size: 11.5px;
  font-weight: 600; letter-spacing: 0.01em; border: 1px solid var(--line); color: var(--muted);
  text-decoration: none; white-space: nowrap;
}
.badge.ch { border-color: transparent; color: #fff; }
.badge.ch-meetings { background: #4a6fa5; }
.badge.ch-land-use { background: #2f7d63; }
.badge.ch-money { background: #9a6b1f; }
.badge.ch-law { background: #6b4f9e; }
.badge.ch-elections { background: #a1483f; }
.badge.ch-schools { background: #2b7f92; }
.badge.ch-public-safety { background: #8a5a2b; }
.badge.ch-courts { background: #5b5f6b; }
.badge.ch-state-federal { background: #46738a; }
.badge.ch-admin { background: #7a7a72; }
.badge.subject { background: var(--accent-soft); border-color: var(--line); color: var(--ink); }
.badge.kind { font-weight: 500; }

.empty {
  border: 1px dashed var(--line); border-radius: var(--radius);
  padding: 34px 20px; text-align: center; color: var(--muted); margin-top: 26px;
}
.empty code { background: var(--panel); padding: 2px 6px; border-radius: 5px; }

.pager { display: flex; gap: 10px; justify-content: center; margin-top: 26px; font-size: 14px; }
.pager a {
  padding: 7px 14px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); text-decoration: none;
}

table.sources { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 18px; }
table.sources th, table.sources td {
  text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top;
}
table.sources th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
table.sources td.url { word-break: break-all; font-size: 12.5px; }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
.pill.ok { background: var(--accent-soft); }
.pill.off { opacity: 0.6; }

.detail { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; margin-top: 26px; }
.detail h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.3; }
.detail dl { display: grid; grid-template-columns: 150px 1fr; gap: 7px 16px; margin: 18px 0 0; font-size: 14px; }
.detail dt { color: var(--muted); font-size: 12.5px; padding-top: 2px; }
.detail dd { margin: 0; word-break: break-word; }
.detail .actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
.agenda { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.agenda h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
.agenda ol { margin: 0; padding-left: 22px; font-size: 14.5px; }
.agenda li { margin-bottom: 6px; }
.detail .actions a {
  padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px;
  text-decoration: none; font-size: 14px; background: var(--bg);
}

/* timelines */
.subnav { display: flex; gap: 8px; margin: 14px 0 4px; }
.subnav a { padding: 5px 10px; border-radius: 999px; color: var(--muted); text-decoration: none; font-size: 12.5px; border: 1px solid var(--line); }
.subnav a.on { color: var(--ink); background: var(--accent-soft); font-weight: 600; }
.badge.stage { border-color: transparent; color: #fff; }
.badge.stage-filed { background: #4a6fa5; }
.badge.stage-scheduled { background: #2b7f92; }
.badge.stage-heard { background: #5b5f6b; }
.badge.stage-continued { background: #9a6b1f; }
.badge.stage-decided { background: #2f7d63; }
.badge.stage-withdrawn { background: #a1483f; }
.badge.stage-mentioned { background: transparent; border-color: var(--line); color: var(--muted); }

article.event.matter h4 { font-size: 16px; }

ol.timeline { list-style: none; margin: 22px 0 0; padding: 0 0 0 4px; }
ol.timeline .step { display: grid; grid-template-columns: 104px 1fr; gap: 16px; position: relative; padding-bottom: 20px; }
ol.timeline .step::before {
  content: ""; position: absolute; left: 111px; top: 8px; bottom: -8px; width: 1px; background: var(--line);
}
ol.timeline .step:last-child { padding-bottom: 0; }
ol.timeline .step:last-child::before { display: none; }
ol.timeline .step .when {
  font-size: 12.5px; color: var(--muted); text-align: right; padding-top: 2px;
  font-variant-numeric: tabular-nums;
}
ol.timeline .step .what { padding-left: 14px; border-left: 1px solid transparent; }
ol.timeline .step .what > a { font-size: 15px; font-weight: 600; text-decoration: none; margin-left: 6px; }
ol.timeline .step .what > a:hover { text-decoration: underline; }
ol.timeline .step .meta { margin-top: 6px; }
@media (max-width: 620px) {
  ol.timeline .step { grid-template-columns: 1fr; gap: 4px; }
  ol.timeline .step::before { display: none; }
  ol.timeline .step .when { text-align: left; }
  ol.timeline .step .what { padding-left: 0; }
}
blockquote.evidence {
  margin: 8px 0 0; padding: 7px 11px; font-size: 13px; color: var(--muted);
  background: var(--bg); border-left: 2px solid var(--line); border-radius: 0 6px 6px 0;
}
ul.matterlinks { list-style: none; margin: 0; padding: 0; font-size: 14.5px; }
ul.matterlinks li { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
ul.matterlinks .count { font-size: 12.5px; color: var(--muted); }
form.inline { display: inline; }
form.inline button, .detail .actions button {
  padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; font: inherit;
  font-size: 14px; background: var(--bg); color: var(--ink); cursor: pointer;
}

/* derived readings — deliberately set apart from the record */
.derived {
  margin-top: 22px; padding: 16px 18px; border: 1px dashed var(--warn-line);
  border-radius: var(--radius); background: var(--warn-bg); color: var(--warn-ink);
}
.derived h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 8px; }
.derived .count { color: inherit; opacity: 0.85; font-size: 12.5px; margin: 0 0 12px; }
.derived .derived-item + .derived-item { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--warn-line); }
.derived .derived-item p { margin: 6px 0 0; font-size: 14px; }
.pill.warn { border-color: var(--warn-line); }

/* map */
.mapwrap { margin-top: 26px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
.mapwrap svg { display: block; width: 100%; height: auto; max-height: 68vh; }
.mapwrap svg .pin { cursor: pointer; }
.mapwrap svg .pin circle { stroke: var(--panel); stroke-width: 1.5; }
.mapwrap svg .pin:hover circle { stroke: var(--ink); }
.mapwrap svg .frame { fill: var(--bg); stroke: var(--line); }
.mapwrap svg .grid { stroke: var(--line); stroke-width: 0.5; opacity: 0.55; }
.mapwrap svg .townline {
  fill: var(--accent-soft); fill-opacity: 0.55;
  stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round;
}
.maplegend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 12.5px; color: var(--muted); }
.maplegend span { display: flex; align-items: center; gap: 5px; }
.maplegend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.nearby-search { max-width: 660px; margin: 0 0 9px !important; }
.nearby-coverage { margin: 0 0 14px; }
.nearby-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(280px, .8fr); gap: 18px; align-items: start; }
.nearby-grid .mapwrap { margin-top: 0; position: sticky; top: 16px; }
.nearby-grid .mapwrap svg { max-height: 62vh; }
.map-note { margin: 10px 0 0; font-size: 12px; }
.nearby-list { display: flex; flex-direction: column; gap: 8px; max-height: 72vh; overflow: auto; padding-right: 3px; }
.nearby-card { padding: 13px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.nearby-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.nearby-card h2 { font-size: 15px; line-height: 1.3; margin: 5px 0 4px; }
.nearby-card h2 a { text-decoration: none; }
.nearby-card h2 a:hover { text-decoration: underline; }
.nearby-card p { margin: 3px 0; font-size: 12.5px; color: var(--muted); }
@media (max-width: 860px) {
  .nearby-grid { grid-template-columns: 1fr; }
  .nearby-grid .mapwrap { position: static; }
  .nearby-list { max-height: none; overflow: visible; }
}
@media (max-width: 560px) {
  .brand .util { flex-basis: 100%; }
  nav.primary { gap: 16px; }
  nav.channels { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 1px; }
  nav.channels a { white-space: nowrap; }
}

/* accounts */
.interest-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.interest-choice { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); text-decoration: none; }
.interest-choice:hover, .interest-choice:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
.match-reason { margin: 20px 0 5px; color: var(--accent); font-size: 12px; overflow-wrap: anywhere; }
main { min-width: 0; }
form.search select { max-width: 100%; }
.authform { max-width: 380px; }
.authform label { display: block; font-size: 12.5px; color: var(--muted); margin: 14px 0 4px; }
.authform input {
  width: 100%; padding: 8px 10px; font: inherit; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink);
}
.authform button {
  margin-top: 18px; padding: 9px 18px; font: inherit; font-size: 14px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 8px; background: var(--accent-soft); color: var(--ink);
}
.formerror { margin-top: 14px; color: #a1483f; font-size: 13.5px; }
/* Something that went right but is not a sign-in — "check your email". Not red:
   it would read as a failure, and the account was created. */
.formnotice { margin-top: 14px; color: var(--accent); font-size: 13.5px; }
.subscription { display: flex; align-items: center; gap: 10px; justify-content: space-between;
  border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; font-size: 14px; }
.subscription form { margin: 0; }
.subscription button { font-size: 12.5px; padding: 4px 10px; }

footer.site { margin-top: 46px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
footer.site a { color: var(--muted); }
footer.site p { margin: 4px 0; }
`;
