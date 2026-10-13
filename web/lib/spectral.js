// Spectral flow cytometry: reference spectra, unmixing, autofluorescence and diagnostics.
//
// A reference set holds F signatures (fluorochromes, autofluorescence) over D detectors as an
// F × D row-major matrix S, each row normalized so its peak is 1 (Cytek SpectroFlo convention).
// An event's detector vector r (length D) is modeled as r ≈ a S + noise; the abundances a
// (length F) are in units of each signature's peak-detector signal. Detector data arrive
// column-major, one Float32Array per detector, as an array in detector order or an object keyed
// by detector name. Every unmixing function takes `options.indices` (a Uint32Array of events to
// unmix; outputs then have one value per listed event) and returns
// { names, abundances: Float32Array[] (one per signature), residuals: Float32Array | null },
// where a residual is ‖r − â S‖₂ / ‖r‖₂, the part of the event's signal the model leaves
// unexplained.

import { median, robustSD, robustVarianceSE, splitControl } from './compensation.js';
import {
  choleskyInPlace,
  choleskySolveInPlace,
  createNNLSWorkspace,
  inverse,
  nnlsBlockPivotInPlace,
  nnlsGramInPlace,
  pseudoInverse,
  svd,
} from './linalg.js';
import { createRandom, sampleIndices } from './random.js';
import { gather, modeOf, quantileSorted } from './stats.js';

// --- Reference sets and input handling --------------------------------------------------------

// Normalizes a spectrum so its largest value is 1.
export function normalizeSpectrum(values) {
  let peak = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (values[i] > peak) peak = values[i];
  if (!(peak > 0)) throw new Error('A spectrum needs at least one positive value to be normalized.');
  return Float64Array.from(values, (v) => v / peak);
}

// Accepts the shapes a reference set arrives in and returns { names, detectors, F, D, matrix }:
// - { names | fluorochromes, detectors?, matrix } (F × D row-major);
// - an array of { name, spectrum } (as referenceSpectrum and extractAutofluorescence return);
// - an array of plain arrays or typed arrays (named F1, F2, …).
export function referenceMatrix(spectra, detectors = null) {
  if (!spectra) throw new Error('No reference spectra were given.');
  if (!Array.isArray(spectra) && spectra.matrix) {
    const names = Array.from(spectra.names ?? spectra.fluorochromes ?? []);
    const F = names.length;
    const D = F ? spectra.matrix.length / F : 0;
    if (!F || !Number.isInteger(D) || D < 1) throw new Error('The reference matrix does not match its list of fluorochromes.');
    return { names, detectors: spectra.detectors ? Array.from(spectra.detectors) : detectors, F, D, matrix: Float64Array.from(spectra.matrix) };
  }
  const list = Array.isArray(spectra) ? spectra : spectra.signatures;
  if (!list || !list.length) throw new Error('No reference spectra were given.');
  const rows = list.map((entry) => (ArrayBuffer.isView(entry) || Array.isArray(entry) ? entry : entry.spectrum ?? entry.values));
  const D = rows[0]?.length ?? 0;
  if (!D) throw new Error('A reference spectrum is empty.');
  const matrix = new Float64Array(list.length * D);
  rows.forEach((row, f) => {
    if (!row || row.length !== D) throw new Error('All reference spectra must cover the same detectors.');
    for (let d = 0; d < D; d += 1) matrix[f * D + d] = row[d];
  });
  const names = list.map((entry, f) => (entry && !ArrayBuffer.isView(entry) && !Array.isArray(entry) && entry.name) || `F${f + 1}`);
  const named = list.find((entry) => entry && entry.detectors);
  return { names, detectors: named ? Array.from(named.detectors) : (spectra.detectors ?? detectors), F: list.length, D, matrix };
}

function signatureList(afSignatures, D) {
  const list = Array.isArray(afSignatures) ? afSignatures : afSignatures?.signatures;
  if (!list || !list.length) throw new Error('No autofluorescence signatures were given.');
  return list.map((entry) => {
    const values = ArrayBuffer.isView(entry) || Array.isArray(entry) ? entry : entry.spectrum ?? entry.values;
    if (!values || values.length !== D) throw new Error('Autofluorescence signatures must cover the same detectors as the reference spectra.');
    return Float64Array.from(values);
  });
}

// Detector columns for a named detector list, from an array (in order) or a keyed object.
function columnsFor(columns, detectors, D = detectors?.length) {
  let list;
  if (Array.isArray(columns)) list = columns;
  else if (columns && typeof columns === 'object') {
    if (!detectors) throw new Error('The detectors are not named, so the data columns must be given as an array in detector order.');
    list = detectors.map((name) => {
      const column = columns[name];
      if (!column) throw new Error(`The data have no detector "${name}" used by the reference spectra.`);
      return column;
    });
  } else throw new Error('No detector data were given.');
  if (list.length !== D) throw new Error(`The data have ${list.length} detectors but the reference spectra have ${D}.`);
  const n = list[0].length;
  for (const column of list) if (column.length !== n) throw new Error('All detector columns must have the same number of events.');
  return list;
}

function abortError() {
  const error = new Error('The analysis was canceled.');
  error.name = 'AbortError';
  return error;
}

function checkpoint(options, fraction, message) {
  if (options.signal?.aborted) throw abortError();
  if (options.onProgress) options.onProgress(fraction, message);
}

function now() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

// A Float64Array of a column's values at the given indices (all when null).
function valuesAt(column, indices) {
  return gather(column, indices);
}

function transposeFD(matrix, F, D) {
  const out = new Float64Array(D * F);
  for (let f = 0; f < F; f += 1) for (let d = 0; d < D; d += 1) out[d * F + f] = matrix[f * D + d];
  return out;
}

// S W Sᵀ (F × F) for per-detector weights w (null = unweighted).
function weightedGram(matrix, F, D, weights) {
  const g = new Float64Array(F * F);
  for (let i = 0; i < F; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = 0;
      for (let d = 0; d < D; d += 1) sum += matrix[i * D + d] * matrix[j * D + d] * (weights ? weights[d] : 1);
      g[i * F + j] = sum;
      g[j * F + i] = sum;
    }
  }
  return g;
}

// The D × F operator P with â = r P for (weighted) least squares: P = W Sᵀ (S W Sᵀ)⁻¹, computed
// from the SVD of S W^½ for accuracy. Throws a plain-language error for a rank-deficient panel.
// The D × F unmixing operator of a reference set (abundances = signal · operator): the
// pseudo-inverse of the F × D reference matrix, optionally with per-detector weights (WLS).
export function unmixingOperator(spectra, options = {}) {
  return linearOperator(referenceMatrix(spectra, options.detectors), options.weights ?? null);
}

function linearOperator(ref, weights = null) {
  const { F, D, matrix } = ref;
  if (F > D) throw new Error(`The panel has ${F} signatures but only ${D} detectors; unmixing needs at least as many detectors as signatures.`);
  let scaled = matrix;
  if (weights) {
    scaled = new Float64Array(F * D);
    for (let f = 0; f < F; f += 1) for (let d = 0; d < D; d += 1) scaled[f * D + d] = matrix[f * D + d] * Math.sqrt(weights[d]);
  }
  const decomposition = svd(scaled, F, D);
  const { s } = decomposition;
  if (!(s[F - 1] > s[0] * 1e-10)) {
    throw new Error('The reference spectra are linearly dependent (a signature duplicates another or is a mixture of others), so they cannot be unmixed. Remove the duplicate signature.');
  }
  const p = pseudoInverse(scaled, F, D, { svd: decomposition });
  if (weights) {
    for (let d = 0; d < D; d += 1) {
      const root = Math.sqrt(weights[d]);
      for (let f = 0; f < F; f += 1) p[d * F + f] *= root;
    }
  }
  return p;
}

// ‖r − a S‖ / ‖r‖ with S given transposed (D × F).
function relativeResidual(r, a, st, D, F) {
  let res2 = 0;
  let sig2 = 0;
  for (let d = 0; d < D; d += 1) {
    let fit = 0;
    const row = d * F;
    for (let f = 0; f < F; f += 1) fit += a[f] * st[row + f];
    const e = r[d] - fit;
    res2 += e * e;
    sig2 += r[d] * r[d];
  }
  return sig2 > 0 ? Math.sqrt(res2 / sig2) : 0;
}

function prepareEvents(columns, ref, options) {
  const cols = columnsFor(columns, ref.detectors, ref.D);
  const idx = options.indices ?? null;
  return { cols, idx, count: idx ? idx.length : cols[0].length };
}

// --- Reference spectra from controls ----------------------------------------------------------

// Reference spectrum of a single-stain control: per detector, median(positive) − median(negative),
// normalized to a peak of 1 (the SpectroFlo and AutoSpectral definition). The negative is either
// events of the same control (`negativeIdx`) or an unstained control (`options.negativeColumns`,
// with `negativeIdx` indexing it, or null for all its events).
// Quality checks: positive event count; brightness at the peak as a multiple of the negative's
// robust SD (dim if < options.dimThreshold, default 10); per-detector signal-to-noise; negative
// spectrum values (a negative that does not match the positive's autofluorescence); saturation
// (with options.range); and heterogeneity — the spectra of the dimmest and brightest thirds of
// the positive population should agree (cosine ≥ options.heterogeneityThreshold, default 0.98),
// or the control may hold a mixture (degraded tandem, autofluorescent cells, a second dye);
// quality.mixture is the dim third's spectrum minus the bright third's, each normalized at the
// peak detector (its shape says what the mixture is; spectral-doctor.js reads it).
export function referenceSpectrum(columns, detectors, positiveIdx, negativeIdx, options = {}) {
  const D = detectors.length;
  const cols = columnsFor(columns, detectors, D);
  if (!positiveIdx || !positiveIdx.length) throw new Error('The control has no positive events to build a spectrum from.');
  const negCols = options.negativeColumns ? columnsFor(options.negativeColumns, detectors, D) : cols;
  if (!options.negativeColumns && !negativeIdx) throw new Error('A negative population is needed: give negative events or an unstained control.');
  const negIdx = negativeIdx ?? null;
  const positiveMedian = new Float64Array(D);
  const negativeMedian = new Float64Array(D);
  const positiveRSD = new Float64Array(D);
  const negativeRSD = new Float64Array(D);
  for (let d = 0; d < D; d += 1) {
    const pos = valuesAt(cols[d], positiveIdx);
    const neg = valuesAt(negCols[d], negIdx);
    positiveMedian[d] = median(pos);
    negativeMedian[d] = median(neg);
    positiveRSD[d] = robustSD(pos);
    negativeRSD[d] = robustSD(neg);
  }
  const raw = new Float64Array(D);
  let peakIndex = 0;
  for (let d = 0; d < D; d += 1) {
    raw[d] = positiveMedian[d] - negativeMedian[d];
    if (raw[d] > raw[peakIndex]) peakIndex = d;
  }
  if (!(raw[peakIndex] > 0)) throw new Error('The positive events are not brighter than the negative events in any detector; check the positive and negative gates.');
  const spectrum = Float64Array.from(raw, (v) => v / raw[peakIndex]);
  const snr = Float64Array.from(raw, (v, d) => v / Math.max(negativeRSD[d], 1e-12));
  const brightness = raw[peakIndex];
  const separation = snr[peakIndex];
  const warnings = [];
  const minEvents = options.minEvents ?? 200;
  if (positiveIdx.length < minEvents) warnings.push(`Only ${positiveIdx.length} positive events; ${minEvents} or more give a stable spectrum.`);
  const dimThreshold = options.dimThreshold ?? 10;
  if (separation < dimThreshold) {
    warnings.push(`The control is dim: its peak signal is ${separation.toFixed(1)}× the negative's robust SD (aim for ${dimThreshold}× or more). A brighter control gives a more accurate spectrum.`);
  }
  const negativeTolerance = options.negativeTolerance ?? 0.05;
  const negativeDetectors = detectors.filter((_, d) => spectrum[d] < -negativeTolerance);
  if (negativeDetectors.length) {
    warnings.push(`The negative is brighter than the positive in ${negativeDetectors.join(', ')}; the negative may have different autofluorescence from the positive cells.`);
  }
  if (options.range) {
    const peakValues = valuesAt(cols[peakIndex], positiveIdx);
    let saturated = 0;
    for (let i = 0; i < peakValues.length; i += 1) if (peakValues[i] >= 0.98 * options.range) saturated += 1;
    if (saturated > 0.01 * peakValues.length) warnings.push(`${((100 * saturated) / peakValues.length).toFixed(1)}% of positive events are at the top of the detector range in ${detectors[peakIndex]}; off-scale events distort the spectrum.`);
  }
  let heterogeneity = Number.NaN;
  let mixture = null;
  if (positiveIdx.length >= 60) {
    // Spectra of the dimmest and brightest thirds of the positives (ranked on the peak detector).
    const peakColumn = cols[peakIndex];
    const ranked = Array.from(positiveIdx).sort((x, y) => peakColumn[x] - peakColumn[y]);
    const third = Math.floor(ranked.length / 3);
    const low = Uint32Array.from(ranked.slice(0, third));
    const high = Uint32Array.from(ranked.slice(ranked.length - third));
    const lowSpectrum = new Float64Array(D);
    const highSpectrum = new Float64Array(D);
    for (let d = 0; d < D; d += 1) {
      lowSpectrum[d] = median(valuesAt(cols[d], low)) - negativeMedian[d];
      highSpectrum[d] = median(valuesAt(cols[d], high)) - negativeMedian[d];
    }
    heterogeneity = cosine(lowSpectrum, highSpectrum);
    // The shape of the difference, each third normalized at the peak detector: autofluorescence
    // when the positives are autofluorescent cells (it weighs more on the dimmer ones).
    if (lowSpectrum[peakIndex] > 0 && highSpectrum[peakIndex] > 0) {
      mixture = Float64Array.from(lowSpectrum, (v, d) => v / lowSpectrum[peakIndex] - highSpectrum[d] / highSpectrum[peakIndex]);
    }
    const threshold = options.heterogeneityThreshold ?? 0.98;
    if (heterogeneity < threshold) {
      warnings.push(`The spectrum of the dimmest positive events differs from that of the brightest (similarity ${heterogeneity.toFixed(3)}); the positive population may be a mixture (degraded tandem, autofluorescent cells or a second fluorochrome).`);
    }
  }
  return {
    name: options.name ?? null,
    detectors: Array.from(detectors),
    spectrum,
    raw,
    peakIndex,
    peakDetector: detectors[peakIndex],
    positiveMedian,
    negativeMedian,
    positiveRSD,
    negativeRSD,
    snr,
    quality: {
      positiveEvents: positiveIdx.length,
      negativeEvents: negIdx ? negIdx.length : negCols[0].length,
      brightness,
      separation,
      stainIndex: brightness / (2 * Math.max(negativeRSD[peakIndex], 1e-12)),
      heterogeneity,
      mixture,
      warnings,
    },
  };
}

// Picks the positive and negative events of a single-stain control without scatter gates, in the
// spirit of SpectroFlo's "brightest events" positive gate and of AutoSpectral's automated control
// processing (Burton OT et al., bioRxiv 2025, doi:10.1101/2025.10.27.684855). CytoWeave's own
// heuristic:
// 1. Peak detector: the detector where the control's 99.5th percentile rises most above the
//    unstained control's 99.5th percentile (or above the control's own median when there is no
//    unstained control). Comparing upper tails of the same cells cancels autofluorescence.
// 2. Negative: the unstained control if given (options.unstainedColumns); otherwise an internal
//    negative found as the histogram mode of the dimmest `negativeFraction` (0.3) of events on the
//    peak detector, with its spread estimated from the left half only (stained cells never fall
//    below the unstained mode), keeping events within ±2 spreads of the mode.
// 3. Positive: events above mode + `sigmas` (4) × spread, minus events off scale in any detector
//    (with options.range) and the brightest `trimFraction` (0.1%, likely aggregates); of these the
//    brightest `positiveFraction` (0.5) are kept, but at least `minEvents` (200) when available.
// 4. Autofluorescence matching (options.matchNegatives, default true): from the negative pool,
//    keep the `matchFraction` (0.5) of events whose signal in detectors where the dye is dark
//    (< 2% of peak) is closest to the positives' — a scatter-free way of choosing negatives of
//    the same cell type, which is what scatter matching achieves in AutoSpectral.
// Indices in `negative` refer to the unstained control when one is used (negativeSource says so).
export function autoGateControl(columns, detectors, options = {}) {
  const D = detectors.length;
  const cols = columnsFor(columns, detectors, D);
  const n = cols[0].length;
  const random = createRandom(options.seed ?? 1);
  const pool = options.indices ?? null;
  const poolSize = pool ? pool.length : n;
  const unstained = options.unstainedColumns ? columnsFor(options.unstainedColumns, detectors, D) : null;
  const uPool = options.unstainedIndices ?? null;
  const warnings = [];
  const sample = sampleIndices(n, options.maxEvents ?? 50000, random, pool);
  const uSample = unstained ? sampleIndices(unstained[0].length, options.maxEvents ?? 50000, random, uPool) : null;
  let peakIndex = options.peakDetector !== undefined ? (typeof options.peakDetector === 'number' ? options.peakDetector : detectors.indexOf(options.peakDetector)) : -1;
  if (peakIndex < 0 || peakIndex >= D) {
    let best = -Infinity;
    for (let d = 0; d < D; d += 1) {
      const values = valuesAt(cols[d], sample).sort();
      const high = quantileSorted(values, 0.995);
      const base = unstained ? quantileSorted(valuesAt(unstained[d], uSample).sort(), 0.995) : quantileSorted(values, 0.5);
      if (high - base > best) {
        best = high - base;
        peakIndex = d;
      }
    }
  }
  const peak = cols[peakIndex];
  let center;
  let spread;
  let negativePool;
  const negativeSource = unstained ? 'unstained' : 'internal';
  if (unstained) {
    const values = valuesAt(unstained[peakIndex], uPool);
    center = median(values);
    spread = robustSD(values);
    negativePool = uPool ? Uint32Array.from(uPool) : Uint32Array.from({ length: unstained[0].length }, (_, i) => i);
  } else {
    const sorted = valuesAt(peak, pool).sort();
    const lowCount = Math.max(10, Math.floor(sorted.length * (options.negativeFraction ?? 0.3)));
    const low = sorted.subarray(0, Math.min(sorted.length, lowCount));
    center = modeOf(low, 128);
    let below = 0;
    while (below < sorted.length && sorted[below] < center) below += 1;
    spread = center - sorted[Math.floor(0.3174 * below)];
    if (!(spread > 0)) spread = robustSD(low) || 1;
    const lo = center - 2 * spread;
    const hi = center + 2 * spread;
    const list = [];
    for (let i = 0; i < poolSize; i += 1) {
      const e = pool ? pool[i] : i;
      const v = peak[e];
      if (v >= lo && v <= hi) list.push(e);
    }
    negativePool = Uint32Array.from(list);
  }
  const threshold = center + (options.sigmas ?? 4) * spread;
  const ceiling = options.range ? 0.98 * options.range : Infinity;
  const candidates = [];
  let offScale = 0;
  for (let i = 0; i < poolSize; i += 1) {
    const e = pool ? pool[i] : i;
    const v = peak[e];
    if (!(v > threshold)) continue;
    // Off scale in any detector: the clipped detector no longer holds the dye's light, so the
    // event's spectrum (and its unmixed values) are wrong.
    let clipped = v >= ceiling;
    for (let d = 0; d < D && !clipped && ceiling < Infinity; d += 1) if (cols[d][e] >= ceiling) clipped = true;
    if (clipped) offScale += 1;
    else candidates.push(e);
  }
  if (offScale > 0.05 * (candidates.length + offScale)) warnings.push(`${offScale} of the ${candidates.length + offScale} positive events are off scale in at least one detector and are left out; a dimmer control (less antibody, lower gain) keeps them.`);
  candidates.sort((x, y) => peak[y] - peak[x]);
  const trimmed = candidates.slice(Math.floor(candidates.length * (options.trimFraction ?? 0.001)));
  const minEvents = options.minEvents ?? 200;
  const keep = Math.min(trimmed.length, Math.max(Math.ceil(trimmed.length * (options.positiveFraction ?? 0.5)), minEvents));
  const positive = Uint32Array.from(trimmed.slice(0, keep)).sort();
  if (!positive.length) warnings.push(`No events are clearly brighter than the negative in ${detectors[peakIndex]}; check that this is a stained control.`);
  else if (positive.length < minEvents) warnings.push(`Only ${positive.length} events are clearly positive; ${minEvents} or more give a stable spectrum.`);
  const maxNegative = options.maxNegative ?? 20000;
  let negative = negativePool.length > maxNegative ? sampleIndices(negativePool.length, maxNegative, random, negativePool) : negativePool;
  let matched = false;
  if (options.matchNegatives !== false && positive.length >= 20 && negative.length >= 4 * Math.min(minEvents, positive.length)) {
    const negCols = unstained ?? cols;
    const posMedian = new Float64Array(D);
    const negMedian = new Float64Array(D);
    const scale = new Float64Array(D);
    for (let d = 0; d < D; d += 1) {
      posMedian[d] = median(valuesAt(cols[d], positive));
      const neg = valuesAt(negCols[d], negative).sort();
      negMedian[d] = quantileSorted(neg, 0.5);
      scale[d] = Math.max((quantileSorted(neg, 0.8413) - quantileSorted(neg, 0.1587)) / 2, 1e-12);
    }
    const delta = posMedian[peakIndex] - negMedian[peakIndex];
    const dark = [];
    for (let d = 0; d < D; d += 1) if (Math.abs(posMedian[d] - negMedian[d]) < 0.02 * delta) dark.push(d);
    if (delta > 0 && dark.length >= 3) {
      const distance = new Float64Array(negative.length);
      for (let k = 0; k < negative.length; k += 1) {
        const e = negative[k];
        let sum = 0;
        for (const d of dark) {
          const z = (negCols[d][e] - posMedian[d]) / scale[d];
          sum += z * z;
        }
        distance[k] = sum;
      }
      const order = Array.from({ length: negative.length }, (_, k) => k).sort((x, y) => distance[x] - distance[y]);
      const count = Math.max(Math.min(negative.length, minEvents), Math.floor(negative.length * (options.matchFraction ?? 0.5)));
      negative = Uint32Array.from(order.slice(0, count), (k) => negative[k]).sort();
      matched = true;
    }
  }
  return {
    peakIndex,
    peakDetector: detectors[peakIndex],
    positive,
    negative,
    negativeSource,
    negativeCenter: center,
    negativeSpread: spread,
    threshold,
    matchedNegatives: matched,
    warnings,
  };
}

// --- Panel diagnostics --------------------------------------------------------------------------

function cosine(x, y) {
  let xy = 0; let xx = 0; let yy = 0;
  for (let i = 0; i < x.length; i += 1) {
    xy += x[i] * y[i];
    xx += x[i] * x[i];
    yy += y[i] * y[i];
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
}

// Cosine similarity of every pair of spectra: Cytek's "similarity index" (pairs above ≈ 0.98 are
// hard to resolve). Returns { names, n, matrix (F × F), pairs sorted by decreasing similarity }.
export function similarityMatrix(spectra) {
  const ref = referenceMatrix(spectra);
  const { F, D, matrix } = ref;
  const out = new Float64Array(F * F);
  const pairs = [];
  for (let i = 0; i < F; i += 1) {
    const a = matrix.subarray(i * D, (i + 1) * D);
    for (let j = 0; j <= i; j += 1) {
      const value = i === j ? 1 : cosine(a, matrix.subarray(j * D, (j + 1) * D));
      out[i * F + j] = value;
      out[j * F + i] = value;
      if (i !== j) pairs.push({ a: ref.names[j], b: ref.names[i], similarity: value });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return { names: ref.names, n: F, matrix: out, pairs };
}

// Panel complexity index: the 2-norm condition number of the F × D reference matrix (Cytek's
// definition), s_max / s_min from the SVD. 1 for non-overlapping spectra of equal norm; it grows
// as spectra overlap, and with it the noise that unmixing spreads between channels.
export function complexityIndex(spectra) {
  const { F, D, matrix } = referenceMatrix(spectra);
  const { s } = svd(matrix, F, D);
  const min = s[Math.min(F, D) - 1];
  return min > 0 ? s[0] / min : Infinity;
}

// --- Unmixing -----------------------------------------------------------------------------------

function applyOperator(columns, ref, operator, options, label) {
  const { F, D, matrix } = ref;
  const { cols, idx, count } = prepareEvents(columns, ref, options);
  const st = transposeFD(matrix, F, D);
  const out = Array.from({ length: F }, () => new Float32Array(count));
  const residuals = options.residuals === false ? null : new Float32Array(count);
  const r = new Float64Array(D);
  const a = new Float64Array(F);
  for (let k = 0; k < count; k += 1) {
    if ((k & 16383) === 0) checkpoint(options, k / count, label);
    const e = idx ? idx[k] : k;
    a.fill(0);
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][e];
      r[d] = v;
      if (v === 0) continue;
      const row = d * F;
      for (let f = 0; f < F; f += 1) a[f] += v * operator[row + f];
    }
    for (let f = 0; f < F; f += 1) out[f][k] = a[f];
    if (residuals) residuals[k] = relativeResidual(r, a, st, D, F);
  }
  checkpoint(options, 1, label);
  return { names: ref.names.slice(), abundances: out, residuals };
}

// Ordinary least squares: â = r Sᵀ (S Sᵀ)⁻¹, the method of Cytek SpectroFlo and most spectral
// software. The D × F operator (the pseudo-inverse of S) is computed once. OLS is unbiased and
// keeps negative populations spread symmetrically around zero, which is what gating expects.
// About 0.85 s for 200 000 events × 40 signatures × 64 detectors (0.5 s without residuals).
export function unmixOLS(columns, spectra, options = {}) {
  const ref = referenceMatrix(spectra, options.detectors);
  return applyOperator(columns, ref, linearOperator(ref), options, 'Unmixing (OLS)');
}

// Robust per-detector variance, ((p84 − p16) / 2)², of the given events.
function robustVariance(column, indices) {
  const sorted = valuesAt(column, indices).sort();
  const half = (quantileSorted(sorted, 0.8413) - quantileSorted(sorted, 0.1587)) / 2;
  return half * half;
}

// Background (signal-independent) variance per detector: from options.background (variances),
// from an unstained control (options.unstainedColumns), or else from the 10% of events with the
// lowest total signal in the data themselves.
function backgroundVariance(columns, ref, options) {
  const { D } = ref;
  let variance;
  if (options.background) {
    if (options.background.length !== D) throw new Error('The background variances must have one value per detector.');
    variance = Float64Array.from(options.background);
  } else {
    const random = createRandom(options.seed ?? 1);
    variance = new Float64Array(D);
    if (options.unstainedColumns) {
      const ucols = columnsFor(options.unstainedColumns, ref.detectors, D);
      const sample = sampleIndices(ucols[0].length, 20000, random);
      for (let d = 0; d < D; d += 1) variance[d] = robustVariance(ucols[d], sample);
    } else {
      const { cols, idx } = prepareEvents(columns, ref, options);
      const sample = sampleIndices(cols[0].length, 50000, random, idx ?? null);
      const total = new Float64Array(sample.length);
      for (let k = 0; k < sample.length; k += 1) {
        let sum = 0;
        for (let d = 0; d < D; d += 1) sum += cols[d][sample[k]];
        total[k] = sum;
      }
      const cut = quantileSorted(Float64Array.from(total).sort(), 0.1);
      const dim = [];
      for (let k = 0; k < sample.length; k += 1) if (total[k] <= cut) dim.push(sample[k]);
      const dimIdx = Uint32Array.from(dim);
      for (let d = 0; d < D; d += 1) variance[d] = robustVariance(cols[d], dimIdx);
    }
  }
  let max = 0;
  for (let d = 0; d < D; d += 1) if (Number.isFinite(variance[d])) max = Math.max(max, variance[d]);
  if (!(max > 0)) return variance.fill(1);
  for (let d = 0; d < D; d += 1) if (!(variance[d] > max * 1e-6)) variance[d] = max * 1e-6;
  return variance;
}

// Weighted least squares (Novo, Grégori & Rajwa 2013, Cytometry A 83:508,
// doi:10.1002/cyto.a.22272). Detector d is weighted by 1 / σ²_d, with
// σ²_d = background_d + gain_d · max(signal_d, 0): electronic/background noise plus photon
// (Poisson-like) noise that grows with the signal.
// - options.mode 'fixed': weights 1 / background_d for all events (options.weights overrides),
//   which down-weights noisy detectors; one precomputed operator, as fast as OLS.
// - options.mode 'iterative' (default): per event, iteratively reweighted least squares starting
//   from the fixed-weight fit; each of `iterations` (2) rounds sets signal_d to the fitted
//   signal â S and re-solves S W Sᵀ â = S W r. Bright events then rely less on the detectors
//   where their own photon noise is largest, which narrows the spread they impose on
//   co-expressed dim channels.
// options.background: per-detector background variances (default: estimated, see
// backgroundVariance); options.gain: variance per unit signal, scalar or per detector (default 1,
// i.e. data in photoelectron-like units; supply the instrument's value when known).
// Cost for 200 000 events × 40 signatures × 64 detectors (Node 22, Apple silicon): fixed 0.9 s;
// iterative ≈ 12 s per round (forming S W Sᵀ per event dominates). In tests one round already
// matched WLS with the true weights, so iterations: 1 halves the time at little cost.
export function unmixWLS(columns, spectra, options = {}) {
  const ref = referenceMatrix(spectra, options.detectors);
  const { F, D, matrix } = ref;
  const background = backgroundVariance(columns, ref, options);
  const baseWeights = options.weights ? Float64Array.from(options.weights) : Float64Array.from(background, (v) => 1 / v);
  const start = linearOperator(ref, baseWeights);
  const mode = options.mode ?? 'iterative';
  if (mode === 'fixed') {
    const result = applyOperator(columns, ref, start, options, 'Unmixing (WLS)');
    return { ...result, weights: baseWeights, background };
  }
  if (mode !== 'iterative') throw new Error(`Unknown weighted unmixing mode "${mode}".`);
  const iterations = options.iterations ?? 2;
  const gain = new Float64Array(D).fill(1);
  if (options.gain !== undefined) {
    if (typeof options.gain === 'number') gain.fill(options.gain);
    else gain.set(options.gain);
  }
  const { cols, idx, count } = prepareEvents(columns, ref, options);
  const st = transposeFD(matrix, F, D);
  // Packed lower-triangle outer products s_d s_dᵀ of each detector's column of S, so that
  // S W Sᵀ = Σ_d w_d (s_d s_dᵀ) is a sum of contiguous vectors.
  const T = (F * (F + 1)) / 2;
  const outer = new Float64Array(D * T);
  for (let d = 0; d < D; d += 1) {
    let t = 0;
    for (let i = 0; i < F; i += 1) for (let j = 0; j <= i; j += 1) outer[d * T + t++] = st[d * F + i] * st[d * F + j];
  }
  const g0 = new Float64Array(T);
  for (let d = 0; d < D; d += 1) for (let t = 0; t < T; t += 1) g0[t] += baseWeights[d] * outer[d * T + t];
  // Weight changes below this fraction are ignored (their effect on â is far below the noise).
  const weightTolerance = options.weightTolerance ?? 1e-3;
  const out = Array.from({ length: F }, () => new Float32Array(count));
  const residuals = options.residuals === false ? null : new Float32Array(count);
  const r = new Float64Array(D);
  const a = new Float64Array(F);
  const g = new Float64Array(T);
  const full = new Float64Array(F * F);
  const rhs = new Float64Array(F);
  for (let k = 0; k < count; k += 1) {
    if ((k & 4095) === 0) checkpoint(options, k / count, 'Unmixing (WLS)');
    const e = idx ? idx[k] : k;
    a.fill(0);
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][e];
      r[d] = v;
      const row = d * F;
      for (let f = 0; f < F; f += 1) a[f] += v * start[row + f];
    }
    for (let it = 0; it < iterations; it += 1) {
      g.set(g0);
      rhs.fill(0);
      for (let d = 0; d < D; d += 1) {
        const row = d * F;
        let fit = 0;
        for (let f = 0; f < F; f += 1) fit += a[f] * st[row + f];
        const w = 1 / (background[d] + gain[d] * (fit > 0 ? fit : 0));
        const dw = w - baseWeights[d];
        if (Math.abs(dw) > weightTolerance * baseWeights[d]) {
          const base = d * T;
          for (let t = 0; t < T; t += 1) g[t] += dw * outer[base + t];
        }
        const wr = w * r[d];
        for (let f = 0; f < F; f += 1) rhs[f] += wr * st[row + f];
      }
      let t = 0;
      for (let i = 0; i < F; i += 1) for (let j = 0; j <= i; j += 1) full[i * F + j] = g[t++];
      if (!choleskyInPlace(full, F)) break;
      choleskySolveInPlace(full, rhs, F);
      a.set(rhs);
    }
    for (let f = 0; f < F; f += 1) out[f][k] = a[f];
    if (residuals) residuals[k] = relativeResidual(r, a, st, D, F);
  }
  checkpoint(options, 1, 'Unmixing (WLS)');
  return { names: ref.names.slice(), abundances: out, residuals, weights: baseWeights, background };
}

function nnlsSolver(options) {
  const algorithm = options.algorithm ?? 'lawson-hanson';
  if (algorithm === 'block-pivot') return nnlsBlockPivotInPlace;
  if (algorithm === 'lawson-hanson') return nnlsGramInPlace;
  throw new Error(`Unknown NNLS algorithm "${algorithm}".`);
}

// Non-negative least squares per event: min ‖r − a S‖² subject to a ≥ 0 (optionally weighted
// with options.weights), on the precomputed Gram matrix S Sᵀ (Bro & De Jong 1997), warm-started
// from the OLS solution, whose positive entries seed the passive set. options.algorithm
// 'lawson-hanson' (default, 1974) adds one variable per step; 'block-pivot' (Kim & Park 2011)
// exchanges all infeasible variables per step. Both are exact active-set methods: the result
// satisfies the KKT conditions to options.tolerance (relative, default 1e-10). On a realistic
// 40-color, 64-detector panel (complexity index ≈ 70) both take ≈ 7 s for 200 000 events
// (Node 22, Apple silicon; ≈ 2 Lawson–Hanson iterations per event); on a badly conditioned
// panel (index ≈ 10⁵) Lawson–Hanson took 17 s and block pivoting 47 s, hence the default.
// meanIterations reports outer iterations (Lawson–Hanson) or solves (block pivoting).
// Bias: clipping at zero piles dim and negative events onto 0 and pushes the mean of dim
// populations upward, compressing negatives into an artificially tight, skewed spike; OLS keeps
// the symmetric spread around zero that reflects the true measurement uncertainty and that gates
// and statistics assume. NNLS suits abundance estimation for clearly positive signals and
// visual clean-up; check dim populations against OLS.
export function unmixNNLS(columns, spectra, options = {}) {
  const ref = referenceMatrix(spectra, options.detectors);
  const { F, D, matrix } = ref;
  const weights = options.weights ? Float64Array.from(options.weights) : null;
  linearOperator(ref, weights); // validates the panel (rank, size)
  const g = weightedGram(matrix, F, D, weights);
  const gInv = inverse(g, F);
  const stw = transposeFD(matrix, F, D);
  const st = transposeFD(matrix, F, D);
  if (weights) for (let d = 0; d < D; d += 1) for (let f = 0; f < F; f += 1) stw[d * F + f] *= weights[d];
  const { cols, idx, count } = prepareEvents(columns, ref, options);
  const out = Array.from({ length: F }, () => new Float32Array(count));
  const residuals = options.residuals === false ? null : new Float32Array(count);
  const ws = createNNLSWorkspace(F);
  const r = new Float64Array(D);
  const b = new Float64Array(F);
  const x = new Float64Array(F);
  const nnlsOptions = { tolerance: options.tolerance ?? 1e-10 };
  const solveNNLS = nnlsSolver(options);
  let iterations = 0;
  for (let k = 0; k < count; k += 1) {
    if ((k & 4095) === 0) checkpoint(options, k / count, 'Unmixing (NNLS)');
    const e = idx ? idx[k] : k;
    b.fill(0);
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][e];
      r[d] = v;
      if (v === 0) continue;
      const row = d * F;
      for (let f = 0; f < F; f += 1) b[f] += v * stw[row + f];
    }
    for (let i = 0; i < F; i += 1) {
      let sum = 0;
      const row = i * F;
      for (let j = 0; j < F; j += 1) sum += gInv[row + j] * b[j];
      x[i] = sum;
    }
    iterations += solveNNLS(g, b, F, x, ws, nnlsOptions);
    for (let f = 0; f < F; f += 1) out[f][k] = x[f];
    if (residuals) residuals[k] = relativeResidual(r, x, st, D, F);
  }
  checkpoint(options, 1, 'Unmixing (NNLS)');
  return { names: ref.names.slice(), abundances: out, residuals, meanIterations: count ? iterations / count : 0 };
}

// --- Autofluorescence -------------------------------------------------------------------------

// Spherical k-means with k-means++ seeding (Arthur & Vassilvitskii 2007) on unit-norm rows:
// clusters spectral shapes regardless of brightness. Deterministic for a given random source.
function sphericalKMeans(u, m, D, k, random, options) {
  const restarts = options.restarts ?? 3;
  const maxIterations = options.maxIterations ?? 50;
  let best = null;
  const labels = new Int32Array(m);
  const centers = new Float64Array(k * D);
  const distance = new Float64Array(m);
  const sums = new Float64Array(k * D);
  for (let restart = 0; restart < restarts; restart += 1) {
    const first = random.int(m);
    for (let d = 0; d < D; d += 1) centers[d] = u[first * D + d];
    for (let i = 0; i < m; i += 1) distance[i] = Math.max(0, 1 - dotRow(u, i, centers, 0, D));
    for (let c = 1; c < k; c += 1) {
      let total = 0;
      for (let i = 0; i < m; i += 1) total += distance[i];
      let pick = random.int(m);
      if (total > 0) {
        let target = random() * total;
        for (let i = 0; i < m; i += 1) {
          target -= distance[i];
          if (target <= 0) {
            pick = i;
            break;
          }
        }
      }
      for (let d = 0; d < D; d += 1) centers[c * D + d] = u[pick * D + d];
      for (let i = 0; i < m; i += 1) distance[i] = Math.min(distance[i], Math.max(0, 1 - dotRow(u, i, centers, c, D)));
    }
    labels.fill(-1);
    let objective = 0;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let changed = 0;
      objective = 0;
      for (let i = 0; i < m; i += 1) {
        let bestC = 0;
        let bestS = -Infinity;
        for (let c = 0; c < k; c += 1) {
          const s = dotRow(u, i, centers, c, D);
          if (s > bestS) {
            bestS = s;
            bestC = c;
          }
        }
        objective += bestS;
        if (labels[i] !== bestC) {
          labels[i] = bestC;
          changed += 1;
        }
      }
      if (!changed) break;
      sums.fill(0);
      const counts = new Int32Array(k);
      for (let i = 0; i < m; i += 1) {
        const c = labels[i];
        counts[c] += 1;
        for (let d = 0; d < D; d += 1) sums[c * D + d] += u[i * D + d];
      }
      for (let c = 0; c < k; c += 1) {
        if (!counts[c]) {
          // Empty cluster: reseed at the point worst served by its center.
          let worst = 0;
          let worstS = Infinity;
          for (let i = 0; i < m; i += 1) {
            const s = dotRow(u, i, centers, labels[i], D);
            if (s < worstS) {
              worstS = s;
              worst = i;
            }
          }
          for (let d = 0; d < D; d += 1) centers[c * D + d] = u[worst * D + d];
          continue;
        }
        let norm = 0;
        for (let d = 0; d < D; d += 1) norm += sums[c * D + d] * sums[c * D + d];
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < D; d += 1) centers[c * D + d] = sums[c * D + d] / norm;
      }
    }
    if (!best || objective > best.objective) best = { objective, labels: Int32Array.from(labels), centers: Float64Array.from(centers) };
  }
  return best;
}

function dotRow(u, i, centers, c, D) {
  let s = 0;
  const a = i * D;
  const b = c * D;
  for (let d = 0; d < D; d += 1) s += u[a + d] * centers[b + d];
  return s;
}

// Signatures as unit-norm rows of one K × D array.
function unitRows(signatures, D) {
  const unit = new Float64Array(signatures.length * D);
  signatures.forEach((s, c) => {
    let norm = 0;
    for (let d = 0; d < D; d += 1) norm += s[d] * s[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < D; d += 1) unit[c * D + d] = s[d] / norm;
  });
  return unit;
}

// Relative residual of fitting each event (unit row of u) with its best signature, as a
// non-negative multiple: sqrt(1 − cos²), or 1 when the best cosine is ≤ 0.
function signatureFit(u, m, D, unitSignatures, K, assignment = null) {
  const residual = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    let bestCos = 0;
    let bestK = 0;
    for (let k = 0; k < K; k += 1) {
      const c = dotRow(u, i, unitSignatures, k, D);
      if (c > bestCos) {
        bestCos = c;
        bestK = k;
      }
    }
    residual[i] = Math.sqrt(Math.max(0, 1 - bestCos * bestCos));
    if (assignment) assignment[i] = bestK;
  }
  return residual;
}

// Autofluorescence signatures of an unstained sample, allowing several (Roet et al. 2024,
// Cytometry A, doi:10.1002/cyto.a.24856, showed one AF signature is often inadequate). Steps:
// 1. Take a seeded sample of up to options.maxEvents (10 000) events (of options.indices).
// 2. Keep events brighter than the options.minBrightnessQuantile (0.25) quantile of spectral norm:
//    the dimmest events are mostly detector noise and cannot discriminate shapes.
// 3. Normalize each event's spectrum to unit norm and cluster the shapes with seeded spherical
//    k-means++ for k = 1, 2, … options.maxSignatures (6). Each cluster's signature is the
//    per-detector median of its events' raw values, normalized to peak 1.
// 4. Score k by the misfit energy left after fitting every event with its best signature (as a
//    non-negative multiple), minus the detector-noise energy every model leaves (estimated from
//    the dimmest 10% of events). Noise dominates the residual of most cells on a spectral
//    cytometer, so a plain relative residual barely moves even when a real second signature is
//    found. A signature is added while it removes at least options.minImprovement (10%) of the
//    remaining non-noise misfit and at least options.minSignalGain (0.5%) of the total signal
//    energy (which stops k-means from splitting one signature by noise).
//    Clusters with fewer than options.minFraction (1%) of events are discarded.
// 5. Assign every sampled event (dim ones included) to its best-fitting signature to report
//    each signature's fraction of events and median brightness (spectral norm).
// Returns { detectors, signatures: [{ name: 'AF1', spectrum, fraction, count, brightness }],
// k, misfitByK (non-noise misfit as a fraction of signal energy), residualByK (median relative
// residual), medianResidual, noiseFraction, eventsUsed }, signatures by decreasing fraction.
// The choice among signatures for each event (unmixWithAutofluorescence, below) is the per-cell
// autofluorescence matching of AutoSpectral (Burton OT et al., bioRxiv 2025,
// doi:10.1101/2025.10.27.684855).
export function extractAutofluorescence(unstainedColumns, detectors, options = {}) {
  const D = detectors?.length ?? unstainedColumns.length;
  const cols = columnsFor(unstainedColumns, detectors, D);
  const random = createRandom(options.seed ?? 1);
  const sample = sampleIndices(cols[0].length, options.maxEvents ?? 10000, random, options.indices ?? null);
  const norms = new Float64Array(sample.length);
  for (let k = 0; k < sample.length; k += 1) {
    let sum = 0;
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][sample[k]];
      sum += v * v;
    }
    norms[k] = Number.isFinite(sum) ? Math.sqrt(sum) : 0;
  }
  const cut = quantileSorted(Float64Array.from(norms).sort(), options.minBrightnessQuantile ?? 0.25);
  const kept = [];
  for (let k = 0; k < sample.length; k += 1) if (norms[k] > 0 && norms[k] >= cut) kept.push(k);
  const m = kept.length;
  if (m < 20) throw new Error('Too few events in the unstained sample to estimate autofluorescence (at least 20 are needed).');
  const raw = new Float64Array(m * D);
  const u = new Float64Array(m * D);
  kept.forEach((k, i) => {
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][sample[k]];
      raw[i * D + d] = v;
      u[i * D + d] = v / norms[k];
    }
  });
  // Detector noise energy per event: robust per-detector variance of the dimmest 10% of events.
  const dimCut = quantileSorted(Float64Array.from(norms).sort(), 0.1);
  const dim = [];
  for (let k = 0; k < sample.length; k += 1) if (norms[k] <= dimCut) dim.push(sample[k]);
  let noise = 0;
  if (dim.length >= 10) {
    const dimIdx = Uint32Array.from(dim);
    for (let d = 0; d < D; d += 1) noise += robustVariance(cols[d], dimIdx);
  }
  let signalEnergy = 0;
  for (const k of kept) signalEnergy += norms[k] * norms[k];
  signalEnergy /= m;
  const keptNorm2 = Float64Array.from(kept, (k) => norms[k] * norms[k]);
  const maxK = Math.max(1, Math.min(options.maxSignatures ?? 6, Math.floor(m / 20)));
  const minImprovement = options.minImprovement ?? 0.1;
  const minSignalGain = options.minSignalGain ?? 0.005;
  const minCount = Math.max(5, Math.ceil((options.minFraction ?? 0.01) * m));
  const fits = [];
  const residualByK = [];
  const misfitByK = [];
  const fitK = (k) => {
    const clusters = sphericalKMeans(u, m, D, k, random, options);
    const signatures = [];
    for (let c = 0; c < k; c += 1) {
      const members = [];
      for (let i = 0; i < m; i += 1) if (clusters.labels[i] === c) members.push(i);
      if (members.length < minCount) continue;
      const spectrum = new Float64Array(D);
      const column = new Float64Array(members.length);
      for (let d = 0; d < D; d += 1) {
        members.forEach((i, j) => { column[j] = raw[i * D + d]; });
        spectrum[d] = median(column);
      }
      let peak = 0;
      for (let d = 0; d < D; d += 1) peak = Math.max(peak, spectrum[d]);
      if (!(peak > 0)) continue;
      for (let d = 0; d < D; d += 1) spectrum[d] /= peak;
      signatures.push(spectrum);
    }
    const K = signatures.length;
    const residual = K ? signatureFit(u, m, D, unitRows(signatures, D), K) : new Float64Array(m).fill(1);
    let energy = 0;
    for (let i = 0; i < m; i += 1) energy += keptNorm2[i] * residual[i] * residual[i];
    energy /= m;
    return { signatures, energy, misfit: Math.max(0, energy - noise), medianResidual: quantileSorted(residual.sort(), 0.5) };
  };
  let chosen = 0;
  for (let k = 1; k <= maxK; k += 1) {
    checkpoint(options, (k - 1) / maxK, `Autofluorescence: ${k} signature${k > 1 ? 's' : ''}`);
    fits.push(fitK(k));
    residualByK.push(fits[k - 1].medianResidual);
    misfitByK.push(signalEnergy > 0 ? fits[k - 1].misfit / signalEnergy : 0);
    if (k > 1) {
      const previous = fits[k - 2];
      const current = fits[k - 1];
      const gain = previous.misfit > 0 ? (previous.misfit - current.misfit) / previous.misfit : 0;
      const signalGain = signalEnergy > 0 ? (previous.energy - current.energy) / signalEnergy : 0;
      if (gain < minImprovement || signalGain < minSignalGain) {
        chosen = k - 2;
        break;
      }
    }
    chosen = k - 1;
  }
  const fit = fits[chosen];
  const K = fit.signatures.length;
  // Fractions count every sampled event (not only the bright ones used for clustering, which
  // would over-represent the brighter AF types), each assigned to its best-fitting signature.
  const all = [];
  for (let k = 0; k < sample.length; k += 1) if (norms[k] > 0) all.push(k);
  const uAll = new Float64Array(all.length * D);
  all.forEach((k, i) => {
    for (let d = 0; d < D; d += 1) uAll[i * D + d] = cols[d][sample[k]] / norms[k];
  });
  const assignment = new Int32Array(all.length);
  signatureFit(uAll, all.length, D, unitRows(fit.signatures, D), K, assignment);
  const counts = new Int32Array(K);
  const brightnessBy = Array.from({ length: K }, () => []);
  all.forEach((k, i) => {
    counts[assignment[i]] += 1;
    brightnessBy[assignment[i]].push(norms[k]);
  });
  const signatures = fit.signatures
    .map((spectrum, c) => ({ spectrum, count: counts[c], fraction: counts[c] / all.length, brightness: median(Float64Array.from(brightnessBy[c])) }))
    .sort((x, y) => y.count - x.count)
    .map((entry, c) => ({ name: `AF${c + 1}`, ...entry }));
  checkpoint(options, 1, 'Autofluorescence');
  return {
    detectors: detectors ? Array.from(detectors) : null,
    signatures,
    k: signatures.length,
    misfitByK,
    residualByK,
    medianResidual: fit.medianResidual,
    noiseFraction: signalEnergy > 0 ? noise / signalEnergy : 0,
    eventsUsed: m,
  };
}

// Unmixing with per-event autofluorescence selection, the per-cell autofluorescence matching of
// AutoSpectral (Burton OT et al., bioRxiv 2025, doi:10.1101/2025.10.27.684855): every event is
// unmixed with the fluorochromes plus each AF signature in turn, and the signature that leaves
// the smallest residual is kept. Its abundance becomes an extra channel "AF".
// Rather than K separate fits, the extended fit uses the Schur complement: with the
// fluorochrome-only fit â₀ and its residual e₀, signature j enters with α_j = (af_j W e₀) / δ_j,
// δ_j = af_j W af_jᵀ − g_jᵀ (S W Sᵀ)⁻¹ g_j, g_j = S W af_jᵀ, and reduces the weighted squared
// residual by (af_j W e₀)² / δ_j; the fluorochromes become â₀ − α_j (S W Sᵀ)⁻¹ g_j. This equals
// the full least-squares fit with [S; af_j] at a fraction of the cost.
// options.weights (or options.background variances) give fixed-weight WLS; options.method
// 'nnls' refits the chosen model with non-negativity; options.nonNegativeAF only lets signatures
// with α ≥ 0 compete. Returns abundances (F + 1 columns, the last "AF"), afIndex (Int32Array,
// the chosen signature per event), af (the AF column) and residuals.
export function unmixWithAutofluorescence(columns, spectra, afSignatures, options = {}) {
  const ref = referenceMatrix(spectra, options.detectors);
  const { F, D, matrix } = ref;
  const af = signatureList(afSignatures, D);
  const K = af.length;
  let weights = options.weights ? Float64Array.from(options.weights) : null;
  if (!weights && options.background) weights = Float64Array.from(backgroundVariance(columns, ref, options), (v) => 1 / v);
  const operator = linearOperator(ref, weights);
  const g = weightedGram(matrix, F, D, weights);
  const gInv = inverse(g, F);
  const st = transposeFD(matrix, F, D);
  const weightedAF = af.map((sig) => Float64Array.from(sig, (v, d) => v * (weights ? weights[d] : 1)));
  const h = [];
  const delta = new Float64Array(K);
  for (let j = 0; j < K; j += 1) {
    const gj = new Float64Array(F);
    for (let f = 0; f < F; f += 1) {
      let sum = 0;
      for (let d = 0; d < D; d += 1) sum += matrix[f * D + d] * weightedAF[j][d];
      gj[f] = sum;
    }
    const hj = new Float64Array(F);
    for (let i = 0; i < F; i += 1) {
      let sum = 0;
      for (let k = 0; k < F; k += 1) sum += gInv[i * F + k] * gj[k];
      hj[i] = sum;
    }
    let c = 0;
    for (let d = 0; d < D; d += 1) c += af[j][d] * weightedAF[j][d];
    let gh = 0;
    for (let f = 0; f < F; f += 1) gh += gj[f] * hj[f];
    delta[j] = c - gh;
    if (!(delta[j] > 1e-10 * c)) throw new Error(`Autofluorescence signature ${j + 1} is indistinguishable from a combination of the fluorochrome spectra, so it cannot be unmixed alongside them.`);
    h.push(hj);
  }
  const useNNLS = (options.method ?? 'ols') === 'nnls';
  let nnls = null;
  if (useNNLS) {
    const F1 = F + 1;
    const grams = af.map((sig, j) => {
      const ext = new Float64Array(F1 * F1);
      for (let i = 0; i < F; i += 1) for (let k = 0; k < F; k += 1) ext[i * F1 + k] = g[i * F + k];
      let gj = 0;
      for (let f = 0; f < F; f += 1) {
        let sum = 0;
        for (let d = 0; d < D; d += 1) sum += matrix[f * D + d] * weightedAF[j][d];
        ext[f * F1 + F] = sum;
        ext[F * F1 + f] = sum;
      }
      for (let d = 0; d < D; d += 1) gj += sig[d] * weightedAF[j][d];
      ext[F * F1 + F] = gj;
      return ext;
    });
    nnls = { grams, ws: createNNLSWorkspace(F1), b: new Float64Array(F1), x: new Float64Array(F1) };
  }
  const solveNNLS = nnlsSolver(options);
  const nonNegativeAF = options.nonNegativeAF === true;
  const { cols, idx, count } = prepareEvents(columns, ref, options);
  const out = Array.from({ length: F + 1 }, () => new Float32Array(count));
  const afIndex = new Int32Array(count);
  const residuals = options.residuals === false ? null : new Float32Array(count);
  const r = new Float64Array(D);
  const a = new Float64Array(F);
  const e0 = new Float64Array(D);
  const full = new Float64Array(F + 1);
  // [S; af_j] transposed (D × (F + 1)) per signature, for the residual of the chosen model.
  const extended = af.map((sig) => {
    const ext = new Float64Array(D * (F + 1));
    for (let d = 0; d < D; d += 1) {
      for (let f = 0; f < F; f += 1) ext[d * (F + 1) + f] = st[d * F + f];
      ext[d * (F + 1) + F] = sig[d];
    }
    return ext;
  });
  for (let k = 0; k < count; k += 1) {
    if ((k & 8191) === 0) checkpoint(options, k / count, 'Unmixing with autofluorescence');
    const e = idx ? idx[k] : k;
    a.fill(0);
    for (let d = 0; d < D; d += 1) {
      const v = cols[d][e];
      r[d] = v;
      if (v === 0) continue;
      const row = d * F;
      for (let f = 0; f < F; f += 1) a[f] += v * operator[row + f];
    }
    for (let d = 0; d < D; d += 1) {
      let fit = 0;
      const row = d * F;
      for (let f = 0; f < F; f += 1) fit += a[f] * st[row + f];
      e0[d] = r[d] - fit;
    }
    let best = 0;
    let bestGain = -Infinity;
    let bestAlpha = 0;
    for (let j = 0; j < K; j += 1) {
      const waf = weightedAF[j];
      let gamma = 0;
      for (let d = 0; d < D; d += 1) gamma += waf[d] * e0[d];
      let alpha = gamma / delta[j];
      let gainJ = gamma * alpha;
      if (nonNegativeAF && alpha < 0) {
        alpha = 0;
        gainJ = 0;
      }
      if (gainJ > bestGain) {
        bestGain = gainJ;
        best = j;
        bestAlpha = alpha;
      }
    }
    for (let f = 0; f < F; f += 1) full[f] = a[f] - bestAlpha * h[best][f];
    full[F] = bestAlpha;
    if (nnls) {
      const { b, x, ws, grams } = nnls;
      const waf = weightedAF[best];
      b.fill(0);
      for (let d = 0; d < D; d += 1) {
        const wr = r[d] * (weights ? weights[d] : 1);
        for (let f = 0; f < F; f += 1) b[f] += wr * st[d * F + f];
        b[F] += r[d] * waf[d];
      }
      x.set(full);
      solveNNLS(grams[best], b, F + 1, x, ws, { tolerance: options.tolerance ?? 1e-10 });
      full.set(x);
    }
    for (let f = 0; f <= F; f += 1) out[f][k] = full[f];
    afIndex[k] = best;
    if (residuals) residuals[k] = relativeResidual(r, full, extended[best], D, F + 1);
  }
  checkpoint(options, 1, 'Unmixing with autofluorescence');
  return { names: [...ref.names, 'AF'], abundances: out, af: out[F], afIndex, residuals, afSignatures: af };
}

// --- Diagnostics --------------------------------------------------------------------------------

// Spillover spreading matrix of unmixed data (Nguyen, Perfetto, Mahnke, Chattopadhyay & Roederer
// 2013, Cytometry A 83:306, doi:10.1002/cyto.a.22251), the spectral analog of the
// compensation SSM: SS_ij = sqrt(σ²_pos,j − σ²_neg,j) / sqrt(ΔF_i), σ the robust SD
// (84.13th − 50th percentile, as in compensation.js). Rows: the stained fluorochrome of each
// unmixed single-stain control; columns: the unmixed channel receiving the spread.
// controls: [{ fluorochrome: name | index, abundances: Float32Array[] (or an unmixing result),
//   positive?, negative? (indices; found with splitControl when absent),
//   negativeAbundances? (an unmixed unstained control used as the negative) }].
export function spectralSpreading(controls, names, options = {}) {
  const F = names.length;
  const matrix = new Float64Array(F * F).fill(Number.NaN);
  const report = [];
  const observations = [];
  for (const control of controls) {
    const i = typeof control.fluorochrome === 'number' ? control.fluorochrome : names.indexOf(control.fluorochrome);
    if (i < 0 || i >= F) throw new Error(`Control "${control.fluorochrome}" is not among the unmixed channels.`);
    const abundances = control.abundances?.abundances ?? control.abundances;
    const primary = abundances[i];
    const negAbundances = control.negativeAbundances?.abundances ?? control.negativeAbundances ?? null;
    let { positive, negative } = control;
    if (!positive || (!negative && !negAbundances)) {
      const split = splitControl(primary, options);
      positive = positive ?? split.positive;
      if (!negAbundances) negative = negative ?? split.negative;
    }
    const negSource = negAbundances ?? abundances;
    const negIdx = negative ?? null;
    const deltaF = median(valuesAt(primary, positive)) - median(valuesAt(negSource[i], negIdx));
    const entry = { fluorochrome: names[i], positiveEvents: positive.length, deltaF, warnings: [] };
    report.push(entry);
    if (!(deltaF > 0)) {
      entry.warnings.push('The positive population is not brighter than the negative.');
      continue;
    }
    const rows = [];
    const negCount = negIdx ? negIdx.length : negSource[i].length;
    for (let j = 0; j < F; j += 1) {
      if (j === i) {
        matrix[i * F + j] = 0;
        continue;
      }
      const sPos = robustSD(valuesAt(abundances[j], positive));
      const sNeg = robustSD(valuesAt(negSource[j], negIdx));
      const spread = sPos * sPos - sNeg * sNeg;
      matrix[i * F + j] = spread > 0 ? Math.sqrt(spread) / Math.sqrt(deltaF) : 0;
      rows.push({ j, variance: spread, se: robustVarianceSE(sPos, positive.length, sNeg, negCount) });
    }
    observations.push({ i, deltaF, positiveEvents: positive.length, rows });
  }
  return { names: Array.from(names), matrix, n: F, report, observations };
}

// Per-detector residuals of an unmixing over a population. A correct, complete reference set
// leaves residuals that scatter around zero in every detector; a systematic median residual
// with a spectral shape points to a wrong or missing reference (or unmodeled autofluorescence).
// abundances: an unmixing result (or its abundances array) for the events in options.indices
// (or all events); with an AF result, its afIndex and afSignatures are used to rebuild the fit.
// Returns per-detector medianResidual, residualRSD, relativeResidual (median residual / median
// ‖r‖), the worst detectors, medianRelativeResidual, and a heat strip: events in `bins` (24)
// equal-count bins of signal norm (or of options.binBy, a per-event column), each bin's median
// residual per detector divided by its median ‖r‖ (bins × D, row-major).
export function unmixingResidualReport(columns, spectra, abundances, options = {}) {
  const ref = referenceMatrix(spectra, options.detectors);
  const { F, D, matrix } = ref;
  const cols = columnsFor(columns, ref.detectors, D);
  const n = cols[0].length;
  const list = abundances?.abundances ?? abundances;
  const afIndex = abundances?.afIndex ?? options.afIndex ?? null;
  const afSigs = afIndex ? signatureList(abundances.afSignatures ?? options.afSignatures, D) : null;
  if (list.length !== F + (afIndex ? 1 : 0)) throw new Error('The abundances do not match the reference spectra.');
  const indices = options.indices ?? null;
  const length = list[0].length;
  const byEvent = length === n && (!indices || indices.length !== n);
  if (!byEvent && indices && length !== indices.length) throw new Error('The abundances do not match the events of the population.');
  const total = indices ? indices.length : n;
  const random = createRandom(options.seed ?? 1);
  const positions = sampleIndices(total, options.maxEvents ?? 20000, random);
  const m = positions.length;
  const residual = new Float32Array(m * D);
  const signal = new Float64Array(m);
  const relative = new Float64Array(m);
  const key = new Float64Array(m);
  for (let q = 0; q < m; q += 1) {
    const p = positions[q];
    const e = indices ? indices[p] : p;
    const slot = byEvent ? e : p;
    let res2 = 0;
    let sig2 = 0;
    for (let d = 0; d < D; d += 1) {
      let fit = 0;
      for (let f = 0; f < F; f += 1) fit += list[f][slot] * matrix[f * D + d];
      if (afIndex) fit += list[F][slot] * afSigs[afIndex[slot]][d];
      const v = cols[d][e];
      const res = v - fit;
      residual[q * D + d] = res;
      res2 += res * res;
      sig2 += v * v;
    }
    signal[q] = Math.sqrt(sig2);
    relative[q] = sig2 > 0 ? Math.sqrt(res2 / sig2) : 0;
    key[q] = options.binBy ? options.binBy[e] : signal[q];
  }
  const medianSignal = median(signal);
  const medianResidual = new Float64Array(D);
  const residualRSD = new Float64Array(D);
  const relativeResidual = new Float64Array(D);
  const column = new Float64Array(m);
  for (let d = 0; d < D; d += 1) {
    for (let q = 0; q < m; q += 1) column[q] = residual[q * D + d];
    medianResidual[d] = median(column);
    residualRSD[d] = robustSD(column);
    relativeResidual[d] = medianSignal > 0 ? medianResidual[d] / medianSignal : 0;
  }
  const detectorNames = ref.detectors ?? Array.from({ length: D }, (_, d) => `D${d + 1}`);
  const worst = Array.from({ length: D }, (_, d) => ({ detector: detectorNames[d], relativeResidual: relativeResidual[d] }))
    .sort((x, y) => Math.abs(y.relativeResidual) - Math.abs(x.relativeResidual))
    .slice(0, 5);
  const bins = Math.max(1, Math.min(options.bins ?? 24, m));
  const order = Array.from({ length: m }, (_, q) => q).sort((x, y) => key[x] - key[y]);
  const strip = new Float64Array(bins * D);
  const counts = new Int32Array(bins);
  const edges = new Float64Array(bins + 1);
  for (let b = 0; b < bins; b += 1) {
    const lo = Math.floor((b * m) / bins);
    const hi = Math.floor(((b + 1) * m) / bins);
    counts[b] = hi - lo;
    edges[b] = key[order[lo]];
    if (b === bins - 1) edges[bins] = key[order[hi - 1]];
    const part = new Float64Array(hi - lo);
    for (let i = lo; i < hi; i += 1) part[i - lo] = signal[order[i]];
    const scale = median(part) || 1;
    for (let d = 0; d < D; d += 1) {
      for (let i = lo; i < hi; i += 1) part[i - lo] = residual[order[i] * D + d];
      strip[b * D + d] = median(part) / scale;
    }
  }
  return {
    detectors: detectorNames,
    names: afIndex ? [...ref.names, 'AF'] : ref.names.slice(),
    events: m,
    medianResidual,
    residualRSD,
    relativeResidual,
    medianRelativeResidual: median(relative),
    worst,
    strip: { bins, binBy: options.binBy ? 'custom' : 'signal', edges, counts, matrix: strip },
  };
}

// Per-detector background variances (see backgroundVariance): from options.background, an
// unstained control (options.unstainedColumns), or the dimmest 10% of events by total signal.
export function estimateBackground(columns, spectra, options = {}) {
  return backgroundVariance(columns, referenceMatrix(spectra, options.detectors), options);
}

// Runs one unmixing model, as compareUnmixing does for each of its models:
// model = { method: 'ols' | 'wls' | 'wls-fixed' | 'nnls', spectra, afSignatures?, options? }.
// With afSignatures, each event chooses its autofluorescence signature
// (unmixWithAutofluorescence); weighted methods then use fixed background weights, since the
// per-event AF choice is made by weighted least squares with one weight set.
export function unmixModel(columns, model, options = {}) {
  return runModel(model, columns, options);
}

function runModel(model, columns, extra) {
  const method = (model.method ?? 'ols').toLowerCase();
  const options = { ...(model.options ?? {}), ...extra };
  if (model.afSignatures) {
    const weighted = method === 'wls' || method === 'wls-fixed';
    if (weighted && !options.weights && !options.background) {
      const ref = referenceMatrix(model.spectra, options.detectors);
      options.weights = Float64Array.from(backgroundVariance(columns, ref, options), (v) => 1 / v);
    }
    return unmixWithAutofluorescence(columns, model.spectra, model.afSignatures, { ...options, method: method === 'nnls' ? 'nnls' : 'ols' });
  }
  if (method === 'ols') return unmixOLS(columns, model.spectra, options);
  if (method === 'wls') return unmixWLS(columns, model.spectra, options);
  if (method === 'wls-fixed') return unmixWLS(columns, model.spectra, { ...options, mode: 'fixed' });
  if (method === 'nnls') return unmixNNLS(columns, model.spectra, options);
  throw new Error(`Unknown unmixing method "${model.method}".`);
}

function contains(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// "Counterfactual unmixing": runs several unmixing models on the same events and reports, per
// fluorochrome, the spread of the negative population and, per model, the residual, so the user
// can see which model resolves the panel best.
// models: [{ name, method: 'ols' | 'wls' | 'wls-fixed' | 'nnls', spectra, afSignatures?, options? }]
// Negatives: options.negatives ({ [fluorochrome]: sorted event indices }), else an unstained
// control (options.unstainedColumns; every event is negative for every fluorochrome), else, per
// fluorochrome, the options.negativeFraction (0.5) of events with the lowest raw signal on its
// peak detector — chosen from raw data, so every model is judged on the same events (the
// selection slightly narrows all spreads alike).
// Spread is the robust SD (84.13th − 50th percentile); zeroFraction exposes NNLS's pile-up at 0,
// which narrows its spread without improving resolution (such models are marked `clipped` in the
// ranking). A wrong reference shows as a shifted negativeMedian and a higher brightResidual (the
// median relative residual of the brighter half of events; dim events' residuals are mostly
// noise). Up to options.maxEvents (20 000) events are used. Returns { events, negativeSource,
// models: [{ name, method, timeMs, medianResidual, brightResidual, fluorochromes: [{ name,
// negativeMedian, negativeRSD, zeroFraction, count }] }], best: { [fluorochrome]: model name },
// ranking: [{ name, relativeSpread, medianResidual, brightResidual, clipped }] } where
// relativeSpread is the geometric mean over shared fluorochromes of rSD / first model's rSD.
export function compareUnmixing(columns, models, options = {}) {
  if (!models || !models.length) throw new Error('No unmixing models were given to compare.');
  const refs = models.map((model) => referenceMatrix(model.spectra, model.options?.detectors ?? options.detectors));
  const first = refs[0];
  const cols = columnsFor(columns, first.detectors, first.D);
  const n = cols[0].length;
  const random = createRandom(options.seed ?? 1);
  const maxEvents = options.maxEvents ?? 20000;
  const idx = sampleIndices(n, maxEvents, random, options.indices ?? null);
  const count = idx.length;
  let negativeSource = 'peak-detector';
  let uIdx = null;
  const negativePositions = new Map();
  if (options.negatives) {
    negativeSource = 'given';
    for (const [name, list] of Object.entries(options.negatives)) {
      const sorted = Uint32Array.from(list).sort();
      const positions = [];
      for (let k = 0; k < count; k += 1) if (contains(sorted, idx[k])) positions.push(k);
      negativePositions.set(name, Uint32Array.from(positions));
    }
  } else if (options.unstainedColumns) {
    negativeSource = 'unstained';
    const ucols = columnsFor(options.unstainedColumns, first.detectors, first.D);
    uIdx = sampleIndices(ucols[0].length, maxEvents, random, options.unstainedIndices ?? null);
  } else {
    const fraction = options.negativeFraction ?? 0.5;
    for (const ref of refs) {
      for (let f = 0; f < ref.F; f += 1) {
        const name = ref.names[f];
        if (negativePositions.has(name)) continue;
        let peak = 0;
        for (let d = 1; d < ref.D; d += 1) if (ref.matrix[f * ref.D + d] > ref.matrix[f * ref.D + peak]) peak = d;
        const column = columnsFor(columns, ref.detectors, ref.D)[peak];
        const values = new Float64Array(count);
        for (let k = 0; k < count; k += 1) values[k] = column[idx[k]];
        const cut = quantileSorted(Float64Array.from(values).sort(), fraction);
        const positions = [];
        for (let k = 0; k < count; k += 1) if (values[k] <= cut) positions.push(k);
        negativePositions.set(name, Uint32Array.from(positions));
      }
    }
  }
  // Residuals of dim events are mostly noise (relative residual ≈ 1 under any model), so misfit is
  // also summarized over the brighter half of events by raw signal norm.
  const signalNorm = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    let sum = 0;
    for (let d = 0; d < first.D; d += 1) sum += cols[d][idx[k]] ** 2;
    signalNorm[k] = Math.sqrt(sum);
  }
  const brightCut = quantileSorted(Float64Array.from(signalNorm).sort(), 0.5);
  const results = [];
  models.forEach((model, mIndex) => {
    const progress = (fraction, message) => checkpoint(options, (mIndex + fraction) / models.length, `${model.name ?? `Model ${mIndex + 1}`}: ${message}`);
    const started = now();
    const result = runModel(model, columns, { indices: idx, residuals: true, onProgress: progress, signal: options.signal, seed: options.seed });
    const timeMs = now() - started;
    const spreadResult = uIdx ? runModel(model, options.unstainedColumns, { indices: uIdx, residuals: false, signal: options.signal, seed: options.seed }) : result;
    const fluorochromes = [];
    result.names.forEach((name, f) => {
      if (name === 'AF') return;
      const values = uIdx ? valuesAt(spreadResult.abundances[f], null) : valuesAt(result.abundances[f], negativePositions.get(name) ?? null);
      let zeros = 0;
      for (let i = 0; i < values.length; i += 1) if (values[i] === 0) zeros += 1;
      fluorochromes.push({ name, negativeMedian: median(values), negativeRSD: robustSD(values), zeroFraction: values.length ? zeros / values.length : 0, count: values.length });
    });
    const bright = [];
    for (let k = 0; k < count; k += 1) if (signalNorm[k] >= brightCut) bright.push(result.residuals[k]);
    results.push({
      name: model.name ?? `Model ${mIndex + 1}`,
      method: model.method ?? 'ols',
      autofluorescence: Boolean(model.afSignatures) || result.names.includes('AF'),
      timeMs,
      medianResidual: median(valuesAt(result.residuals, null)),
      brightResidual: median(Float64Array.from(bright)),
      fluorochromes,
    });
  });
  const best = {};
  const shared = results[0].fluorochromes.map((entry) => entry.name).filter((name) => results.every((r) => r.fluorochromes.some((x) => x.name === name)));
  for (const name of shared) {
    let winner = null;
    let lowest = Infinity;
    for (const r of results) {
      const spread = r.fluorochromes.find((x) => x.name === name).negativeRSD;
      if (spread < lowest) {
        lowest = spread;
        winner = r.name;
      }
    }
    best[name] = winner;
  }
  const ranking = results.map((r) => {
    let sum = 0;
    let used = 0;
    for (const name of shared) {
      const base = results[0].fluorochromes.find((x) => x.name === name).negativeRSD;
      const mine = r.fluorochromes.find((x) => x.name === name).negativeRSD;
      if (base > 0 && mine > 0) {
        sum += Math.log(mine / base);
        used += 1;
      }
    }
    const clipped = r.fluorochromes.some((x) => x.zeroFraction > 0.05);
    return { name: r.name, relativeSpread: used ? Math.exp(sum / used) : Number.NaN, medianResidual: r.medianResidual, brightResidual: r.brightResidual, clipped };
  }).sort((x, y) => x.relativeSpread - y.relativeSpread);
  return { events: count, negativeSource, models: results, best, ranking };
}

// --- Detector names -----------------------------------------------------------------------------

export const LASER_ORDER = ['UV', 'V', 'B', 'YG', 'R', 'IR'];

function laserFromWavelength(nm) {
  if (nm < 380) return 'UV';
  if (nm < 440) return 'V';
  if (nm < 520) return 'B';
  if (nm < 600) return 'YG';
  if (nm < 700) return 'R';
  return 'IR';
}

// Parses a raw spectral detector name into { laser, index, measurement, wavelength? }, or null for
// scatter, time and conventional channels. Recognized forms:
// - Cytek Aurora / Northern Lights: 'UV1-A', 'V7-A', 'B14-H', 'YG3-W', 'R8-A' (suffix optional);
// - BD FACSDiscover and FACSymphony spectral: 'UV1 (375)-A', 'B12 (725)-A' (the detector's center
//   wavelength in parentheses, kept as `emission`);
// - a detector code in parentheses after a dye or filter label: 'BV421 (V1)', 'PE (YG1)-A';
// - laser wavelength and channel number: '405-3-A', '488nm-12', '561_4' (laser from wavelength).
export function parseDetectorName(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim();
  const measurementOf = (m) => (m ? m.toUpperCase() : null);
  let match = /^(UV|V|B|YG|R|IR)(\d{1,2})(?:-([AHW]))?$/i.exec(text);
  if (match) return { laser: match[1].toUpperCase(), index: Number(match[2]), measurement: measurementOf(match[3]) };
  match = /^(UV|V|B|YG|R|IR)(\d{1,2})\s*\((\d{3})\)(?:-([AHW]))?$/i.exec(text);
  if (match) return { laser: match[1].toUpperCase(), index: Number(match[2]), measurement: measurementOf(match[4]), emission: Number(match[3]) };
  match = /\((UV|V|B|YG|R|IR)(\d{1,2})\)/i.exec(text);
  if (match) {
    const suffix = /-([AHW])\s*$/i.exec(text) ?? /-([AHW])\s*\(/i.exec(text);
    return { laser: match[1].toUpperCase(), index: Number(match[2]), measurement: measurementOf(suffix?.[1]) };
  }
  match = /^(\d{3})\s*(?:nm)?\s*[-_ ]\s*(\d{1,2})(?:-([AHW]))?$/i.exec(text);
  if (match) {
    const wavelength = Number(match[1]);
    if (wavelength >= 300 && wavelength <= 900) return { laser: laserFromWavelength(wavelength), index: Number(match[2]), measurement: measurementOf(match[3]), wavelength };
  }
  return null;
}

export function isSpectralDetector(name) {
  return parseDetectorName(name) !== null;
}

// Sorts detector names by laser excitation order (UV, V, B, YG, R, IR), then detector number,
// then measurement (A, H, W). Names that are not spectral detectors follow, in their original
// order. Returns a new array.
export function detectorOrder(names) {
  const measurementRank = { A: 0, H: 1, W: 2 };
  const parsed = names.map((name, i) => ({ name, i, info: parseDetectorName(name) }));
  return parsed
    .sort((x, y) => {
      if (!x.info || !y.info) return (x.info ? 0 : 1) - (y.info ? 0 : 1) || x.i - y.i;
      return LASER_ORDER.indexOf(x.info.laser) - LASER_ORDER.indexOf(y.info.laser)
        || (x.info.wavelength ?? 0) - (y.info.wavelength ?? 0)
        || x.info.index - y.info.index
        || (measurementRank[x.info.measurement] ?? -1) - (measurementRank[y.info.measurement] ?? -1)
        || x.i - y.i;
    })
    .map((entry) => entry.name);
}
