# brain.md — orientation for this repo

Written for a first-time contributor. Documents how the app is put together and the
non-obvious decisions behind it, not a restatement of the code.

## What this is

A single marketing/product landing page for **9 Foundations**' data-center offering
("The Hidden Economics of Healthy Data Centers"). It argues one thesis end to end:
*find the building → pick the filter → simulate the building → verify the building*,
mapped to four product sections: **Virginia Data Center Inventory → FilterStudio →
MATRIX → H.E.A.A.L.**

It is a hand-authored static site. There is no framework, no bundler, no package.json,
no npm scripts, no server code anywhere in the repo.

## How to run it

There is no build step. Two options, in order of preference:

```bash
npx serve .
```

or, just as valid, open `index.html` directly in a browser (double-click / `open index.html`).
A local server is only needed to avoid `file://` CORS oddities in some browsers — the page
has no server-side dependency either way.

There is nothing to `npm install`. The only external dependencies are loaded from CDN at
runtime (see below), so an internet connection is required to see the map, charts, and fonts
render correctly.

## File structure (root — this is the live site)

- **`index.html`** — the entire page markup. All content lives in one file, organized as
  `<section id="...">` blocks: `hero`, `inventory`, `filterstudio`, `matrix`, `heaal`, `cta`.
- **`app.js`** — a single IIFE (`(function () { "use strict"; ... })()`), ~3,100 lines.
  No modules, no imports. Organized as one big set of section-scoped closures, each with its
  own `renderX()` / `buildX()` functions (e.g. `renderMap`, `renderHistograms`,
  `buildArchetype`, `renderCostReadout`, `renderSpaceTime`, `renderTimeseries`, `renderGrid`).
  Shared utilities at the top: `$`/`$$` (querySelector shorthands), an `fmt` object for
  number/currency formatting, and a seeded Mulberry32 RNG (`rng(seed)`) used so animated/
  randomized visuals are reproducible across reloads rather than truly random.
- **`data.js`** — sets `window.NINEF_DATA`. A single-line JSON literal: **389** Virginia data
  center sites (`sites[]`) plus a `summary`. As of commit `992470d` ("update to match latest
  run") this was regenerated from `building_parameter_inputs.csv` (a newer/updated model run;
  the file itself is *not* checked in — see the CSV-recovery note below), superseding the
  original 412-site `parameterised_va_data_centers_V2.csv` build. `county`/`egrid` per site were
  carried over unchanged from the prior derivation (same PEC_ID/lat-lng-based method, just
  reused rather than re-run, since the new CSV's site set is a strict subset of the old one —
  23 sites present in the old run were dropped, not carried forward). Each site also now
  carries `filters_low`/`filters_high` alongside the mid-estimate `filters` — a confidence
  interval, currently unused by any chart/tooltip (flagged in `TODO.md`).
- **`matrix-data.js`** — sets `window.MATRIX_DATA`. A curated 8-building sample "trimmed to
  fields the marketing surface actually displays," per its header comment, sourced from a real
  MATRIX package (`summary_arbitrage.json` / `summary_peakshaving.json`, not in this repo).
  The header explicitly warns: **do not regenerate this by hand** — treat it as a snapshot.
- **`pm-data.js`** (added in `e307c75`, "add real PM data") — sets `window.PM_DATA`. Real
  measured indoor PM2.5 for FilterStudio's two case studies × two filters, one operating year
  (8,759 hourly readings) bucketed into 60 windows of `{ mean, min, max }` for plotting. This
  replaced an earlier synthetic placeholder (`pmSeries()` in `app.js`, now deleted) that just
  wobbled a sine wave + seeded noise around a single `pmMean` scalar — if you're ever asked
  whether the Indoor PM chart's underlying data needs updating again, the answer is "only if
  `pm-data.js` needs regenerating," not "edit a formula in `app.js`."
- **`iso-tower.js`** (added in `054193b`, "usability stuff and fix HEAAL building plot") — a
  standalone, reusable D3 v7 component, `renderIsometricStack(containerSelector, data, config)`,
  that draws the isometric 5-level "building stack" visual shared by the MATRIX and H.E.A.A.L.
  tower charts. Its geometry is ported directly from the team's R/ggplot `building_outline()`
  helper so it matches that reference exactly — this replaced two separate hand-rolled
  tower-drawing functions in `app.js` (`drawPpTower`, `drawTower`) that had drifted from the R
  reference shape; both are now thin wrappers (`drawPpTowerIso`, `drawTowerIso`) around the one
  shared component. If either tower ever looks geometrically "off" again, fix it once in
  `iso-tower.js`, not in both call sites.
- **`styles.css`** — ~3,400+ lines, one file, no preprocessor (no Sass/Less/PostCSS).
- **`assets/`** — logos (`assets/*.png`, `assets/9f-logo.svg`) and two large image sequences
  used as visual "panels": `assets/heaal/*.webp` and `assets/matrix-panel/*.webp`.
- **`TODO.md`** — an untracked (not committed — see `git status`), local-only running punch
  list. Currently tracks: (1) whether the pressure-drop chart also needs real data like the PM
  chart got, and (2) an app-wide inconsistency in how point estimates vs. confidence intervals
  are surfaced — partially addressed by the `fs__headline-range` tooltip pattern below, but not
  resolved everywhere.

### Script/data loading order (from `index.html`)

`data.js`, `matrix-data.js`, and `pm-data.js` load first (assigning `window.NINEF_DATA` /
`window.MATRIX_DATA` / `window.PM_DATA`), then D3 and topojson from CDN (`cdn.jsdelivr.net`,
pinned versions: `d3@7.9.0`, `topojson-client@3.1.0`, both `defer`), then `iso-tower.js`
(defines the global `renderIsometricStack` function), then `app.js` last, which reads all of
the above to render the map/charts. There's no other runtime dependency.

### Typography decision (documented inline in `index.html`)

Jost (Google Fonts) stands in for 9F's actual brand pair (Avenir display + Century Gothic
body) because those aren't freely licensable web fonts — Jost is a geometric sans in the
same Futura/Avenir tradition and covers both registers at different weights. JetBrains Mono
is kept for technical/tabular labels (axis ticks, key/value pairs, eyebrows).

## `v2/` — a frozen snapshot, not an active branch of work

`v2/index.html`, `v2/app.js`, `v2/styles.css` mirror the root files but are meaningfully
smaller (app.js 2,190 vs 3,082 lines; styles.css 2,122 vs 3,392 lines) and have not been
touched since the single commit that created them (`4dba24f`, "...v2 design-system clone").
Every commit since has only modified the root files. Treat `v2/` as a **reference/clone
checkpoint from one point in time**, not a parallel version to keep in sync or a place to make
new changes — new work goes in the root files. (`data.js`/`matrix-data.js` under `v2/` are
byte-identical to root, confirmed via `diff`.)

## `explorations/` — abandoned design directions

Four self-contained prototype variants (`editorial/`, `instrument/`, `brand-v2/`,
`map-first/`), each with its own `index.html`/`app.js`/`styles.css`. These were one-off
design explorations (see commits like "Branding visual-system pass + 3 design explorations,"
"Instrument exploration," "Add explorations/brand-v2"). None have been touched since their
introduction — they're a design history/reference, not code that feeds the live page.

## `reviews/` — external/stakeholder review artifacts

Markdown write-ups from team/stakeholder review passes (e.g.
`team-review-2026-05-13-9f-datacenters-round2--detailed.md`,
`team-review-2026-05-15-website-rebuild-ui-ux.md`). These are feedback documents that drove
subsequent commits (many recent commit messages directly reference "Execute Feedback N" /
"Audit follow-up" — trace a commit back to the review that prompted it if you need the
"why" behind a UI decision). Read-only artifacts, not app code.

Note: `.gitignore` deliberately excludes brief/source documents (`9f_*brief.md`,
`*review*.md` outside this tracked set, `*.pdf`, `*.pptx`, `*.docx`, `*.csv`) — original
source materials (like the CSVs that produced `data.js`) live locally, not in git. **Caveat
learned the hard way**: `building_parameter_inputs.csv` (the source for the current 389-site
`data.js`) was accidentally deleted from disk during the regeneration work and could not be
recovered (no Trash copy, no Time Machine backup found) — the parsed/transformed output had
already been written into `data.js` before the deletion, so no *site data* was lost, but the
raw CSV itself is gone unless a copy exists elsewhere. If `data.js` ever needs to be
regenerated again with a different transformation, there is currently no raw source file to
regenerate it from — treat `data.js` as the source of truth until/unless a fresh CSV shows up.

## FilterStudio's data model, in one place

Almost everything in FilterStudio (`#filterstudio`) traces back to one hardcoded object,
`CASES`, in `app.js` (~line 650) — Case A/B site specs and Filter A/B stats (`pressureEnd`,
`pmMean`, `energyRecirc`/`energyVent`/`energyKwh`, `energyCost`, `dustHeld`, and now
`pmAxisCap`). Charts, the cost readout, and the site-characteristics block all render *from*
this object at load time — their HTML placeholders are overwritten by `render*()` calls, so
you generally only need to edit `CASES` itself, not the markup. Exception: the "Statewide
Co-Benefits" band above the case study ($ totals, GWh saved, and — as of `a481b81` — their
low–high range tooltips via `fs__headline-range`/`data-tooltip`) is separate static text in
`index.html`, not derived from `CASES`, and has to be kept in sync by hand.

`COBENEFIT_PER_MWH` (a constant near `CASES`, derived by hand from the statewide totals) is
currently commented out/dead — it was left that way after a numbers update rather than being
recomputed or deleted. Nothing else references it, so it's inert, but it still carries a stale
"412 sites · $2.83M climate..." comment. Worth deleting or recomputing next time someone's in
that area, rather than leaving it to confuse a future reader.

## Notable implementation decisions worth knowing before you touch things

- **"Component Intent Block" pattern** (commit `2ec439e`): each interactive product section
  has a `.intent` block (`role="note"`, `aria-live="off"`) that narrates, in plain language,
  what the interaction does and shows current selection state (e.g. `#intent-map`). This is a
  deliberate accessibility/legibility affordance — when adding a new interactive surface,
  follow this pattern rather than inventing a new one.
- **Truthfulness-over-polish is an explicit, repeated priority.** Multiple commits exist
  purely to remove interactions that looked real but weren't backed by real data/state:
  "MATRIX interaction truthfulness: demote inert chips, make clock + unit real," "MATRIX
  occupancy toggle: real state model, disable All Occupied (no source data)," "HEAAL
  truthfulness + chart fidelity." If a control doesn't have real underlying data, the
  established convention is to disable/relabel it rather than fake it.
- **Reproducible randomness**: any animated or seemingly-random visual behavior should go
  through the `rng()` Mulberry32 helper in `app.js`, not `Math.random()`, so behavior is
  stable across reloads.
- **No build/lint/test tooling exists.** There's nothing to run before committing beyond
  manually checking the page in a browser — treat visual/manual verification as the
  verification step for this repo.
- **A number that appears in more than one place has to be updated in every place — nothing
  is computed/derived across files at runtime beyond what's explicitly wired.** Several
  numbers exist as parallel hardcoded copies rather than being computed from one source: the
  inventory's counters/legend-defaults/histogram-range captions in `index.html` are static text
  that doesn't recompute itself from `data.js` (only the map/histogram *shapes* are genuinely
  data-driven); `NINEF_DATA.summary` in `data.js` is written but never actually read by
  `app.js`. When updating headline figures, grep for the old number across `index.html` and
  `app.js` rather than assuming one edit propagates.
- **Shared visual components are being extracted as duplication is noticed** (see
  `iso-tower.js` above) — prefer adding to/reusing an existing shared helper over copy-pasting
  a chart-drawing function for a new surface, matching the direction this codebase is already
  moving in.

## Quick map of the four product sections (in `index.html` / `app.js`)

| Section | `id` | Data source | Key `app.js` renderers |
|---|---|---|---|
| Virginia Data Center Inventory | `#inventory` | `data.js` (`NINEF_DATA`) | `renderMap`, `renderHistograms` |
| FilterStudio | `#filterstudio` | `CASES` object in `app.js` + `pm-data.js` (`PM_DATA`) | `buildArchetype`, `renderCostReadout`, `renderCaseHeader`, `pmBandChart`, `drawPpTowerIso` (→ `iso-tower.js`) |
| MATRIX | `#matrix` | `matrix-data.js` (`MATRIX_DATA`) + `assets/matrix-panel/*.webp` | `build`, `renderGrid`, `renderBuilding`, `renderBins`, `renderSpaceTime`, `renderTimeseries` |
| H.E.A.A.L. | `#heaal` | inline/hardcoded + `assets/heaal/*.webp` | `renderBins`, `renderCards`, `renderLiveVals`, `drawTowerIso` (→ `iso-tower.js`) |

Both `drawPpTowerIso` (MATRIX) and `drawTowerIso` (HEAAL) are thin wrappers that just build a
`{k, letter, label, color, text, value}[]` layer array and hand it to the shared
`renderIsometricStack()` in `iso-tower.js` — the actual isometric-drawing logic lives in one
place, not two.

## Key changes since this file was first written

This doc was originally written against commit `fea5731`. Everything below happened after,
and is folded into the sections above — this is just the delta, for anyone who read the
original version and wants to know what moved:

- **Inventory data regenerated wholesale**: 412 sites → 389, from a new source
  (`building_parameter_inputs.csv`) instead of the original `parameterised_va_data_centers_V2.csv`.
  Every static count/range in `index.html` that mirrors this data (counters, legend defaults,
  histogram captions, prose mentions) was hand-synced to match. New `filters_low`/`filters_high`
  fields were added to each site but aren't surfaced in the UI yet.
- **FilterStudio's `CASES` numbers were fully replaced** with a new modeling run's figures
  (pressure, PM, energy, cost, dust-held — both cases, both filters), and the "Statewide
  Co-Benefits" band totals were updated to match (energy saved changed units, MWh/y → GWh/y).
- **The Indoor PM₂.₅ chart went from synthetic to real data.** It used to be a sine wave +
  seeded noise wobbling around one `pmMean` number; it's now driven by real bucketed
  measurements in `pm-data.js` (`PM_DATA`), rendered as a mean line + min/max band
  (`pmBandChart`), with a per-case y-axis cap (`pmAxisCap`) that lets outlier spikes clip off
  the top of the frame rather than rescale the whole chart.
- **Low–high ranges + tooltips added to the Statewide Co-Benefits band** (`fs__headline-range`
  / `data-tooltip`), explaining what each range does and doesn't account for (filter-count
  sensitivity vs. underlying cost/valuation uncertainty) — a first pass at the
  point-estimate-vs-confidence-interval problem `TODO.md` flags as still inconsistent
  app-wide.
- **HEAAL's and MATRIX's isometric building/tower visuals were unified and fixed.** Two
  separate hand-rolled drawing functions (`drawTower`, `drawPpTower`) had drifted from the
  team's R/ggplot reference shape; both were replaced with wrappers around one new shared
  component, `renderIsometricStack()` in `iso-tower.js`, ported directly from the R geometry.
  Assorted usability fixes rode along in the same commit (FilterStudio cost tiles are now
  keyboard-operable toggles; a redundant case-A/B chip pair was added next to the archetype
  figure).
- **The "KEY INSIGHT #1/#3/#6" labels on FilterStudio's three charts were simplified** to just
  "KEY INSIGHT" — the numbers were deliberate deck-recognition callbacks (see the review doc
  in `reviews/`) but read as broken/missing-numbers to anyone who hadn't seen the original
  deck, so they were dropped rather than explained.
- **Incident**: the source CSV behind the inventory regeneration was accidentally deleted
  mid-task and could not be recovered (no Trash/Time Machine copy). No data was lost — the
  parsed output had already landed in `data.js` — but there's currently no raw file to
  regenerate from if the transformation ever needs to change. See the CSV-recovery note
  earlier in this doc.
