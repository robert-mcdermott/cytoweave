# CytoWeave design

This document explains how CytoWeave is built and why. For code conventions
and the data model, see `conventions.md`. For how views are put together, see
`ui-conventions.md`. For the market, the methods and the standards behind
these choices, see `research.md`.

## Goals

1. **Correct numbers.** Every result must agree with the method it
   reimplements and with the standards (FCS, Gating-ML, FlowJo's scales), and
   that agreement must be checked automatically (`validation/`).
2. **The everyday workbench, fast.** Gating, compensation, statistics and
   figures for conventional, spectral and mass cytometry. Built for 30+
   samples and millions of events, without a license server, account,
   install step or plugin dependencies.
3. **Trust in the analysis, not just the result.** Show how sensitive each
   number is to analyst choices: where a gate was drawn, which matrix was
   used, how faithful an embedding is. Show what changed between two versions
   of an analysis.
4. **Local and private.** Files stay on the user's computer. Nothing is
   uploaded.
5. **Open.** Apache-2.0, no third-party runtime dependencies, standard
   formats in and out.

## Architecture

```
┌──────────────────────────── cytoweave (one Go binary, stdlib only) ───────────────────────────┐
│ main.go      flags, startup, single-instance forwarding, /api/info, /api/open                │
│ security.go  loopback-only, Host-header check, same-origin API, CSP, COOP/CORP headers       │
│ local.go     files named on the command line, served read-only by index                      │
│ store.go     workspace library: workspaces/*.json, files/<sha256>.fcs, trash/                │
│ window.go    app window (Chrome/Edge/Brave --app, own profile) or default browser            │
│ remote.go    remote-control hub (SSE to the page, actions from local programs)               │
│ mcp.go       `cytoweave mcp`: Model Context Protocol server on stdio, driving the hub         │
│ embed web/   ───────────────────────────────────────────────────────────────────────────┐    │
└──────────────────────────────────────────────────────────────────────────────────────────│────┘
                                                                                           ▼
┌──────────────────────────────────────── browser ─────────────────────────────────────────────┐
│ web/app.js        shell, modes, import dispatch, commands, shortcuts                         │
│ web/ui/*.js       views and components (the only code that touches the DOM)                  │
│ web/workers/*.js  module workers: FCS parsing, QC, spectral, clustering, embeddings, examples│
│ web/lib/*.js      pure analysis modules (no DOM), shared by page, workers, Node tests and     │
│                   the validation suite                                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why all analysis runs in the browser

- **One implementation everywhere.** The same modules run in the desktop
  program, on a static web server (no backend), in Node for tests and
  validation, and in workers for heavy work.
- **No upload step and no server state.** The Go host only serves files and
  stores the library.
- **Easy to install.** No Python or R, and nothing that is broken by the next
  OS update.
- **Fast enough.** Typed arrays, lookup-table transforms, memoized
  populations and workers handle ten million events per sample (see "Large
  samples" below). WebGPU can later accelerate hot loops (unmixing, kNN,
  SOM), but every algorithm keeps a CPU path, because WebGPU availability
  still varies by browser and OS.

### The Go host

- **Network exposure.** It binds to 127.0.0.1 by default. Every request's
  Host header must name a loopback address, which blocks DNS rebinding. API
  calls must be same-origin. Responses carry a strict Content-Security-Policy
  (pages connect only to the host and to Cirro's hosts: `*.cirro.bio`,
  `*.amazoncognito.com`, `*.amazonaws.com`; with `--no-cirro`, to the host
  alone, and `/api/info` says so, so the page offers no Cirro)
  and `X-Content-Type-Options`, Cross-Origin-Opener- and Resource-Policy
  `same-origin`, and Cross-Origin-Embedder-Policy `require-corp`. The last
  two make the page cross-origin isolated, which allows shared memory with
  workers.
- **Single instance.** A second launch forwards its files to the running
  instance (`/api/open`) instead of starting another server.
- **App window.** `--window app` opens a chromeless Chrome/Edge/Brave/Chromium
  window with a dedicated profile. Closing it stops the server unless
  `--keep-running` is given.
- **Library.** The library stores each FCS file once, under its SHA-256. A
  workspace refers to files by hash, so it never breaks when files move.
  Derived per-event results (cluster labels, embeddings, unmixed abundances,
  QC masks) are stored the same way. The host computes the hash while it
  writes a file: an uploaded file (`POST /api/library/files`), or a file
  named on the command line, which it copies itself
  (`POST /api/library/local/{index}`). The browser streams the upload from
  disk and never holds or hashes the file. Stored files are served with
  range requests.
- **Static hosting.** With no host, `web/ui/storage.js` switches to the
  browser's origin-private file system, falling back to IndexedDB for
  workspaces. Nothing in `web/` requires the host.

## The analysis pipeline

```
FCS bytes ─parseFCS→ columns (Float32, linear scale values)
          ─compensate (S⁻¹) or unmix (M⁺)→ compensated columns       [SampleView cache]
          ─transform (logicle/biex/arcsinh/…)→ scaled columns ∈ ~[0,1] [SampleView cache]
          ─gates (in their own scale space)→ populations (EventSet)       [memo by gate-chain hash]
          ─statistics / plots / algorithms
```

### Data and precision

- **Storage.** Event data are kept as column-major `Float32Array`s, the
  precision of most FCS files. On a cross-origin isolated page they live on
  `SharedArrayBuffer`s (`web/lib/memory.js`), so workers read them without a
  copy.
- **Arithmetic.** Accumulators, matrices and transform constants are
  `Float64Array` or plain numbers.
- **Integer files.** Integer data are converted to linear scale values on
  read, applying `$PnE`, `$PnG` and bit masks per FCS 3.1 / 3.2.

### Transforms

- **Contract.** A transform maps data to a display coordinate that is about 0
  at the bottom of the axis and 1 at the top. This is the Gating-ML 2.0
  convention, so gates written in it are portable.
- **Logicle and hyperlog.** These follow the Moore & Parks reference
  implementation, which Gating-ML requires: Taylor series near zero, Halley
  iteration, reflection for negatives. Arcsinh, Gating-ML fasinh, log and
  linear are also provided.
- **FlowJo biex.** Biex is FlowJo's legacy table algorithm, reproduced
  exactly (see `validation/README.md`), not approximated by a logicle.
- **Speed.** Per-event transforms of logicle, hyperlog and biex use a dense
  lookup table with linear interpolation (≈ 1e-7 of the axis), so a million
  events take milliseconds.
- **Bounds.** A transform may carry Gating-ML's `boundMin`/`boundMax`, which
  clamp its output.

### Gates

- **Geometry space.** Gate geometry lives in the gate's own scale space, with
  a `{channel, transform}` per dimension, as in Gating-ML. A gate keeps its
  meaning when a plot's axes change, and imports and exports without loss.
- **Boundary semantics** follow Gating-ML: rectangles and ranges are
  half-open `[min, max)` (an open upper side still excludes +∞), polygons use
  even–odd ray casting and include their edges, and ellipses include their
  boundary. Quadrants and splits are linked families that move together.
- **Exact boundaries.** Scaled columns are float32 and logicle-type scales
  come from a lookup table, so membership is tested on them and events within
  rounding distance of a boundary are re-decided from double-precision values
  (compensation, ratios and transforms recomputed for that event).
- **Compensation per dimension.** A dimension may name its own compensation
  (`'uncompensated'`, `'file'` or a matrix id), as Gating-ML's
  `compensation-ref` does; without one it follows the sample's.
- **More than two dimensions.** Imported rectangles and ellipsoids may have
  three or more dimensions; they are evaluated in all of them and are not
  drawn on 2-D plots.
- **Per-sample adjustments** are `overrides` on the gate, not copies. A
  template stays one gate with exceptions, and the review queue can list
  them.
- **Scopes** limit a gate to a sample group.
- **Gates on derived channels.** Category gates select cluster labels.
  Boolean gates combine others (and, or, not) within their parent: "not" is
  the parent minus the operands. They are made from the population menu
  (all of / any of / none of chosen populations, with a live count). A gate
  cannot use itself, its descendants, or Boolean gates that depend on them.

### Index sorting

`web/lib/indexsort.js` reads each sorted event's well from BD FACSDiva's
`INDEX SORTING LOCATIONS` keyword ("row,column;", 0-based, in event order) or
from well-coordinate parameters ("Index X"/"Index Y" and similar). It sizes
the plate from `INDEX SORTING DEVICE TYPE` or from the positions. In Gate mode,
an index-sorted sample shows its plate below the plots:
- Wells are colored by the deepest population their cell is in, or by a chosen
  population or channel. Selecting a population in the tree colors its wells.
- Clicking a well marks its cell on every plot of the sample.
- The wells, their populations and values export as CSV.

### Populations and caching

`SampleView` (`web/lib/engine.js`) owns one decoded data set and caches the
following:

- compensated columns, keyed by matrix (the sample's, and any that a gate
  dimension names), each computed the first time it is asked for;
- channels computed on demand from the workspace's derived records: Gating-ML
  ratios and spectral unmixing;
- scaled columns, keyed by channel and transform key;
- populations, keyed by a 53-bit hash of the gate chain: the type, dimensions
  and effective geometry of the gate and of all its ancestors.

Editing a gate invalidates only that gate and its descendants. Moving a gate
on one sample, through an override, invalidates only that sample.

A population is an `EventSet` (`web/lib/eventset.js`) in the smaller of two
forms:
- a bitset of one bit per event (1.25 MB at ten million events);
- the sorted indices of its members, when fewer than 1/32 of the events
  belong.

Gates, set operations, counts, plots and statistics work on either form
directly. `populationSet` returns the set; `population` returns indices, for
code that needs them, expanding a bitset once into a bounded cache. The
caches are bounded by bytes, least recently used first: scaled columns
384 MB, populations 128 MB, expanded indices 128 MB. When samples exceed
the memory budget, the data store first drops other samples' caches, then
whole samples. It never drops the sample in use, even when that sample alone
exceeds the budget.

### Large samples

The aim is ten million events per sample at interactive speed (requirement
D6). `validation/bench.mjs` measures each stage; the results are in
`validation/README.md`. Six things make it work:
- **Reading in parts.** `parseFCSAsync` reads the HEADER and TEXT first.
  It then reads the file once, start to end, in 16 MB parts, decoding events
  as they arrive. Parts come from a `File` (slices), from the host (range
  requests) or from memory. Only the columns and one part are held, never the
  whole file. Little-endian float data are decoded through a `Float32Array`.
- **Hashing.** Without the host, the parse worker hashes the file with an
  incremental SHA-256 (`web/lib/sha256.js`) as it reads it.
- **Lazy compensation.** A channel's compensated values are computed when a
  gate, plot or statistic first needs them. The first plots, on scatter,
  need none.
- **Polygon gates by cell grid.** For 20,000 or more events, a 256 × 256 grid
  over the polygon classes each cell as inside, outside or near an edge. Only
  events in cells near an edge take the per-edge test (and the exact
  boundary test), so membership is identical to testing every event.
- **Statistics by selection.** Medians, percentiles and robust SDs are exact
  order statistics. They are found by a radix selection on the bits of each
  value, in a few passes, instead of a sort.
- **No waiting on the page.** The inspector's statistics table is cached per
  population and filled one channel at a time. It waits while a gate is
  dragged. During a drag, the label of a gate on a large parent is an
  estimate (≈) from an even 200,000-event sample; dropping the gate gives
  the exact value.

Plots bin events onto a pixel grid; binning ten million events takes about
30 ms. Drawing is therefore not the bottleneck, and the planned optional
WebGL renderer was not needed.

### Workspace state, undo and provenance

- **Immutable workspace.** The workspace is one immutable JSON value
  (`web/lib/workspace.js`). Each edit produces a new value through
  `store.commit(next, label)`. Undo and redo walk those values.
- **Provenance.** Every algorithm result records method, parameters, seed
  and version in `ws.derived`. The workspace keeps a provenance log.
- **Checkpoints and diff.** Checkpoints snapshot the analysis part of a
  workspace. `web/lib/diff.js` compares two snapshots *semantically*: which
  gates moved and by how much, which matrices or scales changed, which
  results appeared. The Report view shows the effect of those changes on
  every population's frequency.

### Workers

Each heavy algorithm runs in a module worker (`web/workers/`). The protocol
is `{id, type, payload}` → progress* → result | error. Event columns on shared
memory are shared, not copied. Without isolation, a browser refuses to copy
much more than a gigabyte to a worker. Other large arrays are transferred.
A payload that cannot be handed over fails the job with a message. Jobs can
be canceled. Long loops check an abort signal and report progress.

## Interoperability

- **FCS.** CytoWeave reads FCS 2.0, 3.0, 3.1 and 3.2, including multiple
  data sets per file. It reads spillover from `$SPILLOVER`, `SPILL`, `$SPILL`
  or `$COMP`. Files with problems produce diagnostics rather than failures
  where the data are still recoverable. It writes FCS 3.1, for exports of
  populations, derived channels and concatenations.
- **Gating-ML 2.0** import and export. Covers all gate types, transformations
  (flin, flog, fasinh, logicle, hyperlog, fratio), compensation as
  `spectrumMatrix`, and quadrant gates. A CytoWeave `custom_info` block
  restores names, colors and exact transform specs on re-import. FlowJo's
  biex has no Gating-ML form, so it is written as its closest logicle, with
  gate coordinates converted and a warning.
- **FlowJo workspaces (.wsp).** Imported with a fidelity report. FlowJo
  stores gate vertices in data units, ellipses in a 256-bin display space and
  quadrants as four rectangles. Each is converted into CytoWeave's model, and
  anything that cannot be represented is listed.
- **CLR** (Classification Results, Spidlen 2015) export of clusters and
  gates, and **ACS** containers.
- **Cirro.** A Cirro tenant is a source and destination of files, with no
  dependency added and nothing required of the host. CytoWeave signs in as a
  registered Public App (Cirro app kit) by OAuth with PKCE against the
  tenant's Cognito user pool, keeps tokens in memory, calls the tenant's API
  as the user, and reads and writes S3 by URLs it presigns (SigV4) with the
  short-lived credentials the API hands out (`web/lib/cirro.js` holds what
  needs no page; `web/ui/cirro*.js` the rest). The sign-in window returns to
  CytoWeave's own address, `localhost` for this computer as Cognito requires,
  and a page at `127.0.0.1` gets the code through a BroadcastChannel after
  the return page moves to its host. Files opened from Cirro go through the
  same import as dropped files; each sample keeps `cirro: { host, projectId,
  datasetId, path }`, and `DataStore.sourceFor` reads a file from there when
  the library lacks it, checking its SHA-256. An analysis saves as a new
  dataset of the `custom_dataset` type, tagged `cirro-app: cytoweave`, with a
  provenance note.

## Automation

- **Remote control.** `--remote-control` lets local programs (Python,
  Jupyter) post actions to `/api/remote/action`. The page receives them over
  server-sent events and answers through `/api/remote/result/{id}`. Requests
  need a per-session token.
- **MCP.** `cytoweave mcp` is a Model Context Protocol server on stdio. It
  lets an AI agent open files and examples, list populations and statistics,
  render plots, create, auto-place, edit and review gates, compare groups,
  write methods and export Gating-ML (`docs/MCP.md`).
  - Agents act through the same commands as the user.
  - Their changes are proposals (`web/lib/proposals.js`), one open proposal
    per agent, accepted or rejected as a group. New gates are added at once,
    marked as proposed, so their counts are real and the agent can gate on
    them; edits and deletions of accepted gates, and compensation matrices,
    are held until accepted. Rejecting removes the proposed gates.
  - The change log records each decision with the agent's name (from the MCP
    client's `clientInfo`, or the `client` a script gives) and who decided.
    Accepted gates keep `proposedBy` and `acceptedBy`, which the inspector and
    the methods paragraph report.
  - Agents read numbers and text descriptions, not screenshots.

## Features that go beyond existing tools, and how they work

- **Gate robustness.** The boundary is moved inward and outward by
  0.5–2% of the axis and the frequency recomputed. The slope, in percentage
  points per 1% of axis, rates the gate *robust* or *sensitive*. A sensitive
  gate was drawn through a dense region, where a different analyst would get
  a different number.
- **Cohort review queue.** Every sample's version of a template gate is
  ranked for review, so attention goes where it is needed. Three things move
  a sample up:
  - a frequency outlier (robust z-score against the cohort);
  - a boundary that cuts through dense events on that sample;
  - a low event count.

  Adjusting a sample from the queue creates an override for that sample only.
- **Refined acquisition QC.** This is PeacoQC's peak tracking and outlier
  detection with three changes:
  - peaks are tracked with a tolerance tied to neighboring populations;
  - a MAD outlier must also stand out from the track's robust (Theil–Sen)
    trend, by more than 4 noise SDs (estimated from successive differences)
    and at least 1.5% of the axis. A steady drift is then left alone; drift
    is reported separately.
  - isolation-tree splits must be coherent in time.

  These remove PeacoQC's false removals on clean and drifting files while
  still catching clogs and bubbles (`validation/`). The classic algorithm
  stays available as an exact port of PeacoQC 1.22: it removes the same
  events as PeacoQC in R.
- **Counterfactual unmixing.** One population is unmixed with up to seven
  models:
  - OLS;
  - WLS with fixed weights;
  - WLS with per-event weights;
  - NNLS;
  - OLS with one autofluorescence signature;
  - OLS and NNLS with per-event autofluorescence.

  For each fluorochrome, the view compares the width of the negative
  population (robust SD) and the signal each model leaves unexplained. A
  researcher sees whether dim populations, and so the conclusions, depend on
  how the data were unmixed.
- **Compensation checked against the controls.** Each single-stain control
  is compensated with the matrix in use. Any signal its positives still leave
  in other detectors is a residual, and the spillover value is off by about
  that much. When positives are brighter in several detectors at once, the
  cause is autofluorescence of the positive cells (dead cells, beads against
  cells), and it is reported as such instead of as a correction.
- **Embedding honesty.** Every t-SNE or UMAP map comes with:
  - trustworthiness and continuity, and kNN preservation;
  - seed stability (neighborhood overlap and Procrustes disparity);
  - mixing (LISI, entropy) by sample or batch;
  - per-event reliability, which can shade unreliable regions;
  - plain-language warnings.

  Samples left out of a UMAP can be placed on it afterwards with UMAP's
  transform (each event among its nearest neighbors of the map's own events;
  the map does not change). Placed events get no quality measures of their
  own: a sample unlike any on the map lands on its nearest look-alikes, which
  the dialog and the methods paragraph say.
- **Methods and MIFlowCyt.** The Report view writes a methods paragraph from
  what the workspace actually did, with numbered references and DOIs:
  instrument, panel, compensation source, scales, gating hierarchy,
  algorithms with parameters and seeds, and software version. A MIFlowCyt
  checklist shows what is documented and what is missing.
- **Simulated examples with ground truth.** The bundled examples are
  generated in the browser by a physical simulator (`web/lib/simulate.js`).
  It models:
  - instruments with lasers, detectors and photon statistics;
  - fluorochrome spectra, spillover and autofluorescence;
  - cell populations with marker expression;
  - dead cells, debris and doublets;
  - event timing with clogs, bubbles and drift;
  - batch effects and calibration beads.

  Each example is a teaching data set and a test with known answers. The
  validation suite uses them.

## Testing

- `go test -race ./...` covers the host, library, remote control and MCP
  protocol.
- `node --test "web/lib/*.test.mjs"` runs unit tests of every pure module,
  against hand-computed, published or reference-tool values.
- `node validation/run.mjs` checks the pipelines end to end against
  simulated truth and published reference values.
- `node --expose-gc validation/bench.mjs [events]` times the pipeline on a
  large sample (ten million events by default).
- CI runs all of these, plus `node --check` of every web file,
  cross-compilation for six platforms, and a lint of the install scripts.
