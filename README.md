# CytoWeave

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/gate-dark.webp">
  <img alt="CytoWeave's Gate view: the gating path of T cells in a 14-color PBMC experiment" src="docs/images/gate-light.webp">
</picture>

CytoWeave is a flow cytometry analysis workbench for conventional, spectral
and mass cytometry. It runs on your own computer as one self-contained
program: a single command installs it, and it needs no license server,
account, Python, R or plugins. Files are read and analyzed in your browser
and never leave your machine.

It covers the analysis loop a cytometry lab works through every day, and
checks each step:

- gating many samples consistently, with per-sample adjustments, and gates
  adapted to each sample with a confidence for each;
- spillover from single-stain controls, checked against those controls;
- spectral unmixing with autofluorescence, and a comparison of how the choice
  of unmixing model changes the result;
- panel design: a panel's spread predicted from the instrument's own noise
  before the panel is run;
- acquisition QC that finds clogs and bubbles and leaves clean data alone,
  also as the instrument writes each file;
- the instrument itself: detector efficiency Q and background B from beads,
  Levey–Jennings charts across runs, and a library of reference spectra;
- batch normalization and debarcoding;
- clustering and UMAP/t-SNE maps that report how far they can be trusted;
- statistics tables and group comparisons with the right test for the design,
  and a check of whether a conclusion survives other reasonable analysis
  choices;
- samples compared with a control (SED, Overton, probability binning), and
  rare populations reported with exact intervals and detection limits;
- formula channels (ratios and other expressions of channels), fluorescence
  in calibrated MEF units from multi-level beads (as FlowCal computes it),
  and absolute counts from counting beads;
- cell-cycle and proliferation models, and kinetics of a signal or ratio over
  time (calcium flux);
- plates: wells as samples, plate layouts, heat maps of any statistic with
  Z′, dose-response curves (EC50/IC50) and bead immunoassays (LEGENDplex,
  CBA) read against their standard curves;
- publication figures, a methods paragraph with references, and a MIFlowCyt
  checklist.

It reads and writes FlowJo workspaces and Gating-ML, and reproduces FlowJo's
scales exactly.

CytoWeave is free and open source (Apache 2.0).

**[Website and user guide](https://robert-mcdermott.github.io/cytoweave/)**: step-by-step
guides to every view, with screenshots.

- [Highlights](#highlights)
- [Install](#install)
- [Getting started](#getting-started)
- [Opening data](#opening-data)
- [The views](#the-views)
- [Workspaces, history and the library](#workspaces-history-and-the-library)
- [Working with FlowJo and other tools](#working-with-flowjo-and-other-tools)
- [Command-line options](#command-line-options)
- [Scripting and AI agents](#scripting-and-ai-agents)
- [Validation](#validation)
- [Privacy and security](#privacy-and-security)
- [Limitations](#limitations)
- [Development](#development)
- [License, citation and credits](#license-citation-and-credits)

## Highlights

- **Gating.**
  - Rectangle, polygon, freehand, ellipse, quadrant, range and split gates,
    with keyboard shortcuts.
  - A magic wand that gates a density basin on a 2-D plot, or splits a
    histogram at its valley.
  - Pseudocolor, dot, density, contour, zebra, histogram and cumulative plots.
  - Backgating, overlays of other samples, and the gating path of any
    population as a row of plots.
  - Gates are shared by every sample. Adjusting one for a single sample makes
    a visible override, not a copy.
  - **Adapt a gate to each sample** where the data have drifted: each sample
    gets a confidence, confident adjustments are proposed, uncertain samples
    go to review with the reason. Checked against an expert's own gates in a
    real study.
- **Templates and published strategies.**
  - Save an analysis as a template and apply it to another experiment: its
    channels are matched by marker, not detector, with a report of what
    matched and what could not be applied.
  - OMIP-101 (major leukocyte populations) and OMIP-090 (regulatory T cells)
    built in, their gates placed on your own data, each explaining where it
    was placed and why.
- **Cell types.** Each population gets a suggested Cell Ontology term from
  the markers along its path, never its name, to confirm; confirmed terms go
  into the FlowJo and Gating-ML exports, tables and the methods.
- **Scales that match.** Logicle (Moore & Parks reference implementation),
  arcsinh, log, linear and FlowJo's biexponential. The biexponential is
  reproduced exactly from FlowJo's own table algorithm, and checked against
  BD's published lookup tables.
- **Compensation.**
  - Compute spillover from single-stain controls, by median difference or
    robust regression.
  - Edit a matrix with undo, check it in N×N pair plots, and see the
    spillover spreading matrix.
  - **Check a matrix against its controls.** The check finds a wrong value
    and suggests the correction. It recognizes when a control's positives are
    simply more autofluorescent (dead cells, beads) rather than
    miscompensated.
- **Spectral unmixing.**
  - Reference spectra from single-stain controls, gated automatically.
  - Several autofluorescence signatures extracted from the unstained control.
  - Least-squares, weighted (fixed or per event) and non-negative unmixing,
    with per-event autofluorescence.
  - Panel complexity index, similarity and spreading matrices, a residual
    check, and a side-by-side **comparison of unmixing models** on your own
    sample.
  - A **spectral library** across experiments that flags a degraded tandem
    and supplies spectra for dyes without a control.
  - An **unmixing doctor** that names the likely cause of a poor unmixing (a
    dye without a reference, a wrong or bead control, a degraded tandem, a
    cell control carrying autofluorescence, autofluorescence the unstained
    control lacks) and tries its fix on your sample.
- **Panel design.** A panel's spreading matrix predicted from its spectra and
  the instrument's noise (photon counting and laser fluctuations), fitted to
  your controls, kept for the instrument or taken from its bead runs. Leave a
  dye out or add one from the library and see the spread change before you
  run the panel. Checked on a real LSRFortessa's controls.
- **Titration and voltage walks.** The stain and separation index of every
  step of an antibody titration, with the amount to use and why (at least
  twice the amount that gives 90% of saturating staining), and from a voltage
  walk the detector's voltage range: high enough to lift the negative cells
  above its electronic noise, low enough to keep the positive cells within its
  linear range. A figure for the panel's record.
- **Acquisition QC.**
  - PeacoQC, with CytoWeave's refinements that stop it removing events from
    clean or slowly drifting files.
  - A flow-rate check, margin events, and signal drift reported per channel.
  - A 0–100 score per sample and a cohort overview.
  - The result is a "QC pass" channel to gate on. Your data are never
    changed.
  - **QC as files are acquired**: watch the instrument's export folder, and
    each file is checked as soon as it is complete (bead files for Q and B),
    so a clog or a failing detector shows before the next tube.
- **The instrument.** Every detector's efficiency Q, background B and the
  beads' CV from multi-level beads or an LED pulser, as flowQB computes them,
  followed across runs and experiments on Levey–Jennings charts with the
  Westgard rules.
- **Batch effects.**
  - CytoNorm normalization against reference samples, with a confounding
    check and before/after distances.
  - Bead normalization for mass cytometry, and debarcoding.
- **Clustering and maps.**
  - FlowSOM, Leiden (PhenoGraph), Louvain and k-means clustering, and UMAP,
    t-SNE and PCA across samples; samples left out of a UMAP can be placed on
    it afterwards.
  - Clusters are named from their marker enrichment and can become gateable
    populations.
  - Every map reports **how faithful it is**: trustworthiness, continuity,
    neighborhood preservation, sample mixing, seed stability, and shading
    of unreliable regions.
- **Tables and statistics.**
  - Counts, frequencies (with 95% confidence intervals), medians, means,
    geometric means, CVs, robust SDs, percentiles and more, for every sample.
  - Group comparisons choose the test from the design: two groups, paired,
    several groups, repeated measures. Each comes with a nonparametric
    counterpart, effect sizes, confidence intervals and multiple-testing
    correction.
  - Screens of every population or cluster, with volcano plots,
    differential abundance and differential state (diffcyt-DS-limma, equal
    to diffcyt in R).
  - **Robustness to analysis choices**: whether a comparison's conclusion
    holds across 64 analyses with the gates moved or adapted, QC removed or
    re-run, another compensation matrix or another test, with a
    specification curve and the choices it depends on.
- **Review across samples.**
  - Every sample's result for a gate, ranked by how unusual it is: frequency
    outliers, boundaries drawn through dense regions, low counts.
  - **Boundary robustness** shows how much a frequency depends on exactly
    where a gate was drawn.
- **Virtual FMO controls.** Where a population's negative for a marker ends
  without its dye, predicted from the spread model fitted to the controls and
  drawn on the plot beside any real FMO control, with the dyes the spread
  comes from and a gate above it on request. A guide, validated against real
  FMOs on a BD LSRFortessa and a Cytek Aurora panel (within about 6% of the
  axis on average); a real FMO still shows compensation or unmixing errors a
  prediction cannot.
- **Panel optimizer.** Which dye each marker of a panel should carry, from the
  dyes' spectra (this experiment's controls or the instrument's spectral
  library), the instrument's noise and the unstained background: every
  marker's stain index predicted with the spread of its co-expressed markers
  at their brightness, and the best assignment searched (every assignment
  for small panels). Warns of tandems and dyes on the same cells that can
  pass energy, and checks a kept design against the panel's run.
- **Figures and reports.**
  - Gating-strategy and across-samples figures that stay live until you
    export them, as SVG, PNG or vector PDF, with statistics tables on the page.
  - Batch reports: a figure repeated for each sample or each subject, as a
    multi-page PDF or a PowerPoint deck, with every number traced to its source.
  - Excel workbooks of the tables with sheets that say where each number comes
    from, and GraphPad Prism projects grouped by condition.
  - A methods paragraph with numbered references, written from what the
    workspace actually did, and a MIFlowCyt checklist.
  - Exported figures carry the analysis behind them (gates, scales, matrices
    and file checksums): open one to see what changed since, or rebuild it.
  - Checkpoints, with a plain-language diff of what changed between two
    versions of an analysis and how it moved every frequency.
  - Review reports: the analysis as one HTML file that opens in any browser,
    every sample's gates drawn and every number traced to its source.
  - Reproducibility certificates: the analysis packed with its files and every
    number it reported, with a fingerprint to quote; anyone can verify it, and
    every number is computed again from the files and compared.
- **Interchange.**
  - FlowJo workspaces (.wsp), FlowJo 11 workbenches (.flowjo), FACSDiva
    experiments (XML) and the gates FACSChorus records in its files, imported
    with a report of exactly what was reproduced, plus a population-by-population
    count comparison; FlowJo workspaces exported with one gating tree per sample.
  - SpectroFlo experiments (.Expt): reference controls set up for unmixing.
  - De-identified FCS files: only technical keywords kept, the events copied
    byte for byte.
  - Gating-ML 2.0 in and out, and classification results (CLR).
  - Events in CSV files, checked column by column with each column's kind
    and scale guessed; a population's events in several samples out as one
    concatenated FCS file (with a sample identifier), one file per sample or
    an AnnData file (`.h5ad`) for scanpy and R, optionally downsampled with a
    seed.
  - Archival Cytometry Standard containers that bundle the workspace with its
    FCS files.
  - FCS 2.0 to 3.2.
- **Sixteen example experiments** generated by a physical simulator, each with
  the ground truth for every event: immunophenotyping with a deliberate
  compensation error, an FMO tube, calibration beads and a second day's
  batch; a FlowJo workspace to migrate; a 25-color spectral panel and its
  troubleshooting day 2; cell cycle, proliferation, a calcium flux, a 96-well
  drug screen, a cytokine bead assay, absolute counts with counting beads, a
  two-batch mass cytometry cohort, a barcoded plate, an index sort, a QC
  plate, 30 days of bead QC, and an antibody titration with a voltage walk.
  Some come with files other programs would have written (a FlowJo 11
  workbench, FACSDiva and SpectroFlo experiments, CSV events and annotations),
  so those imports can be tried too. Together they show every analysis
  CytoWeave does.
- **Exercises.** Eighteen exercises on the examples (gating, compensation,
  QC, spectral unmixing, statistics, plates and assays) ask a question, check
  the answer against the simulator's truth with partial credit, then reveal
  what was planted; a class code gives a class the same data. They appear
  only in a workspace an exercise made.
- **Scripting and agents.** An MCP server lets AI agents such as Claude Code
  run the whole analysis in the window you are watching: open and annotate
  data, gate, run QC, unmix, cluster, compute statistics, review gates, build
  figures, write methods and export files. Their changes arrive as proposals
  that you accept or reject, and every change can be undone.
- **Headless runs.** `cytoweave run` applies a template to a folder of FCS
  files without a window and writes its tables, report, workspace and methods,
  with a record of every input and count, for nightly runs, pipelines and CI.
- **Large files.** Samples of ten million events open in seconds and stay
  responsive: files are read in parts and never held whole, populations are
  kept as bitsets, and analyses in the background share the events rather
  than copy them.
- **Accessible.** Color-vision-friendly colors as a setting (populations,
  heat maps and status colors), text contrast that meets WCAG AA in both
  themes, the population tree, sample list and dialogs by keyboard, and every
  plot described for screen readers.
- **Validated.** A validation suite checks the pipelines against known
  answers and published reference values on every change; see
  [validation/](validation/README.md).

## Install

### macOS and Linux

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh | sh
```

This installs the latest release as `$HOME/.local/bin/cytoweave`. It checks the
download's SHA-256 checksum and version, and replaces an existing copy only
after both checks pass. It does not use `sudo` or change `PATH`; if
`~/.local/bin` is not on your `PATH`, it prints the full path to run.

### Windows

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1 | iex
```

This installs to `%LocalAppData%\Programs\CytoWeave`, checks the checksum and
version, and adds that folder to your user `PATH`. It needs neither
administrator rights nor a change to the execution policy. Open a new terminal
afterwards.

To pin a version, download and verify the files yourself, upgrade or
uninstall, see [Installing CytoWeave](docs/INSTALLING.md).

### Start

```sh
cytoweave
```

CytoWeave starts a local server and opens its window. If Chrome, Edge, Brave
or Chromium is installed, the window is a desktop app window; otherwise the
default browser is used. Closing the window stops the program.

Files and folders named on the command line open directly:

```sh
cytoweave ~/data/2026-09-30_panel1/
```

Running `cytoweave <files>` again while it is open hands the files to the
open window.

CytoWeave is developed and tested in Chrome, Edge and Brave. It uses only
standard web features (module workers, canvas, IndexedDB and the
origin-private file system), so current Firefox and Safari should work when
you open the printed address in them, but they are not tested regularly.

## Getting started

The quickest way to see what CytoWeave does is an example experiment. On the
start page, or with **Workspace → Example experiments…**, open one:

| Example | What it shows |
| --- | --- |
| PBMC immunophenotyping, 14 colors | Six donors, unstimulated and stimulated, with a full set of compensation controls. The file's spillover matrix has one wrong value for the compensation check to find, and one sample has a clog for QC to find. |
| Moving from FlowJo | Four PBMC samples with the FlowJo 10 workspace made for them. It opens in the FlowJo import dialog; the migration report then compares every population count with FlowJo's. |
| Spectral 25-color panel | Raw data from 64 detectors, 25 single-stain references and an unstained control with lymphoid and myeloid autofluorescence. |
| Cell cycle | Propidium iodide DNA content of an asynchronous and a nocodazole-arrested culture, with doublets and debris. |
| T-cell proliferation | CellTrace Violet dilution over four days, with and without stimulation, and a day-0 reference. |
| Calcium flux | Indo-1-loaded PBMC acquired for four minutes: buffer, anti-CD3 at two doses (T cells respond), ionomycin (every cell responds), and the high dose injected without a pause. The simulator knows every cell's calcium. |
| Drug screen on a 96-well plate | One file per well: six compounds at ten doses inhibiting T-cell activation (CD69), with stimulated and unstimulated control wells. Every compound's IC50 and Hill slope are known. |
| Cytokine bead assay (LEGENDplex-like) | An 8-plex on two bead sizes, standards C0–C7 in duplicate and 20 sera diluted 2-fold. Every serum's concentrations are known. |
| Mass cytometry cohort | Eight subjects in two batches with anchor samples, EQ beads and signal drift; non-classical monocytes are doubled in the case group. |
| Barcoded mass cytometry plate | Twenty samples pooled into one file with palladium barcodes and the barcode key. Debarcode it, split it into one sample per well, and compare stimulated with unstimulated wells. |
| Index sort | A presort and the index-sorted events of a 96-well plate. |
| Acquisition QC showcase | Four wells: clean, a clog, gradual drift and an air bubble. |
| Daily bead QC | Thirty runs of 8-peak beads with every detector's true Q and B; a PMT ages, the flow cell gets dirty and the violet laser weakens. |
| Antibody titration and a voltage walk | CD4-PE in ten two-fold steps from 1000 ng to 2 ng per test, and the PE detector walked from 300 V to 750 V, with the antibody's binding constant and the detector's noise and gain known. |

Every example is generated in the browser by a simulator that models
instruments, fluorochrome spectra, spillover, autofluorescence, cell
populations, dead cells, debris, doublets and acquisition problems. It keeps
the true identity of every event. After opening an example you can:
- add its suggested gates;
- color plots by the "Truth (simulated)" channel;
- compare your answers with the truth.

With your own data, add FCS files or a folder (each folder becomes a sample
group), then:

1. **Annotate** the samples (**Annotate selection…** in the sample list):
   condition, subject, batch, timepoint and so on. **Suggest from file names**
   fills these from the parts of the file names that vary.
2. **Mark the controls** (unstained, single stain, FMO, beads) and check the
   compensation in the **Compensate** view.
3. **Gate** in the **Gate** view. Gates apply to every sample. Press ↑ and ↓
   to step through the samples, and switch the scope to **This sample** to
   adjust a gate for one sample only.
4. Run **QC**, then **Explore**, **Tables** and **Compare** as your question
   needs.
5. Build **Figures** and copy the **Report**'s methods paragraph.

Press ⌘K (Ctrl+K) to search samples, populations, channels and commands, and
**?** for every keyboard shortcut.

## Opening data

| File | Opens as |
| --- | --- |
| `.fcs`, `.lmd` | Samples. FCS 2.0, 3.0, 3.1 and 3.2; integer, float, double and ASCII data; files with several data sets become one sample each |
| A folder | Its FCS files, as a sample group |
| `.cwz` | A CytoWeave workspace |
| `.acs`, `.zip` | An Archival Cytometry Standard container: a workspace with its FCS files |
| `.wsp` | A FlowJo 10 workspace (see [below](#working-with-flowjo-and-other-tools)) |
| `.flowjo` | A FlowJo 11 workbench (see [below](#working-with-flowjo-and-other-tools)) |
| `.Expt` | A SpectroFlo experiment: its reference controls, set up for spectral unmixing |
| `.xml` | Gating-ML 2.0 gates and compensation, or a FACSDiva experiment exported as XML |
| `.csv`, `.tsv`, `.txt` | Events, a row per event and a column per channel (checked before import, below); or, when the first column names samples, sample annotations |
| `.svg`, `.png`, `.pdf` | A figure or plot CytoWeave exported: where it came from, what changed since, and a rebuild (see [Figures](#figures)) |

Drag files onto the window, use the **+** button of the sample list, or name
them on the command line.

FCS files from real instruments often bend the standard, and CytoWeave reads
them anyway. Every repair it makes is listed in the sample's diagnostics in
the inspector:
- text that is neither UTF-8 nor Latin-1;
- offsets that disagree or are off by one;
- truncated data or a missing event count;
- log-amplified integer data.

Spillover is read from `$SPILLOVER`, `SPILL`, `$SPILL` or `$COMP`.

**Events in CSV files** (FlowJo's *Export CSV*, FCS Express, R, Python) open
in a dialog that checks each column first: the delimiter and decimal mark,
FlowJo's `Comp-PE-A :: CD25` headers, cells that are not numbers (with the row
of the first), empty cells and short rows, an event number column (left out)
and label columns such as clusters or sample numbers (which can split the file
into one sample per value). Each column's kind and scale are guessed (logicle
for intensities, arcsinh for mass cytometry counts, linear for scatter, time
and values that are already transformed) and can be changed. Each file becomes
a sample stored as an FCS file of 32-bit floats.

## The views

### Gate

The workbench above.
- **Left:** the samples and the population tree.
- **Middle:** the gating path of the selected population and its plots.
- **Right:** the population's frequency with a 95% confidence interval, the
  gate's exact geometry (editable as numbers), statistics per channel, and
  the sample's keywords.

Gates are drawn with the toolbar or the keyboard:

| Key | Tool |
| --- | --- |
| V | Select and edit |
| R, P, E, L | Rectangle, polygon, ellipse, freehand |
| Q, H, S | Quadrant (four gates), range, split (two gates) |
| W | Magic wand: the density basin under the cursor, or a histogram's valley |
| B | Backgate the selected population on its ancestors |

A tool is used for one gate. Hold ⇧ with its key, or double-click it, to keep
it for several. New gates get a suggested name ("Singlets", "Live",
"CD4+ CD8−") that you can accept or type over.

The plot menu covers:
- export as SVG, PNG or to the clipboard;
- overlays of other samples, and the axis scales;
- adding a plot to a figure;
- the color map and dot size.

The **Edit axis scales** dialog sets a channel's scale for every plot, with a
live histogram preview. It can estimate the logicle width from the data.

Right-click a population for more:
- **Review across samples** ranks every sample's result for this gate;
- **Adapt to each sample** carries the gate to every sample (below);
- **Copy to another population**, and **Applies to** limits a gate to a
  sample group;
- export of the population's events as FCS (raw values and the original
  keywords) or CSV;
- **New Boolean population**: the events in all of, any of or none of chosen
  populations, with a live count;
- the **cell cycle** and **proliferation** models, **kinetics**, and a
  **bead immunoassay** on a bead population.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/review-dark.webp">
  <img alt="Review Lymphocytes across samples: every sample ranked by a robust z-score of its frequency, with a rating of its boundary" src="docs/images/review-light.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/autogate-dark.webp">
  <img alt="Adapt Monocytes to each sample: six confident adjustments ticked, four samples that already fit and one sent to review, each with its confidence and reason" src="docs/images/autogate-light.webp">
</picture>

**Adapt to each sample** moves a shared gate where the data have shifted. It
learns from the samples the gate is known to be right on (where you drew,
adjusted or confirmed it) and registers the density peaks of the parent
population along the gate's axes on every other sample. Each sample gets a
confidence:
- **Fits:** the gate already fits, or does not cut into a population there.
- **Adjust:** a confident adjustment, ticked; applying them is one undoable
  step.
- **Review:** uncertain, listed first with the reason. Adjust the gate on the
  sample by hand, or mark it **Looks right**, and adapt again: CytoWeave
  learns from it.

A gate is moved only where it cuts into a population and the adaptation finds
sparser events, because populations also move for biological reasons: a
stimulation down-regulates CD3 and CD4. When a donor's or subject's samples
differ by the stimulation you are measuring, choose **Keep one gate per**
donor (or subject): its samples are adapted together, and one unlike the rest
goes to review. Each event's membership probability exports as CLR files, and
the methods paragraph describes the adaptation.

An **index-sorted** sample shows its plate below the plots. Wells come from
BD FACSDiva's `INDEX SORTING LOCATIONS` keyword or from well parameters such
as "Index X" and "Index Y". Each well is colored by the population its cell
falls in, or by a channel's value; selecting a population colors its wells.
Clicking a well marks its cell on the plots, and the wells export as CSV with
their populations and values.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/indexsort-dark.webp">
  <img alt="An index-sorted 96-well plate colored by population, with well C3 marked and its cell circled on the plots" src="docs/images/indexsort-light.webp">
</picture>

The **cell cycle** model fits Dean–Jett–Fox or Watson to the DNA content and
suggests a singlet gate. The **proliferation** model fits generations of dye
dilution and reports the division, proliferation, expansion and replication
indices. **Kinetics** follows a signal or a ratio (Indo-1 violet/blue) against
acquisition time, as in a calcium flux: the baseline before the stimulus
(found where acquisition paused to add it), the peak, the time to peak, the
half-max time, the area under the curve and the share of responding cells,
with other samples overlaid at their stimulus.

### Plates

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/plates-dark.webp">
  <img alt="The Plates view of a 96-well drug screen: % CD69+ of T cells as a heat map across the plate, with Z′ from the control wells" src="docs/images/plates-light.webp">
</picture>

The **Plates** view places samples acquired from a plate in their wells, from
the files' `$WELLID` or `WELL ID` keywords or their names (`Plate1_A01.fcs`).
The layout (compound, dose, control, standard, specimen, dilution) is kept as
sample annotations. You can set it on selected wells, fill in a dilution
series, or import it from CSV: one row per well, or plate maps as R's plater
writes them.

**Heat map** shows any statistic of a population across the plate, with the
screen's Z′ (Zhang et al. 1999) from its positive and negative control wells.

**Dose-response…** fits four- or five-parameter log-logistic curves per
compound, in the parameterization of R's drc. Each curve gives the EC50 or
IC50 with its 95% confidence interval, the Hill slope and the asymptotes. The
response can be raw, % of controls or % inhibition. A curve that is no better
than a flat line, or whose EC50 is not determined, is flagged.

**Bead assay…** reads LEGENDplex and CBA kits:
- each analyte's beads are found by their level of the classification dye in
  each bead size;
- a standard curve is fitted per analyte;
- each well's concentration is read off it and multiplied by the well's
  dilution, with the quantifiable range set from the standards' recovery and
  CV (FDA 2018) and the limit of detection from the blanks.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/beadassay-dark.webp">
  <img alt="A bead immunoassay of eight cytokines: the bead levels of the two bead sizes and the eight standard curves with the sera on them" src="docs/images/beadassay-light.webp">
</picture>

### QC

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/qc-dark.webp">
  <img alt="The QC view: four wells with a clog, a drift and a burst found" src="docs/images/qc-light.webp">
</picture>

**Clean** runs acquisition QC on any set of samples:
- PeacoQC on every scatter and fluorescence channel;
- a flow-rate check (generalized ESD on events per 0.1 s);
- margin events at the detector limits;
- per-channel drift.

Each sample gets a score, plain-language findings and plots of its signal and
event rate over time. **Add a "QC pass" gate at the top** puts the result
under the whole gating tree; undo restores it.

The default **refined** PeacoQC requires a flagged stretch to stand out from
the signal's own trend by more than its noise and by at least 1.5% of the
axis, and requires isolation-tree splits to be contiguous in time. As
published, PeacoQC removes events from clean files and cuts the ends of
drifting ones; the refined variant does neither, and still catches clogs and
bubbles. The validation suite measures both. The classic algorithm, a port
of PeacoQC 1.22 that removes the same events as PeacoQC in R, is one click
away under **Sensitivity**, where both results can be compared.

**Normalize** trains CytoNorm on reference samples, one per batch, and
applies it. It first checks that batch and condition are not confounded. It
can model the whole population or each cluster of a clustering channel, and
reports each batch's distance to the pooled distribution before and after.
For mass cytometry, **bead normalization** corrects signal drift with EQ
beads.

**Debarcode** assigns barcoded events by their k positive channels, with a
draggable separation cutoff and a yield plot. **Split into samples** then
writes each code's events as a sample of its own, named after the code, so
the wells of a pooled plate can be annotated and compared. A key can name the
codes after the samples they hold.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/levey-jennings-dark.webp">
  <img alt="QC Instrument: a Levey–Jennings chart of one detector's Q over 30 daily bead runs, in control for 20 baseline runs and then falling out of control" src="docs/images/levey-jennings-light.webp">
</picture>

**Instrument** measures each fluorescence detector's efficiency **Q**
(photoelectrons per unit of signal), optical background **B** and the beads'
intrinsic CV from multi-level beads (8-peak rainbow, 6-peak and others) or an
LED pulser series, with Parks et al.'s weighted quadratic fit as flowQB does
it; it gives the same results as flowQB on flowQB's own data. Each run shows
Q and B with their standard errors and a plot of peak variance against mean.
**Save to the instrument's record** keeps the runs in the library, and
**Levey–Jennings** charts follow Q, B and a bead level across runs and
experiments, flagged by the Westgard rules.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/titration-dark.webp">
  <img alt="QC Titration: the stain index of a CD4-PE titration against the amount, with the fitted saturation curve and 125 ng recommended, and a histogram of every step" src="docs/images/titration-light.webp">
</picture>

**Titration** analyzes a reagent titration or a detector voltage walk on one
channel, within a population such as lymphocytes. The amounts are read from
the file names ("CD4-PE 125 ng", "CD8 1-200", "2.5 uL") or an "amount"
annotation, and the voltages from each file's `$PnV`. At each step the
positive and negative cells are found from the data, and the table gives
their medians and rSD, the stain index (Maecker et al. 2004) and the
separation index (Bigos 2007):
- **A titration** fits a saturation curve to the stain index and recommends
  the first amount tested at or above twice the amount that gives 90% of
  saturating staining (Bonilla et al. 2024), noting where excess antibody
  raises the background.
- **A voltage walk** finds the minimum voltage, where the negative cells' rSD
  reaches 2.5 times the detector's electronic noise (BD's criterion; the
  noise from the cytometer's baseline report, or estimated from the walk),
  and the maximum, where the positive cells' 99th percentile reaches the top
  of the linear range.

Stacked histograms of every step show where the cells were divided. The
result can be exported as a figure (SVG, PNG) and a CSV for the panel's
record, and saved in the workspace, where the methods describe it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/qc-live-dark.webp">
  <img alt="QC Live: watching the instrument's export folder, one file still being written, and four wells checked as they landed, scored 49, 80, 79 and 100" src="docs/images/qc-live-light.webp">
</picture>

**Live** (or `cytoweave --watch <folder>`) watches the folder an instrument
exports to. Each FCS file is added to the workspace once the instrument has
finished writing it (its size is steady and its header says all its data are
there, which also works on network shares) and checked at once: acquisition
QC for samples and controls, Q and B for bead files, added to the
instrument's record and checked against the Levey–Jennings rules. A low score
or a detector out of control raises a notice. The folder is only read.
PeacoQC's per-channel work runs on up to four workers, with exactly the
serial result: 3.4 s instead of 10.5 s for two million events in 20 channels.

### Compensate

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/compensate-dark.webp">
  <img alt="The Compensate view: the file's matrix checked against 14 single-stain controls" src="docs/images/compensate-light.webp">
</picture>

- **Compute from controls.** Pick each control's stained channel, the events
  to use and the negative reference (each control's dim events, or an
  unstained sample). Choose the median difference (as FACSDiva and FlowJo do)
  or robust regression (AutoSpill-style).
- **Edit.** Edit a matrix as percentages, with the mouse wheel or by typing,
  and apply it to all samples, a group or a selection. Its condition number
  shows how much it amplifies noise.
- **Check against the controls.** Compensates each single-stain control with
  the matrix and measures what its positive events still leave in every
  other detector. A residual means the spillover value is off by about that
  much; the check suggests the corrected value.
  - A matrix you made can be corrected in place. One from a file is
    corrected in a copy that its samples then use, in one undoable step.
  - When a control's positives are brighter in several detectors at once,
    the check reports autofluorescence (dead cells in a viability control,
    beads against cells) instead of offering a "correction".
- **Diagnose.** The spillover spreading matrix (Nguyen et al. 2013) shows
  which detectors lose resolution, and N×N pair plots show any population
  that still leans.

### Spectral

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/spectral-dark.webp">
  <img alt="The Spectral view: 25 reference spectra with two autofluorescence signatures" src="docs/images/spectral-light.webp">
</picture>

For raw data from spectral cytometers (Cytek Aurora and Northern Lights, Sony
ID7000, BD FACSDiscover and others), a five-step workflow:
1. **Mark controls.** Mark the single-stain references and the unstained
   control.
2. **Reference spectra.** Gate all controls automatically. Each control's
   positive and negative events are found without scatter gates, and its
   spectrum is the difference of their medians.
3. **Autofluorescence.** Extract one or more autofluorescence signatures from
   the unstained control.
4. **Check the panel.** See the complexity index, the most similar pair of
   spectra, the similarity matrix and the spreading matrix.
5. **Unmix.** Choose a method: ordinary, weighted (fixed or per-event
   weights) or non-negative least squares. Autofluorescence can be left out,
   treated as one signature, or assigned per event. Unmixed channels become
   ordinary channels to gate on, and the residual of every event is a
   channel too.

**Compare models** unmixes one population of your sample with seven
combinations of method and autofluorescence model. For every dye it shows the
spread of the negative population and the signal left unexplained, so you can
see which choice resolves your dim populations best. **Residuals** shows where
the reference set fails to explain the data, for example a missing dye or a
degraded tandem.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/spectral-library-dark.webp">
  <img alt="The spectral library: PE-Cy7 marked changed against the spectra of an earlier experiment, with the two spectra overlaid" src="docs/images/spectral-library-light.webp">
</picture>

**Library** keeps reference spectra across experiments, per instrument. Today's
controls are compared with the library's latest spectra, so a dye that
changed (a tandem that degraded, a new lot) is flagged before it distorts the
unmixing; a fluorochrome you have no control for can be unmixed with its
library spectrum.

**Diagnose** names the likely causes of a poor unmixing of a sample, most
likely first: a dye in the sample without a reference (named from the library
when it holds the dye), a reference that does not match the dye in the sample
(another dye in the control tube, a dye that emits differently on beads than
on cells), a tandem degraded in the samples or in its control, a cell control
whose positives carry autofluorescence, or autofluorescence the unstained
control does not describe (fixation, cells it lacks). Each comes with its
evidence and a fix already tried on the sample's events, applied in one
click.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/spectral-design-dark.webp">
  <img alt="The Panel design tab: noise fitted to the 25 controls with its check, the panel with BV711 left out, and the predicted spreading matrix" src="docs/images/spectral-design-light.webp">
</picture>

**Panel design** predicts the spreading matrix of a panel from its spectra and
the instrument's noise, so you can try a change before running it. The noise
has two parts: photon counting in every detector (1/Q), and each laser's
intensity fluctuations, which make a dye excited by two lasers spread in
proportion to its brightness. It is fitted to this experiment's controls
(each control's spread is predicted from the others as a check), kept for the
instrument in the library, or taken from its bead runs. Leave a dye out or add
one from the library, and the matrix, the complexity index and the spread
each channel receives follow; the channels that receive the least suit dim
markers. With no files open, **Design a panel from the spectral library** does
the same from an instrument's library alone. On a BD LSRFortessa's 15 bead
controls, each control's spread predicted from the other 14 was within 2× of
the observed value for 79% of well-measured pairs.

### Explore

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/explore-dark.webp">
  <img alt="The Explore view: FlowSOM clusters on a UMAP of 60,000 events from 12 samples, with the map's faithfulness" src="docs/images/explore-light.webp">
</picture>

Pick a population, the samples (an equal number of events from each) and the
markers. Then run:
- **FlowSOM**, **Leiden** (PhenoGraph), **Louvain** or **k-means**
  clustering on every event of the population;
- **UMAP**, **t-SNE** or **PCA** on the sampled events.

**Place samples on this map** positions other samples' events on a finished
UMAP without changing it, so later samples can be compared on the same map.

Clusters are named from their marker enrichment (MEM). The heatmap shows each
cluster's median of every marker. **Make populations of the clusters** turns
them into gates. A cluster's frequency per sample goes straight to
**Compare**. You can color the map by cluster, density, sample, any
annotation or any marker, and lasso a region to make it a population.

**How faithful is the map?** answers what most tools leave to faith:
- **Trustworthiness and continuity** (Venna & Kaski): are map neighbors true
  neighbors, and do true neighbors stay together?
- **Neighborhood preservation**: the share of exact nearest neighbors kept.
- **Sample mixing on the map versus in the data** (LISI): whether the map
  separates samples more than the data do.
- **Seed stability**, against a second run with another seed.
- **Shading of unreliable regions**: events whose map neighbors come from
  elsewhere in the data.

Each result comes with a plain-language reading.

### Tables

Batch statistics: one row per sample, one column per statistic. The
statistics are:
- count, % of parent, % of grandparent, % of total, % of any ancestor;
- concentration (/µL, from `$VOL`), and absolute counts (/µL) from counting
  beads, each with a dilution factor;
- median, mean, geometric mean, SD, robust SD, CV, robust CV, median
  absolute deviation;
- minimum, maximum, percentile, mode, and % above a threshold;
- for rare events, the count's and % of parent's exact 95% limits (Poisson,
  binomial) and the counting CV;
- against a control sample's population (an FMO, an unstimulated sample):
  % positive by SED (Bagwell's enhanced normalized subtraction) and by
  Overton subtraction, probability binning's T(χ) and % positive, and the
  Kolmogorov–Smirnov D. A histogram with the control overlaid shows the same
  comparison under the plot.

**Table of every population** builds the usual frequency table in one click.
Tables can be shown as a heat map, copied as TSV, or saved as CSV, as an Excel
workbook (every table in full precision, with sheets for each column's
definition, the samples and their checksums, the gating and the methods) or as
a GraphPad Prism project (a column table per statistic with a column per
group, for Prism's t tests and ANOVA). Any column
can be compared between groups. A count or frequency column can carry
detection limits from blank and low-level samples (limit of blank, of
detection and of quantification, as CLSI EP17 describes); values below them
are marked not detected or below the LLOQ.

### Compare

Compare one measure between groups of samples:
- a population statistic;
- a table column;
- a cluster's abundance.

Group by any annotation, or by workspace groups. Paired designs are detected
from a subject field.

The **automatic** test follows the design, and each test is reported with a
nonparametric counterpart:

| Design | Test | Counterpart |
| --- | --- | --- |
| Two groups | Welch's t-test | Mann–Whitney U |
| Paired | Paired t-test | Wilcoxon signed-rank |
| Several groups | Welch's ANOVA | Kruskal–Wallis |
| Repeated measures | Repeated-measures ANOVA | Friedman |

Several groups are followed by Holm-adjusted comparisons with the reference.
Results show:
- effect sizes with 95% confidence intervals: differences and ratios of
  means, Hedges' g, the Hodges–Lehmann shift;
- each group's mean with a t interval, or median with a bootstrap interval;
- a note on assumptions.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/compare-dark.webp">
  <img alt="The Compare view: median CD25 of T cells in stimulated and unstimulated samples, paired by donor, with the paired t-test and effect sizes" src="docs/images/compare-light.webp">
</picture>

**Screen populations** and **Screen clusters** test every population or
cluster at once. Results are corrected for multiple testing
(Benjamini–Hochberg, Benjamini–Yekutieli, Holm or Bonferroni) and shown on a
volcano plot. Cluster abundance uses a quasi-binomial model in the manner of
diffcyt. Clicking a point opens that sample.

**Screen marker states** asks whether a marker's level changes within a
cluster or population, with diffcyt-DS-limma (Weber et al. 2019): each
sample's median of arcsinh-transformed expression per cluster, a linear model
per cluster and marker weighted by the cells in each sample (pairing and
covariates as fixed effects), and limma's moderated t-statistics with a
mean–variance trend, adjusted across every cluster and marker. The markers the
clusters were made from are left out by default.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/compare-states-dark.webp">
  <img alt="Screen marker states: FlowSOM clusters from lineage markers, activation markers tested between stimulated and unstimulated samples paired by donor; CD25 and HLA-DR up and CD127 down in the T-cell clusters" src="docs/images/compare-states-light.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/compare-robustness-dark.webp">
  <img alt="Robustness to analysis choices for monocytes, stimulated against unstimulated: the conclusion mostly holds, with a specification curve of 64 analyses and the choices each changed" src="docs/images/compare-robustness-light.webp">
</picture>

**Robustness to analysis choices** asks whether a two-group comparison's
conclusion would change had the data been processed differently in ways
another analyst might reasonably have chosen. The comparison is repeated with
each gate on the population's path moved 1% and 2% of the axis, with the
gates adapted to each sample or without per-sample adjustments, without the
QC gate or with QC re-run stricter and looser, with the workspace's other
compensation matrices and with the rank test, each alone and in random
combinations (64 analyses). The result says whether the conclusion holds
(≥ 90%), mostly holds (≥ 70%) or is fragile, names the choices that change it
and those that move the size of a difference beyond its confidence interval,
and draws the specification curve. The declared analysis stays the result;
the methods text includes a sentence on the check.

### Figures

Page layouts for publication: the gating strategy of a population in one
click, a grid of the current plots across samples, or a blank page with
plots, text, arrows and statistics (columns of a table for the samples on the
page). Plots stay live, following gate and compensation changes, until you
export the page as SVG, PNG or PDF (vector: text and lines stay text and
lines). Pages come in slide (16:9), Letter, A4, landscape and square sizes.

**Batch reports** repeat a figure page after page, as a multi-page PDF or a
PowerPoint deck (plots as pictures, statistics as native tables):
- for each sample: the plots of the figure's main sample are redrawn on each
  sample, while plots of other samples (a control) stay on every page;
- for each value of an annotation, such as each subject: each plot is redrawn
  on that subject's sample that matches it on the annotations that tell the
  figure's samples apart (the stimulated tube where the figure shows the first
  subject's).

Text such as `{sample}`, `{subject}` or `{page}` is filled on each page, and a
missing tube or an undecided choice between replicates is reported before the
report is written. Every number a report prints is recorded with the table
column or gate it comes from, in the file.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/figures-dark.webp">
  <img alt="The Figures view: the gating strategy of T cells laid out on a page" src="docs/images/figures-light.webp">
</picture>

**Exports carry their analysis.** Every exported figure and plot (SVG, PNG and
PDF) embeds what it shows:
- the samples, by name and the SHA-256 checksum of each FCS file;
- every gate the plots depend on, with per-sample adjustments;
- the scales and compensation matrices;
- each plot's event count.

The record goes in SVG metadata, a PNG text chunk, or a PDF attachment
(`cytoweave-provenance.json`, which PDF readers list). It holds no keywords or
event data. Open the exported file in CytoWeave (drop it on the window) to see
where it came from and what has changed since, plot by plot: for example
"Live changed; 84,450 events now, 84,284 in the figure". From there you can:
- **Rebuild in a new workspace**, from the same files, which the library finds
  by checksum (missing ones can be added, whatever their names now);
- or **Add to this workspace** again.

**Embed the analysis** in the Figures view turns it off.

### Report

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/report-dark.webp">
  <img alt="The Report view: a methods paragraph written from the workspace" src="docs/images/report-light.webp">
</picture>

- **Methods.** A paragraph written from what the workspace contains, with
  numbered references and DOIs:
  - the instrument and files;
  - the compensation and where it came from;
  - the scales;
  - the gating hierarchy;
  - every algorithm with its parameters and seed;
  - the statistical comparisons.

  Copy it, or download it as Markdown with a BibTeX file of the references.
- **MIFlowCyt.** A checklist of the minimum information for a flow
  experiment, showing what the workspace documents and what is missing.
- **Checkpoints.** Save the state of an analysis and later compare it with
  the current one. The comparison lists what changed in words, such as "the
  Live gate moved by 3% of the axis" or "the compensation of 12 samples
  changed", and shows the effect on every population's frequency. Restore a
  checkpoint with one click.
- **Review reports.** Report → Review report writes the analysis as one
  self-contained HTML file for a PI, collaborator or reviewer without
  CytoWeave: the samples with their checksums, the gating, every sample's
  gates drawn on its own events, the figures, tables and saved comparisons,
  the methods, MIFlowCyt and the change log. Click any number to see where it
  comes from. The file loads nothing from the network.
- **Reproducibility certificates.** Report → Certificate writes an ACS
  archive of the analysis: the workspace, the FCS files (or only their
  checksums), stored channels, Gating-ML, the methods and `certificate.json`,
  which records the version, every input's SHA-256, the analyses and seeds,
  MIFlowCyt filled in, and every count, table cell and saved comparison.
  Opening a certificate verifies it: every number is computed again from the
  files and must agree (bit for bit in the same browser version, to 12
  significant digits across engines). `cytoweave verify` does the same from
  the command line.
- **Change log.** Every recorded action, downloadable as JSON. The log is
  hash-chained, so an entry changed, removed or reordered afterward is
  detected.

### Appearance and accessibility

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/color-vision-dark.webp">
  <img alt="The Gate view with color-vision-friendly colors: populations in blue, orange, green, vermillion, sky blue and pink, density plots in viridis, and the Appearance menu with the setting ticked" src="docs/images/color-vision-light.webp">
</picture>

The **Appearance** menu (the sun or moon button) chooses the light or dark
theme, or follows the system. **Color-vision-friendly colors** gives
populations, groups and clusters a palette that stays distinct with
protanopia, deuteranopia and tritanopia, draws the rainbow heat maps as
viridis, and turns the green, amber and red status colors into blue, orange
and magenta. The workspace is not changed: its own colors return when the
setting is off.

The population tree works from the keyboard (arrows, Home, End) and is
announced as a tree with each population's frequency and count; the sample
list is one stop with the arrow keys; dialogs keep the focus inside and give
it back when they close; and every plot has a text description of its axes,
population and gates. The
[Accessibility page](https://robert-mcdermott.github.io/cytoweave/docs/accessibility.html)
of the user guide lists the shortcuts and what is not covered yet.

## Workspaces, history and the library

A workspace holds:
- the samples and their annotations;
- gates, matrices and scales;
- derived results: clusters, maps, unmixed channels and QC masks;
- figures, tables and the change log.

Every edit can be undone (⌘Z) and redone (⇧⌘Z).

Workspaces save themselves to the **library**, a folder in your user
configuration directory: `~/Library/Application Support/CytoWeave` on macOS,
`~/.config/CytoWeave` on Linux, `%AppData%\CytoWeave` on Windows. The
library keeps each FCS file once, under its SHA-256 checksum. A workspace
refers to files by checksum, so it keeps working when the original files are
moved or renamed. Deleted workspaces go to the library's `trash` folder.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/strategy-dark.webp">
  <img alt="Applying OMIP-101 to the PBMC example: its citation, the differences from the article, every channel matched by marker, and 25 populations to be added" src="docs/images/strategy-light.webp">
</picture>

**Templates** (Workspace → Save as a template) keep an analysis, or one
population and those under it: gates, scales, plots, tables, figure layouts and
which compensation the samples used, in the library or as a `.cwt` file.
**Workspace → Apply a template** matches the template's channels to the open
experiment by marker (scatter and time by name), shows how each matched and
lets you choose another, says which populations will be left out and why, and
adds the gates under any population. The same dialog offers two published
gating strategies, OMIP-101 and OMIP-090, written for CytoWeave from the
articles' hierarchies (each lists where it departs from its article). Their
gates are placed on the current sample's events, each in its parent population
(density peaks on scatter, the valleys between a marker's populations), and
say where they were placed and why; review or adapt them across samples like
any other gate.

**Cell types.** The inspector suggests a Cell Ontology term for the selected
population from which side of each gate's markers it lies on (and, for scatter
gates, where it sits), with the markers the term rests on and its definition;
confirm it or choose another. Confirmed terms are written into FlowJo
workspace exports (each population's annotation) and Gating-ML, shown under
the population's columns in Tables, and named in the methods. CLR files keep
populations' names only: the CLR format has no field for a term.

**Workspace → Export** writes:
- a workspace file (`.cwz`);
- an ACS container with the FCS files, to send to a colleague or archive with
  a paper;
- the gates as Gating-ML;
- population memberships as CLR;
- a FlowJo workspace (see [below](#working-with-flowjo-and-other-tools));
- de-identified FCS files, as a ZIP or as an ACS archive with the workspace.

**De-identified files** keep the keywords needed to read and analyze them
(parameters, markers, ranges, voltages, compensation, the instrument model, the
time step, index-sort wells) and remove everything else: operator, specimen and
patient fields, free-text comments, file names, dates (unless you keep them),
serial numbers and vendor keywords. The dialog lists what it removes. Only the
keyword text is rewritten; the events are copied byte for byte. Files are named
after their samples, and sample names are kept, so rename any sample whose name
identifies a person first. **Export events as de-identified FCS** in the
population menu does the same for one population.

## Working with FlowJo and other tools

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/flowjo-dark.webp">
  <img alt="The FlowJo migration report: 56 of 56 population counts agree exactly with FlowJo" src="docs/images/flowjo-light.webp">
</picture>

**FlowJo workspaces** (FlowJo 10 `.wsp`) import their samples, gates,
compensation matrices and scales. The import dialog lists every population as
exact, approximated or unsupported, and says why: a curly quadrant, for
example, imports with straight dividers. Gates FlowJo drew on uncompensated
data keep uncompensated values; time and linear axes with a gain are converted
from FlowJo's units; ellipses are read from FlowJo's display space.

Add the FCS files and CytoWeave matches them. With **Compare every population
count with FlowJo's**, the **FlowJo migration report** shows FlowJo's count,
CytoWeave's count, the difference and the likely cause, population by
population.

FlowJo's biexponential scale is reproduced exactly, from FlowJo's own table
algorithm. On FlowJo's own test workspaces CytoWeave reproduces the counts
FlowJo saved; on real workspaces it matches them exactly at least as often as
FlowKit does, and within 0.1–0.3% for large populations (FlowJo evaluates
gates at its display resolution, which moves events near gate boundaries).

**FlowJo 11 workbenches** (`.flowjo`) import the same way: polygons,
rectangles, ellipses, ranges, quadrant gates (one with an offset arm becomes the
rectangles each quadrant covers), Booleans, per-sample adjustments,
compensation and linear, log and biexponential scales, compared with the
counts FlowJo stored in the workbench. FlowJo 11 counts events on its display
grid; evaluated that way, CytoWeave's reading gives FlowJo 11's own count for
every population of twelve workbenches FlowJo 11.2 saved.

**FACSDiva experiments** exported as XML import their tubes (one sample each,
matched to their FCS files), specimens (groups), gates (rectangles, polygons,
intervals, quadrants, Booleans and "rest of" populations, on the linear, log or
biexponential axes they were drawn on) and compensation, compared with Diva's
counts. On the experiment CytoML is tested with, every count equals CytoML's.

**FACSChorus gates** recorded in FACSDiscover S8 and A8 FCS files are offered
for import when the files open: polygons and rectangles, exact on linear and
log axes (FACSChorus does not record the width of its biexponential axes, so a
polygon on one is approximated; FACSChorus stores no counts to compare).
**SpectroFlo experiments** (`.Expt`) set up the Spectral view's reference
controls from the experiment: each control file's fluorochrome, marker, beads
or cells, and the unstained control. CytoWeave computes the spectra from the
files; the experiment's stored spectra do not match the controls' own events.

**Exporting to FlowJo.** **Workspace → Export → FlowJo workspace** writes a
FlowJo 10 workspace (which FlowJo 11 also opens). Each sample gets its own
gating tree: the gates that apply to it, with its own adjustments. The
compensation, scales and sample groups go with it, and optionally CytoWeave's
population counts and the FCS files in a ZIP (de-identified if you choose). The
dialog lists every population as:
- **exact**;
- **traced**: drawn on a different scale than the one written for its
  channel, so its outline is written with enough vertices to follow it.
  Logicle and arcsinh scales are written as FlowJo's biexponential (the only
  one of the three FlowJo 11 reads correctly), so polygons and ellipses on
  those channels are traced; counts stay within 0.5%;
- **not exported**: category gates (QC pass, barcodes, clusters), gates on
  channels CytoWeave computed (unmixed, normalized, ratios), and gates of three
  or more dimensions, with their children.

Every validation case imports back with its counts unchanged. FlowKit 1.3
reads every export and counts what CytoWeave counts; CytoML 2.24 reads every
export, with 306 of 313 counts equal to CytoWeave's (the others are ellipses,
which CytoML reads differently from FlowJo). Compatibility testing used
FlowJo 11.2.0 (build 11.2.0.210156): three exports open with their files,
groups and compensation, and every population is within 0.6 percentage points
of CytoWeave's, most within 0.1 (FlowJo evaluates gates at its display
resolution). FlowJo 11 needs the files reconnected once (its "reconnect your
missing files" link, pointed at the workspace's folder) and does not import
Boolean populations, from FlowJo 10's own workspaces either. FlowJo 10 has not
been tried.

**Gating-ML 2.0** import and export covers:
- rectangle, polygon, ellipsoid, quadrant and Boolean gates, including gates
  of three or more dimensions (evaluated in all of them, though a plot shows
  two);
- the flin, flog, fasinh, logicle, hyperlog and ratio transformations, with
  their bounds;
- spectrum matrices, including spectral unmixing matrices, and the
  compensation each gate dimension names.

All 190 gates of ISAC's Gating-ML 2.0 compliance suite select exactly the
expected events.

Re-importing a CytoWeave export restores names, colors and scales exactly.
Gating-ML has no biexponential, so biexponential axes are written as their
closest logicle, with the gate coordinates converted; the export warns when it
does this.

**CLR** (classification results) exports a column per population or cluster
for every event, for tools that read memberships.

**Events for other tools.** **Workspace → Export → Events…** writes a
population's events in chosen samples, every event or downsampled (up to a
number per sample, or a share; seeded, each sample drawn on its own, the seed
recorded):
- one concatenated FCS file of the channels every sample has (raw values with
  the shared spillover matrix, or compensated values), with `SampleID`
  numbering the samples (named in its keywords) and `SourceEvent` giving each
  event's index in its own file;
- one FCS file per sample, in a ZIP;
- an AnnData file (`.h5ad`) for scanpy, muon and R (zellkonverter): `X` the
  chosen channels as arcsinh(x / cofactor) or compensated values; `obs` the
  sample, its annotations, each event's populations (a True/False column per
  gate and the deepest as a category), clusters, QC, scatter and time; `var`
  the channels and markers; `obsm` the maps (`X_umap`, `X_tsne`); `uns` where
  it came from. CytoWeave writes the HDF5 itself (uncompressed); anndata 0.10
  and 0.13, h5py and pyfive read it in the validation suite.

## Command-line options

```text
cytoweave [flags] [FCS files, folders, workspaces (.cwz), Gating-ML or FlowJo .wsp and .flowjo files...]
cytoweave mcp [flags]
cytoweave run [flags] [FCS files or folders...]
cytoweave verify [flags] certificate.acs
```

| Flag | Default | Effect |
| --- | --- | --- |
| `--window app\|browser\|none` | `app` | Open an app window (Chrome, Edge, Brave or Chromium, with its own profile), the default browser, or nothing |
| `--no-open` | | Same as `--window none` |
| `--keep-running` | | Keep serving after the window is closed |
| `--port` | `8770` | Preferred port; the next free one is used if it is taken |
| `--host` | `127.0.0.1` | Interface to bind. Keep the default unless you mean to serve other machines (for example `0.0.0.0` on a trusted network), which turns off the DNS-rebinding check |
| `--data-dir` | user config dir | Folder of the workspace library |
| `--no-library` | | Keep workspaces in the browser's own storage instead |
| `--watch` | | Watch a folder for FCS files as they are acquired, and check each one (QC → Live). The folder is only read |
| `--watch-interval` | `1s` | How often the watched folder is checked |
| `--remote-control` | | Accept actions from local programs (see below) |
| `--dev` | | Serve `web/` from the working directory (for development) |
| `--version` | | Print the version |

CytoWeave stops when its app window closes. On macOS, Chrome (and Edge, Brave) keeps running after
its last window is closed: quit it with ⌘Q to stop CytoWeave too. If that browser is still running
when CytoWeave starts, the new window opens in it and CytoWeave keeps serving until Ctrl+C.

### Headless runs

`cytoweave run` applies an analysis template to FCS files without a window, for
a core's nightly runs, pipelines and CI:

```sh
cytoweave run --template panel.cwt --annotations samples.csv --output results/ plate-12/
```

It opens CytoWeave in a headless Chrome (or Chromium, Edge, Brave), applies the
template with the same code as the window, and writes these files to the output
folder:

- the template's tables, as an Excel workbook (`tables.xlsx`) and a CSV per table;
- the batch report of its last figure (`report.pdf`, or `--report pptx`);
- the workspace (`workspace.cwz`), to open and review in the window;
- the methods (`methods.txt`);
- `run.json`, which records each input file's checksum, each step's outcome,
  every population's count in every sample, and what was written.

`--qc` runs acquisition QC first, `--flowjo` adds a FlowJo workspace,
`--review` a review report (`review.html`) and `--certificate` a
reproducibility certificate (`certificate.acs`).
`--steps steps.json` runs any sequence of the agent actions instead. The exit
status is 0 when every step succeeded, 1 when one failed and 2 for a usage
error. See [Scripting and command line](https://robert-mcdermott.github.io/cytoweave/docs/scripting.html#run).

`cytoweave verify analysis.certificate.acs` verifies a certificate the same
way: it computes every number again from the files and exits with 0 when the
certificate is confirmed, 1 when something differs and 3 when files are
missing (`--data folder` supplies them; `--report` writes the result as JSON).

## Scripting and AI agents

`cytoweave mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server. With it, an AI agent such as Claude Code can drive the CytoWeave
window you are watching:
- open files and examples, annotate samples, and inspect the gating tree;
- create gates from coordinates or propose them from the data's density;
- run acquisition QC, unmix spectral files (and diagnose a poor unmixing),
  and cluster and map cells;
- save and apply analysis templates and published gating strategies (OMIP-101,
  OMIP-090), and name populations with Cell Ontology terms;
- analyze an antibody titration or a detector voltage walk;
- edit gates, compute statistics across samples and render plots;
- review a gate across the cohort, adapt it to each sample, compare groups,
  test differential abundance and state of every cluster, check a
  comparison's robustness, build figures and write the methods;
- watch an instrument's export folder as files are acquired;
- export FlowJo workspaces, de-identified FCS files, figures and tables to
  files, and Gating-ML.

```sh
claude mcp add cytoweave -- ~/.local/bin/cytoweave mcp
```

> Open the PBMC example, gate cells, singlets, live cells and CD3+ T cells,
> then CD4 and CD8 T cells, and tell me how the CD4:CD8 ratio differs between
> stimulated and unstimulated samples.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-review-dark.webp">
  <img alt="Reviewing an agent's proposal: three gates proposed by Claude Code with their frequencies, and a compensation matrix, to accept or reject" src="docs/images/agents-review-light.webp">
</picture>

The agent works through the same actions as you do, and its changes are
proposals. Its gates, computed results (QC, unmixed channels, clusters, maps)
and figures appear at once, marked as proposed, with real counts; its
renames, deletions, compensation matrices and sample annotations wait. A strip above the
population tree lets you review the proposal, then accept or reject it as a
whole. The change log records which agent proposed what and what you decided,
and any change can be undone. See
[Using CytoWeave with AI agents](docs/MCP.md) for the 54 tools, other clients
and how it works. The [agent benchmark](benchmark/README.md) grades agents on
analysis tasks against the simulated truth, through these tools.

The same actions are available to your own programs with `--remote-control`.
The R and Python clients in [`clients/`](clients/) make each one a function
and find the running CytoWeave themselves:

```r
library(cytoweave)          # remotes::install_github("robert-mcdermott/cytoweave", subdir = "clients/r")
cw_connect()
states <- cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"),
                                   pair_by = "subject")
as.data.frame(states)
```

```python
import cytoweave            # pip install "git+https://github.com/robert-mcdermott/cytoweave#subdirectory=clients/python"
cw = cytoweave.connect()
table = cw.statistics_table(statistic="freqParent").frame()
```

Any other language can post JSON to `/api/remote/action`;
[docs/MCP.md](docs/MCP.md#scripts-without-an-agent) shows how.

## Validation

The unit tests check every analysis function against hand-computed,
published or reference-tool values. The validation suite runs the complete
pipelines, as the app does, against answers known in advance:

| Area | Checked against | Result |
| --- | --- | --- |
| FCS | All 290 example files | Parsed without warnings; written and read back bit-exact |
| FCS fuzzing | 20,000 mutations of files in every layout (offsets, keywords, delimiters, flipped bytes, truncation) | Every file read consistently or refused with a message; no crash, hang or outsized allocation |
| Compensation | The true spillover of the PBMC example | Matrices within 0.02 of the truth; the planted error found first, corrected to 0.158 (true 0.157) |
| Gating | True cell types | Precision 91–100%, recall 96–100% |
| QC | Known clogs, bubbles and drift | 99.8–100% of anomalous events removed; ≤ 1.4% of clean events, none from clean or drifting files |
| Spectral | True abundances of 25 fluorochromes | Median r = 0.988; within 0.001 of unmixing with the true spectra |
| Unmixing doctor | Six faults planted in the spectral example; real bead and cell controls and fixed spleen (AutoSpectral example) | Each fault named first on two experiments, nothing on clean samples, each fix closer to the truth; the autofluorescent cell controls and the fixed spleen named |
| Cell cycle | True phase fractions | Dean–Jett–Fox within 1.6 points, Watson within 2 |
| Proliferation | True precursor frequencies | Division index within 3% |
| Kinetics | Every cell's calcium in a simulated flux (five tubes) | Peak and times within one bin and 3% of the noise-free curve; responding share within 0.2 points |
| Plates and dose-response | A simulated 96-well screen with known IC50s; R's drc 4.0 on 8 synthetic curves and the screen | Every well placed from keywords and from names; Z′ equal to the true shares'; each simulated IC50 inside its 95% CI; residual sums never above drc's, drc from CytoWeave's estimate within 1e-8, standard errors within 1e-5 of the exact Hessian |
| Bead immunoassays | A simulated LEGENDplex-like 8-plex with known concentrations; beadplexr 0.5 and drc on its curves; beadplexr's own LEGENDplex data (13-plex, 18 files) | 99.6% of beads assigned to their analyte; sera in range within 20% for 97% (median 1.8%); concentrations equal to drc's within 1e-8; bead identification identical to beadplexr's on 17 files, the 18th where its clustering merged two analytes |
| Debarcoding | True wells of a 20-sample barcoded plate | 100% of assigned cells in their true well; 98.7% of cells assigned |
| Clustering | 23 true populations | FlowSOM adjusted Rand index 0.91 |
| Normalization | Same-donor anchors in two batches | Batch distance reduced 25× |
| Scales | BD's FlowJo lookup tables | Biexponential within 5e-6 (the tables' precision) |
| Statistics | R 4.x | t-tests, Wilcoxon, Benjamini–Hochberg and t quantiles agree |
| Autogating | True cell types of a cohort with instrument shifts up to fivefold | Every shifted gate more accurate (T cells F1 0.954 → 0.994), none less; the 4 least accurate of 66 sent to review; nothing sent to review without a shift |
| Instrument (Q and B) | 30 simulated bead runs with known Q and B, and a PMT, flow cell and laser problem | Q within 2% (median), B within 6%; every problem flagged at once on Levey–Jennings charts, none in the 20 baseline runs |
| Spectral library | A second experiment's controls, and a tandem that lost 5% of its emission | Independent controls all match (largest difference 0.01); the degraded PE-Cy7 flagged and nothing else; a library spectrum unmixes as well as the dye's own control |
| Figure provenance | A 60-plot figure of 12 samples | Read back intact from SVG, PNG and PDF; rebuilt with every plot drawn from the same events; a moved gate flags exactly the plots it affects |
| Predicted spread | Simulated controls with known photon noise and laser fluctuations | Photon noise within 1% of the truth; each control's spread predicted from the other 24 within 2× for 98% of pairs; a 15-dye panel predicted from the 25-dye fit within 2× for every pair |
| Comparisons with a control | flowStats and R on tubes with known positive fractions; Bagwell's simulation | Probability binning identical to flowStats (36 cases, to 9e-15); SED within 2 points of the true fraction, Overton up to 8 points under where populations overlap; T(χ) above 4 in 0.5% of samples of the same cells |
| Formula channels | R evaluating the same 7 formulas on 10 tubes; Gating-ML and a template | Medians within 5e-8, single events within 2e-14; a ratio gate the same through Gating-ML (fratio) and on renamed detectors |
| Calibrated units (MEF) | FlowCal 1.3.1 on its own bead and cell files; simulated beads of known response | The same levels left out, medians within one step of the log channel, cells' MEFL within 1.6% of FlowCal's; a known slope within 0.001 |
| Absolute counts | 40 simulated tubes of known concentration with counting beads | Within 1% on average, scattered as Poisson counting predicts |
| Differential state | diffcyt 1.32 and limma 3.68 in R on the mass cytometry examples (8 samples with a batch, 20 paired wells); limma on 11 synthetic cases; activation known in advance | Every count and median identical, every moderated t, p and adjusted p within 3e-11; the known activation changes found (15 of 15 strong ones) with 3 of 53 calls false; no call where no marker differs |
| Events in and out | Concatenated, downsampled and per-sample FCS files against their sources; CSV files from CytoWeave, FlowJo and European locales, and a damaged one; AnnData files read by anndata 0.10 and 0.13, h5py, pyfive, fcsparser and FlowIO | Every event its source's; every population counted alike per SampleID; seeded downsampling exact and uniform; CSV values back exactly, every fault reported; X, obs and maps read exactly by every reader |
| Batch reports and spreadsheets | A figure repeated by sample and by subject; every number recomputed; the files read by openpyxl, python-pptx, pypdf and R pzfx | Every plot where the rules put it; all 171 numbers equal to their table column or gate; workbook, deck and Prism values exact in every reader |
| Headless runs | The PBMC example's 12 samples and a template run twice with `cytoweave run`, and analyzed in the window with its own buttons; Node on the same files | The same outputs both times and as the window exports them (CSV bytes, workbook values, report text, workspace, methods); all 228 counts equal to Node's |
| Virtual FMO controls | Simulated LSRFortessa- and Aurora-like panels with same-donor FMO tubes (15 markers); public FMO controls of a BD LSRFortessa (7 tubes) and a Cytek Aurora panel (4 tubes) | Simulated: within 1% of the display axis on average, against 12–13% for the unstained control; real: 5.8% and 5.5% of the axis on average (worst 11.6% and 14.8%) |
| Panel optimizer | Simulated 8-marker T-cell panels on 10 dyes (Aurora, unmixed; LSRFortessa, compensated), each assignment stained and every marker's resolution measured; random small panels solved exhaustively; a 25-color design on 29 dyes | Predicted cost against measured: r = 0.996 and 0.999 (log) across 26 assignments; the optimum measured best, 4× and 29× less noisy than dimmest-on-brightest; local search found every exhaustive optimum; 25 colors in about 8 s |
| Review reports | Every example's report, every sample's gates drawn; a run's report opened in Chrome | All 2,892 counts, table cells and plot percentages equal to the window's own and shown as it shows them; nothing loaded from outside the file; no accessibility violations (WCAG 2.1 AA, both themes) |
| Reproducibility certificates | Every example certified with its gates, a table, k-means clusters stored as a channel and a saved comparison, read back and verified; six kinds of tampering; certificates made in Chrome verified in Node and the reverse | All 2,413 numbers identical, bit for bit; the same archive byte for byte when made twice; every change caught; across engines, confidence limits equal to 12 digits |
| Rare events | R's exact intervals; simulated blanks and low-level samples | Intervals equal to poisson.test and binom.test, covering ≥ 95%; EP17 limits flagging 4% of new blanks and detecting 98% at the limit of detection |
| Robustness to analysis choices | Comparisons with known answers: a real effect, a gain shift, clogs and a stale matrix in one group, and no effect | The real effect holds in 64 of 64 analyses; each artifact called fragile or traced to the choice behind it; under no effect, half of the chance findings are flagged |
| Accessibility | Every text color on every surface, the palettes in simulated color-vision deficiencies, and axe-core in 86 pages | Contrast ≥ 4.5:1 everywhere in both themes; friendly palette ≥ 11 apart (CIEDE2000) in every kind of vision; no axe-core violations |
| Titration and voltage walks | A simulated CD4-PE titration and PE voltage walk with known binding, noise and gain | Stain index within 4.4% of the true cells' at every step; the recommended amount the binding's; the voltage range within 1 V of the truth; medians equal to FlowJo 11's on the same files |
| Templates | A 19-population analysis applied to the same events with every detector renamed and reordered | Every population holds the same events in all 12 samples; with two markers unnamed, only the gate on them left out |
| Published strategies | OMIP-101 and OMIP-090 placed on one sample of the PBMC example, against the true cell types | Median F1 0.96–0.99 for lineages, 0.88–0.96 for memory subsets, NK cells and classical and non-classical monocytes; Tregs 0.91; intermediate monocytes 0.76 |
| Gating-ML | ISAC's compliance suite | All 190 gates match on every event |
| Cell Ontology | 40 populations experts named in 3 public workspaces | Every top suggestion a term the name denotes; the same with every gate renamed |
| Autogating, against experts | An expert's per-donor gates in 4 FlowJo workspaces of a cytokine study (48 wells) | Agreement with the expert unchanged (F1 0.9876 → 0.9877), no adjustment lowering it; wells gated differently sent to review 3× as often as the others |
| flowQB | flowQB on its own LSR II data: an LED series, 8-peak and 6-peak beads | The same peaks, Q, B and standard errors in all 36 detectors (within 6e-9) |
| FlowJo | FlowJo's saved counts in 14 workspaces, and FlowKit's | The bundled example and FlowKit's synthetic workspaces exact; real 8-color workspaces at least as close to FlowJo as FlowKit |
| FlowJo export | The workspace imported back, FlowKit and CytoML reading the export, and FlowJo 11.2.0 (build 11.2.0.210156) opening three exports | Every count unchanged in 12 workspaces; FlowKit counts what CytoWeave counts (ellipse boundaries aside), CytoML 306 of 313 counts equal; in FlowJo 11 every population within 0.6 percentage points, most within 0.1 |
| Predicted spread, real controls | A BD LSRFortessa's 15 bead controls, each predicted from the other 14; a Cytek Aurora's 25 bead references, a 12-dye panel predicted from the noise of the other 12 dyes | Within 2× of the observed spread for 79% of well-measured pairs (median ×1.32); on the Aurora, 65% and 73% each way (r 0.76 and 0.80) |
| Robustness, real study | 4 donors of an intracellular cytokine study | Every PMA comparison holds in all analyses; one small IL-4 peptide response fragile |
| De-identification | Every example and corpus FCS file | The same events, bit for bit |
| Reference tools | FlowKit 1.3.2 and FlowIO | FCS decoding, compensation, spectral unmixing and transforms agree |
| FCS files | 16 instrument and malformed test files | All readable files read and written back bit-exact; malformed ones refused with a clear message |
| FCS files from 42 more instruments | 47 public files (CytoFLEX, NovoCyte, Aurora, Sony, FACSDiscover S8, FACSymphony, ZE5, Attune, Accuri, Helios and others), against FlowIO and fcsparser | Every file read; values within 4e-7 of both readers, and right where they are not (stale offsets, FCS 3.2 integer channels, log channels stored as decades) |
| R packages | flowCore, PeacoQC 1.22, FlowSOM and CytoNorm in R, on their example data and other public files | Values read, compensated and logicle-scaled within 1e-7; PeacoQC (classic) removes the same events; FlowSOM maps every event alike and agrees with R as closely as R agrees with itself; CytoNorm within 1e-5 |
| BD FACSDiva | Its spillover matrix from 15 real single-stain controls | Every entry within 0.015 (median method), with no manual gating |

The rows from Gating-ML down use public test data, which
`node validation/fetch.mjs` downloads and checksums. Details, tolerances and
how to run it are in [validation/README.md](validation/README.md).

## Privacy and security

- Files are parsed and analyzed in the browser. Nothing is uploaded, and
  CytoWeave makes no network requests of its own.
- By default the server listens only on the loopback interface. It rejects
  requests whose `Host` header is not a local address, which blocks DNS
  rebinding. It accepts API calls only from its own pages, and serves a strict
  Content Security Policy.
- Remote control is off unless `--remote-control` is given (`cytoweave mcp`
  turns it on for its own session). Actions need a per-session token for
  anything that reads files from disk.

CytoWeave is research software. It is not a medical device and must not be
used for diagnosis.

## Limitations

- FlowJo 9 workspaces are not read. FlowJo 11 logicle and arcsinh axes and
  spectral matrices in a `.flowjo` workbench are read but not checked against
  FlowJo 11's counts (logicle and arcsinh) or not applied (spectral).
- Curly quadrants import with straight dividers. Template group gates import
  as per-sample copies, merged where samples agree.
- FlowJo evaluates gates at its display resolution; CytoWeave evaluates them
  exactly, so a few events near gate boundaries can differ from FlowJo's
  counts (the migration report shows how many).
- In FlowJo 11 (tested with 11.2.0, build 11.2.0.210156), Boolean
  populations of an exported workspace are not imported, as with workspaces
  FlowJo 10 wrote. FlowJo 10 has not been tried.
- Adapting gates is conservative by design: a boundary that sits in sparse
  events is kept even when a large shift has left it off-center, and gates of
  three or more dimensions, Boolean and category gates are not adapted.
- Q and B standard errors are somewhat optimistic (in simulation 87% of true
  values lie within 2 SE), as in flowQB. The spectral library's threshold for
  a changed spectrum (0.03) was calibrated on simulated controls; real
  controls vary more, and a laboratory may need its own.
- Predicted spread was checked on the real controls of one conventional
  cytometer (LSRFortessa) and one spectral cytometer (Aurora), where it runs
  low by a median factor of 1.3 to 1.6. It does not predict spread from a
  heterogeneous dye (a degraded tandem) or from autofluorescence that differs
  between positive and negative cells.
- The panel optimizer was validated on simulated panels, where every
  assignment can be stained and measured; on real cells, its design rests on
  the dyes' approximate brightness and the expression levels given.
- Robustness to analysis choices covers two-group comparisons of a
  population; designs of more than two groups and cluster abundances are not
  checked, and scales are not varied.
- Differential state uses limma's standard empirical Bayes moderation and
  enters pairing and covariates as fixed effects; diffcyt's random-effect
  options (blocking with duplicateCorrelation, diffcyt-DS-LMM) and limma's
  robust moderation are not offered.
- QC as files are acquired needs the CytoWeave program (not the page served
  as a web site) and checks whole files, as acquisition software writes them,
  not events as they are acquired.
- Drawing a new gate needs a pointer (or an AI agent); from the keyboard,
  gates can be selected, moved, renamed and their limits typed. CytoWeave has
  not yet been tested by people who use screen readers every day.
- Published strategies place each gate on one sample and share it; where
  samples differ (stimulation, another instrument), review and adapt the gates.
  Intermediate monocytes, which lie between the classical and non-classical
  ones on CD16, are the least accurate of their populations (F1 0.76 in
  validation).
- Imaging flow data (CellView, Amnis) are not supported.
- Spectral unmixing needs the raw detector channels; files that hold only
  unmixed channels can be gated but not re-unmixed.
- Very large experiments are limited by browser memory: plan on about 4 bytes
  per event per parameter of every loaded sample, plus as much again for the
  compensated channels in use (ten million events × 21 parameters is 0.8 GB,
  about 1.5 GB in use). Samples load on demand, and the least recently used
  are dropped beyond 1.6 GB (3 GB on machines with 8 GB or more).
- Served as a plain web site rather than by the CytoWeave program, the page
  is cross-origin isolated only if the site sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them, analyses in
  workers get a copy of the events, and browsers refuse copies much over a
  gigabyte (QC of ten million events).

## Development

### Requirements

- Go 1.24 or later (standard library only).
- Node.js 22 or later, for the tests and the validation suite.
- No build step: the web application is plain ES modules.

### Run from source

```sh
go run . --dev
```

`--dev` serves `web/` from disk, so a browser reload picks up changes.

### Build

```sh
go build -o cytoweave .
GOOS=windows GOARCH=amd64 go build -o cytoweave.exe .
```

Releases are built by `.github/workflows/release.yml` for macOS, Linux and
Windows on x64 and ARM64.

### Test

```sh
go test -race ./...
node --test "web/lib/*.test.mjs"
node validation/fetch.mjs
node validation/run.mjs
```

`node validation/agent-session.mjs` drives every agent tool in the program and
headless Chrome (it needs Go and Chrome) and checks each result.
`node clients/test-clients.mjs` runs the R and Python clients' tests against
CytoWeave in headless Chrome (it also needs Python 3, and R with curl, jsonlite
and testthat). After changing a tool in `mcp.go`, run
`go test -run TestTheClientsToolListIsCurrent -update` and
`node clients/generate.mjs`; the latter also sets the clients' versions to
`main.go`'s.
`node validation/fuzz.mjs` fuzzes the FCS reader for longer than the suite
does (`--cases 200000`), and `--replay <file> <seed>` repeats a failing case.

`fetch.mjs` downloads the public test data the validation uses (about 540 MB,
into the git-ignored `validation/cache/`); without it those suites are
skipped.

### Documentation

The screenshots in `docs/images` are captured from the example experiments,
in the light and dark themes, by a script that drives headless Chrome (or
Chromium, Edge or Brave; set `CHROME` to choose):

```sh
node docs/capture/capture.mjs
node docs/capture/capture.mjs gate compensate --theme dark
```

The [website](https://robert-mcdermott.github.io/cytoweave/) is built from
`docs/site` into a checkout of the `gh-pages` branch. The build checks every
link, anchor and screenshot. Build into any folder to check it, and into the
`gh-pages` checkout only for a release (`--publish`), as committing that
checkout publishes the site:

```sh
node docs/site/build.mjs /tmp/cytoweave-site-check
node docs/site/build.mjs --publish
```

[docs/site/README.md](docs/site/README.md) describes how to set up the
`gh-pages` checkout, preview and publish the site, write pages, and add
screenshots.

### Code layout

```text
main.go, security.go, local.go, store.go,      Go host: server, security checks, files named on
window.go, remote.go, mcp.go, connection.go    the command line, library, app window, remote
                                               control, MCP server, connection file for scripts
web/index.html, web/styles.css, web/app.js     application shell
web/ui/                                        views and components (the only code using the DOM)
web/lib/                                       analysis modules, each with a *.test.mjs
web/workers/                                   module workers for heavy work
validation/                                    end-to-end checks against known answers
clients/                                       the R and Python clients (functions generated from
                                               clients/tools.json by clients/generate.mjs)
cytoweave-spec/                                design, conventions, requirements, roadmap, research
docs/                                          installing, AI agents, screenshots, website source
```

The design is described in [cytoweave-spec/design.md](cytoweave-spec/design.md),
the conventions in [cytoweave-spec/conventions.md](cytoweave-spec/conventions.md),
and the plans in [cytoweave-spec/roadmap.md](cytoweave-spec/roadmap.md).

## License, citation and credits

CytoWeave is licensed under the [Apache License 2.0](LICENSE). If you use it
in published work, please cite it (see [CITATION.cff](CITATION.cff)), together
with the methods listed in its Report view.

CytoWeave reimplements published methods. Their authors are cited in the
code and in the methods text it writes, among them:
- Logicle (Parks, Roederer & Moore);
- PeacoQC (Emmaneel et al.);
- FlowSOM (Van Gassen et al.);
- UMAP (McInnes et al.) and t-SNE (van der Maaten & Hinton);
- Leiden (Traag et al.) and Louvain (Blondel et al.);
- k-means++ (Arthur & Vassilvitskii) and Hamerly's k-means;
- CytoNorm (Van Gassen et al.);
- the spillover spreading matrix (Nguyen et al.);
- MEM (Diggins et al.);
- diffcyt (Weber et al. 2019) and limma's moderated t-statistics (Smyth 2004;
  Ritchie et al. 2015; Chen et al. 2025);
- MIFlowCyt, FCS and Gating-ML (ISAC);
- the OMIP-101 (Imbratta et al. 2024) and OMIP-090 (Stroukov et al. 2023)
  gating strategies, and the immunophenotypes of Maecker, McCoy & Nussenblatt
  (2012).

Cell types are named with terms of the [Cell Ontology](https://obofoundry.org/ontology/cl.html)
(release 2026-06-08): CytoWeave contains its labels, synonyms and definitions
of 89 terms, under the
[Creative Commons Attribution 4.0](http://creativecommons.org/licenses/by/4.0/)
license. Tan SZK et al. The Cell Ontology in the age of single-cell omics.
*Sci Data* 13, 946 (2026), doi:10.1038/s41597-026-07173-8.

Ported code:
- The FlowJo biexponential algorithm is ported from FlowKit (BSD-3-Clause,
  Scott White), which ported it from cytolib.
- The moderated t-statistics (`web/lib/limma.js`) follow the R and C sources
  of limma 3.68.5 (GPL ≥ 2, Gordon Smyth and co-authors) and statmod 1.5
  (Gordon Smyth), so that results equal R's.
- The validation suite includes excerpts of BD's FlowJo transformation lookup
  tables (MIT license, © 2020 Becton, Dickinson and Company; see
  `validation/data/LICENSE-BD-FlowJo-LUTs.txt`).

### Trademarks

FlowJo, FACSDiva, FACSDiscover, BD, Cytek, Aurora, Northern Lights, Sony,
ID7000, Amnis, CellView, CellTrace and the other product and company names in
CytoWeave and its documentation are trademarks of their respective owners.
They are named only to say what CytoWeave works with, such as the files and
workspaces it reads. CytoWeave is an independent open-source project. It is
not affiliated with, endorsed by or sponsored by any of them.

The example experiments are simulated. Instrument names in them (such as
"LSRFortessa-like") describe the configuration that was modeled, not data
from that instrument.
