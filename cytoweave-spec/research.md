# CytoWeave: methods, standards and design research

*Research date: 2026-10-01. Background for the design of CytoWeave, an Apache-2.0, local-first flow cytometry application: a single Go binary serves an embedded vanilla-JS web app, and all analysis runs in the browser.*

**Conventions**
- Citations are inline as URLs or DOIs.
- **(unverified)** marks a claim that could not be confirmed from a primary source.
- **(measured)** marks numbers produced during this research by porting reference code to JS and running it against published lookup tables. The scripts were scratch work and are not part of the repo.
- Section numbers follow the original research report, so references such as §3A.2 stay stable. Its market survey (sections 1 and 2) is not part of this repository.

---

## 0. Summary

1. **Numerical agreement with FlowJo needs care.**
   - BD published FlowJo's transform lookup tables under the **MIT license** (2020).
   - Measured against them, FlowJo's *logicle* departs from the Moore–Parks reference by up to about 108 of 4096 channels at W = 1. FlowJo's *biex* is a table algorithm of its own, not a logicle.
   - CytoWeave therefore reproduces FlowJo's biexponential exactly (`validation/`), and uses the published tables as golden tests (§3A.2–3A.3).
2. **Standards facts that implementations often get wrong:**
   - exact Gating-ML 2.0 namespaces and elements;
   - gate-boundary semantics: half-open rectangles, even–odd polygons;
   - FlowJo workspace (.wsp) structure and quirks;
   - the FCS 3.2 keyword set;
   - a robustness checklist for real vendor files (NIST fireflow).

   All are in Section 4.
3. **Spectral unmixing** is where method choices matter most.
   - Multiple autofluorescence signatures (Roet et al. 2024) and per-cell autofluorescence (AutoSpectral, bioRxiv 2025) improve unmixing.
   - Normalization and model choices change results (Robinson, Gmyrek & Rajwa, *BioEssays* 2025, doi:10.1002/bies.70091), so they should be visible and comparable (§3A.8, §5).
4. **Algorithms** (QC, clustering, embeddings, normalization, statistics, cell cycle, proliferation) are specified with their reference defaults, so a JavaScript implementation can be checked against R and Python (Section 3).
5. **Example data**: what may be redistributed, and under which terms (Section 6).
6. **Design implications**, in priority order (Section 8).

---

## 3. Algorithms to implement natively in JavaScript

This section has three parts:
- **3A** covers transforms, compensation and unmixing. I verified these directly against reference code and BD's published FlowJo lookup tables.
- **3B** covers QC, clustering, embedding, normalization, statistics and specialized analyses, with exact defaults from the reference source.
- **3C** covers the JavaScript numerical environment.

### 3A. Scale transforms, compensation and spectral unmixing (numerical-agreement detail)

All formulas below were checked against reference code that was read for this report: FlowUtils `logicle.c` (C port of the Moore/Parks reference, BSD-3, https://github.com/whitews/FlowUtils), FlowKit 1.3.2 `_transforms.py` / `_wsp_transforms.py` (BSD-3, https://github.com/whitews/FlowKit), flowCore `R/AllClasses.R` and `src/logicleTransform.cpp` (Artistic-2.0, https://github.com/RGLab/flowCore), and the Gating-ML 2.0 specification PDF (`GatingML_2.0_Specification.20130122.pdf`, https://sourceforge.net/projects/flowcyt/files/Gating-ML/Gating-ML%202.0/).

#### 3A.1 Order of operations (Gating-ML 2.0 §4.2, Fig. 5)

1. Decode DATA by `$DATATYPE`/`$PnDATATYPE`, `$BYTEORD`, `$PnB`, and mask integer values with `$PnR` (bitmask when `$PnR` is a power of two).
2. Convert "channel" values to "scale" values: if `$PnE = f1,f2` with f1 > 0 (log-amplified integer data), `scale = f2 · 10^(f1 · xc / $PnR)` (f2 = 0 is a common vendor error and should be read as 1). If linear and `$PnG` is present, `scale = xc / $PnG`. FCS 3.2 forbids `$PnG` together with log `$PnE` and restricts log `$PnE` to integer data. The spec's worked example decodes `0x01AF` = 431 with `$P3E=4,1` and `$P3R=1024` as `10^(4·431/1024) = 48.26071`.
3. Compensate or unmix, using the `$SPILLOVER` keyword (`compensation-ref="FCS"`), a Gating-ML `spectrumMatrix` (`compensation-ref="<id>"`), or nothing (`compensation-ref="uncompensated"`). Ratio dimensions (`fratio`) are computed after compensating their source dimensions.
4. Apply the scale transform named by `transformation-ref`.
5. Evaluate the gate in that compensated and transformed space.

CytoWeave's gate model should record `{dimension, compensation-ref, transformation-ref}` on every gate axis, exactly as Gating-ML does. Then a gate is unambiguous regardless of how the plot was displayed.

#### 3A.2 Logicle (Parks, Roederer & Moore 2006; Moore & Parks 2012)

- References: Parks DR, Roederer M, Moore WA. Cytometry A 2006;69A:541–551, **doi:10.1002/cyto.a.20258**. Moore WA, Parks DR. "Update for the logicle data scale including operational code implementations." Cytometry A 2012;81A:273–277, **doi:10.1002/cyto.a.22030**. The Gating-ML 2.0 spec says implementers should follow the reference implementation rather than code the formulas naively, because a naive implementation suffers serious round-off error (spec §6.4).
- Definition: `logicle(x; T,W,M,A) = y` such that `B(y) = x`, where `B(y) = a·e^(b·y) − c·e^(−d·y) − f`.
  - `w = W/(M+A)`, `x2 = A/(M+A)`, `x1 = x2 + w` (the scale position of data 0), `x0 = x2 + 2w`, `b = (M+A)·ln 10`.
  - `d` solves `2(ln d − ln b) + w(d + b) = 0`. The reference uses an RTSAFE-style safeguarded Newton/bisection, bracketed on (0, b), with tolerance `2·b·DBL_EPSILON` and at most 40 iterations. When w = 0, d = b and the transform is arcsinh.
  - `ca = e^(x0·(b+d))`, `mfa = e^(b·x1) − ca/e^(d·x1)`, `a = T / ((e^b − mfa) − ca/e^d)`, `c = ca·a`, `f = −mfa·a`.
- Implementation details that matter for bit-level agreement (from `logicle.c`):
  - **Symmetry by reflection**: for x < 0, compute on |x| and return `2·x1 − y`. The inverse reflects scale values below x1 the same way.
  - **Taylor series near zero**: within `xTaylor = x1 + w/4`, evaluate B with a 16-term Taylor series around x1. Coefficients are `posCoef *= b/(i+1)`, `negCoef *= −d/(i+1)`, `taylor[i] = posCoef + negCoef`, starting from `posCoef = a·e^(b·x1)` and `negCoef = −c/e^(d·x1)`. `taylor[1]` is forced to exactly 0 (the Logicle condition).
  - **Forward solve**: Halley's method from an initial guess. The guess is linear, `x1 + value/taylor[0]`, if `value < f`, and otherwise logarithmic, `ln(value/a)/b`. Tolerance is `3·DBL_EPSILON`, or `3·x·DBL_EPSILON` if x > 1, with at most 40 iterations. Above `xTaylor`, compute the residual as `(a·e^(bx) + f) − (c·e^(−dx) + value)`, which is the better-conditioned form.
  - Value 0 maps exactly to x1.
- Parameter constraints (Gating-ML): T > 0, M > 0, 0 ≤ W ≤ M/2, −W ≤ A ≤ M − 2W. The XSD records these only in comments, so the implementation has to validate them.
- **Output-scale conventions differ by tool, and this is a classic source of disagreement**:
  - Gating-ML, FlowKit and FlowUtils map to [0, 1], with T → 1.
  - flowCore's `logicleTransform()` returns `scale · M`, i.e. 0…M "decades", for both forward and inverse (`src/logicleTransform.cpp`). Its defaults are `w=0.5, t=262144, m=4.5, a=0`.
  - CytoWeave should keep the transform in [0, 1] internally and convert at import/export boundaries.
- **Automatic W estimate** (Parks 2006; flowCore `.lgclTrans`, `q = 0.05`): `r = (5th percentile of negative events) + DBL_EPSILON`, `W = (M − log10(T/|r|))/2`. flowCore's defaults are M = 4.5 (type="instrument") and T = the instrument range. flowCore *errors* if W < 0, and sets W = 0 if there are no negative events.
- **FlowJo's logicle is not bit-identical to the reference (finding from this research)**:
  - In 2020 BD published FlowJo transform lookup tables under the **MIT license** (`FlowJo Transformations Lookup Tables 2020.zip`, https://sourceforge.net/projects/flowcyt/files/Flow%20Cytometry%20Transformations/). The zip holds 224 logicle and 181 biex CSVs, 4096 rows each, mapping channel i (0–4095 of 4096) to a data value.
  - I compared the logicle LUTs (T = 262144, M = 4.41854, W 0–2, A 0–1) to the Moore–Parks reference evaluated at scale i/4096. The zero point x1 = (W+A)/(M+A) always matches.
  - The curves match to 0.00 channels only for W = 0 and W = 0.4. Elsewhere they deviate: about 1.4–1.8 channels at W = 0.5, about 90–108 channels (≈2.5% of axis) at W = 1.0, and hundreds of channels for W ≥ 1.5. The largest deviations are in the quasi-linear region.
  - **The construction behind the tables (measured, 2026-10):** the Moore–Parks reference with `d` taken after the solver's *first* RTSAFE step from d = b/2, every other step unchanged (including forcing the Taylor coefficient `taylor[1]` to 0). This reproduces all 224 logicle tables to within 0.01 of 4096 channels. With that `d` the logicle condition fails, so the series (near zero) and the exponential form disagree at x1 ± w/4: a jump of 0.1 channel at W = 0.5, 9 at W = 1, and for W ≥ 1.5 the curve turns back on itself (59 of the tables are not monotone). At W = 0.4 the first step lands within 1e-5 of the root, which is why the tables match the reference there.
  - **FlowJo's counts do not follow these tables.** On FlowKit's real FlowJo 10.6 workspaces (logicle W = 1, three samples of ~290 000 events), the reference logicle agrees with FlowJo's saved counts better than the tables' curve does; an ellipse gate, drawn in display space and so sensitive to the scale, is within 2% with the reference and 14% off with the tables' curve. CytoWeave therefore imports FlowJo's logicle as the reference logicle (`validation/README.md`).
  - Implication: gates imported from FlowJo WSP (vertices stored in data space) evaluate correctly with any monotone transform except at polygon edges. Edges are straight lines in *display* space, so a different transform bends them slightly differently.
  - **A second BD artifact confirms this.** The zip also contains `FlowJo_transforms.xlsx`, a forward table f(x) in channels for x = −10000…262150 in steps of 10. It shows the same pattern against the reference forward transform: W = 0 exact at all A; W = 0.5 within ≤ 2 channels; W = 1 off by 89–109 channels; W = 1.5 off by > 900 channels **(measured)**.
  - **BD's own notes in that workbook:**
    - Biex with neg = 0 and width −10 is FlowJo's default for fluorescence parameters. It is nearly identical to logicle with A = 0, W = 0.5.
    - Biex with width −100 roughly matches logicle with A = 0, W = 1, but differs by about ±3% in the low region.
    - FlowJo added logicle, using Wayne Moore's implementation, for Gating-ML compatibility. Biex is the legacy transform, kept for backward compatibility.
    - FlowJo treats combinations with **W + A > M/2** as invalid. That is stricter than Gating-ML's 2W + A ≤ M.
  - ~~CytoWeave should provide a "FlowJo-compatible logicle" mode backed by the BD LUTs.~~ Superseded by the two findings above: the tables are reproduced by formula, and FlowJo's counts follow the reference logicle instead.

#### 3A.3 FlowJo biexponential ("biex") (FlowJo legacy Java → cytolib → FlowKit)

- The WSP element is `<transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-10" transforms:pos="4.418539922">` with a child `<data-type:parameter data-type:name="..."/>`. `width` is the negative "width basis", e.g. −10, −100, −1000.
- Algorithm (`generate_biex_lut`, ported from TreeStar Java via the R cytolib library). It builds a 4097-point lookup table, `channel_range = 4096`:
  - `width = log10(−widthBasis)`; `decades = pos − width/2`; `extra = max(neg, 0) + width/2`.
  - `zero_point = int(extra·4096/(extra + decades))`, capped at 2048. If zero_point > 0, `decades = extra·4096/zero_point`.
  - `width /= 2·decades`; `positive_range = ln10·decades`; `minimum = maxRange/e^positive_range`.
  - `negative_range = logRoot(positive_range, width)` is a Newton/bisection root solver *with quirks* that must be ported verbatim:
    - its initial `f` uses `w·b` instead of `w·d`;
    - its bracket test subtracts rather than multiplies;
    - it uses `dx = abs(int(lo − hi))`.
  - For i = 0…4096: `P[i] = e^(i/4097·positive_range)` and `N[i] = e^(−i/4097·negative_range)·s`, with `s = e^((positive_range+negative_range)(width + extra/decades))`.
  - For i ≥ zero_point: `P[i] = minimum·((P[i] − N[i]) − (P[zp] − N[zp]))`. For i < zero_point: `P[i] = −P[2·zp − i]`.
  - Data → channel uses linear interpolation in that table, clamped to the LUT ends. Display coordinates are the channel / 4096.
- **Validation result (this research)**: I ported the algorithm to JS and compared it to all 181 BD MIT-licensed biex LUTs.
  - It reproduces every table to < 0.01 channel for width basis −3.98 through −1000 at every neg value 0–1.
  - It **deviates by 70–440 channels for width basis −1, −1.58 and −2.51**. FlowJo presumably clamps or special-cases very small |width basis|.
  - Use the LUTs directly for |widthBasis| < ~3.2, or as golden tests.
  - FlowKit's own test asserts < 0.01% mean deviation for the bundled LUT at width −7.94 (`tests/workspace_tests.py`).
- The WSP `<Cytometers><Cytometer ... widthBasis="-100" extraNegs="0" transformType="BIEX" linMax="262144" ...>` element stores the per-cytometer defaults that FlowJo applies to newly loaded samples.

#### 3A.4 Hyperlog (Bagwell 2005)

- Reference: Bagwell CB. Cytometry A 2005;64A:34–42, **doi:10.1002/cyto.a.20114**.
- Gating-ML defines `hyperlog(x; T,W,M,A) = y` with `EH(y) = a·e^(b·y) + c·y − f`. Its parameters (w, x2, x1, x0, b) are the same as logicle's.
- From `logicle.c` (`hyperlog_scale`):
  - `e0 = e^(b·x0)`, `ca = e0/w`, `fa = e^(b·x1) + ca·x1`, `a = T/(e^b + ca − fa)`, `c = ca·a`, `f = fa·a`.
  - Use a Taylor series with `taylor[i] = a·e^(b·x1)·b^(i+1)/(i+1)!` and `taylor[0] += c`.
  - Halley iterations: at most 10, tolerance `3·DBL_EPSILON`.
  - The linear-region initial guess is `x1 + value·w/inverse`, where `inverse = EH(x0)`.
  - Negative reflection works as in logicle.
- Constraints are as for logicle. Ship it for Gating-ML compliance; it is rarely user-selected.

#### 3A.5 Arcsinh variants (three incompatible conventions)

| Convention | Formula | Where used |
|---|---|---|
| Gating-ML `fasinh` | `y = (asinh(x·sinh(M·ln10)/T) + A·ln10) / ((M+A)·ln10)`, maps T→1. Equivalent to Logicle(T, 0, M, A). | Gating-ML, FlowKit `AsinhTransform`, FlowJo WSP `<transforms:fasinh transforms:length="256" transforms:maxRange=… T A M W>`. FlowKit ignores `length/maxRange/W` and matches FlowJo counts exactly in its tests. |
| Cofactor arcsinh | `y = asinh(x / cofactor)` | CATALYST/diffcyt (`cofactor=5` CyTOF), OMIQ, Cytobank, Spectre, cyCombine. Common cofactors are 5 (CyTOF), 150 (conventional flow) and 6000 (spectral/Aurora, per Ferrer-Font 2020, doi:10.1002/cpcy.70, as reported in cyCombine, doi:10.1038/s41467-022-29383-5). |
| flowCore `arcsinhTransform` | `y = asinh(a + b·x) + c` (defaults a = 1, b = 1, c = 0) | flowCore. Note the default *offset a = 1*. |

CytoWeave should model the cofactor form as the user-facing "arcsinh" (with per-channel cofactor) and convert it to `fasinh` on Gating-ML export. The conversion for M+A decades is `T = cofactor·sinh(M·ln10)` with A = 0. Note that flowCore's `a` is an offset, not Gating-ML's A.

#### 3A.6 Linear and log

- Gating-ML `flin(x; T, A) = (x + A)/(T + A)`.
- Gating-ML `flog(x; T, M) = (1/M)·log10(x/T) + 1`.
- FlowJo WSP `<transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1">` maps to flin with A = −minRange... FlowKit uses `param_a = minRange` as the offset (verify sign with negative minRange).
- FlowJo WSP `<transforms:log transforms:offset=… transforms:decades=…>` maps to `y = (log10(max(x, offset)) − log10(offset))/decades`. Values below the offset are clamped (FlowKit `WSPLogTransform`).

#### 3A.7 Conventional compensation

- **Spillover matrix semantics**:
  - `S[i][j]` is the fraction of fluorochrome i's primary-detector signal that appears in detector j. Rows are sources.
  - `$SPILLOVER` (FCS 3.1+) is `n, PnN_1…PnN_n, s11, s12, …, snn`, row-major.
  - Compensated row vector: `v_c = v · S⁻¹` (Gating-ML §7.6.1). FlowUtils implements this as `solve(S.T, X.T).T`, which is numerically better than forming S⁻¹ explicitly.
  - Legacy keywords: `SPILL` and `$SPILL` (BD, often without `$`), `$COMP` (FCS 3.0), and `$DFCiTOj` (FCS 2.0, percent values).
  - Some files use parameter *indices* instead of `$PnN` names in `$SPILLOVER` (NIST fireflow `COMMON_ISSUES.md`), so be tolerant.
- **Estimating S from single-stain controls**:
  - Classic approach: `S[i][j] = (median_j(pos_i) − median_j(neg_i)) / (median_i(pos_i) − median_i(neg_i))`, using a matched negative (universal negative or internal negative).
  - Robust approach: **AutoSpill** (Roca et al., Nat Commun 2021, **doi:10.1038/s41467-021-23126-8**) fits robust linear regressions per channel pair, then iteratively refines on compensated data until the residual slope converges. It requires no explicit negative gate. FlowJo now ships "AutoSpill Compensation" (https://docs.flowjo.com/flowjo/experiment-based-platforms/plat-comp-overview/autospill-compensation/).
  - CytoWeave should offer both, with a residual-slope diagnostic matrix.

#### 3A.8 Spectral unmixing: OLS, WLS, NNLS, Poisson/GLS, and autofluorescence

Notation: y ∈ R^d is the raw detector vector for one event. M ∈ R^(d×p) holds the reference spectra (columns are fluorochromes plus AF signatures, each normalized to peak = 1). x ∈ R^p is the abundance vector.

- **OLS** (default in SpectroFlo, FlowJo and the Gating-ML spec): `x = (MᵀM)⁻¹Mᵀy = M⁺y`, with M⁺ from SVD (Gating-ML §7.6.2). Precompute U = M⁺ once (p × d); unmixing is then one matrix–vector product per event. In FlowJo WSP a spectral matrix is `<transforms:spilloverMatrix spectral="1" weightOptAlgorithmType="OLS" …>` (FlowKit raises `NotImplementedError` for any other algorithm type).
- **WLS**: `x = (MᵀWM)⁻¹MᵀWy`, with W = diag(1/σ²_d).
  - With *global* weights it remains a single precomputed matrix.
  - With *per-event* Poisson-like weights (σ²_d = B_d + k·signal_d), it needs a p × p solve per event.
  - BD **SpectralFX** (FlowJo ≥ 10.10, FACSDiscover S8/A8/A7) is a "system-aware" WLS whose weights come from LED-calibrated, real-time detector baseline-noise keywords written by BD instruments (BD SpectralFX flyer: https://www.bdbiosciences.com/en-us/learn/applications/BD-spectralFX-technology). The exact keyword names are unverified.
- **NNLS** (Lawson–Hanson active set; fast variant: Bro & de Jong 1997) constrains x ≥ 0. Gating-ML names OLS and NNLS as the "basic" algorithms. NNLS removes negative spread but biases dim populations upward and destroys symmetric negative distributions. Offer it with a warning, not as the default.
- **Poisson IRLS / generalized model**: Novo, Grégori & Rajwa 2013, Cytometry A 83A:508–520, **doi:10.1002/cyto.a.22272**.
- **Theoretical unmixed spread under OLS**: `Cov(x) = U Σ_y Uᵀ`, where Σ_y is the detector noise covariance (Poisson: diag(B_d + k·M x_true)). This gives a principled *predicted* spillover-spreading matrix for panel design without running controls.
  - The 2026 "Residual Model" preprint formalizes such prediction for OLS: Cai et al., bioRxiv **doi:10.64898/2026.01.27.701929**, CC-BY 4.0, R package `USERM`.
  - **Complexity Index™** (Cytek) is the condition number of the peak-normalized reference matrix. **Similarity Index** is the cosine similarity between two normalized spectra.
- **Autofluorescence (AF) handling, in increasing sophistication**:
  1. Treat AF as one extra "fluorochrome" whose spectrum comes from the unstained control (SpectroFlo "AF as a fluorescent tag", FlowJo "Autofluorescence Subtraction").
  2. **Multiple AF signatures** included simultaneously. Roet et al. 2024 identify distinct AF spectra by unbiased dimensionality reduction plus clustering of *unstained* cells and add each cluster's spectrum as an extra AF column (Cytometry A 105:595–606, **doi:10.1002/cyto.a.24856**). Also see Pilkington et al. 2024, "Autofluorescence: from burden to benefit", **doi:10.1002/cyto.a.24885**.
  3. **Per-cell AF assignment (per-cell autofluorescence matching)**: AutoSpectral (Burton OT, Buecken L, De Vuyst L, Humblet-Baron S, De Leon ALM, Khan S, Cerveira J, Dooley J, Liston A; bioRxiv preprint 2025-10-27, **doi:10.1101/2025.10.27.684855**; R package, **AGPL-3**, https://github.com/DrCytometer/AutoSpectral).
     - Each cell is paired with the autofluorescence spectrum, among several, that suits it, rather than one autofluorescence spectrum for every cell.
     - The authors report up to 9000-fold fewer incorrectly assigned cells.
     - **Citation:** CytoWeave cites the preprint wherever it uses per-cell matching: in the code, the documentation, the Science page and the methods paragraph it writes.
     - **License:** AutoSpectral's code is AGPL-3 and is not copied or translated into Apache-2.0 CytoWeave; CytoWeave's implementation is its own (§3A.8).
- **Efficient per-cell AF selection in JS (derivation, not from a paper)**:
  - Let P_S be the projector onto the fluorochrome columns, and e = (I − P_S)y the fluorochrome-only residual, computed once per event.
  - For each AF candidate a_k, precompute ã_k = (I − P_S)a_k.
  - Adding a_k reduces the squared residual by exactly `(ã_kᵀe)² / ‖ã_k‖²`.
  - So the minimum-residual AF is the argmax of the squared normalized projection. It costs O(d) per candidate per event, not a full re-unmix: about 100 × 64 multiply-adds per event for 100 candidates and 64 detectors, which is feasible in a Web Worker or WebGPU for 10⁶ events.
  - The abundances then follow from a rank-1 update of the base OLS solution.
- **Spectral reference QC worth computing**:
  - cosine similarity of each control to a library spectrum;
  - peak-channel consistency;
  - positive-population brightness, i.e. stain index (see Section 3B);
  - AF contamination of controls (as AutoSpectral's automated control processing handles);
  - residual magnitude per event (‖y − Mx‖ / ‖y‖), shown as a QC parameter;
  - condition number;
  - an NxN unmixed-pairs plot (worst-pair ranking).

### 3B. QC, clustering, embeddings, normalization, statistics and specialized analyses

*Sources: reference code read directly from saeyslab/PeacoQC, SofieVG/FlowSOM, the Bioconductor mirrors (ConsensusClusterPlus, sva, edgeR, limma, flowAI, flowClean, flowDensity, flowStats), saeyslab/CytoNorm, biosurf/cyCombine, lmweber/diffcyt, uwot, umap-learn, umap-js, openTSNE, FIt-SNE, bhtsne, Multicore-opt-SNE, PaCMAP, TriMap, PhenoGraph, openCyto and R itself (wch/r-source). Also open-access papers and the npm registry. "(unverified)" marks claims not confirmed from a primary source. FlowSOM SOM, metaclustering and PeacoQC defaults were independently re-checked from source in this session.*

**License reminder:** FlowSOM, PeacoQC, CytoNorm, CATALYST and leidenalg are GPL. Implement from these formula descriptions, not by translating code (§8 licensing guardrails).

#### 3B.0 Cross-cutting

##### 3B.0.1 Wrong DOIs or titles in the brief, verified via Europe PMC
- **Spillover spreading matrix (SSM).** Nguyen, Perfetto, Mahnke, Chattopadhyay, Roederer, Cytometry A 2013;83(3):306–315. DOI **10.1002/cyto.a.22251**. 10.1002/cyto.a.22278 is OMIP-018.
- **Maecker 2004, "Selecting fluorochrome conjugates for maximum sensitivity".** Cytometry A 62:169–173. DOI **10.1002/cyto.a.20092**. 10.1002/cyto.a.20076 is an unrelated FDA/PI paper.
- **Overton 1988.** Cytometry 9(6):619–626. DOI **10.1002/cyto.990090617**. 10.1002/cyto.990090608 is an ATC3000 paper.
- **Fox 1980.** Cytometry 1(1):71–77. DOI **10.1002/cyto.990010114**. The 990010205 DOI is a polarization cytometer paper.
- **Dean & Jett 1974.** J Cell Biol 60:523, DOI 10.1083/jcb.60.2.523 (PMC2109170).
- **Probability binning (PB) papers, labels swapped in the brief.**
  - `…45:1<47::AID-CYTO1143>…` is the **multivariate** paper (Roederer, Moore, Treister, Hardy, Herzenberg).
  - `…45:1<37::AID-CYTO1142>…` is the **univariate** paper (Roederer, Treister, Moore, Herzenberg).
- **Wood 1998.** Cytometry 33(2):260–266. DOI 10.1002/(SICI)1097-0320(19981001)33:2<260::AID-CYTO23>3.0.CO;2-R.
- **Steen 1992.** "Noise, sensitivity, and resolution of flow cytometers", Cytometry 13:822–830. DOI 10.1002/cyto.990130804.
- **Other verified DOIs:**
  - Parks et al. 2017, Q/B weighted quadratic fit: 10.1002/cyto.a.23052 (PMC5483398).
  - Perfetto 2014, Q and B: 10.1002/cyto.a.22579.
  - Bigos 2007, separation index: 10.1002/0471142956.cy0121s40.
  - Hoffman & Wood 2007: 10.1002/0471142956.cy0120s40.
  - flowCut: 10.1002/cyto.a.24670.
  - flowClean: 10.1002/cyto.a.22837.
  - flowDensity: 10.1093/bioinformatics/btu677.
  - CytoNorm 2.0: 10.1002/cyto.a.24910 (Cytometry A 2025;107(2):69–87).
  - CytoNormPy (Exner 2025): 10.1002/cyto.a.24953.
  - QFMatch: 10.1038/s41598-018-21444-4.
  - Leiden: 10.1038/s41598-019-41695-z.
  - PhenoGraph: 10.1016/j.cell.2015.05.047.
  - FIt-SNE: 10.1038/s41592-018-0308-4.
  - Kobak & Berens: 10.1038/s41467-019-13056-x.
  - FlowSOM protocol: 10.1038/s41596-021-00550-0.
  - Becht UMAP: 10.1038/nbt.4314.
- **Baggerly 2001, PB χ² correction.** DOI 10.1002/1097-0320(20011001)45:2<141::AID-CYTO1156>3.0.CO;2-M.

##### 3B.0.2 R primitives you must port exactly to match R pipelines
Most of these packages sit on base R. Source lives in wch/r-source.

- **`stats::density()`** (R/density.R). Used by PeacoQC, openCyto, flowDensity and flowCut.
  - Defaults: `bw="nrd0"` = 0.9·min(sd, IQR/1.34)·n^(-1/5) (bandwidths.R), `adjust=1`, `n=512`, `cut=3`, `ext=4`, Gaussian kernel.
  - Grid: `from=min−3bw`, `to=max+3bw`, `lo=from−4bw`, `up=to+4bw`.
  - Binning: `C_BinDist` does linear binning of the data onto n points over [lo, up] in an array of length 2n.
  - Convolution: Gaussian kernel evaluated at `kords = seq(0, (2n−1)/(n−1)·(up−lo), length=2n)`, mirrored, convolved by FFT, `pmax(0, Re(...)[1:n]/(2n))`.
  - Output: interpolated with `approx` onto `seq(from, to, length=512)`.
  - R ≥ 4.4 changed `kords` (`old.coords=FALSE`), so tiny differences appear versus older R.
- **`quantile` type 7.** h=(n−1)p+1 and Q = x⌊h⌋ + (h−⌊h⌋)(x⌊h⌋+1 − x⌊h⌋).
- **`median`** averages the two middle values; **`sd`/`var`** use n−1.
- **`mad`** = 1.4826·median|x−median(x)|.
- **`scale()`** centers by the mean and divides by sd (n−1).
- **`smooth.spline`** (R/smspline.R plus Fortran `sbart`). Used by PeacoQC (spar=0.5) and flowDensity (spar=0.4).
  - x is scaled to [0,1]; knots are all unique x if n<50, otherwise `.nknots.smspl(n)`:
    - a_i = log2(50, 100, 140, 200);
    - n<200: 2^(a1+(a2−a1)(n−50)/150); n<800: 2^(a2+(a3−a2)(n−200)/600); n<3200: 2^(a3+(a4−a3)(n−800)/2400); else 200+(n−3200)^0.2; then truncated.
  - λ = r·256^(3·spar−1) with r = tr(XᵀWX)/tr(Ω). The ratio form is from memory of sbart.c (unverified).
  - Penalized cubic B-spline. A generic Reinsch smoother will **not** reproduce R.
- **`splinefun(method="monoH.FC")`** (R/splinefun.R, src/monoSpl.c). Used by CytoNorm and cyCombine.
  - x/y are first passed through `regularize.values(ties=mean)`, so duplicate x values collapse to mean y. This matters with many tied quantiles.
  - Secant slopes: Sx = Δy/Δx.
  - Initial slopes: m = c(Sx1, (Sx[k−1]+Sx[k])/2, Sx_last).
  - Fritsch–Carlson fix (`monoFC_mod`), for each k:
    - if Sk=0 then m_k = m_{k+1} = 0;
    - else α=m_k/Sk and β=m_{k+1}/Sk; if (2α+β−3>0 && α+2β−3>0 && α(4α+... ) i.e. α·(a2b3+ab23) < a2b3²) then τ = 3Sk/√(α²+β²), m_k=τα, m_{k+1}=τβ.
  - Evaluation is cubic Hermite (`splinefunH0`) with **linear extrapolation** outside the knots using end slopes (default `extrapol="linear"`).
- **`lowess`** (Cleveland, iter=3, delta=0.01·range). Used by voom.
- **`hclust`** (Fortran hclust.f, nearest-neighbor list).
  - Ties: the first minimal pair by index wins (strict `.LT.` comparisons, from memory; verify).
  - **`cutree`** numbers clusters in order of first appearance of observations.
- **`nls`** (Gauss–Newton) in uwot versus scipy `curve_fit` (Levenberg–Marquardt) in umap-learn. The a,b values for UMAP differ at about 1e-6.
- **R RNG, needed for bit-exact FlowSOM/ConsensusClusterPlus** (src/main/RNG.c, verified).
  - `set.seed(s)`: seed=s; apply seed=69069·seed+1 fifty times (uint32 wrap); then 625 times, storing each value in i_seed[0..624].
  - i_seed[0] (mti) is forced to 624, so mt[0..623]=i_seed[1..624] and MT19937 regenerates on the first draw.
  - `unif_rand` = fixup(MT_genrand()) with genrand = y·2.3283064365386963e-10. fixup maps ≤0 to 0.5·2.328306437080797e-10 and ≥1 to 1 minus that.
  - Since R 3.6 (`sample.kind="Rejection"`), `R_unif_index(dn)` does: bits=ceil(log2 dn); repeat v=rbits(bits) until v<dn.
    - `rbits` concatenates 16-bit chunks floor(unif·65536) for n=0; n≤bits; n+=16, then masks to `bits`.
  - `sample(x, k)` without replacement for n ≤ 1e7 (no hash) uses `SampleNoReplace`: x[i]=i; for i<k: j=R_unif_index(n); y[i]=x[j]+1; x[j]=x[--n]. The SampleNoReplace loop is from memory; verify.
  - FMA contraction in C builds can create last-bit differences.

##### 3B.0.3 JS library landscape (npm registry metadata as of 2026-10-01)

| package | version / last publish | license | notes |
|---|---|---|---|
| umap-js | 1.4.0 / 2024-06-05 | package.json "MIT", repo LICENSE file Apache-2.0 (inconsistent) | Random uniform[−10,10] init (no spectral); own RP-forest + NN-descent; different epoch schedule (§4); low maintenance |
| @saehrimnir/druidjs | 0.9.0 / 2026-08-02 | **LGPL-3.0-or-later** | Has UMAP, TSNE, TriMap, **PaCMAP**, LocalMAP, KMeans, KMedoids, OPTICS, hierarchical clustering; some WASM variants |
| tsne-js (scienceai) | 1.0.3 / 2016 | Apache-2.0 | Exact O(N²) t-SNE |
| bhtsne (npm) | 3.0.2 / 2018 | MIT | Barnes–Hut port |
| @tensorflow/tfjs-tsne | 0.2.0 / 2018 (repo last commit 2021) | Apache-2.0 | Pezzotti GPU field method. Defaults: perplexity 18 (capped by GPU), exaggeration 4, exaggerationIter 300, decayIter 200 (src/tsne.ts) |
| hnswlib-wasm | 0.8.2 / 2023-07 | Apache-2.0 | ANN for kNN |
| graphology-communities-louvain | 2.0.2 / 2024-12 | MIT | Options: resolution=1, randomWalk=true, rng=Math.random (seedable), fastLocalMoves=true |
| ngraph.leiden | 0.3.0 / 2026-06 | MIT | Leiden/Louvain; modularity or CPM; seeded |
| ml-kmeans 7.0.1, ml-hclust 4.0.0, ml-matrix 6.15.0, ml-pca 4.1.1, ml-levenberg-marquardt 5.1.0, ml-regression-polynomial 4.0.0 | 2022–2026 | MIT | |
| d3-contour 4.0.2 | — | ISC | |
| d3-hexbin 0.2.2 | — | BSD-3 | |
| fft.js 4.0.4 | — | MIT | |
| flatbush 4.6.2 | — | ISC | |
| static-kdtree 1.0.2 | — | MIT | |
| simple-statistics 7.12.1 | — | ISC | |
| @stdlib/* | — | Apache-2.0 | t/χ²/gamma CDFs, digamma/trigamma |
| mathjs 15.2.0 | — | Apache-2.0 | |
| kd-tree-javascript | — | npm says "UNLICENSED" | avoid |
| umap-wasm | — | — | **npm security-holder (removed malicious package); do not use** |

No npm packages exist under the names `pacmap`, `fast-tsne` or `graphology-communities-leiden`.

---

#### 3B.1 PeacoQC
Emmaneel et al., Cytometry A 2022;101:325, DOI 10.1002/cyto.a.24501. Source: saeyslab/PeacoQC v1.21.0, files `R/PeacoQC.R` and `R/PeacoQC_helper_functions.R`.

**Signature:**
```
PeacoQC(ff, channels, determine_good_cells="all", plot=20, save_fcs=TRUE, output_directory=".",
        name_directory="PeacoQC_results", report=TRUE,
        events_per_bin=FindEventsPerBin(remove_zeros, ff, channels, min_cells, max_bins, step),
        min_cells=150, max_bins=500, step=500, MAD=6, IT_limit=0.6, consecutive_bins=5,
        remove_zeros=FALSE, suffix_fcs="_QC", force_IT=150, peak_removal=1/3,
        min_nr_bins_peakdetection=10, time_channel_parameter="Time")
```

**Algorithm**

1. **Events per bin (`FindEventsPerBin`).**
   - max_cells = ceiling(2N/max_bins); max_cells = (max_cells %/% step)·step + step; epb = max(min_cells, max_cells).
   - With `remove_zeros`, max_bins = min(max_bins, min over channels of #nonzero/min_cells).
   - Example: N=1e6 gives epb=4500.
2. **Bins (`MakeBreaks`/`SplitWithOverlap`).**
   - Bins are taken over **event index order**, not time values: starts=seq(1, N, by=epb−ceiling(epb/2)), ends=min(start+epb−1, N).
   - This gives about 50% overlap, about 2N/epb bins, and up to 2 bins per event.
   - A check warns if time is not monotonic.
3. **Trend warning only (`FindIncreasingDecreasingChannels`).**
   - Take per-bin medians and smooth with `ksmooth(bandwidth=50)` (box kernel).
   - The channel is flagged "increasing" if cummax(y)==y in more than 3/4 of bins (same logic for decreasing).
4. **Peaks per channel per bin (`FindThemPeaks`).**
   - `density(x, adjust=1)` with R defaults.
   - A peak is where y[i] > y[i−1], y[i] > y[i+1] and y[i] > peak_removal·max(y).
   - Peak locations come from `dens$x[-1][selection]`. R recycles the logical index here, so x[n] is also selected when selection[1] is TRUE; replicate this quirk.
   - If there are no peaks, use argmax.
5. **Peak clustering (`DetermineAllPeaks`).**
   - Count peaks per bin. Choose "most_occuring" = the max peak count among counts that occur in more than `min_nr_bins_peakdetection`% (10%) of bins.
   - Take column-wise medians of peak positions over bins having exactly that count.
   - Assign every peak to the nearest median (`which.min`, so the first index wins ties).
   - Within a bin, duplicate assignments keep the peak closest to the median.
   - Drop clusters present in fewer than ½·(max bin id) bins.
   - `ExtractPeakValues`: one trajectory per (channel, cluster); bins missing that peak are filled with the cluster median.
6. **Isolation tree (`isolationTreeSD`), only if nbins ≥ force_IT=150.** Deterministic.
   - For each node with more than 3 rows and depth < ceil(log2(nbins)), and for each column:
     - Sort the values; for split index i compute gain = (sd_all − mean(sd_left, sd_right))/sd_all (sd uses n−1).
     - sd_left is 0 when i=1; sd_right is 0 when i=len−1; the update condition `gain ≥ best` means the last maximum wins.
   - Accept a split only if the best gain > gain_limit (0.6). **Quirk:** after each accepted split, gain_limit is set to that gain, so later splits need even larger gain.
   - The split rule is x ≤ x_sorted[i] (ties go left). If one child would get everything, the node becomes a leaf.
   - Leaf path length = depth + c(n), with c(n) = 2(ln(n−1)+0.5772156649) − 2(n−1)/n.
   - **Kept bins = the leaf with the most bins.** All other bins are outliers; the anomaly score is computed but not used for selection.
7. **MAD step (`MADOutlierMethod`), on IT-kept bins only.**
   - For each trajectory: s = smooth.spline(1:nb, peak, spar=0.5)$y.
   - Outlier if s > median(s)+MAD·mad(s) or s < median(s)−MAD·mad(s), with MAD=6 and mad scaled by 1.4826.
   - A bin is bad if any trajectory flags it.
8. **`RemoveShortRegions`.** `inverse.rle(within.list(rle(good), values[lengths<consecutive_bins] <- FALSE))`: runs of good bins shorter than 5 become bad.
9. **Event removal.** An event is removed if **any** bad bin contains it (union over overlapping bins). A warning is issued if more than 70% of events are removed.

**`RemoveMargins(ff, channels, channel_specifications=NULL, output="frame", remove_min=channels, remove_max=channels)`**
- Lower margin: e ≤ max(min(minRange, 0), min(e)). Upper margin: e ≥ min(maxRange, max(e)).
- minRange/maxRange come from flowCore parameter metadata (overridable).
- Warns if more than 10% of events are removed.

**`RemoveDoublets(ff, channel1="FSC-A", channel2="FSC-H", nmad=4, b=0)`**
- r = A/(1e−10 + H + b); keep r < median(r) + 4·mad(r). One-sided, mad scaled by 1.4826.

**JS notes**
- Cost is dominated by per-bin density: O(C·nbins·(epb + 1024·log 1024)) using FFT (fft.js).
- The IT as written in R is O(rows²) per column per node because it recomputes sd. Use prefix sums but keep the same tie semantics.
- Exact parity needs ports of R `density` and `smooth.spline`.

---

#### 3B.2 flowAI, flowCut, flowClean

##### flowAI
Monaco et al. 2016, DOI 10.1093/bioinformatics/btw191. Source: bioc/flowAI v1.43.

`flow_auto_qc(remove_from="all", timeCh=NULL, timestep=NULL, second_fractionFR=0.1, alphaFR=0.01, ModeDevFR=NULL, decompFR="cffilter", ChExcludeFS=c("FSC","SSC"), outlier_binsFS=FALSE, pen_valueFS=500, max_cptFS=3, ChExcludeFM=c("FSC","SSC"), sideFM="both", neg_valuesFM=1)`

- **Flow rate.**
  - Count events in 0.1 s bins. `timestep` comes from the $TIMESTEP keyword; the fallback is 0.01, or 1/1024 in one branch.
  - Christiano–Fitzgerald band-pass filter `cffilter(pl=2, pu=200, type="symmetric")` splits counts into trend + cycle. Zero-count bins are dropped.
  - Then a generalized ESD test (S-H-ESD style; `R/anomaly-detection.R`):
    - Iterate i = 1..⌊0.49n⌋.
    - R_i = max|v − median(v)|/mad(cycle), where v = (|x−trend| + |cycle|)·sign(cycle).
    - p = 1 − α/(2(n−i+1)); λ_i = t_{p, n−i−1}·(n−i)/√((n−i−1+t²)(n−i+1)).
    - The number of anomalies is the last i with R_i > λ_i. Events in anomalous bins are removed.
- **Signal acquisition.**
  - Bin size = min(max(1, ceil(N/100)), 500) events.
  - Per-bin median per channel (FSC/SSC excluded).
  - `changepoint::cpt.meanvar(method="BinSeg", penalty="Manual", pen.value=500, Q=3, test.stat="Normal")`.
  - Keep the largest segment between change points.
- **Dynamic range.**
  - Upper: events ≥ channel max range.
  - Lower (neg_values=1): x ≤ median(neg) − 3.5·mad(neg)/0.6745, where neg = negative values. **Quirk:** R `mad` already includes ×1.4826, so the effective threshold is about 7.7× the raw MAD.
  - Plus any negative scatter value.

##### flowCut
Meskas et al. 2023, DOI 10.1002/cyto.a.24670. Source: jmeskas/flowCut v1.5.2.

`flowCut(Segment=500, MaxContin=0.1, MeanOfMeans=0.13, MaxOfMeans=0.15, MaxValleyHgt=0.1, MaxPercCut=0.3, LowDensityRemoval=0.1, AmountMeanRangeKeep=1, AmountMeanSDKeep=2, UnifTimeCheck=0.22, RemoveMultiSD=7, Measures=1:8)`

- First remove low-density time stretches (time density ≤ 0.1·max).
- Split into 500-event segments. Per segment and channel compute 8 measures: P5, P20, P50, P80, P95, mean, 2nd central moment, 3rd central moment.
- z-score each measure across segments, sum |z| over the measures and over channels to get a segment score.
- If the file looks clean (max jump of segment means < 0.1, mean range-of-means < 0.13, max < 0.15; all relative to the P2–P98 range), drop segments outside mean ± 7 SD.
- Otherwise cut on the score density with `flowDensity::deGate` (tinypeak.removal 0.001, upper=TRUE).
- The file is flagged if any threshold is exceeded.

##### flowClean
Fletez-Brant 2016, DOI 10.1002/cyto.a.22837. Source: `clean(binSize=0.01, nCellCutoff=500, cutoff="median", fcMax=1.3, nstable=5)`.

- Requires ≥30,000 events; uses 100 equal time bins.
- Each marker is binarized at its median (if more than 90% of events are above, use the median anyway).
- Populations are the 2^p bit patterns with ≥500 events; at least 5 required, otherwise the quantile grid 0.5…0.05 is tried.
- Per-bin population frequencies are CLR-transformed; the per-bin Lp norm feeds `cpt.mean(method="PELT", penalty="Manual", pen.value=1)`.
- Segments are flagged by fold change > 1.3. "Weird" bins are found with seeds 37/42/51.
- Output is a `GoodVsBad` parameter; bad events get runif(10000, 20000).

**JS:** all three need changepoint (BinSeg/PELT) and CF-filter ports. They are moderate effort, and exact parity is plausible only for flowAI's ESD/margins parts.

---

#### 3B.3 FlowSOM
Van Gassen 2015, DOI 10.1002/cyto.a.22625; Quintelier 2021 Nat Protoc, DOI 10.1038/s41596-021-00550-0. Source: SofieVG/FlowSOM 2.11.1, files `R/0_FlowSOM.R`, `R/1_readInput.R`, `R/2_buildSOM.R`, `R/3_buildMST.R`, `R/4_metaClustering.R`, `src/som.c`.

**Wrapper:**
```
FlowSOM(input, compensate=FALSE, transform=FALSE, scale=FALSE, scaled.center=TRUE, scaled.scale=TRUE,
        colsToUse=NULL, nClus=10, maxMeta=NULL, importance=NULL, seed=NULL, ...)
```
- `set.seed(seed)` is called first.
- **scale defaults to FALSE since FlowSOM 2.1.4.** Older versions effectively scaled; the 2.x startup message says so.
- When scale=TRUE it uses R `scale()` (mean, sd with n−1).
- `BuildSOM(outlierMAD=4)`.

**`SOM()` defaults:**
```
SOM(data, xdim=10, ydim=10, rlen=10, mst=1, alpha=c(0.05,0.01),
    radius=stats::quantile(nhbrdist, 0.67)*c(1,0), init=FALSE, initf=Initialize_KWSP,
    distf=2, codes=NULL, importance=NULL)
```

**Grid, radius and initialization**
- grid = expand.grid(1:xdim, 1:ydim), so x varies fastest.
- nhbrdist = Chebyshev ("maximum") grid distance matrix.
- Default start radius = type-7 quantile at 0.67 of the full n×n matrix, diagonal zeros included. I computed: 10×10 → **6**; 7×7 → 4; 12×12 → 7; 14×14 → 8; 15×15 → 9; 20×20 → 11.
- With init=FALSE, codes = data[sample(1:n, xdim·ydim, replace=FALSE), ].
- `Initialize_KWSP`: random first point, then farthest-point selection. `Initialize_PCA` (±5 sd grid) is also available.
- `importance` multiplies columns before training.

**`C_SOM` training loop (som.c, exact)**
- The data matrix is column-major (data[i + j·n]). niter = rlen·n. threshold = radius[0]; thresholdStep = (radius[0]−radius[1])/niter; change = 1.
- For k = 0..niter−1:
  - If k % n == 0: if change < 1, stop; then reset change = 0. (Practically never triggers on real data.)
  - Sample i = (int)(n·unif_rand()), with replacement.
  - BMU = argmin distance over codes, strict "<" (first index wins). distf: 1 Manhattan, **2 Euclidean (with sqrt)**, 3 Chebyshev, 4 cosine (1−cos).
  - If threshold < 1, threshold = 0.5. Since the next decrement drops it below 1 again, this is effectively a floor of 0.5: only the BMU is updated at the end.
  - alpha = a0 − (a0−a1)·k/niter (linear 0.05 → 0.01).
  - For every code cd with nhbrdist[cd, BMU] ≤ threshold, i.e. a **bubble/step neighborhood with no Gaussian**: code += alpha·(x − code) and change += |x − code|.
  - threshold −= thresholdStep (linear radius 6 → 0).
- **mst > 1:** radius and alpha are split into mst linear segments. After each segment, nhbrdist = hop distance on the MST of the current codes (`Dist.MST`, igraph).
- **Mapping (`C_mapDataToCodes`):** nearest code, strict "<", returns 1-based id and distance.
- **Derived values (`UpdateDerivedValues`):** per-node median, CV (sd/mean), sd, mad, percentages. Outlier test: distance to node > median + 4·MAD.
- **MST (`BuildMST`):** igraph `minimum.spanning.tree` on the complete Euclidean graph of codes; weights normalized by their mean; Kamada–Kawai layout seeded with grid coordinates. This layout will not be bit-reproducible in JS and is display only.

**Metaclustering (`metaClustering_consensus`)**
- Call: `ConsensusClusterPlus(t(codes), maxK=k, reps=100, pItem=0.9, pFeature=1, clusterAlg="hc", distance="euclidean", seed=seed)`. Defaults used: innerLinkage="average", finalLinkage="average", corUse="everything".
- **Algorithm** (bioc/ConsensusClusterPlus 1.77, `R/ConsensusClusterPlus.R`):
  - `set.seed(seed)`; if seed is NULL, seed = `as.numeric(Sys.time())`, so results are **nondeterministic unless a seed is given**.
  - D = dist(t(d)), the Euclidean distance between nodes, computed once.
  - For each rep: sampleCols = sort(sample(100, floor(100·0.9)=90)). hc = hclust(D[sub,sub], "average"). For k = 2..maxK: cutree(hc, k) and accumulate the co-clustering count M_k; the indicator count I accumulates co-sampling.
  - Consensus C_k = M_k/I (0 where I = 0).
  - Final classes: hclust(as.dist(1−C_k), "average") → **cutree(·, k)**, then labels via `as.factor`.
- **`maxMeta` (`MetaClustering` → `DetermineNumberOfClusters`):**
  - Within-cluster SSE for k = 1..max, smoothed for i = 2..max−1: res_i = 0.8·res_i + 0.1·res_{i−1} + 0.1·res_{i+1}.
  - `findElbow`: for each split point i, fit two lm lines (1..i−1 and i..n) and pick i minimizing the sum of absolute residuals.

**Parity and JS notes**
- FlowSOM is deterministic given seed. Bit-exact agreement with R is achievable by porting R's MT19937 seeding, `unif_rand`, `R_unif_index` and `SampleNoReplace`, `hclust` average linkage and `cutree` (§0.2).
- Cost: O(rlen·n·100·d) is about 3e10 flops for n=1e6, d=30. Use a WASM/SIMD Worker; mapping is O(n·100·d).
- Python port saeyslab/FlowSOM_Python has the same SOM defaults (xdim=10, ydim=10, rlen=10, mst=1, alpha=(0.05,0.01)). Its consensus step is sklearn AgglomerativeClustering average linkage, H=100, resample 0.9, so its RNG differs from R.
- CATALYST (cluster(): 10×10, maxK=20, seed=1, same CCP args) and diffcyt use the same core (CATALYST details unverified).

---

#### 3B.4 UMAP
McInnes et al., arXiv:1802.03426. Sources: lmcinnes/umap 0.5.12 `umap/umap_.py`, `umap/layouts.py`; jlmelville/uwot 0.2.5.9000; PAIR-code/umap-js.

**umap-learn defaults**
- n_neighbors=15 (**includes self**), metric euclidean, min_dist=0.1, spread=1.0, learning_rate=1.0, init="spectral", set_op_mix_ratio=1, local_connectivity=1, repulsion_strength(γ)=1, negative_sample_rate=5, transform_queue_size=4, random_state=None, low_memory=True.
- n_epochs=None: 500 if n ≤ 10,000, else 200 (+200 for densMAP).
- kNN: NN-descent with n_trees = min(64, 5+round(√n/20)) and n_iters = max(5, round(log2 n)).

**Graph construction (`smooth_knn_dist`)**
- target = log2(k)·bandwidth.
- ρ_i = distance to the local_connectivity-th nonzero neighbor, interpolated for fractional values.
- Binary search for σ_i (≤64 iterations, tolerance 1e-5) so that Σ_{j≥1} exp(−max(0, d_ij−ρ_i)/σ_i) = target. Terms with d−ρ ≤ 0 contribute 1.
- Floor: σ_i ≥ 1e-3·mean(d_i·), or 1e-3·mean of all distances if ρ_i = 0.
- Weights w_ij = exp(−(d_ij−ρ_i)/σ_i).
- Symmetrize: W = A + Aᵀ − A∘Aᵀ (set_op_mix_ratio=1).
- Prune: edges with w < max(w)/n_epochs are set to 0.

**Layout optimization**
- Spectral init:
  - Eigenvectors 2..d+1 of the normalized Laplacian I − D^{−½}WD^{−½} (multi-component layout if disconnected).
  - Then `noisy_scale_coords`: scale so max|coord| = 10, then add N(0, 1e-4) noise.
- a,b: fit 1/(1+a·x^{2b}) to the offset-exponential curve on 300 points in [0, 3·spread]. Values I computed with LM:

| min_dist | a | b |
|---|---|---|
| 0.001 | 1.92907 | 0.79150 |
| 0.01 | 1.89561 | 0.80064 |
| 0.05 | 1.75023 | 0.84206 |
| **0.1** | **1.57694** | **0.89506** |
| 0.25 | 1.12144 | 1.05750 |
| 0.5 | 0.58303 | 1.33417 |

- Edge sampling: epochs_per_sample = max(w)/w; epochs_per_negative_sample = that /5.
- SGD per sampled edge (move_other=True during fit):
  - Attractive: coef = −2ab·d^{2(b−1)}/(1+a·d^{2b}).
  - Repulsive: coef = 2γb/((0.001+d²)(1+a·d^{2b})).
  - Each gradient component is clipped to ±4.
  - α_n = α0(1 − n/n_epochs).
- RNG is Tausworthe; numba threading makes results nondeterministic unless random_state is set.

**uwot differences (R/uwot.R, R/umap2.R, R/init.R)**
- **`uwot::umap()` defaults min_dist = 0.01**; spread 1; learning_rate 1; init "spectral" with `scale_and_jitter` (max 10, sd 1e-4).
- Epochs: 500 if n ≤ 10k, else 200.
- NN: "fnn" (exact) if n < 4096 and not ret_model, else Annoy (n_trees=50, search_k = 2·k·n_trees).
- RNG: PCG (pcg_rand=TRUE); a,b fitted by `nls`.
- **`uwot::umap2()`** is closer to Python: min_dist=0.1, init_sdev="range" (columns range-scaled to [0,10]), HNSW if RcppHNSW is installed, **batch=TRUE with Adam** (β1=0.5, β2=0.9, eps=1e-7, α=learning_rate).
- **Cytometry defaults:** most pipelines use n_neighbors=15, metric Euclidean on arcsinh/logicle data with no scaling. min_dist=0.1 (umap-learn/umap2) versus 0.01 (uwot::umap, and therefore tools that call it). The FlowJo UMAP plugin defaults (reportedly min_dist 0.5) are unverified.

**Transform (projecting new data)**
- umap-learn:
  - kNN query of the training index (k = n_neighbors, epsilon 0.12).
  - `smooth_knn_dist` with local_connectivity = max(0, lc−1).
  - Init = membership-weighted average of neighbor embeddings (`init_graph_transform`).
  - Epochs = 100 if n ≤ 10k, 30 otherwise; if the user set n_epochs, use ⌊n_epochs/3⌋. Prune edges < max/n_epochs.
  - SGD with move_other=False and **initial α = α0/4**. Training points stay fixed.
- uwot `umap_transform`: init "weighted" (default) or "average"; epochs = max(2, round(model_epochs/3)), else 100/30; initial_alpha = α/4.

**umap-js specifics (src/umap.ts)**
- Defaults: nNeighbors 15, minDist 0.1, spread 1, learningRate 1, negativeSampleRate 5, localConnectivity 1, setOpMixRatio 1, `random = Math.random` (seedable).
- Epochs: ≤2500 → 500; ≤5000 → 400; ≤7500 → 300; else 200.
- Init is uniform [−10,10]; there is no spectral init. a,b come from ml-levenberg-marquardt.
- Transform uses epochs = nEpochs/3 or 100/30 and appears **not** to divide the learning rate by 4 (moderately confident).
- Expect qualitative rather than numerical agreement. For validation, compare kNN graphs and fuzzy weights (deterministic given kNN) and trustworthiness metrics, not coordinates.

---

#### 3B.5 t-SNE, opt-SNE and FIt-SNE

**Core (bhtsne `tsne.cpp`; Rtsne uses the same code)**
- Input is zero-meaned then divided by max|x|. This is scale-irrelevant to P apart from numerics.
- K = 3·perplexity neighbors via a VP-tree.
- p_{j|i} ∝ exp(−β_i·d_ij²). Binary search on β (start 1, ×2 / ÷2 or bisection; |H − log(perp)| < 1e-5 in nats; up to 200 iterations).
- P = (P + Pᵀ) normalized to sum 1.
- Gradient **without the factor 4**: F_i = Σ_j p_ij q_ij Z (y_i−y_j) − Σ_j q_ij² Z (y_i−y_j).
- Barnes–Hut quadtree acceptance: max_cell_width/√(d²) < θ, with **θ = 0.5**.
- Update: gains += 0.2 if sign(grad) ≠ sign(update), else gains ×= 0.8; gains ≥ 0.01. uY = mom·uY − η·gains·dY; Y is re-centered each iteration.
- Schedule: η=200, momentum 0.5 → 0.8 at iteration 250, early exaggeration 12 until iteration 250, max_iter 1000.
- Init: randn·1e-4.
- Rtsne additionally defaults to pca=TRUE with initial_dims=50 and normalize=TRUE (unverified details).
- KL = Σ p log(p/q).

**Learning-rate conventions (they differ by the gradient's factor 4)**

| Implementation | Learning-rate rule |
|---|---|
| opt-SNE (`multicore_tsne/tsne.cpp`) | η = N/α, α = EE factor = 12 |
| FIt-SNE (`fast_tsne.py`) | `learning_rate="auto"` → max(200, N/12) |
| openTSNE (`tsne.py`) | `"auto"` → N/exaggeration **per phase** (N/12 during EE, N afterwards) |
| scikit-learn (includes factor 4) | `"auto"` = max(N/EE/4, 50) (unverified) |
| FlowJo docs | Learning rate suggested at about 7% of the cell count; opt-SNE on by default; Iterations 300–3000, Perplexity 2–100, Eta 2–2000, KNN VP-tree or ANNOY, gradient BH or FFT |

**opt-SNE**
Belkina 2019 Nat Commun, DOI 10.1038/s41467-019-13055-y (PMC6882880). Source: omiq-ai/Multicore-opt-SNE, BSD-3.
- KLDRC_N = 100·(KLD_{N−1} − KLD_N)/KLD_{N−1}.
- **Stop EE just past the local maximum of KLDRC.** In code:
  - KLD is polled every 3 iterations during EE and every 5 afterwards; monitoring starts after a 15-iteration buffer.
  - The EE→normal switch, which also switches momentum, happens at the **third** poll where KLDRC < previous KLDRC (`auto_iter_ee_switch_buffer=2`).
- **Stop the run when (KLD_{N−1}−KLD_N) < KLD_N/X with X = 5000** (`auto_iter_end=5000`; code: |Δ|/5 < KLD/5000), at least 15 iterations after EE.
- Python defaults: perplexity 30, EE 12, η=200 unless auto_iter, max_iter=1000, angle 0.5.
- Gains rule here is ×0.8 + 0.01 (not clamped).

**FIt-SNE** (Linderman 2019). `fast_tsne(theta=0.5, perplexity=30, max_iter=750, stop_early_exag_iter=250, early_exag_coeff=12, momentum=0.5, final_momentum=0.8, mom_switch_iter=250, learning_rate="auto", nterms=3, intervals_per_integer=1, min_num_intervals=50, knn_algo="annoy", n_trees=50, initialization="pca", max_step_norm=5, df=1)`. PCA init is divided by sd(PC1) and multiplied by 1e-4.

**openTSNE** (`TSNE.__init__`)
- perplexity 30; early_exaggeration_iter 250; early_exaggeration "auto" = 12; n_iter 500; theta 0.5; initialization "pca" (rescaled so sd(PC1) = 1e-4).
- initial_momentum = final_momentum = 0.8; max_step_norm 5.
- negative_gradient_method "auto": BH if n < 10,000, otherwise FFT.
- Gains: +0.2 / ×0.8 + 0.01.

**Kobak & Berens 2019 recommendations**
- PCA initialization (scaled to sd 1e-4).
- Learning rate n/12.
- Multi-scale affinities: perplexity combination 30 and n/100.
- For very large n: exaggeration of about 4, or downsampling-based initialization.
- They note UMAP behaves like t-SNE with exaggeration ≈ 4.

**JS**
- BH t-SNE in a Worker/WASM is fine to about 1e5–1e6 points. FFT interpolation is more work.
- tfjs-tsne (Pezzotti, GPGPU field method; IEEE TVCG 2020, DOI 10.1109/TVCG.2019.2934307, unverified) is archived.
- tsne-js is exact O(N²), so small n only.
- Coordinates will not match other implementations; compare KL and kNN preservation instead.

---

#### 3B.6 PaCMAP and TriMap

**PaCMAP** (Wang, Huang, Rudin, Shaposhnik, JMLR 22(201), 2021). Source: YingfanWang/PaCMAP v0.9.1, `source/pacmap/pacmap.py`, Apache-2.0.
- Defaults: `PaCMAP(n_components=2, n_neighbors=10, MN_ratio=0.5, FP_ratio=2.0, distance="euclidean", lr=1.0, num_iters=(100,100,250), apply_pca=True, random_state=None, knn_backend="faiss")`.
- If n_neighbors=None: 10 when n ≤ 10k, else round(10+15(log10 n − 4)). n_MN = round(n_nb·0.5); n_FP = round(n_nb·2).

**Preprocessing**
- If d > 100 and apply_pca: center, then TruncatedSVD to 100 dims.
- Otherwise: X −= min, X /= max, then center; a PCA is fitted for init.

**Pairs**
- Fetch kNN with n_neighbors+50 extra neighbors.
- σ_i = mean distance to neighbors 4–6 (columns 3:6).
- Scaled distance d²_ij/(σ_iσ_j); keep the n_neighbors smallest.
- Mid-near (MN) pairs: sample 6 random points, drop the closest, take the second-closest.
- Further pairs (FP): random non-neighbors.

**Loss** (d̃ = 1 + ‖y_i−y_j‖²)
- Neighbors: w_NB·d̃/(10+d̃).
- Mid-near: w_MN·d̃/(10000+d̃).
- Further: w_FP/(1+d̃).

**Weight schedule (`find_weight`)**

| Iterations | w_MN | w_NB | w_FP |
|---|---|---|---|
| 0–99 | linear 1000 → 3 | 2 | 1 |
| 100–199 | 3 | 3 | 1 |
| 200–449 | 0 | 1 | 1 |

**Optimizer and init**
- Adam with β1=0.9, β2=0.999, lr=1, eps=1e-7, bias-corrected lr_t.
- Init "pca": 0.01·PCA coordinates. A random init is N(0,1)·1e-4.

**JS:** DruidJS (LGPL-3.0) has a PaCMAP implementation; a custom port is easy at O(n·35·450).

**TriMap** (Amid & Warmuth, arXiv:1910.00204). Source: eamid/trimap `trimap_.py`.
- Defaults: n_inliers=12, n_outliers=4, n_random=3, lr=0.1, n_iters=400, weight_temp=0.5, apply_pca=True, opt_method="dbd".

---

#### 3B.7 PhenoGraph and Leiden

**PhenoGraph** (Levine 2015). Source: dpeerlab/PhenoGraph `cluster.py`, `core.py`.
- Defaults: `cluster(k=30, clustering_algo="louvain", directed=False, prune=False, min_cluster_size=10, jaccard=True, primary_metric="euclidean", q_tol=1e-3, louvain_time_limit=2000, nn_method="kdtree", resolution_parameter=1, n_iterations=-1, use_weights=True, seed=None)`.

**Steps**
1. Exact kNN via sklearn with k+1 neighbors, dropping self.
2. Jaccard weight: s_ij = |N(i)∩N(j)|/(2k − |N(i)∩N(j)|), only for j ∈ N(i).
3. Symmetrize: (G + Gᵀ)/2; with prune=True use G∘Gᵀ instead. Keep the lower triangle.
4. Louvain: the Blondel C++ binary, repeated random restarts. Stop when there is no modularity gain > 1e-3 in 20 runs, after 100 runs, or after 2000 s. Keep the best partition.
5. `sort_by_size`: labels ordered by descending size; clusters < 10 cells become −1.

**Leiden in PhenoGraph:** leidenalg `RBConfigurationVertexPartition`, resolution 1, n_iterations −1 (until convergence), weights used.

**Leiden** (Traag 2019)
- Phases: fast local moving (queue), then refinement (randomness θ=0.01 in the paper), then aggregation on the refined partition.
- Modularity with resolution: Q = (1/2m)Σ_ij(A_ij − γ·k_ik_j/2m)δ(c_i,c_j). CPM: Σ_c[e_c − γ·C(n_c,2)].
- leidenalg `find_partition` default n_iterations=2.
- Common defaults (unverified): scanpy resolution 1; Seurat FindClusters 0.8.

**JS**
- kNN: hnswlib-wasm, or exact brute force in Workers up to about 1e5 cells.
- Jaccard is O(n·k²).
- Community detection: graphology-communities-louvain or ngraph.leiden (both MIT).
- Modularity values are reproducible; labels are not (random order).

---

#### 3B.8 CytoNorm and CytoNorm 2.0

CytoNorm: Van Gassen 2020, DOI 10.1002/cyto.a.23904. CytoNorm 2.0: Quintelier et al. 2025, DOI 10.1002/cyto.a.24910. Source: saeyslab/CytoNorm v2.0.12 (`R/QuantileNorm.R`, `R/CytoNorm.R`, `R/evaluation.R`, `inst/NEWS`).

**`CytoNorm.train` defaults**
- `FlowSOM.params=list(nCells=1e6, xdim=15, ydim=15, nClus=10, scale=FALSE)`, `normMethod.train=QuantileNorm.train`, `normParams=list(nQ=99)`, `seed=NULL`, `clean=TRUE`, `recompute=FALSE`.
- In 1.x: `normParams=list(nQ=101)`.
- `prepareFlowSOM` defaults: nCells 1e6, xdim 15, ydim 15, **nClus=30**, scale FALSE.

**Algorithm**
1. Aggregate the training files and transform: cytofTransform is asinh(x/5) for CyTOF; transforms are out of scope here.
2. Train FlowSOM.
3. Map each file with `NewData`, giving a metacluster per cell, and split into per-metacluster files.
4. For each metacluster, label (batch) and channel, compute quantiles with R type 7:
   - **2.x:** nQ=99 at (1:99)/100, i.e. 0.01…0.99. The README states that from v2 the default is 99 quantiles and the 0th and 100th quantiles are no longer included.
   - **1.x:** nQ=101 at c(0, (1:100)/100), i.e. 0…1, including min and max.
   - Multiple files per label are aggregated (all cells). Fewer than or equal to `minCells=50` cells gives NA and an **identity function**.
5. `limit` (default NULL), e.g. c(0,8): the values are appended as fixed points to both the sample and goal quantiles, so the spline passes through (limit, limit).
6. Goal (refQuantiles):
   - `"mean"`: element-wise mean across labels (na.rm).
   - A batch label: that batch's quantiles.
   - A numeric vector of length nQ, or an nQ×channels matrix.
   - 2.x adds a per-metacluster list, e.g. from `getCytoNormQuantiles` of another model, for "normalising towards a model/distribution".
7. Spline per (cluster, label, channel): `splinefun(labelQ, refQ, method="monoH.FC")` (§0.2: ties averaged, linear extrapolation). If there are fewer than 2 unique quantiles, use identity.
8. **Normalize:** map cells to a metacluster and apply that metacluster's spline per channel. Infinite outputs are replaced by sign·max|finite|.

**New in 2.0** (paper, vignettes and code)
- Use without controls: the aggregate of each batch serves as a proxy control.
- Goal distribution tailored to the design.
- Guidance on choosing markers for the internal FlowSOM.
- `testCV(fsom, cluster_values=3:50, seed=1)`: CV of cluster % across files; the README suggests reconsidering clustering if CV exceeds about 1.5–2.
- `emdEvaluation(binSize=0.1, minRange=-100, maxRange=100)` and `madEvaluation`.
- New plots: `plotDensities`, `plotSplines`, `plotRidgelines`, `plotFileScatters`.
- nQ changed to 99.

**JS:** trivial cost. Parity needs FlowSOM parity plus the monoH.FC port.

**CytoWeave** follows 2.x: 99 quantiles at (1:99)/100, and identity for a batch with `minCells` or fewer cells in a cluster, which is left out of the goal. Given R's metacluster for each cell, it agrees with CytoNorm 2.0.12 to 9e-14 (QuantileNorm) and 7e-6 (clustered; R writes 32-bit floats). See validation/README.md, "Agreement with the R packages".

---

#### 3B.9 cyCombine
Pedersen 2022 Nat Commun 13:1698, DOI 10.1038/s41467-022-29383-5. Source: biosurf/cyCombine 0.3.0, `R/02_batch_correct.R`.

**Wrapper:** `batch_correct(df, xdim=8, ydim=8, rlen=10, mode="online", parametric=TRUE, method="ComBat", cluster_method="kohonen", distf="euclidean", nClus=NULL, seed=473, covar=NULL, anchor=NULL, ref.batch=NULL, norm_method="scale", ties.method="average")`.

**Steps**
1. **Per-batch normalization, used only for clustering:**
   - `scale`: per-batch, per-marker z-score; the default.
   - `rank`: rank/n.
   - `CLR` variants.
   - `qnorm`: monoH.FC spline mapping 5 quantiles (0, .25, .5, .75, 1) per batch to the global quantiles, ties=min.
2. **SOM clustering:** kohonen::som on an 8×8 grid, rlen=10, online, `set.seed(473)`; labels = unit.classif. FlowSOM, FuseSOM and kmeans are alternatives.
3. **Per SOM node,** on the un-normalized transformed data:
   - Nodes with a single batch are skipped.
   - The covariate model matrix is used only if it is not confounded with batch and has enough cells (sum < max + 5·levels gives 1 level).
   - Run `sva::ComBat(t(x), batch, mod, par.prior=TRUE, ref.batch)`.
   - Corrected values are **capped to the node's input min/max per marker**.

**ComBat** (Johnson 2007; bioc/sva `R/ComBat.R`, `R/helper.R`). Genes = markers, samples = cells.
- Standardize:
  - B̂ = (XᵀX)⁻¹XᵀY with X = [batch indicators, mod].
  - Grand mean = Σ_b (n_b/n)·B̂_b.
  - var_pooled = mean over cells of residual² (**divides by n**, not n−1).
  - z = (y − stand.mean)/√var_pooled.
- Per batch: γ̂ = batch mean of z; δ̂² = row variance (n−1).
- Priors, pooled across markers per batch: γ̄ = mean(γ̂), τ² = var(γ̂). For δ̂², with m = mean and s² = var: a = (2s²+m²)/s², b = (m·s²+m³)/s².
- `it.sol` iterations until max relative change < 1e-4:
  - γ* = (n·τ²·γ̂ + δ*²·γ̄)/(n·τ² + δ*²).
  - δ*² = (½Σ(z−γ*)² + b)/(n/2 + a − 1).
- Adjust: y* = (z − γ*)/√δ*² · √var_pooled + stand.mean.
- If any batch has a single sample, mean.only=TRUE.

**JS:** easy. The kohonen SOM schedule differs from FlowSOM's (defaults unverified: radius = quantile(nhbrdist, 2/3), bubble neighborhood, Euclidean/sum-of-squares), so node labels will not match R unless kohonen is ported.

---

#### 3B.10 diffcyt
Weber 2019 Commun Biol 2:183, DOI 10.1038/s42003-019-0415-5. Source: lmweber/diffcyt 1.33.1.

**Wrapper defaults**
- transform=TRUE with cofactor 5 (asinh).
- Clustering: xdim=10, ydim=10, meta_clustering=FALSE, meta_k=40. That is **100 FlowSOM SOM clusters, no scaling**, BuildSOM defaults.
- Filters: min_cells=3, min_samples=NULL → ncol/2. A cluster is kept if count ≥ 3 in at least half the samples.
- normalize=FALSE, norm_factors="TMM" (TMM is **off by default**).
- trend_method="none"; for DS-limma, trend=TRUE and weights=TRUE.

**Methods**
- **DA-edgeR (default):** `DGEList` → `estimateDisp(y, design, trend.method="none")` → `glmFit` → `glmLRT(contrast)` → `topTags(adjust="BH")`.
- **DA-voom:** `voom` → optional `duplicateCorrelation(block)` → `lmFit` → `contrasts.fit` → `eBayes`.
- **DA-GLMM:** per cluster, `lme4::glmer(binomial, weights=total cells)` with `multcomp::glht`; BH adjustment.
- **DS-limma:** cluster-sample medians of state markers stacked into one matrix; weights = cluster cell counts; `lmFit` → `eBayes(trend=TRUE)`.
- **DS-LMM:** `lmer`/`lm` with weights = total cells and `glht`.

**edgeR internals** (bioc/edgeR 4.99)
- **TMM** (`R/calcNormFactors.R`): logratioTrim=0.3, sumTrim=0.05, doWeighting=TRUE, Acutoff=−1e10.
  - Reference column: argmin |f75 − mean(f75)| over the per-sample upper-quartile/lib.size ratios f75. If median(f75) < 1e-20, use the column with max Σ√counts.
  - M = log2((o/N_o)/(r/N_r)); A = ½(log2(o/N_o) + log2(r/N_r)); variance weight v = (N_o−o)/(N_o·o) + (N_r−r)/(N_r·r).
  - Trim ranks: lo = ⌊n·trim⌋+1, hi = n+1−lo, applied to both M and A.
  - f = 2^(Σ(M/v)/Σ(1/v)); finally f/geomean(f).
- **`estimateDisp`** defaults: prior.df=NULL, min.row.sum=5, grid.length=21, grid.range=c(−10,10), robust=FALSE, tol 1e-6.
  - Grid: φ_g = 0.1·2^{seq(−10,10,len=21)}.
  - Cox–Reid adjusted profile log-likelihood per gene at each φ_g, from an NB GLM with offset log(lib·nf).
  - Common dispersion = 0.1·2^(argmax of the interpolated Σ APL), via `maximizeInterpolant` (spline-based).
  - With trend "none": m0 = column mean of APL.
  - prior.df from `squeezeVar`(deviance/df_resid) with covariate NULL; prior.n = prior.df/(n_libs − n_coefs).
  - Tagwise φ = argmax(APL_g + prior.n·m0) via WLEB.
- `glmLRT`: deviance difference with χ²₁.

**limma internals** (bioc/limma 3.99)
- **`fitFDist`:**
  - x clamped to ≥ 1e-5·median.
  - e = log x − digamma(d/2) + log(d/2).
  - No covariate: ē = mean(e), var_e = Σ(e−ē)²/(n−1) − mean(trigamma(d/2)).
  - With trend: ē from lm on a natural spline `ns(Amean, df=splinedf, intercept=TRUE)`, where splinedf = 1+(n≥3)+(n≥6)+(n≥30), capped by the number of unique covariate values; var_e = mean(residual effects²) − mean(trigamma).
  - If var_e > 0: d₀ = 2·trigammaInverse(var_e) and s₀² = exp(ē − (log(d₀/2) − digamma(d₀/2))). Otherwise d₀ = ∞.
- **`squeezeVar`:** s̃² = (d·s² + d₀·s₀²)/(d+d₀). `legacy=NULL` means legacy fitting if all residual df are equal; otherwise the new `fitFDistUnequalDF1`.
- **`eBayes`:** t̃ = β/(stdev.unscaled·s̃); df_total = min(d+d₀, Σd); p = 2·pt(−|t̃|, df_total).
- **`voom`** (`R/voom.R`):
  - y = log2((c+0.5)/(lib+1)·1e6).
  - Lowess of √σ against Amean + mean(log2(lib+1)) − log2(1e6).
  - Span: `adaptive.span=TRUE` (current default) gives `chooseLowessSpan(n)` = min(1, 0.3+0.7·(50/n)^(1/3)), about 0.86 for 100 clusters. Older limma used 0.5.
  - Weights: w = 1/f(log2 fitted count)^4, with `approxfun(rule=2)` on the lowess fit.
- **BH:** p_adj(i) = min_{j≥i} min(1, n·p_(j)/j).

**Feasibility in JS**
- DS-limma and DA-voom: straightforward. Needs WLS/QR, lowess, `ns` basis, digamma/trigamma/trigammaInverse (Newton) and a Student-t CDF.
- DA-edgeR (LRT): feasible but substantial. Needs NB IRLS, Cox–Reid APL, the 21-point grid with spline maximization, WLEB and squeezeVar. trend="none" simplifies it.
- edgeR quasi-likelihood (`glmQLFit`): not used by diffcyt; skip.
- GLMM/LMM (lme4 Laplace/REML plus glht): not worth parity; offer an approximation.

---

#### 3B.11 Cell cycle

**Dean–Jett 1974** (verified from the paper, PMC2109170)

Y(X) = A₁/(√(2π)σ₁)·exp(−(X−X₁)²/(2σ₁²)) + A₂/(√(2π)σ₂)·exp(−(X−X₂)²/(2σ₂²)) + P̃(X)

- P is a 2nd-degree polynomial defined only on (X₁, X₂). P̃ means the polynomial is "broken into a histogram" and each channel is broadened by a Gaussian with **the same CV as G1** (σ(x) = CV₁·x).
- 9 free parameters (A₁, A₂, σ₁, σ₂, X₁, X₂, 3 polynomial coefficients), fitted by nonlinear least squares.
- **Fox 1980 (DJF)** adds a Gaussian to the S-phase polynomial so it can handle synchronous S distributions.

**Watson pragmatic 1987** (DOI 10.1002/cyto.990080101)
- Assumes only that G1 (and G2) are normally distributed and that G1 is identifiable.
- The S phase is extracted by subtracting the fitted G1/G2 Gaussians from the whole histogram.

**FlowJo implementation** (docs.flowjo.com cell-cycle-univariate pages)
- Initialization:
  - The G1 mean starts at the mode of the left part of the data.
  - SD is taken from the width at 60% of peak height. For a Gaussian this half-width is σ√(−2 ln 0.6) ≈ 1.011σ.
  - Least-squares refinement over −3 to +1 SD around the G1 mean.
  - The G2 mean is initialized at **1.75×G1** and fitted the same way.
- Watson and DJF differ only in the S-phase model: DJF uses Ax²+Bx+C, optionally plus a Gaussian for synchronous S.
- Constraints:
  - CV: "= n", or "= G1 CV" / "= G2 CV" (equal CVs).
  - Means: G2 = G1×n (FlowJo suggests 1.95, nominally 2) or G1 = G2×n (about 0.5), or a range.
- Phase % = sum over events of membership probabilities, remapped to sum to about 100%; small negatives are possible.
- Goodness of fit is RMSD. Gates are placed at Gaussian intersection points.
- ModFit (Bagwell) adds debris and aggregate modeling and broadened-trapezoid S phase (unverified).

**JS:** Levenberg–Marquardt (ml-levenberg-marquardt) on histogram bins. Implement the broadened polynomial as a discrete convolution per channel.

---

#### 3B.12 Proliferation (FlowJo; verified against the docs worked example)

Model:
- Gaussian peaks on the display scale, peak i mean = μ₀·r^i with peak ratio r ≈ 0.5 (">0.5 not biologically meaningful").
- One **common CV** for all peaks, typically 4–7%.
- G0 position from an unstimulated control gate.
- Amplitudes fitted by least squares and reported as RMS. The exact objective is unverified.

With N(i) = fitted cell count in generation i (i=0 undivided):

| Statistic | Formula |
|---|---|
| cells at start | S = Σ_{i≥0} N(i)/2^i |
| total divisions | D = Σ_i i·N(i)/2^i |
| responders | R = Σ_{i≥1} N(i)/2^i = S − N(0) |
| **Division Index** | D/S = Σ_{i≥0} i·N(i)/2^i ÷ Σ_{i≥0} N(i)/2^i |
| **Proliferation Index** | D/R (sum from i=1) |
| **Expansion Index** | Σ_i N(i)/S |
| **Replication Index** | Σ_{i≥1} N(i)/R |
| **% Divided (= precursor frequency)** | R/S = Division Index/Proliferation Index |

Worked example: G0..3 = 15888, 32922, 13647, 897 gives S = 35872.875, D = 23620.875, R = 19984.875, DI 0.66, PI 1.18, EI 1.77, RI 2.375, %Div 55.7%. Roederer 2011 (DOI 10.1002/cyto.a.21010, Cytometry A 79:95) discusses these statistics and their caveats (abstract only checked).

Variants (unverified):
- ModFit's "Proliferation Index" equals the expansion index above.
- Older FlowJo versions used different naming.

---

#### 3B.13 Probability binning
Univariate paper DOI …<37…>; multivariate DOI …<47…>. Formulas verified from the multivariate PDF.

- **Binning:**
  - Compute the variance of each parameter in the control.
  - Split the parameter with the largest variance at its **median**, recursing on each half until a threshold (events per bin or number of bins).
  - The result is hyper-rectangles each holding about equal control counts.
  - Guidance: roughly 10 or more events per bin; maximum bins ≈ 10% of the event count.
  - With multiple samples, the bins can be built on the concatenation of all samples.
- **Metric:**
  - χ'² = Σ_i (ĉ_i − ŝ_i)²/(ĉ_i + ŝ_i), with ĉ_i = c_i/E_c and ŝ_i = s_i/E_s. Range 0–2.
  - χ̄'² = B/E and σ = √B/E, where E = min(E_c, E_s) and B = number of bins.
  - **T(χ) = max(0, (χ'² − B/E)/(√B/E)).**
- **Interpretation (FlowJo v9 docs):** T=0 means indistinguishable (p=0.5); T=1 means p<0.17; **T>4 means p<0.01**. The paper uses T=4 as its significance cut-off. Establish an empirical baseline, e.g. alternate-event halves of the same file.
- **flowStats implementation** (`R/pbin.R`):
  - `proBin(m, minEvents=500)` splits while a node has more than 500 events, on the max-variance channel; the right child gets x > median (ties go left).
  - `calcPBChiSquare` uses **Baggerly's normalization**: pbStat = (2·C·S·Σ(ĉ−ŝ)²/(ĉ+ŝ)/(C+S) − (B−1))/√(2(B−1)). This differs from Roederer's T.

**JS:** O(n log n·d). Implement both normalizations.

---

#### 3B.14 Overton, SED (FlowJo ENS) and K-S

**FlowJo's description** (docs.flowjo.com, plat-comparison-univariate):
- **Overton:** normalize each histogram by its **mode** (bin count / mode count), it subtracts the control histogram from the test histogram and counts the events remaining per bin as positive. In other words: %pos = Σ_b max(0, T̂_b − Ĉ_b)/Σ T̂_b on mode-normalized histograms. The exact "cumulative" modification in Overton 1988 is unverified; it is commonly described as cumulative-frequency subtraction, i.e. a max difference of cumulative distributions.
- **SED (Bagwell, unpublished):** FlowJo describes its SED as essentially Enhanced Normalized Subtraction (ENS) without the correction factor.
  - Control and test are normalized to **equal area**, not mode.
  - The positive population's PDF is estimated and aligned at the point of maximum difference.
- **K-S:** D = max|F_T − F_C|. Standard p-value (Numerical Recipes form; FlowJo's exact form is unverified):
  - n_e = n₁n₂/(n₁+n₂); λ = (√n_e + 0.12 + 0.11/√n_e)·D; Q(λ) = 2Σ_{j≥1}(−1)^{j−1}e^{−2j²λ²}.
  - FlowJo warns it over-calls significance at flow-cytometry sample sizes.
- **R reference:** flowStats `overton_like(ref, test, twosided=FALSE)` (`R/ovtsub.R`) is a KDE-based variant (density n=1024, normalized by Σmax(ref,test)). It is not Overton's original.

---

#### 3B.15 Stain index, separation index, rSD and rCV
- **Maecker 2004** (DOI 10.1002/cyto.a.20092): SI = D/W = (MFI_pos − MFI_neg)/(2·SD_neg).
- **Parks nonparametric SI** (ISAC 2004, per the SickKids/Trotter note): SI = 3.29·(P50_pos − P50_neg)/(P95_neg − P5_neg). For Gaussians this equals D/σ, i.e. **2× Maecker's SI**; the conventions are inconsistent.
- **FACSDiva nonparametric:** SI = (median_pos − median_neg)/rSD_neg (no factor 2). Diva rSD is reportedly 1.4826·MAD (unverified).
- **Separation index** (Bigos 2007; formula per MSKCC "Good Flow Notes", unverified primary source): (Med_pos − Med_neg)/((P84_neg − Med_neg)/0.995). Here 0.995 ≈ Φ⁻¹(0.84), so this is D/σ estimated from the right half of the negative.
- **FlowJo (docs):**
  - rSD is half the spread of the central 68.26% of events around the median, which works out to rSD = (P84.13 − P15.87)/2.
  - **rCV = 100·½(P84.13 − P15.87)/Median.**
  - CV = SD/Mean.
  - MAD = median|x − median| with no 1.4826 scaling shown (unverified).
  - Geometric mean is computed in display space.
  - FlowJo's percentile interpolation is unverified.
- **SSM paper σ** = P84 − P50.
- **R `mad`** = 1.4826·MAD.

---

#### 3B.16 Q and B
Steen 1992; Wood 1998; Hoffman & Wood 2007; Parks 2017 (verified equations); Perfetto 2014.

- Variance model in measurement units (Parks Eq 1a): **V(M) = c₀ + c₁M + c₂M²**.
- In statistical photoelectrons (Spe): V = B_spe + M_spe + CV₀²M_spe².
- Therefore **Q_I = 1/c₁** (Spe per intensity unit), **B_spe = c₀/c₁²**, **CV₀² = c₂**.
- With an MEF/MESF calibration M_E = k·M_I:
  - Q_E = Q_I/k (Spe per MEF); B_E = B_spe/Q_E (background in MEF).
  - CV² = (B_E + M_E)/(Q_E·M_E²) + CV₀².
- **Fit:** weighted least squares on peak means/variances from multi-level beads (Spherotech 8-peak, Thermo 6-peak) or LED pulses.
  - Weights w_i = 1/Var[V_i] = (N_i − 1)/(2V_i²); ignore errors in M_i.
  - Peaks are found automatically (FSC/SSC gate, k-means, Gaussian peak fit).
  - Exclude peaks near the baseline or above the linear range; for Height, exclude peaks with mean < 10× minimum height or CV > 65%.
  - Report standard errors and weighted residuals.
- Older approaches estimate CV₀ separately, then a linear fit for Q and B. A two-bead method solves CV² equations at a dim and a bright level.
- BD CS&T Qr/Br and Cytek SpectroFlo daily QC (%rCV and gain per detector; Q and B not exposed) are unverified.

---

#### 3B.17 Spillover spreading matrix
Nguyen 2013, DOI 10.1002/cyto.a.22251 (PMC3678531). Equations verified.

- Eq 1: Δσ_C = √(σ²_{C,S} − σ²_{C,R}), on **compensated** data.
  - S = single-stained sample, R = unstained or negative reference.
  - C = spillover (secondary) detector; P = primary detector.
- Eq 2: σ = F₈₄ − F₅₀ (percentiles).
- Eq 3: ΔF_P = F₅₀,P(S) − F₅₀,P(R).
- **Eq 4: SS_{C}^{P} = Δσ_C/√ΔF_P.**
- Rows are fluorochromes (P); columns are detectors (C); diagonal entries are meaningless.
- Theory (Eq 9): SS = √(U_C·X_CP + U_P·X_CP²), with X_CP the spillover coefficient and U the detector constants (inverse Q).
- **FlowJo:** computes the square root of the difference in squared robust SDs (84th−50th percentile) between the comp controls' positive and negative populations.
  - FlowJo's **Total Spreading Matrix** is the SSM without normalization to probe intensity, i.e. Δσ_C.
  - For AutoSpill matrices FlowJo uses "AutoSpread … a linear model" (details unpublished).
- Handling of σ²_S < σ²_R (clip to 0?) is undocumented; choose and document.
- **Spectral:** apply the same formula to unmixed single-stain controls. Spreading then depends on the unmixing matrix (OLS/WLS).

---

#### 3B.18 EMD and QF distances
- **Orlova 2016** (DOI 10.1371/journal.pone.0151859): signatures are bin centroids with normalized weights (total mass 1); ground distance is Euclidean between centroids; transport LP; EMD = Σd_ij·f_ij/Σf_ij (the Mallows distance).
- **1D closed form:** W₁ = Σ_k |P_k − Q_k|·h, using cumulative bin masses and bin width h. For raw samples of equal size, mean |x₍ᵢ₎ − y₍ᵢ₎|.
- **CytoNorm `emdEvaluation`:** hist with breaks seq(−100, 100, by=0.1), counts/n, `emdist::emd2d` on n×1 matrices. The ground distance is in **bin-index units**, so multiply by binSize to get data units (unverified).
- **QFMatch** (Orlova 2018):
  - D²(h,f) = (h−f)ᵀA(h−f), with a_ij = 1 − d_ij/d_max, d = Euclidean distance between bin centers of mass on the combined sample.
  - Bins come from adaptive (probability) binning: split on the max-variance dimension at the median on the merged samples.
  - The paper compares this with the χ² distance Σ(h−f)²/(h+f).
- Cytobank's "Earth mover's" and Jensen–Shannon in its QF tables: unverified.

---

#### 3B.19 Density for contour and pseudocolor plots
- **FlowJo (docs):**
  - Contours are **equal-probability contours**. Options "2%/5%/10%" give 50/20/10 levels, with equal numbers of cells between consecutive lines. "Logarithmic": each line encloses twice as many events as the previous.
  - "Show outliers" draws events outside the lowest level as dots.
  - Density plots use the same contouring.
  - Pseudocolor colors each dot by local density; "Smooth" renders a density image.
  - FlowJo's kernel and bandwidth are unpublished (unverified).
- **Implementation:**
  - Grid KDE, then density at each event (bilinear interpolation).
  - Sort densities descending; level thresholds are where the cumulative event fraction reaches k·p.
  - Marching squares (d3-contour, ISC). d3 `contourDensity` uses a box-blur Gaussian approximation; its defaults (bandwidth ≈ 20.49 px, cellSize 4) are unverified.
- **R references:**
  - `grDevices::densCols` / `smoothScatter`: nbin=128, default bandwidth = (P95 − P5)/25 per axis. Uses `KernSmooth::bkde2D`: range ±1.5h, linear binning, Gaussian kernel truncated at τ = 3.4 bandwidths, FFT.
  - `MASS::kde2d`: h = c(bandwidth.nrd(x), bandwidth.nrd(y)) with bandwidth.nrd = 4·1.06·min(sd, IQR/1.34)·n^(−1/5); internally uses h/4 as the kernel sd; default n=100 grid. ggplot2's `stat_density_2d` uses this (unverified).
  - 1D bandwidth rules: Silverman `nrd0` = 0.9·min(sd, IQR/1.34)·n^(−1/5); `nrd` = 1.06·…; Scott in d dimensions: h_j = σ_j·n^(−1/(d+4)).

---

#### 3B.20 Gate-propagation helpers
- **flowDensity `deGate`** (Malek 2015). Defaults: n.sd=1.5, use.percentile=FALSE, use.upper=FALSE, upper=NA, alpha=0.1, sd.threshold=FALSE, all.cuts=FALSE, tinypeak.removal=1/25, adjust.dens=1, count.lim=20, magnitude=0.3, slope.w=4, seq.w=4, spar=0.4, twin.factor=0.98, bimodal=FALSE.
  - Density = `density(x, adjust)`, then `smooth.spline(x, y, spar=0.4)` with negatives set to 0.
  - Peaks are local maxima > (1/25)·max.
  - Cut between adjacent peaks = argmin of the spline density between them (`.getIntersect`).
  - One peak: inflection point (`.getFlex`), else slope tracking (`.trackSlope`, α=0.1), else peak ± 1.5·sd.
  - More than 2 peaks: `.getScoreIndex`.
  - Fewer than 20 events returns −Inf.
- **openCyto 2.21** (`R/gating-functions.R`, `R/bayes-flowClust.R`):
  - `gate_mindensity(positive=TRUE, gate_range=NULL)`:
    - Density with **adjust=2**.
    - Peaks where diff(sign(diff(y))) == −2 and valleys where it is +2, both within range(x); peaks sorted by height, valleys by depth.
    - One peak: cut at range min (if positive).
    - Several valleys: the first valley between the two highest peaks, else the deepest valley.
  - `gate_tail` / `.cytokine_cutpoint`: num_peaks=1, ref_peak=1, method first or second derivative of the KDE, tol=0.01, adjust=1, side="right".
  - `gate_quantile(probs=0.999)`.
  - `gate_flowclust_1d`: K required unless a prior is given; trans=0; criterion BIC; cutpoint "boundary"; quantile 0.99.
  - `gate_flowclust_2d`: K=2, quantile 0.9 ellipse.
  - `gate_singlet`: robust linear model of FSC-H on FSC-A, prediction level 0.99, maxit 5.
- **FlowJo magnetic gates (docs):** when copied or re-applied, the gate moves to the nearby area of maximum event density relative to its original position; works for 1D and 2D; draws an arrow showing the shift. The algorithm is unpublished. A JS approximation: local search over translations maximizing the enclosed count, using a summed-area table on a binned grid (unverified equivalence).
- **FlowJo autogate:** equal-probability contour level sets.
- **FMO thresholds:** convention is a threshold at the 99th–99.9th percentile of the FMO control in that channel on the same transform (unverified as a standard; openCyto `gate_quantile` defaults to 0.999).

---

#### 3B.21 Key reference source files
- saeyslab/PeacoQC: `R/PeacoQC.R`, `R/PeacoQC_helper_functions.R`
- SofieVG/FlowSOM: `src/som.c`, `R/2_buildSOM.R`, `R/4_metaClustering.R`
- bioc/ConsensusClusterPlus: `R/ConsensusClusterPlus.R`
- saeyslab/CytoNorm: `R/QuantileNorm.R`, `R/CytoNorm.R`, `R/evaluation.R`
- biosurf/cyCombine: `R/02_batch_correct.R`
- bioc/sva: `R/ComBat.R`, `R/helper.R`
- lmweber/diffcyt: `R/testDA_*.R`, `R/testDS_*.R`, `R/3_generateClusters.R`
- bioc/edgeR: `R/calcNormFactors.R`, `R/estimateDisp.R`
- bioc/limma: `R/fitFDist.R`, `R/squeezeVar.R`, `R/ebayes.R`, `R/voom.R`
- lmcinnes/umap: `umap/umap_.py`, `umap/layouts.py`
- jlmelville/uwot: `R/uwot.R`, `R/umap2.R`, `R/init.R`, `R/transform.R`
- PAIR-code/umap-js: `src/umap.ts`
- pavlin-policar/openTSNE: `openTSNE/tsne.py`
- KlugerLab/FIt-SNE: `fast_tsne.py`
- lvdmaaten/bhtsne: `tsne.cpp`
- omiq-ai/Multicore-opt-SNE: `multicore_tsne/tsne.cpp`
- YingfanWang/PaCMAP: `source/pacmap/pacmap.py`
- dpeerlab/PhenoGraph: `phenograph/cluster.py`
- bioc/flowAI: `R/*.R`
- jmeskas/flowCut: `R/flowCut.R`
- bioc/flowClean: `R/flowClean.R`
- bioc/flowDensity: `R/helper_functions.R`
- RGLab/openCyto: `R/gating-functions.R`
- bioc/flowStats: `R/pbin.R`, `R/ovtsub.R`
- wch/r-source: `src/library/stats/R/{density,bandwidths,splinefun,smspline}.R`, `stats/src/monoSpl.c`, `src/main/RNG.c`, `grDevices/R/smooth2d.R`
- cran/KernSmooth: `R/all.R`

### 3C. JavaScript numerical environment: what determines agreement with R, Python and FlowJo

- **Float precision.**
  - FCS data are usually float32 (`$DATATYPE=F`); integer data are common on older BD instruments.
  - Store raw columns as `Float32Array` (half the memory).
  - Do **all transform, compensation and gating arithmetic in float64**, as R, NumPy and FlowKit do. Round-trip to float32 only for rendering.
  - Gate-boundary decisions (`min ≤ x < max`, inclusive polygon edges) must be evaluated on the *same* precision as the oracle. Otherwise events exactly on boundaries flip. These are common with integer-valued data and quadrant dividers at integer values.
- **Transcendentals are not correctly rounded.**
  - `Math.exp`, `Math.log`, `Math.asinh` and `Math.sinh` may differ by 1 ulp between V8, JavaScriptCore and SpiderMonkey, and from glibc.
  - Expect agreement to about 1e-12 relative, not bit-exactness. Golden tests should use tolerances, plus membership-count tests that allow boundary-ulp flips.
  - Logicle and hyperlog should use the reference iteration structure (Section 3A.2) so that convergence paths match.
- **Linear algebra.**
  - Use Cholesky/QR or a precomputed pseudo-inverse via SVD for unmixing. Avoid normal equations with an explicit inverse for ill-conditioned panels (complexity index > ~50).
  - Compensation: solve `Sᵀ x = vᵀ` once per matrix (LU), or precompute S⁻¹ once and apply it as a d×d matrix–vector product per event. The two agree to about 1e-15 for well-conditioned S.
- **RNG parity.** Algorithms with random initialization differ between implementations unless the RNG and sampling routine are reproduced.
  - Examples: FlowSOM codebook init and per-iteration sampling, UMAP, t-SNE, k-means, ConsensusClusterPlus subsampling.
  - Matching R exactly needs R's Mersenne-Twister *and* R ≥ 3.6's "Rejection" `sample()` algorithm.
  - Matching NumPy needs PCG64 *and* NumPy's bounded-integer method.
  - Practical policy: use a documented seeded PRNG (e.g., xoshiro128** or PCG32). Test *statistical* agreement with R/Python (cluster ARI, metacluster label agreement after Hungarian matching, embedding trustworthiness), not bit equality. Store seed and PRNG name in provenance.
- **Parallelism.**
  - Use Web Workers with `SharedArrayBuffer`. This requires cross-origin isolation (`COOP: same-origin`, `COEP: require-corp`), which the Go server can set because it serves the app.
  - Chunk per-event work (transform, compensate, gate, bin) across workers.
  - Reductions such as sums for means or SOM updates must be order-stable for reproducibility. Use deterministic chunk ordering and pairwise or Kahan summation.
- **GPU.**
  - WebGL2 is universal and suitable for point and density rendering.
  - WebGPU compute is attractive for unmixing, SOM, kNN and UMAP. Its default-on availability (Chrome/Edge ≥ 113; Firefox ≥ 141 Windows/macOS-26 only; Safari 26) means **CytoWeave must keep a CPU path for every algorithm** and treat WebGPU as acceleration (flow-atlas `docs/decisions.md`).
- **Memory and files.**
  - A 50-parameter, 10M-event float32 file is 2 GB. Browsers cap individual ArrayBuffers (about 2–4 GB, engine-dependent) and tab memory.
  - Stream FCS DATA in chunks from the Go server via HTTP range requests. Keep per-sample columnar caches. Use bitset gate memberships (1 bit per event per gate: 10M events = 1.25 MB per gate).
  - Cache derived columns in OPFS only as an optional accelerator, because the Go server can serve and cache files natively.

## 4. Standards: exact names and structures

### 4.1 FCS 3.2 (Spidlen et al., Cytometry A 2021;99:100–102, **doi:10.1002/cyto.a.24225**; normative PDF referenced as http://flowcyt.sf.net/fcs/fcs32.pdf — that URL currently 404s; the spec is in the article's Supporting Information)

Sources: the article summary (https://pmc.ncbi.nlm.nih.gov/articles/PMC8241566/) and NIST's fully standards-compliant reader/writer **fireflow** (Rust/Python; NIST public-domain-style license; https://github.com/usnistgov/fireflow), whose `STANDARD.md` and `COMMON_ISSUES.md` are the best current implementer's guide.

**New in 3.2**

| Keyword | Value format / notes |
|---|---|
| `$PnDATATYPE` | `I`, `F`, or `D` per measurement (overrides `$DATATYPE`). Enables mixed-type DATA, e.g. 64-bit time with 32-bit float fluorescence. Breaks older readers. |
| `$PnTYPE` | Measurement type. Values listed in §3.3.55 (as implemented in fireflow): `Forward Scatter`, `Side Scatter`, `Raw Fluorescence`, `Unmixed Fluorescence`, `Mass`, `Time`, `Electronic Volume`, `Index`, `Classification`. fireflow allows any string; `Time` is required for the temporal channel. |
| `$PnFEATURE` | `Area`, `Width`, or `Height` (imaging vendors use others) |
| `$PnDET` | Detector name |
| `$PnTAG` | Dye/reporter (e.g., "BV421") |
| `$PnANALYTE` | Target molecule or process (e.g., "CD4") |
| `$PnCALIBRATION` | 3.2 form `slope,[offset,]unit` (the offset is new; 3.1 form is `slope,unit`) |
| `$CARRIERID`, `$CARRIERTYPE`, `$LOCATIONID` | Replace the deprecated `$PLATEID`, `$PLATENAME`, `$WELLID` |
| `$BEGINDATETIME`, `$ENDDATETIME` | ISO-8601. Replace the deprecated `$DATE`, `$BTIM`, `$ETIM` |
| `$FLOWRATE` | Instrument flow-rate setting name |
| `$UNSTAINEDCENTERS` | `n,PnN_1…PnN_n,v_1…v_n`: the vector of unstained central values (for spectral/AF) |
| `$UNSTAINEDINFO` | Free text describing how the centers were obtained |

**Other changes**

- `$CYT` became required.
- `$BEGINSTEXT`/`$ENDSTEXT`/`$BEGINANALYSIS`/`$ENDANALYSIS` became optional.
- `$MODE` is deprecated (fixed to `L`).
- `$GATING`, `$RnI`, `$RnW`, `$PnP` are deprecated.
- `$PnB` values not divisible by 8 are deprecated.
- `$PnG` is restricted to integer data and forbidden with log `$PnE`.
- Removed: `$GATE`, `$GnE/F/N/P/R/S/T/V`, histogram support (`$PKn`, `$PKNn`), and the ANALYSIS-segment keywords `$CSMODE`, `$CSVBITS`, `$CSVnFLAG`.
- OTHER-segment offsets are 8 bytes.
- "Dark bytes" between segments should be spaces.
- Reference CRC implementations are provided in C++ and C#.
- Time must be linear, have no `$PnG`, and be named `Time` (case-insensitive), with `$TIMESTEP`.

**From FCS 3.1 (still essential; Spidlen 2010, doi:10.1002/cyto.a.20825)**

- `$SPILLOVER`.
- `$PnD` display hint: `Linear,lower,upper` or `Logarithmic,decades,offset`.
- `$PnCALIBRATION`.
- `$ORIGINALITY` (`Original`, `NonDataModified`, `Appended`, `DataModified`), `$LAST_MODIFIED`, `$LAST_MODIFIER`.
- `$VOL`.
- `$PnL` may list multiple wavelengths.
- `$BYTEORD` only `1,2,3,4` or `4,3,2,1`.
- `$PnN` unique and comma-free.

**Robustness checklist** (NIST fireflow `COMMON_ISSUES.md`; observed in real vendor files)

- Off-by-one end offsets: the end offset is typically one byte too large.
- Truncated files.
- "Split" HEADER offsets (`start,0` when > 8 digits).
- Pseudo-empty `0,-1` offsets.
- Missing or incorrect `$NEXTDATA`. One FlowRepository file hides 95 datasets behind `$NEXTDATA=0`.
- Duplicated `$PnN`.
- Indexed `$SPILLOVER`.
- Bad date formats.
- Float data with log `$PnE`.
- `$PnE=X,0`.
- `$PnB`/`$BYTEORD` mismatch.
- Huge `$PnR`.
- Whitespace in values and comma lists.
- Non-standard time names (`T1`, `HDR-T`, `TIME` on Sony).
- Delimiter escaping (a doubled delimiter means a literal).
- Non-ASCII keys.
- Supplemental TEXT duplicating primary.

CytoWeave's reader should implement "scalpel" (repair while preserving metadata) and "sledgehammer" (just get the DATA) modes like fireflow's, and should show every repair in an inspector.

### 4.2 Gating-ML 2.0 (Spidlen et al., Cytometry A 2015;87:683–687, **doi:10.1002/cyto.a.22690**; spec v2.0 2013-01-22, XSD version `2.0.121207`)

- **Namespaces** (exact):
  - `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"`
  - `xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"`
  - `xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`
  - XSDs: `Gating-ML.v2.0.xsd`, `Transformations.v2.0.xsd`, `DataTypes.v2.0.xsd`. Both `elementFormDefault` and `attributeFormDefault` are `qualified`, so **attributes are namespace-prefixed** (`gating:id`, `data-type:value`, `transforms:T`).
  - XSD copyright notice: ISAC allows free distribution and read-only use but reserves the right to modify. Bundle the XSDs unmodified, or validate without bundling them.
- **Root**: `<gating:Gating-ML>`, containing any number of `transforms:transformation`, `transforms:spectrumMatrix`, and gates.
- **Gates** (all carry `gating:id` (ID) and optional `gating:parent_id` (IDREF)):
  - `gating:RectangleGate` → 1+ `gating:dimension[@gating:min?, @gating:max?, @gating:compensation-ref, @gating:transformation-ref?]`, each containing `data-type:fcs-dimension[@data-type:name]` or `data-type:new-dimension[@data-type:transformation-ref]` (ratio).
  - `gating:PolygonGate` → exactly 2 `gating:dimension` + ≥ 3 `gating:vertex`, each with 2 × `gating:coordinate[@data-type:value]`.
  - `gating:EllipsoidGate` → ≥ 2 `gating:dimension`, `gating:mean` (coordinates), `gating:covarianceMatrix` → `gating:row` → `gating:entry[@data-type:value]`, `gating:distanceSquare[@data-type:value]`.
  - `gating:QuadrantGate` → `gating:divider[@gating:id, @gating:compensation-ref, @gating:transformation-ref?]` containing `data-type:fcs-dimension` and 1+ `gating:value` (element text). Then 1+ `gating:Quadrant[@gating:id]` → `gating:position[@gating:divider_ref, @gating:location]`. Only individual Quadrant ids may be referenced as parents or Boolean operands.
  - `gating:BooleanGate` → one of `gating:and` (≥ 2 operands), `gating:or` (≥ 2), `gating:not` (1), each containing `gating:gateReference[@gating:ref, @gating:use-as-complement="false"]`.
  - All allow `data-type:custom_info` (anyType) for vendor extensions. CytoWeave can store its own metadata there (colors, names, provenance).
- **Transformations**: `<transforms:transformation transforms:id="…" [transforms:boundMin] [transforms:boundMax]>` containing one of:
  - `transforms:flin[@T,@A]`
  - `transforms:flog[@T,@M]`
  - `transforms:fasinh[@T,@M,@A]`
  - `transforms:logicle[@T,@W,@M,@A]`
  - `transforms:hyperlog[@T,@W,@M,@A]`
  - `transforms:fratio[@A,@B,@C]` with 2 `data-type:fcs-dimension`
  - All attributes are `transforms:`-prefixed.
- **Compensation**: `<transforms:spectrumMatrix transforms:id="…" [transforms:matrix-inverted-already="false"]>` → `transforms:fluorochromes` (≥ 2 `data-type:fcs-dimension`), `transforms:detectors` (≥ 2), then one `transforms:spectrum` row per fluorochrome containing `transforms:coefficient[@transforms:value]` (row-major). Fluorochrome and detector names must be disjoint. Gates reference *fluorochrome* names when `compensation-ref` is the matrix id. Non-square matrices use the Moore–Penrose pseudoinverse (OLS).
- **compensation-ref values**: `FCS` (use the file's `$SPILLOVER`/`$COMP`/`SPILL`; dimensions not in the matrix pass through uncompensated), `uncompensated`, or a spectrumMatrix id. It is required on every dimension and divider.
- **Membership semantics** (normative):
  - Rectangle: `min ≤ x < max` (half-open, so tiling gates sum exactly).
  - Quadrant: the same half-open rule per divider. Axes are not implicit dividers.
  - Polygon: **even–odd (parity) rule**, explicitly *not* non-zero winding; the boundary is inclusive.
  - Ellipsoid: `(x−μ)ᵀC⁻¹(x−μ) ≤ D²` (inclusive).
  - Boolean: standard set semantics.
  - A child gate's population is ⊆ its parent (`parent_id`).
- **Compliance test suite**: the ISAC Gating-ML 2.0 compliance files ship in FlowKit `data/gate_ref/`. They contain `data1.fcs`, 40+ `gml_*.xml` gates covering all gate/transform/matrix combinations, and per-event 0/1 `truth/Results_*.txt`. Use them as CytoWeave's first golden test (check the license; see Section 6).

### 4.3 FlowJo workspace (.wsp) XML (FlowJo 10.x; observed in FlowJo 10.6.x files in the FlowKit test corpus; parsing logic from FlowKit `wsp_utils.py`)

```xml
<Workspace version="20.0" flowJoVersion="10.6.2" modDate="…" curGroup="All Samples"
  xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes" …>
  <Columns/> <Matrices>…</Matrices> <Cytometers>…</Cytometers>
  <Groups><GroupNode name="All Samples" owningGroup="All Samples">
      <Group name="All Samples" live="1"><Criteria/><SampleRefs><SampleRef sampleID="1"/></SampleRefs></Group>
      <Subpopulations>…group template gates…</Subpopulations></GroupNode></Groups>
  <SampleList><Sample>
      <DataSet uri="file:/…/x.fcs" sampleID="1"/>
      <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Acquisition-defined" transforms:id="uuid">
        <data-type:parameters><data-type:parameter data-type:name="FITC-A" userProvidedCompInfix="Comp-FITC-A"/>…</data-type:parameters>
        <transforms:spillover data-type:parameter="FITC-A">
          <transforms:coefficient data-type:parameter="PE-A" transforms:value="0.0141"/>…</transforms:spillover>…
      </transforms:spilloverMatrix>
      <Transformations> <transforms:logicle transforms:length="256" transforms:T="262144" transforms:W="1" transforms:M="4.418539922" transforms:A="0">
          <data-type:parameter data-type:name="Comp-FITC-A"/></transforms:logicle> … </Transformations>
      <Keywords><Keyword name="$BEGINDATA" value="1962"/>…</Keywords>
      <SampleNode name="x.fcs" sampleID="1" count="283969">
        <Graph type="Pseudocolor">…</Graph>
        <Subpopulations>
          <Population name="Lymphocytes" owningGroup="DEN" count="…">
            <Graph …/>
            <Gate gating:id="ID645057196" gating:parent_id="ID199018363">
              <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" tint="#000000" …>
                <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
                <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
                <gating:vertex><gating:coordinate data-type:value="86016"/><gating:coordinate data-type:value="43008"/></gating:vertex>…
              </gating:PolygonGate></Gate>
            <Subpopulations>…</Subpopulations>
            <Statistic name="Count" owningGroup="DEN" ancestor="" correlate="" value="283969"/>
          </Population>
          <OrNode name="CD107a+ or IFNg+"><Dependents><Dependent name="Time/Singlets/…/CD107a+"/>…</Dependents></OrNode>
        </Subpopulations></SampleNode></Sample></SampleList>
  <TableEditor>…<TColumn analysisPath="Time/Singlets" statistic="fj.stat.freqofparent" …/></TableEditor>
  <LayoutEditor>…</LayoutEditor> <Scripts/> <SOPS/> <Exports/> <experiment/>
</Workspace>
```

**Semantics that differ from Gating-ML (must be handled explicitly)**

- **Gate coordinates are stored in untransformed (compensated) data units**, and the dimension names carry the compensation prefix (`Comp-FITC-A`).
  - Transforms are per-sample, in `<Transformations>`.
  - Polygon edges are straight in *transformed display space*. FlowKit therefore transforms the vertices into display space and evaluates there. This reproduces FlowJo counts exactly in FlowKit's small test workspaces, but not universally: flow-atlas found 332/1067 exact and 953/1067 within 1% on a large real workspace, with residuals at polygon edges near the biex zero region.
- **Ellipses** (`gating:EllipsoidGate` with `gating:foci` (2 vertices), `gating:edge` (4 vertices) and a `gating:distance` attribute) are stored in **256×256 display-bin space**. FlowKit converts them to 128-vertex polygons, taking the major radius from the edge points and the minor from the foci; this reproduces FlowJo's count on FlowKit's synthetic ellipse and is within 2–3% of it on the real 8-color workspace.
- **Time** is shown and gated in seconds: the stored value × the time parameter's linear `gain` attribute (0.0102654811 in FlowKit's 8-color workspace, where $TIMESTEP is 0.01), or × $TIMESTEP without one. FlowIO and FlowKit use $TIMESTEP, which misses a few events at a time gate's edges (measured, 2026-10).
- **Linear gains:** on any `transforms:linear` axis with `gain`, FlowJo's coordinates are gain × the stored value.
- **Biex beyond the table:** values outside the 4097-point table are clamped to its ends (as cytolib and FlowKit do). The table stops just short of the top of scale (261 622 for width −10), so saturated events sit on the top edge.
- **Display resolution:** polygon vertices are snapped to the 256-bin grid (multiples of 1024 on a 0–262144 linear axis) and `gateResolution="256"`. FlowJo's counts on real workspaces differ from an exact evaluation (CytoWeave's or FlowKit's) by 0.1–0.3% on large populations, presumably from evaluation at this resolution; rounding each axis to the grid did not reproduce them (measured, 2026-10).
- **Quadrants** are written as four sibling `Population`s, each with a one-sided `gating:RectangleGate` (min-only or max-only dimensions). They are not `gating:QuadrantGate`.
- **Boolean gates** are `AndNode`/`OrNode`/`NotNode` elements with `Dependents/Dependent[@name]` holding '/'-joined *gate paths* (not ids). There is no complement flag.
- `eventsInside="0"` means the gate's complement.
- `owningGroup=""` marks a sample-specific (custom) gate. A non-empty value marks a group-owned gate.
- One gate tree per sample even when the sample belongs to several groups. Group template trees may be incomplete.
- Spectral matrices: `spectral="1"` and `weightOptAlgorithmType="OLS"`. The rows are non-square, `detectors_by_row` vs true detectors.
- Other per-sample transform elements: `transforms:linear[minRange,maxRange,gain]`, `transforms:log[offset,decades]`, `transforms:biex[length,maxRange,neg,width,pos]`, `transforms:fasinh[length,maxRange,T,A,M,W]`. FlowKit rejects anything else as "undocumented".
- Statistic nodes look like `<Statistic name="Count" … value=…/>`. Per-parameter statistics (median, CV, and so on) probably add a parameter attribute **(unverified; only Count nodes appear in the test corpus)**. Table columns use identifiers such as `fj.stat.freqofparent`. Tables are `TableEditor/Table/TColumn[@analysisPath,@statistic,@parameterName,@formula]`. Layouts are `LayoutEditor/Layout`.
- WSP files reference FCS files by absolute `file:` URI (`DataSet/@uri`). Relinking by filename + `$TOT` + keyword fingerprint is required.

### 4.4 CLR, ACS, MIFlowCyt

- **CLR** (Spidlen et al., Cytometry A 2015;87:86–88, **doi:10.1002/cyto.a.22586**):
  - RFC-4180 CSV with one row per event (in FCS event order) and one column per class.
  - Values are membership probabilities in [0, 1], so overlapping and soft classes are allowed.
  - The paper reports about 7 bytes/event uncompressed for hard classes.
  - Ideal for exporting clusters and automated or probabilistic gates that Gating-ML cannot express.
- **ACS** (Archival Cytometry Standard; spec https://flowcyt.sourceforge.net/acs/latest.pdf):
  - A ZIP container whose XML table of contents links files, associations, and optional signatures and audit info.
  - FlowJo exports ACS bundles.
  - Useful as CytoWeave's portable "project export" target alongside its native bundle.
- **MIFlowCyt** (Lee et al., Cytometry A 2008;73A:926–930, **doi:10.1002/cyto.a.20623**; checklist doi:10.1002/cyto.a.20941). Four sections:
  1. *Experiment overview*: purpose, keywords, organization, primary contact, dates, conclusions, quality control.
  2. *Flow sample/specimen details*: material, source, treatment, and reagents (analyte, analyte detector, reporter/fluorochrome, clone, manufacturer, catalog), plus controls.
  3. *Instrument details*: manufacturer, model, configuration (lasers, filters, detectors, voltages).
  4. *Data analysis details*: list-mode files, compensation, gating (Gating-ML), statistics.
  - FCS 3.2's `$PnTAG`/`$PnANALYTE`/`$PnDET` map directly onto Section 2/3 fields, so CytoWeave can auto-fill most of a MIFlowCyt report.

### 4.5 Spectral-instrument FCS conventions (practical)

- **Cytek Aurora / Northern Lights (SpectroFlo)**:
  - Writes FCS **3.1**, two files per tube: *Raw* (one parameter per detector) and *Unmixed* (one per fluorochrome tag) (Cytek Aurora User's Guide).
  - Detector `$PnN` follow laser+index: `UV1-A…UV16-A`, `V1-A…V16-A`, `B1-A…B14-A`, `YG1-A…YG10-A`, `R1-A…R8-A`, with `-H`/`-W` variants; scatter is `FSC-A`, `SSC-A`, and `SSC-B-A` on 5L systems.
  - The data range is about 4,194,304 (2²²).
- **BD FACSDiscover S8/A8/A7**: detector names include the center wavelength, e.g. `V6 (515)-A`; scatter includes `SSC (Violet)-A`. Spectral detectors match the regex `[0-9]\)-A`. FlowJo ≥ 10.10 reads BD's noise keywords for SpectralFX (names unverified).
- **Sony ID7000**: `405CH7-A`-style names, `TIME` in upper case, range about 1,048,576 (2²⁰).
- Unmixed exports frequently carry no machine-readable reference spectra. CytoWeave should import raw files plus single-stain controls and persist the reference matrix itself, ideally as a Gating-ML `spectrumMatrix` so the work round-trips.
- Treat SpectroFlo `.expt` and BD spectral reference libraries as optional importers.

## 5. Novel features: evidence and novelty assessment

Novelty key:
- **Novel**: not found in any analysis GUI surveyed.
- **Partial**: exists in a narrower form, or only in code libraries.
- **Exists**: available in shipping tools.

| # | Feature | Evidence and motivation | Where something similar exists | Novelty |
|---|---|---|---|---|
| N1 | **Gate robustness / sensitivity intervals.** Perturb vertices by ±δ in display space, or dilate/erode the gate, and report each statistic as value ± sensitivity. Add a "fragility index" (Δ%parent per 1% axis shift) and a flag when the boundary crosses high density. | Mahnke et al. 2026, "Gate Shape Matters", Cytometry A 109:165–166 (doi:10.1002/cyto.a.70023). Grant 2021, inter-analyst variance (doi:10.3390/mps4020024). NIST uncertainty work (Patrone 2025, doi:10.1002/cyto.a.24955) | None found | **Novel** |
| N2 | **Boundary-density score per gate per sample.** Mean density along the gate perimeter relative to the population's mean density. Cheap, and it drives N3. | Valley-seeking logic of flowDensity (doi:10.1093/bioinformatics/btu677) | R packages that *place* gates by density | **Novel** as a QC metric |
| N3 | **Cohort review queue.** Rank samples by N2, gate displacement, statistic outlier score (robust z), event count, QC removal and unmixing residual. Accept, adjust or exclude, with a per-sample status. | Analysis software documentation advises inspecting every adapted gate. QUAliFiER (doi:10.1186/1471-2105-13-252) | Per-sample automated-gate scores in some commercial platforms | **Partial**; an integrated queue is novel |
| N4 | **Semantic analysis diff and branches.** Gate geometry Δ, membership Δ, statistic Δ, matrix and transform Δ. Content-addressed FCS (SHA-256) also fixes "missing files". | Documentation deficits in published cytometry (Sorigue 2025, doi:10.1002/cytoa.70003) | Audit logs and e-signatures in regulated platforms | **Partial**; semantic diff and branch comparison are novel |
| N5 | **Embedding faithfulness layer.** Trustworthiness and continuity, kNN preservation, per-cell distortion, seed and subsample stability, batch-mixing score. | Chari & Pachter 2023 (doi:10.1371/journal.pcbi.1011288); Kobak & Berens 2019 (doi:10.1038/s41467-019-13056-x); Huang 2022 (doi:10.1038/s42003-022-03628-x); DynamicViz (doi:10.1038/s43588-022-00380-4); scDEED (doi:10.1038/s41467-024-45891-y) | Research libraries only | **Novel in cytometry GUIs** |
| N6 | **Transparent spectral workbench.** Control quality scorecard, multi-AF discovery and per-cell AF (§3A.8), residual-norm parameter, spreading/similarity/complexity matrices, every normalization choice visible. | Robinson 2025; Roet 2024; AutoSpectral 2025; Mage 2026 (doi:10.1002/cyto.a.70044) | Parts exist in instrument software and spectral analysis platforms | **Partial**; the integrated, auditable workbench is novel |
| N7 | **Predicted spread before acquisition.** Unmixed covariance U Σ Uᵀ from the user's own reference library and instrument noise, for "what-if" panel edits. | Nguyen 2013 SSM (doi:10.1002/cyto.a.22251); Novo 2013 (doi:10.1002/cyto.a.22272); the Residual Model preprint (doi:10.64898/2026.01.27.701929) | Panel-design viewers built on vendor spectrum libraries | **Partial** |
| N8 | **Agent interface (MCP).** Typed, auditable tools: describe a view as text, list populations, propose gates, run QC, export. Every agent edit is reviewable and undoable. | Agentic single-cell analysis (CellVoyager, Nat Methods 2026); LLM gating benchmarks (2026); single-cell MCP servers | Early prototypes and commercial read-oriented servers | **Partial**; a local workbench with reviewable writes is novel |
| N9 | **LLM-assisted gating through tools, not pixels.** The model calls density, valley and FMO tools; outputs carry uncertainty and go to N3. | Vision models are weak at reading quantities from plots (npj Precis Oncol 2024) | LLM gating assistants | **Partial** |
| N10 | **Uncertainty-aware autogating.** Density/valley, FMO-anchored thresholds and models learned from gated exemplars; per-event probabilities exported as CLR; abstention routes to N3. | UNITO (doi:10.1038/s41467-025-56622-2); ElastiGate (doi:10.1038/s41598-025-99118-1); BayesFlow (doi:10.1186/s12859-015-0862-z) | Autogating that returns point estimates | **Partial**; uncertainty, CLR and review are novel |
| N11 | **Counterfactual preprocessing explorer.** Vary cofactor or W, matrix normalization, AF model, QC thresholds and gate variants; report the change in endpoint statistics and whether the conclusion survives. | Robinson 2025; OTflow (doi:10.1002/cyto.a.24491) | None found | **Novel** |
| N12 | **Provenance-embedded vector figures.** SVG/PDF carry gates, transforms, matrices and file hashes; re-render from data at any resolution. | Reproducibility literature | Figure editors without provenance | **Novel** (full provenance) |
| N13 | **Ontology-mapped population labels** (Cell Ontology IDs, OMIP templates). | flowCL; CytoPheno (doi:10.1038/s41598-025-12153-w) | R packages only | **Novel in GUIs** |
| N14 | **Frequency confidence intervals everywhere.** Wilson/Poisson intervals; an "events needed" calculator; combined with N1. | Rare-event practice | Rarely shown **(unverified)** | **Partial**, an easy win |
| N15 | **Live linked brushing** across plots, tree, plate and tables at 10M events. | — | Real-time backgating in desktop analysis software | **Partial** |
| N16 | **Acquisition-time QC.** The host watches the instrument's export folder and runs QC as files land. | PeacoQC and flowAI are post hoc | Bead-based instrument QC | **Partial** |
| N17 | **FCS de-identification and linting on export.** | Privacy; the fireflow issues list | Some free tools | **Exists** |
| N18 | **Instrument characterization** inside the analysis app (Q and B, rCV, Levey–Jennings), reused by N7. | Steen, Wood and Hoffman methods (Section 3B) | Instrument daily-QC software | **Partial** |

Kinetics, cell cycle, proliferation and cloud collaboration already exist in shipping tools. Real-time local-first co-annotation (CRDT) is a later-phase option.

---

## 6. Public, redistributable example datasets (license audit)

**Method.** Checked live via the Zenodo, Mendeley, Dryad and GitHub APIs, FCS header reads, and the repositories' terms pages. Zenodo licenses for 22808501, 19221995, 13928969 and 4984659 were re-verified via the Zenodo API on 2026-10-02.

**Rules applied.**
- Data files keep their own license inside an Apache-2.0 binary.
- CC BY 4.0 requires credit, a license link and a note of any changes (e.g., "subset extracted").
- CC BY-SA imposes share-alike on modified data.
- Prefer non-human data (bead, mouse, worm, bacterial) for anything bundled.

### 6.1 Repositories and terms

**FlowRepository** (https://flowrepository.org/terms_of_service)
- Terms: ISAC places *no restrictions on use or redistribution*, **requires attribution**, and warns that third parties may hold IP rights. There is no named license (re3data lists "Public Domain; Copyrights").
- Not suited to automated in-app downloads: downloads require interactive steps (a CAPTCHA, a login, an API client ID), and new deposits are no longer accepted.
- No successor exists. New OMIP and other deposits (2025–26) go to **Zenodo under CC BY 4.0**.
- **Plan:** host your own mirror (Zenodo or GitHub Releases) of selected FlowRepository sets, with ISAC and author attribution. Precedent: readfcs (Apache-2.0) re-hosts FR-FCM-ZYQ9 on S3.

**Other repositories**
- **ImmPort** (https://docs.immport.org/home/agreement/): login required; no re-identification; redistribution must stay under terms commensurate with ImmPort's agreement. **Do not bundle; link out.**
- **Cytobank Community**: terms require permission for redistribution. **Link out only.**
- **Vendor tutorial data**: no redistribution license found. **Link out only.**
- **OMIP-069** has no public FCS deposit found **(unverified)**. Note FR-FCM-Z3WR is a COVID-19 36-color Duke set, *not* OMIP-069.
- **Dryad**: always CC0, but anonymous API downloads returned 401, so mirror. **Zenodo and Mendeley S3** allow anonymous per-file and HTTP Range downloads, which makes them the best in-app sources.

**ISAC Gating-ML 2.0 compliance suite** (`data1.fcs`, `data2.fcs`, gates, per-event truth)
- Its readme allows free distribution and read-only use; modification and other rights are reserved by ISAC.
- **Keep it as a separately-noticed test fixture in the repo, not in the shipped binary.**

### 6.2 Candidate datasets

**Small conformance / tutorial files**

| Dataset | Content | License | Bundle? | Use |
|---|---|---|---|---|
| **FlowCal examples** (taborlab/FlowCal `examples/FCFiles`) | 15 FCS, 11.6 MB; E. coli sfGFP induction + calibration beads; Cytek xP3 (upgraded FACScan), FCS 3.0, 33,024 ev, 8 par; `test/Data001–005` FCS 2.0 | **MIT** (© 2015 Sexton, Landry, Castillo-Hair) | **Yes** | Tutorials, bead/MEF calibration |
| **fcsparser test files** (eyurtsev/fcsparser) | 19 files, ~21 MB; Cytek xP5, FACSCalibur, Fortessa/LSRII, MACSQuant FCS 2.0/3.0/3.1, Guava Muse, CyFlow Cube 8, corrupted, fake-large | **MIT** | Test dir only | Reader robustness. Exclude `facs_diva_test.fcs` (apparent clinical B-ALL panel, unknown origin) |
| **flowCore extdata** | `0877408774.*` (FACSCalibur FCS 2.0, 10k ev) and `compdata/060909.001–005` comp controls (~0.1 MB each) | **Artistic-2.0** | Yes (include license) | Legacy FCS 2.0, compensation |
| **FlowKit synthetic** (`test_data_2d_01.fcs`, `test_data_diamond_01.fcs`) | 10k / 200k events | BSD-3 | Yes | Gate-semantics tests |
| FlowKit real files (8-color ICS + `.wsp`, 1007xx FACSAria, `test_comp_example` exported from Cytobank) | — | BSD-3 repo, **undocumented provenance** | Test dir only (risk) | WSP parity tests: valuable, but verify provenance |
| **FR-FCM-ZZZ4** "FCS collection for software testing" | 39 files, 331 MB, ~15 vendors incl. LMD and FCS 3.0/3.1 pairs | FlowRepository ToS | Mirror and download | The reference multi-vendor reader suite |
| GPL/AGPL package data: flowWorkspaceData, FlowSOM `68983.fcs`, PeacoQC `111.fcs`, CytoNorm extdata, CytoExploreRData, cytoflow, CytometryInR (AGPL + CC BY-SA) | — | GPL / AGPL | **No** | Oracle comparisons in CI only |

**Spectral, with raw detector channels and reference controls**

| Dataset | Content | License | Bundle? |
|---|---|---|---|
| **AutoSpectral example** (Burton, Dooley & Liston; Mendeley ch5dnspd79 v1, doi:10.17632/ch5dnspd79.1) | 2.12 GB; Aurora 5L, mouse 9-color; SpectroFlo .Expt; raw and unmixed; 8 bead + 8 cell raw controls; unstained spleen/lung/liver; fixative series | **CC BY 4.0** | **Yes**: bead-control subset ~12 MB (mark "subset extracted"); full set as download |
| **CELeidoscope ZAM47** (Zenodo 19221995) | BD FACSDiscover S8, **FCS 3.2, 440 parameters**; single-color controls 18.3 MB each; FlowJo .wsp; C. elegans | **CC BY 4.0** | Optional (one 18 MB control); the only real FCS 3.2 files found |
| CLL 42-color OMIP (Zenodo 19485511) | Raw 2.17 GB, refs 2.98 GB, unmixed 1.58 GB; human | CC BY 4.0 | Download |
| 41-color whole-blood OMIP (Zenodo 19452540) | 2.48 GB + refs 6.32 GB | CC BY 4.0 | Download |
| Petti OMIP mouse tumor/LN (Zenodo 17568671, 20644656) | Unmixed 1.3 GB; raw zip 7.19 GB with 25 bead controls and 50 FMOs | CC BY 4.0 | Download |
| CytoBatchFlagR (Zenodo 15388817) | 74 Aurora unmixed files, 3.69 GB; batch controls | CC BY 4.0 | Download |
| Roet 2024 (FR-FCM-Z78C, 459 MB); den Braanker 2021 (FR-FCM-Z4KT, 516 MB); FR-FCM-Z3YL; FR-FCM-Z3WR | Aurora, single stains | FlowRepository ToS | Mirror |

**Mass cytometry**

| Dataset | License | Use |
|---|---|---|
| ImmunoCluster (Zenodo 4719468; FR-FCM-Z244 derivative) | CC BY 4.0, with a chain-of-title caveat | Download |
| Zenodo 10510047 (microglia, 138 MB), 13147938, 19653078, 17238592 | CC BY 4.0 | Download |
| **FR-FCM-ZYL8** (diffcyt: BCR-XL/Bodenmiller, anti-PD-1, AML-sim), 911 MB | FlowRepository ToS | Mirror; differential-analysis demos |
| HDCytoData (Bioconductor ExperimentHub) | "MIT + file LICENSE", but asserted over third-party data, so weak chain of title | Oracle use only |

**Conventional flow**

| Dataset | Content | License | Bundle? |
|---|---|---|---|
| **Mouse skull BM chimera** (Zenodo 22808501, 2026-09-17) | LSRFortessa/Diva 9; **15 single-stain comp controls, 3 MB total**, 15 FMOs, 46 samples; 319 MB | **CC BY 4.0** | **Yes** (comp controls + a few samples) |
| **CytoNorm 2.0 use-case data** (Zenodo 13928969) | 48 FCS, 80 MB; FACSymphony A5; 2 panels × 8 patients × 3 timepoints | **CC BY 4.0** | Subset (< 5 MB) for the batch-normalization tutorial |
| **Glycophorin A RBC** (Zenodo 4984659 = Dryad f862c) | 103 FCS 2.0 FACScan files, 117 MB | **CC0** | **Yes** (2–3 files) |
| Dryad CC0 sets: Lewy-body phospho-flow (h70rxwdrc), healthy BM (4b8gthtcf), AML SCNP (94r9s) | — | CC0 | Mirror |
| **FR-FCM-ZZPH** (Weber & Robinson 2016: Levine_13/32dim, Samusik, Nilsson_rare, Mosmann_rare, FlowCAP ND/WNV; labels in an FCS column), 701 MB | — | FlowRepository ToS | Mirror; clustering ground truth |
| FlowCAP-I (ZZY2, ZZYY, ZZY6, ZZY3, ZZYZ; small), FlowCAP-II (large), OMIP-018/021/058/102, AutoSpill sets (Z2SS, Z2SV, Z2ST) | — | FlowRepository ToS | Mirror selectively |
| Cross-platform benchmark (Zenodo 17094078, 194 GB) | — | CC BY 4.0 | Selected archives only |

### 6.3 Recommendation

**(a) Bundle in the binary** (about 25–40 MB; attribute in NOTICE / THIRD_PARTY_LICENSES and the About screen):
1. FlowCal beads plus 3–5 E. coli files (MIT).
2. Skull-chimera comp controls plus 1–2 samples (CC BY).
3. AutoSpectral raw **bead** reference controls (CC BY, ~12 MB). This is the bundled spectral/unmixing tutorial.
4. Glycophorin FCS 2.0 files (CC0).
5. A CytoNorm 2.0 subset (CC BY).
6. flowCore FACSCalibur files (Artistic-2.0).
7. FlowKit synthetic files (BSD-3).
8. Optionally one CELeidoscope FCS 3.2 control (CC BY).

**(b) In-app downloads with license display**, via direct Zenodo and Mendeley per-file URLs plus Range requests:
- AutoSpectral full, CELeidoscope, CLL-42, 41-color OMIP, Petti, CytoBatchFlagR, CytoNorm 2.0 full, skull chimera full, CyTOF Zenodo sets.
- A **CytoWeave-hosted mirror** of FlowRepository classics with attribution: ZZPH, ZYL8, FlowCAP-I, ZZZ4, Z78C, Z4KT, AutoSpill sets.

**(c) Avoid, or link out only:**
- Cytobank Community data and vendor tutorial data (no redistribution license).
- ImmPort-only data.
- GPL/AGPL package data.
- The Gating-ML suite inside the binary.
- FlowKit/FlowIO real files of undocumented provenance.
- fcsparser `facs_diva_test.fcs`.
- tlnagy/fcsexamples (no license).

## 7. Corrections to the original product brief

1. **Architecture.**
   - The brief recommended Rust/Arrow, Python/FlowKit services, R workers, React and Tauri.
   - CytoWeave is a **Go single binary plus an embedded vanilla-JS app, with all analysis in the browser**.
   - Algorithms that live in R or Python (CytoNorm, diffcyt-style statistics, PeacoQC, FlowSOM, UMAP) are therefore **re-implemented in JS** and validated against R/Python results.
   - The Go server serves files, persists projects, hashes files and hosts the MCP endpoint.
2. **SSM reference.** The spillover spreading matrix paper is Nguyen, Perfetto, Mahnke, Chattopadhyay & Roederer, Cytometry A 2013;83A:306–315, **doi:10.1002/cyto.a.22251** (verified via Crossref).
3. **FCS 3.2.** Read 3.2 fully, but write 3.1 by default: instrument software and analysis exports still write FCS 3.1, and 3.2's mixed data types break older readers.
4. **Gating-ML polygon semantics.** Gating-ML mandates the **even–odd** rule (explicitly not non-zero winding). Rectangles are **half-open** `[min, max)`.
5. **DOIs.**
   - CLR: 10.1002/cyto.a.22586 (Cytometry A 2015;87:86–88).
   - Gating-ML 2.0: 10.1002/cyto.a.22690.
   - FCS 3.2: 10.1002/cyto.a.24225.
   - FCS 3.1: 10.1002/cyto.a.20825.

---

## 8. Design implications for CytoWeave (prioritized)

The ordering principle is **trust first** (numbers that match the standards, FlowJo, R and Python), then **the daily workbench**, then **features no single tool combines**.

### Tier 0: correctness foundations (build before any UI polish)

1. **A forgiving, transparent FCS reader and a strict writer.**
   - Read FCS 2.0, 3.0, 3.1 and 3.2, including `$PnDATATYPE` mixed types, 8-byte OTHER offsets and `$UNSTAINEDCENTERS`.
   - Repair modes: "scalpel" (repair while keeping metadata) and "sledgehammer" (just read DATA), with every repair shown in a file inspector.
   - Write FCS 3.1 by default and 3.2 on request. Optionally strip PHI keywords on export.
   - Rationale: instrument files are routinely non-compliant (NIST fireflow `COMMON_ISSUES.md`); 3.2 mixed types break old readers (§4.1).
2. **A golden-test harness as a first-class deliverable**, run in Node and in a headless browser in CI:
   - **(a)** the ISAC Gating-ML 2.0 compliance suite (FlowKit `data/gate_ref`, per-event truth);
   - **(b)** BD's **MIT-licensed FlowJo LUTs**, 405 tables plus the xlsx forward table, for biex and logicle;
   - **(c)** FlowKit 1.3.2 as an oracle for .wsp gate counts, including its exact-count FlowJo tests;
   - **(d)** R/Python oracles for every algorithm (FlowSOM, PeacoQC, CytoNorm, UMAP), compared on statistical agreement (ARI, rank correlations, trustworthiness) rather than bit equality;
   - **(e)** a fuzzed FCS corpus.
   - Rationale: small transform and boundary differences change counts near zero on biexponential axes (§3A, §3C).
3. **Transform engine with two explicit fidelity modes.**
   - *Reference mode*: Gating-ML logicle, hyperlog, fasinh, flin, flog and fratio, ported from Moore's reference structure (Taylor series, Halley iteration, reflection).
   - *FlowJo-compatible mode*: LUT-backed biex and logicle (4096 channels, linear interpolation), with the FlowJo parameter constraint W + A ≤ M/2.
   - Also the cofactor arcsinh common in mass and spectral cytometry, with documented conversions to Gating-ML (§3A.5).
   - Show the mode on each axis.
   - Rationale: FlowJo's logicle differs from the reference by about 100/4096 channels at W = 1, and the open biex port fails for width basis > −3.2 (measured, §3A.2–3A.3).
4. **A gate engine with normative Gating-ML semantics.**
   - Store `{dimension, compensation-ref, transformation-ref}` per gate axis.
   - Rectangles are half-open; polygons use the even–odd rule with inclusive edges; ellipsoids use Mahalanobis ≤ D².
   - Membership is a bitset per event; evaluation runs in Workers in float64.
   - Rationale: removes the "which space is this gate in?" ambiguity, and gives lossless Gating-ML and WSP round-trips (§4.2–4.3).
5. **Compensation core.**
   - `$SPILLOVER`/`SPILL` import.
   - A matrix editor that never mutates the original matrix.
   - Classic and AutoSpill-style estimation from single stains.
   - Residual-slope N×N diagnostics.
   - Rationale: AutoSpill-style estimation (Roca et al. 2021, doi:10.1038/s41467-021-23126-8) needs no explicit negative gate.

### Tier 1: the daily workbench

6. **Rendering and interaction at 10M+ events.**
   - WebGL2 pseudocolor, density, contour, histogram and dot plots with a deterministic subsample.
   - Live gate dragging with instant statistic updates.
   - Linked brushing across plots, tree, plate and tables (N15).
   - Server-side streaming of columns via HTTP range requests from the Go binary.
   - WebGPU as optional acceleration only.
   - Rationale: large spectral cohorts; WebGPU is not yet available in every browser (§3C).
7. **Comparison-first organization.**
   - Groups, populations and samples as separate axes.
   - Keyword/metadata manager with CSV import.
   - Template propagation with per-sample overrides.
   - Gallery views by other samples, parameters, ancestry or backgating.
   - Batch tables with the standard statistic definitions: freq of parent/total, median, gMFI, CV, rCV, rSD.
8. **Reports and figures.**
   - Page-oriented reports with batch iteration.
   - **Vector SVG and PDF with embedded provenance JSON** (N12); PNG at any DPI.
   - Rationale: figures that can be traced to the analysis that made them.
9. **Interchange.**
   - Import .wsp with a per-gate *fidelity report*: unsupported transforms, curly quads, magnetic gates, ellipse conversion.
   - Export .wsp and Gating-ML 2.0 (gates, transforms, `spectrumMatrix`), and export CLR for clusters and probabilistic gates.
   - Project bundles reference FCS files by **sha256 + size + basename**, never by absolute path.
   - Rationale: analyses must move between tools, and files must be found again when they move.
10. **Provenance graph with semantic diff and branches (N4).**
    - Every edit is an immutable node.
    - The diff view shows gate geometry, membership, statistic, matrix and transform deltas.
    - Undo/redo is history navigation.
    - Rationale: reproducibility (Sorigue 2025); no semantic diff was found in existing tools.
11. **Acquisition-quality QC.**
    - Time and flow-rate tracks.
    - A JS PeacoQC port (validated against Bioconductor 1.22) as a reversible event mask.
    - Optional folder-watch QC in the Go server as files land from the instrument (N16).

### Tier 2: spectral analysis

12. **Spectral workbench (N6).** Import raw files (Aurora, FACSDiscover, ID7000, Xenith, Opteon) and single-stain controls. Then:
    - clean controls: positive/negative selection, AF contamination removal, cosine to library;
    - offer **OLS (default) and WLS** (global weights), with NNLS optional and warned;
    - **multi-AF discovery** by clustering unstained cells (Roet 2024);
    - **per-cell AF assignment**, the per-cell autofluorescence matching of AutoSpectral (Burton et al. 2025, cited), with CytoWeave's own O(d)-per-candidate residual-projection method (§3A.8); AutoSpectral's AGPL code is not used;
    - a residual-norm QC parameter;
    - similarity, complexity, hotspot and SSM matrices;
    - a correction matrix layered over the original;
    - export of the reference matrix as a Gating-ML `spectrumMatrix`.
    - Rationale: Robinson 2025; Roet 2024; an auditable workflow from controls to unmixed data.
13. **Instrument and panel metrics.**
    - Stain index, separation index, rSD, rCV.
    - **Q and B** and Levey–Jennings from bead files.
    - **Predicted spread** `U Σ Uᵀ` from the user's own references and noise model (N7, N18).
    - Rationale: Mage 2026; the Residual Model preprint.

### Tier 3: cohort scale and trust (novel; build on Tiers 0–2)

14. **Cohort review queue (N2, N3).** Rank samples by:
    - boundary-density score, gate displacement and robust-z outlier statistics;
    - QC removal % and unmixing residual.
    Each sample gets an accept/adjust/exclude workflow with status.
    - Rationale: adapted template gates must be checked on every sample; an integrated queue makes that practical.
15. **Uncertainty on every number.**
    - Wilson/Poisson confidence intervals (N14).
    - **Gate-sensitivity intervals and a fragility index** (N1).
    - Rationale: novel; grounded in "Gate Shape Matters" (2026) and the NIST uncertainty-quantification work.
16. **Adaptive gating with abstention (N10).**
    - Start with density/valley (flowDensity-style) and FMO-anchored thresholds.
    - Add learned per-file adjustment trained on the user's own gated exemplars.
    - Export per-event probabilities as CLR; route low confidence to item 14.
    - Rationale: existing autogating returns point estimates; uncertainty plus review is new.

### Tier 4: high-dimensional analysis (JS implementations validated against R and Python)

17. **Clustering and embedding.**
    - Downsample and concatenate with provenance.
    - FlowSOM (SOM plus consensus metaclustering) and Leiden/Phenograph.
    - UMAP (including transform of new data), opt-SNE/FIt-SNE-style t-SNE, PaCMAP.
    - Cluster heatmaps.
    - **Embedding faithfulness metrics and seed stability** shown next to every embedding (N5).
    - Rationale: table stakes plus the clearest novel trust feature (§3B, §5).
18. **Normalization and statistics.**
    - CytoNorm 2.0-style quantile-spline normalization with confounding warnings; cyCombine-like option.
    - Sample-aware differential abundance and state (diffcyt-style), with the design matrix built from metadata.
    - Rationale: these analyses should not require uploading data.

### Tier 5: agents and advanced exploration

19. **MCP server in the Go binary (N8).**
    - Typed tools: `describe_view` as text (histogram, peaks, gates), list and query populations, propose gate, run QC or algorithms, export.
    - Every write lands as a **pending commit in the provenance graph** that the user accepts.
    - Never let an LLM silently alter data or gates.
    - Rationale: agents read numbers and text more reliably than screenshots, and their edits must stay reviewable.
20. **Counterfactual preprocessing explorer (N11)**, ontology-mapped labels and OMIP templates (N13), and cell-cycle and proliferation platforms (§3B).
21. **Later:** imaging-flow galleries (FACSDiscover/Amnis) and local-first real-time co-annotation (CRDT).

### Licensing guardrails for implementation

Licenses were verified from GitHub and DESCRIPTION files on 2026-10-01.

- **OK to port or adapt with notice:**
  - FlowKit, FlowUtils, FlowIO (BSD-3).
  - BD FlowJo LUTs (MIT).
  - Several MIT-licensed open-source cytometry projects (check each license).
  - diffcyt (MIT).
  - cyCombine (MIT + file).
  - umap-js (repo LICENSE Apache-2.0; package.json says MIT, so confirm).
  - The ml-* family, graphology-communities-louvain, ngraph.leiden (MIT).
  - PaCMAP reference (Apache-2.0).
  - NIST fireflow (public-domain-style notice; acknowledge NIST).
  - flowCore (Artistic-2.0, permissive-compatible with care).
- **Re-implement from the papers; do not translate code:**
  - AutoSpectral (**AGPL-3**).
  - TRU-OLS (GPL-3).
  - FlowSOM R (GPL ≥ 2), FlowSOM_Python (GPL-3).
  - PeacoQC (GPL ≥ 3).
  - CytoNorm (GPL ≥ 2).
  - CATALYST (GPL ≥ 2).
  - leidenalg (GPL-3). The Leiden algorithm itself is published (Traag 2019, doi:10.1038/s41598-019-41695-z).
  - Cytoflow (GPL-2).
- **LGPL:** DruidJS is LGPL-3, so use it only as a dynamically loaded dependency or re-implement.
- **Never use** the removed malicious `umap-wasm` npm package.
- **ISAC XSDs:** redistribute only unmodified copies.
