# SCSASM 2026 — Interactive Scientific Program

A finished static agenda for **Friday, April 17 through Sunday, April 19, 2026**, built with semantic HTML, plain CSS and vanilla JavaScript. It can be hosted directly on GitHub Pages in a domain root **or** a project repository subdirectory. There are no client-side frameworks, secrets, API keys, installation steps or build process.

**Data status:** The first request on every page load goes to the published Google Sheets CSV in `script.js`. If that fetch fails, times out, is blocked by CORS, or has an invalid schema, the site falls back to `data/agenda-snapshot.csv` and clearly displays its origin and date. A successfully loaded published CSV is identified by the interface, but Google's publication cache may delay changes. **The live URL's network access and cross-origin permissions could not be verified from this development environment.**

## Deliverable files

| Path | Purpose |
| --- | --- |
| `index.html` | Semantic header, date tabs, search, filter controls, time/room grid container and modal markup |
| `style.css` | Responsive theme, layout, multi-room timeline styles, card accents and dialog accessibility styles |
| `script.js` | Live CSV download, robust parsing, validation, normalization, filtering, overlapping session geometry and interactions |
| `data/agenda-snapshot.csv` | Checked-in fallback generated directly from the supplied Excel workbook |
| `data/snapshot-metadata.json` | Snapshot origin, timestamp and validated source counts, displayed in the fallback notice |
| `.github/workflows/sync-agenda.yml` | **Optional** daily/manual GitHub Actions job to refresh and commit a validated CSV fallback |
| `tools/sync_live_csv.py` | Optional no-dependency Python downloader/validator for the GitHub Actions workflow |
| `tools/export_workbook.py` | Developer-only Python script to re-export an updated `.xlsx` into the fallback (requires `openpyxl`) |
| `tools/test_model.js` | Developer-only Node.js model/parser validation; Node.js is **not** required to host the site |
| `tools/smoke_browser.py` | Developer-only Playwright/Chromium UI smoke test with simulated fetches; browser tooling is **not** required by visitors |

## Publish on GitHub Pages

1. Create a GitHub repository (for example, `scsasm-2026-program`).
2. Upload **the contents of this folder** into the repository root, retaining the `data/` directory. Include the `.github/workflows/` directory only if you want automatic fallback updates.
3. Commit all files. Open **Settings → Pages** and under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/(root)`, and save.
4. Visit `https://YOUR-USERNAME.github.io/scsasm-2026-program/` (or your custom domain). Allow a minute for the first build.
5. Inspect the data-status label. In a fresh/incognito session, select all three dates, search for a presenter, open a session and test the filters.

The HTML links use `./style.css` and `./script.js`, and the snapshot fetches use `./data/...`, so moving this folder to a subdirectory does not break the paths. Do not double-click `index.html` as a `file://` URL to test it: browsers may block CSV `fetch` from `file://`. Instead, use GitHub Pages or a local HTTP server:

```sh
cd SCSASM_2026_Agenda
python -m http.server 8000
# Open http://localhost:8000/
```

## Publishing and updating the schedule

The published CSV address is defined once in `script.js` as `SOURCE_URL`:

`https://docs.google.com/spreadsheets/d/e/2PACX-1vR7XZFOcEKOxCsw8Yb1LJpdSj_VUhncQMaGqTIOW19PRN1jr9Df4b_-_hmJ7dOHvUUXe4dCezqVn2Hd/pub?gid=0&single=true&output=csv`

The CSV is fetched over HTTPS **once on each initial page load**, with an 8.5-second timeout. Changing a day, search or filter does not fetch again. The request uses browser CORS (`mode: 'cors'`); a CSV link that works when pasted directly into a browser does **not** prove that a cross-origin `fetch` from GitHub Pages will work. No proxy is used.

To check whether live updates work:

1. Open the published site in an incognito window, then open browser **Developer Tools → Network**.
2. Reload and inspect the `docs.google.com/...output=csv` request, including its HTTP status, redirects, **Access-Control-Allow-Origin**, and any Console CORS errors.
3. Inspect the visible data badge and notice: **Published Google Sheets CSV** means a client-side fetch returned a validated CSV during this page load; **Local snapshot · not live** means the local data was used instead.
4. Make a known, legitimate spreadsheet change, **publish** it, allow for Google Sheets caching, then reload with DevTools open. Confirm the published CSV actually contains the change; compare with the displayed session.
5. If CORS fails, leave the fallback in place and enable the optional GitHub Actions sync below. It downloads server-side at build time, keeps a validated copy in the repository, and requires no third-party proxy or visitor credentials.

### Recommended fallback refresh with GitHub Actions (optional)

The workflow `.github/workflows/sync-agenda.yml` can run daily at 03:15 UTC or be started manually in **Actions → Refresh SCSASM agenda fallback CSV → Run workflow**. It downloads the exact published Google URL with Python's standard library, validates critical headers and source row counts before replacing files, and commits updated CSV and metadata only if content changed. A failed fetch or malformed CSV raises an error **without overwriting the last good snapshot**.

GitHub Actions needs permission to write repository contents (`permissions: contents: write` in the workflow); your repository settings must allow the Actions token to create commits. Publication caching also applies to this downloaded source. GitHub scheduled runs can be delayed or disabled for inactive repositories. If the published URL stops working, investigate and update `SOURCE_URL` in `script.js` and `URL` in `tools/sync_live_csv.py` to match the confirmed link.

### Updating the fallback from a revised Excel workbook

Use the same 19-column sheet structure as the supplied source. In a development environment with Python:

```sh
python -m pip install openpyxl
python tools/export_workbook.py "/path/to/SCSASM 2026 - WEB PAGE TEST.xlsx"
node tools/test_model.js  # optional QA; adapt expectations if the source changes
```

The export script preserves supplied speaker names, biographies, session descriptions, exact date/time strings and role assignments; it does not invent missing content. Commit the updated `data/` CSV and metadata files, then reload GitHub Pages. If the live CSV is accessible, it will continue to take precedence over this local snapshot.

## Source workbook and model verification

The provided `SCSASM 2026 - WEB PAGE TEST (1).xlsx` contains one worksheet, 19 columns and 198 populated data rows. Its exact column headers are:

```text
Title | First Name | Last Name | Position | Organization | Biography
Session - Name | Session - Details | Session - Date | Session - Start Time
Session - End Time | Session - Location | Session - Type | Session - Track
Paper Title | Presentation Status | Presentation Type
Presentation Start Time | Presentation End Time
```

Normalized from this uploaded workbook and verified against its rows:

| Day | Unique session instances |
| --- | ---: |
| Friday, April 17 | 1 |
| Saturday, April 18 | 20 |
| Sunday, April 19 | 8 |
| **Total** | **29** |

The model also contains **127 distinct titled presentation/program-item groups** and **21 role/team groups**, grouped from the original 198 rows. The filter options are dynamically derived from the source: **seven rooms**, tracks **1–5**, plus **Unassigned**. Thirty workbook rows have no assigned track; those sessions remain visible when Track is unrestricted.

### How the data is grouped

- **Session identity:** case-normalized session name + source date + source start + source end + room. This prevents two different sessions with the same title on different dates/rooms from being merged. **Limitation:** two genuinely separate sessions with *all* five matching values cannot be distinguished without a unique source session ID; add one to the source and adjust the grouping logic if that case arises.
- **Presentation/program-item identity:** within each session, title + presentation start + presentation end + status; multiple people who share one talk are attached to a **single** presentation. An item's `Presentation Type` stays attached to each person and the group, even when it varies across rows. **Limitation:** genuinely separate same-title/same-time/same-status presentations within one session require a source-specific ID to avoid grouping.
- **Session roles/teams:** when `Paper Title` is exactly **Judge**, **Panelist**, **Moderator**, a chair-role label, or begins **Team …**, it is treated as a **role/group rather than a paper**. The role label and corresponding people, types, biographies and actual role times (if any) appear under *Session roles & teams*. For example, judges in free-paper sessions are not fabricated as talks. Other titled segments (e.g., opening remarks, case discussions) remain in *Presentations & program items*.
- **Repeated speaker appearances:** the same person can appear in several talks and sessions. Person duplicates are removed only when the name, organization **and** source type are identical inside the same item.
- **Missing detail:** blank affiliations, biographies and tracks are never invented. If an item has no presentation-specific times, its details state **Time not specified** rather than borrowing the parent session time.
- **Source session notes:** line-break HTML such as `<br>` is converted into readable text; arbitrary CSV content is never inserted into the page as executable HTML.

### How the timeline works

- A shared minute-to-pixel scale positions every session by its published local **wall-clock time**, never the visitor's browser timezone. Heights match session durations; hour/half-hour ticks align across every room lane.
- On **Saturday, April 18, 10:30 AM–12:00 PM**, **S02 — The Great Echo Debates** and **S05 — 2026 Updates in Cardiology** both occupy **Grand Ballroom**. The overlap algorithm places them **side by side**, not on top of one another. Other overlapping periods are handled by the same algorithm.
- Vertical and horizontal scrolling are kept inside the timeline frame, with a sticky time gutter and sticky room headings. On desktop, small numbers of rooms expand to use available width; on phones room columns remain horizontally scrollable.
- Track multi-selection uses OR, Room multi-selection uses OR, and the two categories combine with AND. Date and case-insensitive search (session, participant, organization and item) further restrict the result. Filters and search persist across dates. **Clear filters** keeps the date.
- Invalid/missing session times appear under **Sessions without valid times** if they still have a valid date/name. Ambiguous or invalid source dates cannot be assigned to a day; those records are reported in a source-data warning instead of being silently treated as another date. Unmistakable evening-to-early-morning intervals are treated as overnight and labeled **next day**.
- Short cards remain keyboard-focusable and their full content is accessible in the details dialog. Ultra-short sessions in future source data may produce narrow-duration-height cards; their usability should be checked after updates.

## Look and branding

The page takes the **general information architecture** of the ICSES 2026 scientific-program site as inspiration (search/filter/date navigation and session details) without copying its assets, logos or code. The SCSASM header is **typographic only**; no official logo was supplied. All key CSS tokens—backgrounds, accents, spacing, border radii, type families and Track 1–5 colors—are near the top of `style.css` in `:root`. Edit those variables to apply approved SCSASM brand colors or fonts later. No third-party web fonts or trackers are used.

## Testing and remaining limitations

**Actually performed in the development environment:**

- Inspected the exact workbook header names, per-row source values, missing fields, dates, tracks, rooms, presentation times and role types with `openpyxl`.
- Validated that **198 rows → 29 sessions**, with **127 titled program items** and **21 role/team groups**, and verified overlap allocation and no fabricated presentation times in the model.
- Executed `node tools/test_model.js` for CSV quoting/commas/newlines/BOM/blanks, date/time parsing, source counts, role and presentation grouping, same-room overlap and relative links.
- Executed `python tools/smoke_browser.py` against Chromium with a **controlled simulated fetch** (the runtime forbids Chromium network navigation). The UI rendered on desktop and a 390px mobile viewport, including the fallback notice, all date tabs, session detail open/close, search, Track/Room selection and mobile horizontal scrolling. Console JS errors: **none in this test**.
- Viewed rendered desktop and mobile screenshots for visual layout and containment. The reference ICSES page's textual search/filter shell was fetched, but its full visual layout could not be inspected reliably here.

**Not yet verified and should be checked after publishing:**

- The real Google Sheets **CORS response from your GitHub Pages origin**, publication timing/redirects and changes to its source headers.
- Real-world GitHub Actions server-side access to the Google-published CSV and repository write permissions.
- Live deployment across Chrome, Safari, Firefox, iPad and Android devices; touch behavior, high-contrast mode, screen-reader announcements and an external accessibility audit.
- Any last-minute changes in the underlying program since the supplied workbook was exported. **The local fallback is a dated snapshot, not a promise that the agenda is currently accurate.**

For the most accurate deployment check, test on the final GitHub Pages URL—not only with local simulation. If there is an official venue timezone or approved SCSASM logo, it can be added after it is confirmed; none has been invented in the site.
