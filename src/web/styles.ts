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

nav.channels { display: flex; gap: 4px; flex-wrap: wrap; margin: 16px 0 0; }
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

form.search { display: flex; gap: 6px; margin-bottom: 22px; }
form.search input {
  flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink);
}
form.search button {
  padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink);
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

footer.site { margin-top: 46px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
footer.site a { color: var(--muted); }
footer.site p { margin: 4px 0; }
`;
