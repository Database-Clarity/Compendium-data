# Compendium data publisher

Source for the separate public `Database-Clarity/Compendium-data` repository.
That repository's default `main` branch holds `runner.mjs`, bundled `parser.mjs`,
this README, `parser-source.txt`, `compendium.json`, and
`.github/workflows/compendium.yml`. It does not touch the live description database.

The Action runs daily at 05:17 UTC and on demand. GitHub schedules can be delayed.
The runner fetches the Landing htmlview to discover all tabs, then parses each
tracked tab using the editor core parser. Tab names containing literal uppercase
`OLD` are excluded case-sensitively; `Old` and `old` remain eligible.
A failed fetch, invalid schema, unknown layout
or empty non-Landing tab fails the entire run without replacing the old data.
Landing is a navigation-only tab. Other tabs support ordinary/parallel tables,
row-spanned names/descriptions, and artifact cards with their descriptions on
the following row. Config overrides are in the editor core's Compendium config.

Only content changes produce a commit; `fetchedAt` is the last changed dataset's
fetch time, not proof of the most recent unchanged run. The editor polls the
Actions status as well as this timestamp so an unchanged refresh can complete.
No class names, raw HTML, scripts or arbitrary CSS are stored in the dataset.
The bundled parser's MIT third-party notices must remain in `parser.mjs`.

## Updating the parser

From a reviewed, committed editor checkout, with dependencies restored:

```powershell
npm exec esbuild -- scripts\compendium\parser-entry.ts --bundle --platform=node --format=esm --legal-comments=inline --outfile=scripts\compendium\dist\parser.mjs
```

Copy the result and `runner.mjs` into the data repository; record the exact editor
commit in `parser-source.txt`. Copy this workflow to
`.github/workflows/compendium.yml`. Review, test and explicitly approve publishing
that commit separately from editor integration. The published runner needs only
Node 24: no install, npm credentials or runtime dependencies.

```powershell
node runner.mjs compendium.json
```

The repository must allow Actions to write contents. Install the editor GitHub
App on **both** the authored database and this repository, with Actions read/write
and Contents read/write permissions. Never grant the web client an installation
token. Refresh requests are checked against the authored database's current
editor/maintainer roles by the Worker.

## Full grid and manual descriptions

Each tab includes `grid`: non-empty cells with one-based row, zero-based column,
normalized styled runs and optional row/column spans. Merged cells are stored once;
lookup resolves every covered coordinate. Parsed names carry their name-cell anchor.
Human `cells: [{dRow,dCol}]` offsets follow that anchor, including across tab moves.
Empty/missing targets or two offsets into the same merged cell require relinking.
The editor displays all columns within eight rows of the chosen anchor, supports
full-tab text search for arbitrary anchors, and previews cells in click order.
Selections create local drafts and use the normal save/conflict flow.

Same-name rows (including trailing weapon-type qualifiers) combine in sheet order
with bold labels and blank separators. `parts` records the labels; human cell
choices override automatic parts. Explicit section/category boundaries stay ambiguous.

Reproduce grid size from the cached acceptance HTML after bundling the parser:

```powershell
node scripts/compendium/measure-grid.mjs "$env:TEMP" scripts/compendium/dist/compendium-grid.json 2026-10-27T13:54:07.043Z
```

October 31 check using October 27 cached HTML: 16 tabs, 1,598 parsed rows,
4,520 grid cells; JSON 8,021,786 bytes (gzip 930,633 bytes). This is below the
15 MB split/gzip threshold. The measurement tool refuses larger output pending
a delivery change. These counts do not prove the current live sheet is unchanged.
`test/compendium/fixtures/intrinsic.json` in core contains real Aggressive Frame
rows 315–319 and nearby grid cells extracted from that cached Weapon Perks HTML.
