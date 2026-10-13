// The unmixing doctor (S8): names the likely cause of a poor unmixing and proposes its fix.
//
// A sample is unmixed with the current model (reference spectra, autofluorescence signatures) and
// its events are examined for the marks each fault leaves:
//
// - Light no signature explains (a dye without a reference, autofluorescence the model lacks):
//   each event's residual is compared with the noise expected for it (background plus photon
//   noise that grows with the signal, both estimated from the sample), and residual directions
//   are sought along which far more events lie above +5 noise SDs than below −5 (noise is
//   symmetric; missing light is not). The signature's full spectrum is then estimated from the
//   events that carry it with every abundance non-negative (the residual alone gives only its part
//   outside the model's span), and named from the library or the unstained control's signatures.
//   Light whose amount follows one dye's abundance is that dye's reference missing part of its
//   spectrum (next check); light that grows with each event's autofluorescence is autofluorescence.
// - A reference whose spectrum differs from the dye in the sample (a wrong or mislabeled control,
//   a bead control whose dye emits differently on cells): over events where the dye is bright, the
//   median residual per unit of its abundance, after the other dyes' departures are taken out, is
//   the part of the sample's spectrum the reference misses. Medians of ratios over bright events
//   are used rather than a regression of residuals on abundances, which photon noise biases (an
//   event's abundance and residual share its noise). The strongest departure is corrected before
//   the next is sought, so a dye co-expressed with a mismatched one is not blamed. Library spectra
//   of the dye tell a wrong control (one on the same carrier fits the sample) from a dye that
//   emits differently on beads (bead spectra all misfit, or one on cells fits).
// - A tandem whose acceptor degraded in the sample but not in its control (or the reverse): its
//   lost emission comes out as its donor's, which the model already holds, so it leaves no
//   residual and shows instead as the donor's negative population rising in proportion to the
//   tandem's brightness. The half-sample mode of the donor's abundance is tracked across bins of
//   the tandem's (modes follow the donor-negative cells, which most cells are).
// - Autofluorescence the unstained control does not represent: the sample's autofluorescence-
//   dominated cells fitted worse than the unstained control's own (fixation, another tissue),
//   cells of the sample's scatter absent from the unstained control, autofluorescence-like light
//   left unexplained, or dyes whose spectra resemble autofluorescence rising with it. Signatures
//   extracted from the sample's own autofluorescence-dominated cells are tried as the fix.
//
// Controls are checked without a sample too: a cell control whose dimmer positives carry
// relatively more autofluorescence than its brighter ones (myeloid and granulocyte markers on
// autofluorescent cells: the CD11b and Siglec F cell controls of the AutoSpectral example data,
// Burton, Dooley and Liston, Mendeley Data, doi:10.17632/ch5dnspd79.1), and a
// control that differs from the library's spectrum of its dye (a degraded tandem when the
// difference has the donor's shape, the other carrier when the library's entry is on beads or
// cells).
//
// Every proposed fix that changes the model is tried on the same events, and its effect (on the
// residual, the unexplained events, the leak or the mismatch) is reported, so a cause is named
// with the evidence that fixing it helps.

import { median } from './compensation.js';
import { inverse, createNNLSWorkspace, nnlsGramInPlace } from './linalg.js';
import { createRandom, sampleIndices } from './random.js';
import { extractAutofluorescence, referenceMatrix, unmixingOperator, unmixOLS, unmixWithAutofluorescence } from './spectral.js';
import { compareSpectra } from './spectral-library.js';

export const DOCTOR_DEFAULTS = {
  maxEvents: 20000,
  seed: 1,
  // A t beyond this many noise SDs is not noise.
  tail: 5,
  // A signature is unexplained when this many more events lie above +tail than below −tail
  // (and at least 4 times as many).
  minExcessEvents: 25,
  minExcessFraction: 0.002,
  // A reference differs from its dye in the sample when the sample's spectrum departs from it by
  // this much in a detector (peak = 1) with |z| at least mismatchZ.
  mismatchTolerance: 0.03,
  mismatchZ: 6,
  // A tandem leaks into its donor when the donor rises by at least this fraction of the tandem's
  // abundance with |z| at least leakZ.
  leakTolerance: 0.02,
  leakZ: 10,
};

const norm = (name) => String(name ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');

// --- Dyes -------------------------------------------------------------------------------------

// The donor of a tandem dye (the dye its acceptor is coupled to, whose emission a degraded tandem
// regains), by name: PE, APC and PerCP tandems (PE-Cy7, PE-Dazzle 594, APC-Fire 750, PerCP-Cy5.5
// …), and the Brilliant Violet and Ultraviolet tandems on BV421 and BUV395 (BV570 and up, BUV563
// and up; BV510 and BUV496 are not tandems). Null for a dye that is not a known tandem.
export function donorOf(name) {
  const n = String(name ?? '').trim();
  if (/^PE[-\s]/i.test(n)) return 'PE';
  if (/^APC[-\s]/i.test(n)) return 'APC';
  if (/^PerCP[-\s]/i.test(n)) return 'PerCP';
  const bv = /^BV(\d{3})$/i.exec(n);
  if (bv && Number(bv[1]) >= 570) return 'BV421';
  const buv = /^BUV(\d{3})$/i.exec(n);
  if (buv && Number(buv[1]) >= 563) return 'BUV395';
  return null;
}

// Peak-normalized copy (null when the spectrum has no positive value).
function peakNormalized(values) {
  let peak = 0;
  for (const v of values) if (v > peak) peak = v;
  return peak > 0 ? Float64Array.from(values, (v) => v / peak) : null;
}

function cosine(x, y) {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i += 1) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return nx > 0 && ny > 0 ? dot / Math.sqrt(nx * ny) : 0;
}

function maxAbs(values) {
  let best = 0;
  let at = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (Math.abs(values[i]) > Math.abs(best)) {
      best = values[i];
      at = i;
    }
  }
  return { value: best, at };
}

// Laser of a detector name (UV7-A → UV), or ''.
function laserOf(detector) {
  return /^([A-Z]+)\d/.exec(String(detector ?? ''))?.[1] ?? '';
}

// The part of v outside the span of `basis` (rows, each length D): v − Bᵀ (B Bᵀ)⁻¹ B v.
function projectOut(v, basis) {
  const K = basis.length;
  if (!K) return Float64Array.from(v);
  const D = v.length;
  const g = new Float64Array(K * K);
  const b = new Float64Array(K);
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) {
      let s = 0;
      for (let d = 0; d < D; d += 1) s += basis[i][d] * basis[j][d];
      g[i * K + j] = s;
    }
    let s = 0;
    for (let d = 0; d < D; d += 1) s += basis[i][d] * v[d];
    b[i] = s;
  }
  let inv;
  try {
    inv = inverse(g, K);
  } catch {
    return Float64Array.from(v);
  }
  const out = Float64Array.from(v);
  for (let i = 0; i < K; i += 1) {
    let c = 0;
    for (let j = 0; j < K; j += 1) c += inv[i * K + j] * b[j];
    for (let d = 0; d < D; d += 1) out[d] -= c * basis[i][d];
  }
  return out;
}

// Least-squares weights w of v ≈ Σ w_k basis_k and the fraction of v's energy they explain.
function explainBy(v, basis) {
  const rest = projectOut(v, basis);
  let all = 0;
  let left = 0;
  for (let d = 0; d < v.length; d += 1) {
    all += v[d] * v[d];
    left += rest[d] * rest[d];
  }
  return all > 0 ? 1 - left / all : 0;
}

// Least-squares weights of v ≈ Σ w_k basis_k (null when the basis is degenerate).
function weightsOf(v, basis) {
  const K = basis.length;
  const g = new Float64Array(K * K);
  const b = new Float64Array(K);
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) {
      let s = 0;
      for (let d = 0; d < v.length; d += 1) s += basis[i][d] * basis[j][d];
      g[i * K + j] = s;
    }
    let s = 0;
    for (let d = 0; d < v.length; d += 1) s += basis[i][d] * v[d];
    b[i] = s;
  }
  try {
    const inv = inverse(g, K);
    return Array.from({ length: K }, (_, i) => {
      let w = 0;
      for (let j = 0; j < K; j += 1) w += inv[i * K + j] * b[j];
      return w;
    });
  } catch {
    return null;
  }
}

// An autofluorescence-like shape: broad (a quarter or more of the detectors at ≥ 20% of the
// peak) and peaking on the UV, violet or blue laser, as cellular autofluorescence (NAD(P)H,
// flavins) does.
function autofluorescenceLike(spectrum, detectors) {
  const s = peakNormalized(spectrum);
  if (!s) return false;
  let broad = 0;
  let peak = 0;
  for (let d = 0; d < s.length; d += 1) {
    if (s[d] >= 0.2) broad += 1;
    if (s[d] === 1) peak = d;
  }
  return broad >= s.length / 4 && ['UV', 'V', 'B'].includes(laserOf(detectors[peak]));
}

// Spearman's rank correlation of two equal-length arrays.
function rankCorrelation(x, y) {
  const ranks = (v) => {
    const order = Uint32Array.from({ length: v.length }, (_, i) => i).sort((a, b) => v[a] - v[b]);
    const r = new Float64Array(v.length);
    order.forEach((i, k) => { r[i] = k; });
    return r;
  };
  const a = ranks(x);
  const b = ranks(y);
  const n = a.length;
  const mean = (n - 1) / 2;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i] - mean) * (b[i] - mean);
    saa += (a[i] - mean) ** 2;
    sbb += (b[i] - mean) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

// --- Fitting a model to the sample's events -----------------------------------------------------

// The model fitted to the events: abundances, the fit and residual of every event (n × D,
// row-major) and each event's signal norm.
export function fitModel(cols, spectra, afSignatures) {
  const D = cols.length;
  const n = cols[0].length;
  const ref = referenceMatrix(spectra.map((s) => ({ name: s.name, spectrum: s.spectrum })));
  const F = ref.F;
  const S = ref.matrix;
  const af = (afSignatures ?? []).map((s) => Float64Array.from(s.spectrum));
  const result = af.length
    ? unmixWithAutofluorescence(cols, spectra, afSignatures, {})
    : unmixOLS(cols, spectra, { residuals: false });
  const A = result.abundances.slice(0, F).map((a) => Float64Array.from(a));
  const afAbundance = af.length ? Float64Array.from(result.abundances[F]) : null;
  const afIndex = af.length ? result.afIndex : null;
  const E = new Float64Array(n * D);
  const fit = new Float64Array(n * D);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let r2 = 0;
    for (let d = 0; d < D; d += 1) {
      let v = 0;
      for (let f = 0; f < F; f += 1) v += A[f][i] * S[f * D + d];
      if (af.length) v += afAbundance[i] * af[afIndex[i]][d];
      fit[i * D + d] = v;
      const r = cols[d][i];
      E[i * D + d] = r - v;
      r2 += r * r;
    }
    signal[i] = Math.sqrt(r2);
  }
  return { n, D, F, names: ref.names, S, A, af, afAbundance, afIndex, E, fit, signal, spectra, afSignatures: afSignatures ?? [] };
}

// Per-detector noise: background variance b_d from the dimmest fifth of events (their median
// squared residual over the median of χ²₁, 0.455) and photon noise k_d per unit of signal from
// the brighter half (the lower quartile, over χ²₁'s). Var(r_id) ≈ b_d + k_d · max(fit_id, 0).
export function noiseModel(m) {
  const { n, D, E, fit } = m;
  const total = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (let d = 0; d < D; d += 1) s += Math.max(0, fit[i * D + d]);
    total[i] = s;
  }
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => total[a] - total[b]);
  const dim = order.subarray(0, Math.max(10, Math.floor(n * 0.2)));
  const bright = order.subarray(Math.floor(n * 0.5));
  const b = new Float64Array(D);
  const k = new Float64Array(D);
  for (let d = 0; d < D; d += 1) {
    b[d] = Math.max(1e-12, median(Float64Array.from(dim, (i) => E[i * D + d] ** 2)) / 0.455);
    // The lower quartile (χ²₁'s is 0.1015), not the median: light the model misses in most bright
    // events would otherwise pass for photon noise and hide itself.
    const ratios = [];
    for (const i of bright) {
      const f = fit[i * D + d];
      if (f > 0) ratios.push((E[i * D + d] ** 2 / 0.1015 - b[d]) / f);
    }
    ratios.sort((x, y) => x - y);
    k[d] = ratios.length ? Math.max(0, ratios[Math.floor(ratios.length * 0.25)]) : 0;
  }
  return { b, k, variance: (i, d) => b[d] + k[d] * Math.max(0, fit[i * D + d]) };
}

// Median relative residual ‖e‖/‖r‖ of all events and of the brighter half (where misfit, not
// noise, dominates).
function residualSummary(m) {
  const rel = new Float64Array(m.n);
  for (let i = 0; i < m.n; i += 1) {
    let e2 = 0;
    for (let d = 0; d < m.D; d += 1) e2 += m.E[i * m.D + d] ** 2;
    rel[i] = m.signal[i] > 0 ? Math.sqrt(e2) / m.signal[i] : 0;
  }
  const order = Uint32Array.from({ length: m.n }, (_, i) => i).sort((a, b) => m.signal[a] - m.signal[b]);
  return { medianResidual: median(rel), brightResidual: median(Float64Array.from(order.subarray(m.n >> 1), (i) => rel[i])) };
}

// Events whose fitted signal is mostly autofluorescence (≥ 80% of its energy) and above the
// dimmest fifth (pure noise), with each one's relative residual: cells the dyes leave alone, whose
// fit says how well the model's autofluorescence describes them.
function autofluorescenceDominated(m) {
  if (!m.afAbundance) return { events: [], residuals: new Float64Array(0) };
  const sorted = Float64Array.from(m.signal).sort();
  const floor = sorted[Math.floor(m.n * 0.2)];
  const events = [];
  const residuals = [];
  for (let i = 0; i < m.n; i += 1) {
    if (m.signal[i] <= floor) continue;
    let total = 0;
    let own = 0;
    let e2 = 0;
    for (let d = 0; d < m.D; d += 1) {
      const fd = m.fit[i * m.D + d];
      total += fd * fd;
      const a = m.afAbundance[i] * m.af[m.afIndex[i]][d];
      own += a * a;
      e2 += m.E[i * m.D + d] ** 2;
    }
    if (total > 0 && own / total >= 0.8) {
      events.push(i);
      residuals.push(Math.sqrt(e2) / m.signal[i]);
    }
  }
  return { events, residuals: Float64Array.from(residuals) };
}

// Each event's projection onto direction u in noise SDs (t), and the counts beyond ±tail.
function alongDirection(m, noise, u, tail) {
  const t = new Float64Array(m.n);
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < m.n; i += 1) {
    let p = 0;
    let v = 0;
    for (let d = 0; d < m.D; d += 1) {
      p += m.E[i * m.D + d] * u[d];
      v += u[d] * u[d] * noise.variance(i, d);
    }
    t[i] = v > 0 ? p / Math.sqrt(v) : 0;
    if (t[i] > tail) pos += 1;
    else if (t[i] < -tail) neg += 1;
  }
  return { t, pos, neg };
}

// --- Unexplained light ----------------------------------------------------------------------------

// Residual directions shared by many poorly fit events: seeded spherical k-means on the
// noise-whitened, unit-normalized residuals of the 5% of events with the largest χ².
function residualDirections(m, noise, k = 4) {
  const { n, D, E } = m;
  const chi = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let c = 0;
    for (let d = 0; d < D; d += 1) c += E[i * D + d] ** 2 / noise.variance(i, d);
    chi[i] = c;
  }
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => chi[b] - chi[a]);
  const top = order.subarray(0, Math.max(50, Math.floor(n * 0.05)));
  const units = Array.from(top, (i) => {
    const w = new Float64Array(D);
    let nn = 0;
    for (let d = 0; d < D; d += 1) {
      w[d] = E[i * D + d] / Math.sqrt(noise.variance(i, d));
      nn += w[d] * w[d];
    }
    nn = Math.sqrt(nn) || 1;
    for (let d = 0; d < D; d += 1) w[d] /= nn;
    return w;
  });
  const dot = (x, y) => {
    let s = 0;
    for (let d = 0; d < D; d += 1) s += x[d] * y[d];
    return s;
  };
  // Farthest-point seeding from the worst-fit event: deterministic.
  const centers = [units[0]];
  while (centers.length < Math.min(k, units.length)) {
    let best = 0;
    let far = -Infinity;
    units.forEach((x, j) => {
      const closest = Math.max(...centers.map((c) => dot(x, c)));
      if (-closest > far) {
        far = -closest;
        best = j;
      }
    });
    centers.push(units[best]);
  }
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const sums = centers.map(() => new Float64Array(D));
    for (const x of units) {
      let best = 0;
      let value = -Infinity;
      centers.forEach((c, q) => {
        const v = dot(x, c);
        if (v > value) {
          value = v;
          best = q;
        }
      });
      for (let d = 0; d < D; d += 1) sums[best][d] += x[d];
    }
    sums.forEach((s, q) => {
      const nn = Math.hypot(...s);
      if (nn > 0) centers[q] = s.map((v) => v / nn);
    });
  }
  // Back to detector units (un-whitened by the background SD), unit norm.
  return centers.map((c) => {
    const raw = Float64Array.from(c, (v, d) => v * Math.sqrt(noise.b[d]));
    const nn = Math.hypot(...raw) || 1;
    return raw.map((v) => v / nn);
  });
}

// Unexplained signatures: directions (from the residuals and from candidate spectra outside the
// model) along which far more events lie above +tail noise SDs than below −tail.
function unexplainedSignatures(m, noise, candidates, options) {
  const { tail } = options;
  const basis = [...m.spectra.map((s) => Float64Array.from(s.spectrum)), ...m.af];
  const directions = [
    ...residualDirections(m, noise).map((u) => ({ u, from: 'residuals' })),
    ...candidates.map((c) => {
      const rest = projectOut(c.spectrum, basis);
      const nn = Math.hypot(...rest);
      return nn > 0.05 * Math.hypot(...c.spectrum) ? { u: rest.map((v) => v / nn), from: 'candidate', candidate: c } : null;
    }).filter(Boolean),
  ];
  const need = Math.max(options.minExcessEvents, Math.round(options.minExcessFraction * m.n));
  const found = [];
  for (const dir of directions) {
    let along = alongDirection(m, noise, dir.u, tail);
    if (along.neg > along.pos) {
      dir.u = dir.u.map((v) => -v);
      along = alongDirection(m, noise, dir.u, tail);
    }
    if (along.pos - along.neg >= need && along.pos >= 4 * Math.max(along.neg, 2)) found.push({ ...dir, ...along });
  }
  found.sort((a, b) => b.pos - b.neg - (a.pos - a.neg));
  const kept = [];
  for (const f of found) {
    const affected = [];
    for (let i = 0; i < m.n; i += 1) if (f.t[i] > tail) affected.push(i);
    const same = kept.find((k) => Math.abs(cosine(k.u, f.u)) > 0.9 || overlap(k.affected, affected) > 0.5);
    if (same) {
      if (f.candidate && !same.candidate) same.candidate = f.candidate;
      continue;
    }
    kept.push({ u: f.u, from: f.from, candidate: f.candidate ?? null, pos: f.pos, neg: f.neg, affected, t: f.t });
  }
  return kept;
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const i of b) if (set.has(i)) shared += 1;
  return shared / Math.min(a.length, b.length);
}

// What an unexplained signature is, judged with it added to the model (so dyes and
// autofluorescence no longer absorb it): over the events that carry it (the 1000 strongest), its
// amount against each dye's and against the autofluorescence. It belongs to a dye present (≥ 20
// noise SDs) in 90% of those events whose ratio to it varies least (robust CV < 0.3) and is
// small (< 0.5): a reference's error scales with its dye and is a fraction of it, a missing dye's
// amount does not follow another dye's, and light a dye absorbs exceeds what the dye takes.
// It is autofluorescence when its amount grows with the events' autofluorescence (rank
// correlation ≥ 0.75). It is also a dye's own light, as the sample shows it, when its spectrum is
// close to that dye's reference (cosine ≥ 0.9) and the dye is in at least half of its events, or
// when it rises with a dye present in half its events (rank correlation ≥ 0.7, in the fit
// without it) and resembles it (cosine ≥ 0.75).
// Returns { owner: { index, name, cv | similar } | null, nearest, followsAF: number | null }.
function classifySignature(cols, m, noiseOfM, sig, estimate) {
  const sigNoise = noiseOfM.variance;
  let refit;
  try {
    refit = fitModel(cols, [...m.spectra, { name: 'unexplained', spectrum: estimate }], m.afSignatures);
  } catch {
    return { owner: null, followsAF: null };
  }
  const noise = noiseModel(refit);
  const { D, F } = m;
  const events = sig.affected.slice().sort((a, b) => sig.t[b] - sig.t[a]).slice(0, 1000);
  if (events.length < 20) return { owner: null, followsAF: null };
  const amount = Float64Array.from(events, (i) => refit.A[F][i]);
  const op = unmixingOperator(refit.spectra.map((s) => ({ name: s.name, spectrum: s.spectrum })));
  let owner = null;
  let nearest = null;
  for (let f = 0; f < F; f += 1) {
    const ratios = [];
    events.forEach((i, j) => {
      let v = 0;
      for (let d = 0; d < D; d += 1) v += op[d * (F + 1) + f] ** 2 * noise.variance(i, d);
      if (refit.A[f][i] >= 20 * Math.sqrt(v)) ratios.push(amount[j] / refit.A[f][i]);
    });
    if (ratios.length < 0.5 * events.length) continue;
    const mid = median(ratios);
    const cv = (median(ratios.map((r) => Math.abs(r - mid))) * 1.4826) / Math.abs(mid || 1e-12);
    if (!nearest || cv < nearest.cv) nearest = { name: m.names[f], cv, ratio: mid, present: ratios.length / events.length };
    if (ratios.length < 0.9 * events.length) continue;
    // A reference's error is a small part of its dye's light; light a dye merely absorbs is more
    // than the dye takes of it.
    if (cv < 0.3 && Math.abs(mid) < 0.5 && (!owner || cv < owner.cv)) owner = { index: f, name: m.names[f], cv, ratio: mid };
  }
  // The estimate may also take over its dye's whole light (every event that carries it carries
  // the dye): then it is that dye's spectrum as the sample shows it, close to its reference.
  if (!owner) {
    const original = unmixingOperator(m.spectra.map((s) => ({ name: s.name, spectrum: s.spectrum })));
    for (let f = 0; f < F; f += 1) {
      const similar = cosine(estimate, m.spectra[f].spectrum);
      if (similar < 0.9) continue;
      let present = 0;
      for (const i of events) {
        let v = 0;
        for (let d = 0; d < D; d += 1) v += original[d * F + f] ** 2 * sigNoise(i, d);
        if (m.A[f][i] >= 20 * Math.sqrt(v)) present += 1;
      }
      if (present >= 0.5 * events.length && (!owner || similar > owner.similar)) owner = { index: f, name: m.names[f], cv: null, similar };
    }
  }
  const followsAF = refit.afAbundance ? rankCorrelation(amount, Float64Array.from(events, (i) => refit.afAbundance[i])) : null;
  // How the light follows each dye present in its events (≥ 5 noise SDs in half of them), in the
  // fit without it: rank correlation of its projection with the dye's abundance.
  const original = unmixingOperator(m.spectra.map((x) => ({ name: x.name, spectrum: x.spectrum })));
  const projection = Float64Array.from(events, (i) => {
    let p = 0;
    for (let d = 0; d < D; d += 1) p += m.E[i * D + d] * sig.u[d];
    return p;
  });
  const follows = [];
  for (let f = 0; f < F; f += 1) {
    let present = 0;
    for (const i of events) {
      let v = 0;
      for (let d = 0; d < D; d += 1) v += original[d * F + f] ** 2 * sigNoise(i, d);
      if (m.A[f][i] >= 5 * Math.sqrt(v)) present += 1;
    }
    if (present < 0.5 * events.length) continue;
    follows.push({ index: f, name: m.names[f], rho: rankCorrelation(projection, Float64Array.from(events, (i) => m.A[f][i])), cos: cosine(estimate, m.spectra[f].spectrum), present: present / events.length });
  }
  follows.sort((a, b) => b.rho - a.rho);
  // Light that rises with a dye and resembles it is that dye's own (a dye that merely absorbs
  // light near its spectrum also rises with it, but the light does not resemble it).
  if (!owner) {
    const own = follows.find((x) => x.rho >= 0.7 && x.cos >= 0.75);
    if (own) owner = { index: own.index, name: own.name, cv: null, similar: own.cos, rho: own.rho };
  }
  return { owner, nearest, followsAF, follows };
}

// The full spectrum of an unexplained signature from the events that carry it: alternately fit
// every event with the model's signatures and the new one, all abundances non-negative, and the
// new signature's per-detector least-squares value from those fits (clipped at 0, peak 1). The
// residual gives only the signature's part outside the model's span; non-negativity gives the
// rest (the true spectrum is the one that needs no negative dye to explain the events).
function estimateSignature(cols, m, events, start, options = {}) {
  const D = m.D;
  const F = m.F;
  const use = events.slice(0, 2000);
  if (use.length < 10) return null;
  const rows = m.spectra.map((s) => Float64Array.from(s.spectrum));
  // Start from the positive part of the events' median residual (or of the residual direction).
  let c = peakNormalized(Float64Array.from({ length: D }, (_, d) => Math.max(0, median(use.map((i) => m.E[i * D + d])))))
    ?? peakNormalized(Float64Array.from(start, (v) => Math.max(0, v)))
    ?? Float64Array.from({ length: D }, () => 1);
  const withAF = options.withAF !== false && m.af.length > 0;
  const K = F + (withAF ? 2 : 1);
  const ws = createNNLSWorkspace(K);
  const x = use.map(() => new Float64Array(K));
  const g = new Float64Array(K * K);
  const b = new Float64Array(K);
  const basisFor = (i) => (withAF ? [...rows, m.af[m.afIndex[i]], c] : [...rows, c]);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const grams = new Map();
    const num = new Float64Array(D);
    let den = 0;
    use.forEach((i, j) => {
      const key = withAF ? m.afIndex[i] : 0;
      const basis = basisFor(i);
      if (!grams.has(key)) {
        const gram = new Float64Array(K * K);
        for (let p = 0; p < K; p += 1) {
          for (let q = p; q < K; q += 1) {
            let s = 0;
            for (let d = 0; d < D; d += 1) s += basis[p][d] * basis[q][d];
            gram[p * K + q] = s;
            gram[q * K + p] = s;
          }
        }
        grams.set(key, gram);
      }
      g.set(grams.get(key));
      for (let p = 0; p < K; p += 1) {
        let s = 0;
        for (let d = 0; d < D; d += 1) s += basis[p][d] * cols[d][i];
        b[p] = s;
      }
      nnlsGramInPlace(g, b, K, x[j], ws);
      const w = x[j][K - 1];
      if (!(w > 0)) return;
      for (let d = 0; d < D; d += 1) {
        let rest = cols[d][i];
        for (let p = 0; p < K - 1; p += 1) rest -= x[j][p] * basis[p][d];
        num[d] += w * rest;
      }
      den += w * w;
    });
    if (!(den > 0)) return null;
    const next = peakNormalized(Float64Array.from(num, (v) => Math.max(0, v / den)));
    if (!next) return null;
    let change = 0;
    for (let d = 0; d < D; d += 1) change = Math.max(change, Math.abs(next[d] - c[d]));
    c = next;
    if (change < 1e-4) break;
  }
  return c;
}

// --- Spectra that differ from the sample's dye ------------------------------------------------

// Per dye: how its spectrum in this sample departs from its reference, outside the model's span
// (peak = 1). Over events where the dye is bright (≥ 20 noise SDs) and carries at least 5% of the
// fitted signal (up to 1500, the largest shares first), the departure in each detector is the
// median of the events' residual per unit of the dye's abundance, after the other dyes' current
// departures are taken from the residual: a joint robust fit by coordinate-wise medians, so a dye
// that rides along with a mismatched one (co-expressed on the same cells) is not blamed for it.
// Medians of ratios over bright events are used rather than a least-squares regression of
// residuals on abundances, which photon noise biases (an event's abundance and residual share its
// noise). Events in `exclude` (those of unexplained signatures) are left out.
function spectrumMismatches(m, noise, exclude) {
  const { n, D, F, A, S, E } = m;
  const skip = new Uint8Array(n);
  for (const i of exclude) skip[i] = 1;
  const op = unmixingOperator(m.spectra.map((s) => ({ name: s.name, spectrum: s.spectrum })));
  const events = [];
  for (let f = 0; f < F; f += 1) {
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      if (skip[i] || !(A[f][i] > 0)) continue;
      let v = 0;
      for (let d = 0; d < D; d += 1) v += op[d * F + f] ** 2 * noise.variance(i, d);
      if (A[f][i] < 20 * Math.sqrt(v)) continue;
      let total = 0;
      let own = 0;
      for (let d = 0; d < D; d += 1) {
        const fd = m.fit[i * D + d];
        total += fd * fd;
        const o = A[f][i] * S[f * D + d];
        own += o * o;
      }
      const share = total > 0 ? own / total : 0;
      if (share >= 0.05) candidates.push([i, share]);
    }
    candidates.sort((a, b) => b[1] - a[1]);
    events.push(candidates.slice(0, 1500).map(([i]) => i));
  }
  const delta = Array.from({ length: F }, () => new Float64Array(D));
  const z = Array.from({ length: F }, () => new Float64Array(D));
  const testable = events.map((list) => list.length >= 40);
  for (let round = 0; round < 4; round += 1) {
    for (let f = 0; f < F; f += 1) {
      if (!testable[f]) continue;
      const list = events[f];
      const ratios = new Float64Array(list.length);
      for (let d = 0; d < D; d += 1) {
        list.forEach((i, j) => {
          let y = E[i * D + d];
          for (let g = 0; g < F; g += 1) if (g !== f && testable[g]) y -= A[g][i] * delta[g][d];
          ratios[j] = y / A[f][i];
        });
        const mid = median(ratios);
        const mad = median(Float64Array.from(ratios, (v) => Math.abs(v - mid))) * 1.4826;
        delta[f][d] = mid;
        z[f][d] = mad > 0 ? mid / ((1.2533 * mad) / Math.sqrt(list.length)) : 0;
      }
    }
  }
  return m.names.map((name, f) => {
    if (!testable[f]) return { index: f, name, events: events[f].length, delta: null };
    // The largest departure that is significant.
    let best = 0;
    let at = -1;
    for (let d = 0; d < D; d += 1) {
      if (Math.abs(z[f][d]) >= 3 && Math.abs(delta[f][d]) > Math.abs(best)) {
        best = delta[f][d];
        at = d;
      }
    }
    return { index: f, name, events: events[f].length, delta: delta[f], z: z[f], largest: best, at, zAt: at >= 0 ? z[f][at] : 0 };
  });
}

// --- Leaks between unmixed channels --------------------------------------------------------------

// Half-sample mode (Bickel 2002) of sorted values: the center of the densest half, halved
// repeatedly; robust to a minority of positive events.
function halfSampleMode(sorted) {
  let lo = 0;
  let hi = sorted.length;
  if (!hi) return Number.NaN;
  while (hi - lo > 3) {
    const h = Math.ceil((hi - lo) / 2);
    let best = lo;
    let width = Infinity;
    for (let k = lo; k + h - 1 < hi; k += 1) {
      const w = sorted[k + h - 1] - sorted[k];
      if (w < width) {
        width = w;
        best = k;
      }
    }
    lo = best;
    hi = best + h;
  }
  let s = 0;
  for (let k = lo; k < hi; k += 1) s += sorted[k];
  return s / (hi - lo);
}

// How the mode of `y` follows `x`: events in 10 equal-count bins of x (its lowest 2% and highest
// 0.1% left out), the half-sample mode of y in each (its standard error from the spread below
// the mode, where y's negative cells are), and a weighted line through them. Returns { slope, z,
// intercept and its standard error, rise (fitted change of y across the bins), spread (y's spread
// in the lowest bin), xs, ys }.
export function modeTrend(x, y, bins = 10) {
  const n = x.length;
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
  const use = order.subarray(Math.floor(n * 0.02), n - Math.floor(n * 0.001));
  if (use.length < bins * 30) return null;
  const xs = [];
  const ys = [];
  const se = [];
  let spread = 0;
  for (let k = 0; k < bins; k += 1) {
    const part = use.subarray(Math.floor((k * use.length) / bins), Math.floor(((k + 1) * use.length) / bins));
    xs.push(median(Float64Array.from(part, (i) => x[i])));
    const v = Float64Array.from(part, (i) => y[i]).sort();
    const mode = halfSampleMode(v);
    ys.push(mode);
    // The spread of the population the mode follows, from below it (y's positive cells lie above).
    const sd = Math.max(1e-9, mode - v[Math.floor(v.length * 0.1587)]);
    if (k === 0) spread = sd;
    se.push(Math.max(1e-9, (2.5 * sd) / Math.sqrt(v.length)));
  }
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < bins; k += 1) {
    const w = 1 / se[k] ** 2;
    sw += w;
    sx += w * xs[k];
    sy += w * ys[k];
    sxx += w * xs[k] ** 2;
    sxy += w * xs[k] * ys[k];
  }
  const det = sw * sxx - sx * sx;
  if (!(det > 0)) return null;
  const slope = (sw * sxy - sx * sy) / det;
  const intercept = (sy - slope * sx) / sw;
  let chi = 0;
  for (let k = 0; k < bins; k += 1) chi += ((ys[k] - intercept - slope * xs[k]) / se[k]) ** 2;
  const inflate = Math.sqrt(Math.max(1, chi / (bins - 2)));
  const slopeSE = Math.sqrt(sw / det) * inflate;
  const interceptSE = Math.sqrt(sxx / det) * inflate;
  return { slope, z: slope / slopeSE, intercept, interceptSE, rise: slope * (xs[bins - 1] - xs[0]), spread, xs, ys };
}

// Tandem → donor leaks of the panel's tandems whose donor is in the panel too. A degraded tandem
// adds donor light in proportion to the tandem: among the tandem's positive events (≥ 10 noise
// SDs and a fifth of the event's fitted signal), the donor-negative cells lie on the line donor = center + slope × tandem, through the
// donor's negative center (its mode among the tandem's negative events, or 0, where unmixed
// negatives center, when every event carries the tandem). The slope is found by consensus: the
// one that puts the most positive events within 2 predicted noise SDs of the line. A leak moves
// every positive event off the flat line; co-expression leaves many on it (its donor-negative
// cells) and gathers the rest on no common line through the negative center. So a leak is
// reported when the best slope gathers at least 40% of the positive events and a slope of 0 at
// most a quarter as many (simulated degradation: 53–67% against none; co-expression in the
// spectral example: at most 34% against 19%). Returns per tandem { tandem, donor, slope, z (of
// the slope, from the inliers' ratios), inliers, atZero (fractions of positive events), center,
// positives, rise (over the positives' 2nd–98th percentiles), spread (the donor's median noise SD)
// }.
export function tandemLeaks(m, noise) {
  const index = new Map(m.names.map((name, f) => [norm(name), f]));
  const op = unmixingOperator(m.spectra.map((s) => ({ name: s.name, spectrum: s.spectrum })));
  const sdOf = (i, f) => {
    let v = 0;
    for (let k = 0; k < m.D; k += 1) v += op[k * m.F + f] ** 2 * noise.variance(i, k);
    return Math.sqrt(v);
  };
  const out = [];
  m.names.forEach((name, t) => {
    const donor = donorOf(name);
    const d = donor ? index.get(norm(donor)) : undefined;
    if (d === undefined) return;
    const positive = [];
    const negative = [];
    for (let i = 0; i < m.n; i += 1) {
      const sd = sdOf(i, t);
      if (m.A[t][i] >= 10 * sd) {
        // Stained events: the tandem carries a fifth or more of the fitted signal (not light of
        // another kind, such as autofluorescence the model lacks, unmixed into it).
        let total = 0;
        let own = 0;
        for (let k = 0; k < m.D; k += 1) {
          total += m.fit[i * m.D + k] ** 2;
          own += (m.A[t][i] * m.S[t * m.D + k]) ** 2;
        }
        if (total > 0 && own / total >= 0.2) positive.push(i);
      } else if (Math.abs(m.A[t][i]) <= 2 * sd) negative.push(i);
    }
    if (positive.length < 200) return;
    const center = negative.length >= 200 ? halfSampleMode(Float64Array.from(negative, (i) => m.A[d][i]).sort()) : 0;
    const x = Float64Array.from(positive, (i) => m.A[t][i]);
    const y = Float64Array.from(positive, (i) => m.A[d][i] - center);
    const sy = Float64Array.from(positive, (i) => sdOf(i, d));
    const within = (k) => {
      let count = 0;
      for (let j = 0; j < x.length; j += 1) if (Math.abs(y[j] - k * x[j]) < 2 * sy[j]) count += 1;
      return count;
    };
    // Slopes from −0.5 to 1 (a tandem regaining or losing up to its whole donor emission).
    let best = 0;
    let bestCount = within(0);
    const atZero = bestCount;
    for (let k = -0.5; k <= 1.0001; k += 0.005) {
      const c = within(k);
      if (c > bestCount) {
        bestCount = c;
        best = k;
      }
    }
    // Refine with the inliers' own ratios.
    const ratios = [];
    for (let j = 0; j < x.length; j += 1) if (Math.abs(y[j] - best * x[j]) < 2 * sy[j]) ratios.push(y[j] / x[j]);
    const slope = ratios.length ? median(ratios) : best;
    const mad = ratios.length ? median(ratios.map((r) => Math.abs(r - slope))) * 1.4826 : Infinity;
    const z = mad > 0 && ratios.length ? slope / ((1.2533 * mad) / Math.sqrt(ratios.length)) : 0;
    const sorted = Float64Array.from(x).sort();
    const rise = slope * (sorted[Math.floor(x.length * 0.98)] - sorted[Math.floor(x.length * 0.02)]);
    out.push({ tandem: name, donor: m.names[d], tandemIndex: t, donorIndex: d, slope, z, inliers: bestCount / x.length, atZero: atZero / x.length, center, positives: positive.length, rise, spread: median(sy) });
  });
  return out;
}

// --- Autofluorescence ------------------------------------------------------------------------------

// Sample events whose scatter the unstained control does not cover: 32 × 32 bins of FSC and SSC
// (scaled to the sample's 0.5th–99.5th percentiles); a sample bin is uncovered when the unstained
// control holds less than a tenth of the sample's share of events there. Returns the uncovered
// fraction and the median FSC and SSC of the uncovered and covered events.
function scatterCoverage(sample, unstained) {
  const bins = 32;
  const range = (values) => {
    const s = Float64Array.from(values).sort();
    return [s[Math.floor(s.length * 0.005)], s[Math.floor(s.length * 0.995)]];
  };
  const [fx0, fx1] = range(sample.fsc);
  const [sy0, sy1] = range(sample.ssc);
  if (!(fx1 > fx0 && sy1 > sy0)) return null;
  const binOf = (f, s) => {
    const a = Math.floor(((f - fx0) / (fx1 - fx0)) * bins);
    const b = Math.floor(((s - sy0) / (sy1 - sy0)) * bins);
    return a < 0 || b < 0 || a >= bins || b >= bins ? -1 : a * bins + b;
  };
  const count = (data) => {
    const h = new Float64Array(bins * bins);
    let total = 0;
    for (let i = 0; i < data.fsc.length; i += 1) {
      const k = binOf(data.fsc[i], data.ssc[i]);
      if (k >= 0) {
        h[k] += 1;
        total += 1;
      }
    }
    return { h, total };
  };
  const a = count(sample);
  const u = count(unstained);
  if (!a.total || !u.total) return null;
  // Smooth the unstained histogram over 3 × 3 bins, so sampling gaps are not read as missing cells.
  const smooth = new Float64Array(bins * bins);
  for (let p = 0; p < bins; p += 1) {
    for (let q = 0; q < bins; q += 1) {
      let s = 0;
      let c = 0;
      for (let dp = -1; dp <= 1; dp += 1) {
        for (let dq = -1; dq <= 1; dq += 1) {
          const pp = p + dp;
          const qq = q + dq;
          if (pp >= 0 && qq >= 0 && pp < bins && qq < bins) {
            s += u.h[pp * bins + qq];
            c += 1;
          }
        }
      }
      smooth[p * bins + q] = s / c;
    }
  }
  const uncoveredBin = new Uint8Array(bins * bins);
  for (let k = 0; k < bins * bins; k += 1) if (a.h[k] / a.total > 0 && smooth[k] / u.total < 0.1 * (a.h[k] / a.total)) uncoveredBin[k] = 1;
  const inside = [];
  const outside = [];
  for (let i = 0; i < sample.fsc.length; i += 1) {
    const k = binOf(sample.fsc[i], sample.ssc[i]);
    if (k >= 0 && uncoveredBin[k]) outside.push(i);
    else inside.push(i);
  }
  const medianOf = (values, idx) => median(Float64Array.from(idx, (i) => values[i]));
  return {
    fraction: outside.length / sample.fsc.length,
    events: outside,
    uncovered: outside.length ? { fsc: medianOf(sample.fsc, outside), ssc: medianOf(sample.ssc, outside) } : null,
    covered: inside.length ? { fsc: medianOf(sample.fsc, inside), ssc: medianOf(sample.ssc, inside) } : null,
  };
}

// Dyes whose spectra resemble an autofluorescence signature (cosine ≥ 0.4): where unmodeled
// autofluorescence goes.
function autofluorescenceLikeDyes(m, signatures) {
  return m.names.map((name, f) => ({ name, f, cos: Math.max(0, ...signatures.map((s) => cosine(m.spectra[f].spectrum, s.spectrum))) }))
    .filter((d) => d.cos >= 0.4);
}

// --- Trying fixes ------------------------------------------------------------------------------

function measure(cols, spectra, afSignatures, probes) {
  const m = fitModel(cols, spectra, afSignatures);
  const noise = noiseModel(m);
  const out = { ...residualSummary(m) };
  if (probes.direction) {
    const along = alongDirection(m, noise, probes.direction, probes.tail);
    out.excess = along.pos - along.neg;
  }
  if (probes.leak) {
    const leak = tandemLeaks(m, noise).find((l) => norm(l.tandem) === norm(probes.leak.tandem));
    out.leak = leak ? leak.slope : null;
  }
  if (probes.mismatch) {
    const f = m.names.findIndex((x) => norm(x) === norm(probes.mismatch));
    const row = f >= 0 ? spectrumMismatches(m, noise, []).find((r) => r.index === f) : null;
    out.mismatch = row?.delta ? Math.abs(maxAbs(row.delta).value) : null;
  }
  if (probes.afDominated) out.afDominated = median(autofluorescenceDominated(m).residuals);
  return out;
}

// --- Findings --------------------------------------------------------------------------------------

const SEVERITY = { high: 3, medium: 2, low: 1 };

function finding(props) {
  return { evidence: [], measures: {}, fix: null, effect: null, ...props, score: (SEVERITY[props.severity] ?? 1) * (SEVERITY[props.confidence] ?? 1) + (props.bonus ?? 0) };
}

const day = (entry) => String(entry?.date ?? entry?.added ?? '').slice(0, 10);
const pct = (v) => `${(100 * v).toFixed(v < 0.01 ? 2 : 1)}%`;
const fixed = (v, digits = 3) => (Number.isFinite(v) ? Number(v.toFixed(digits)).toString() : '—');

// Checks of the reference controls alone. references: [{ name, spectrum, carrier ('beads' |
// 'cells' | null), mixture (the peak-normalized spectrum of the dimmest third of positives minus
// that of the brightest, as referenceSpectrum gives), heterogeneity, sampleName }]. options: {
// detectors, library (entries on the detectors: { id, fluorochrome, spectrum, carrier, date, file
// }), afSignatures (the unstained control's) }.
export function diagnoseControls(references, options = {}) {
  const detectors = options.detectors ?? [];
  const af = (options.afSignatures ?? []).map((s) => ({ name: s.name, spectrum: Float64Array.from(s.spectrum) }));
  const library = options.library ?? [];
  const panel = new Map(references.map((r) => [norm(r.name), r]));
  const findings = [];
  for (const ref of references) {
    if (!ref.spectrum) continue;
    const isBeads = /bead/i.test(ref.carrier ?? '');
    // Autofluorescent positives: the dim positives' spectrum departs from the bright ones' in the
    // shape of autofluorescence (a constant autofluorescence excess weighs more on dim cells).
    if (ref.mixture && !isBeads) {
      const { value, at } = maxAbs(ref.mixture);
      const best = af.map((s) => ({ s, cos: cosine(ref.mixture, s.spectrum) })).sort((a, b) => b.cos - a.cos)[0];
      if (Math.abs(value) >= 0.03 && best && best.cos >= 0.6) {
        const big = Math.abs(value) >= 0.1;
        const bead = library.filter((e) => norm(e.fluorochrome) === norm(ref.name) && /bead/i.test(e.carrier ?? '')).at(-1);
        findings.push(finding({
          id: `control-autofluorescence:${ref.name}`,
          kind: 'control-autofluorescence',
          subject: ref.name,
          title: `The ${ref.name} control's positive cells are more autofluorescent than its negatives`,
          severity: big ? 'high' : 'medium',
          confidence: best.cos >= 0.8 ? 'high' : 'medium',
          evidence: [
            `The spectrum of the dimmest third of its positives departs from the brightest third's by ${fixed(Math.abs(value))} (peak = 1) at ${detectors[at] ?? 'a detector'}, in the shape of the unstained control's autofluorescence ${best.s.name} (cosine ${fixed(best.cos)}): a constant extra autofluorescence weighs more on dimmer cells.`,
            `Its positives are likely autofluorescent cells (myeloid cells, granulocytes or macrophages carry the marker), so the reference holds part of their autofluorescence.`,
          ],
          measures: { departure: Math.abs(value), detector: detectors[at] ?? null, cosine: best.cos, signature: best.s.name },
          spectrum: Array.from(ref.mixture),
          compare: { name: best.s.name, spectrum: Array.from(best.s.spectrum) },
          fix: bead
            ? { action: 'use-library', label: `Use the ${ref.name} bead spectrum from the library`, text: `The library holds a bead control of ${ref.name} (${day(bead)}), whose spectrum carries no autofluorescence.`, entryId: bead.id, fluorochrome: ref.name }
            : { action: 'advice', label: 'Use a bead control or matched negatives', text: `Stain capture beads with ${ref.name} for its reference, or gate the control's negatives on the same cells as its positives (scatter), so their autofluorescence cancels.` },
        }));
      }
    }
    // Against the library: the latest entry of the dye (same carrier first).
    const entries = library.filter((e) => norm(e.fluorochrome) === norm(ref.name) && e.spectrum?.length === ref.spectrum.length);
    if (!entries.length) continue;
    const same = entries.filter((e) => (e.carrier ?? null) === (ref.carrier ?? null) || (!e.carrier || !ref.carrier));
    const entry = (same.length ? same : entries).at(-1);
    const cmp = compareSpectra(ref.spectrum, entry.spectrum);
    if (cmp.maxDiff <= (options.tolerance ?? 0.03)) continue;
    const diff = Float64Array.from(peakNormalized(ref.spectrum), (v, d) => v - peakNormalized(entry.spectrum)[d]);
    const donor = donorOf(ref.name);
    const donorSpectrum = donor ? (panel.get(norm(donor))?.spectrum ?? library.filter((e) => norm(e.fluorochrome) === norm(donor)).at(-1)?.spectrum ?? null) : null;
    const carriers = entry.carrier && ref.carrier && /bead/i.test(entry.carrier) !== /bead/i.test(ref.carrier);
    // A degraded tandem: (1 − φ) tandem + φ donor, peak-normalized, so the difference from the
    // library's tandem is a multiple of the donor plus a multiple of the tandem itself.
    let explainedByDonor = 0;
    let donorWeight = 0;
    if (donorSpectrum) {
      const basis = [peakNormalized(donorSpectrum), peakNormalized(entry.spectrum)];
      explainedByDonor = explainBy(diff, basis);
      donorWeight = weightsOf(diff, basis)?.[0] ?? 0;
    }
    const explainedByAF = af.length ? explainBy(diff, af.map((s) => s.spectrum)) : 0;
    const where = `${fixed(cmp.maxDiff)} (peak = 1) at ${detectors[cmp.at] ?? 'a detector'}`;
    const from = `the library's ${entry.carrier ? `${entry.carrier} ` : ''}spectrum of ${day(entry)}${entry.file ? ` (${entry.file})` : ''}`;
    if (explainedByDonor >= 0.7) {
      const degradedHere = donorWeight > 0;
      findings.push(finding({
        id: `degraded-tandem:control:${ref.name}`,
        kind: 'degraded-tandem',
        subject: ref.name,
        title: degradedHere ? `The ${ref.name} control looks degraded: it emits more like ${donor} than the library's ${ref.name}` : `The library's ${ref.name} looks more degraded than this experiment's control`,
        severity: cmp.maxDiff >= 0.1 ? 'high' : 'medium',
        confidence: 'high',
        evidence: [`It differs from ${from} by ${where}; ${pct(explainedByDonor)} of the difference has the shape of ${donor}'s emission (${fixed(Math.abs(donorWeight * 100), 1)}% of the emission ${degradedHere ? 'gone to' : 'regained from'} the donor).`],
        measures: { maxDiff: cmp.maxDiff, detector: detectors[cmp.at] ?? null, donorFraction: donorWeight, explained: explainedByDonor },
        spectrum: Array.from(peakNormalized(ref.spectrum)),
        compare: { name: `Library ${day(entry)}`.trim(), spectrum: Array.from(peakNormalized(entry.spectrum)) },
        fix: degradedHere
          ? { action: 'advice', label: 'Check the vial, then decide', text: `A tandem degrades with light, heat, fixation and age. If the samples were stained from the same vial as the control, keep the control (it matches them); if they were stained fresh, use the library's ${ref.name} and replace the vial.`, entryId: entry.id, fluorochrome: ref.name, alternative: 'use-library' }
          : { action: 'advice', label: 'Keep this control', text: `This experiment's ${ref.name} is the less degraded; consider saving it to the library.` },
      }));
    } else if (carriers && explainedByAF >= 0.6) {
      // Covered by the autofluorescent-positives check when the control is on cells.
      if (!findings.some((f) => f.id === `control-autofluorescence:${ref.name}`)) {
        findings.push(finding({
          id: `control-autofluorescence:${ref.name}`,
          kind: 'control-autofluorescence',
          subject: ref.name,
          title: `The ${ref.name} spectra from cells and from beads differ by autofluorescence`,
          severity: cmp.maxDiff >= 0.1 ? 'high' : 'medium',
          confidence: 'medium',
          evidence: [`This ${ref.carrier} control differs from ${from} by ${where}; ${pct(explainedByAF)} of the difference has the shape of the unstained control's autofluorescence: the cell control's positives are more autofluorescent than its negatives.`],
          measures: { maxDiff: cmp.maxDiff, detector: detectors[cmp.at] ?? null, explained: explainedByAF },
          spectrum: Array.from(peakNormalized(ref.spectrum)),
          compare: { name: `Library ${entry.carrier ?? ''}`.trim(), spectrum: Array.from(peakNormalized(entry.spectrum)) },
          fix: /bead/i.test(entry.carrier) ? { action: 'use-library', label: `Use the ${ref.name} bead spectrum`, text: 'Bead spectra carry no cellular autofluorescence.', entryId: entry.id, fluorochrome: ref.name } : { action: 'advice', label: 'Keep the bead control', text: 'Bead spectra carry no cellular autofluorescence.' },
        }));
      }
    } else if (carriers) {
      findings.push(finding({
        id: `bead-control:${ref.name}`,
        kind: 'bead-control',
        subject: ref.name,
        title: `${ref.name} emits differently on beads and on cells`,
        severity: cmp.maxDiff >= 0.1 ? 'high' : 'medium',
        confidence: 'medium',
        evidence: [`This ${ref.carrier} control differs from ${from} by ${where}, and the difference is not autofluorescence${donor ? ` nor ${donor} emission` : ''}.`],
        measures: { maxDiff: cmp.maxDiff, detector: detectors[cmp.at] ?? null },
        spectrum: Array.from(peakNormalized(ref.spectrum)),
        compare: { name: `Library ${entry.carrier}`, spectrum: Array.from(peakNormalized(entry.spectrum)) },
        fix: /bead/i.test(ref.carrier ?? '')
          ? { action: 'use-library', label: `Use the ${ref.name} cell spectrum from the library`, text: 'For a stain on cells, a reference on cells is the closer match.', entryId: entry.id, fluorochrome: ref.name }
          : { action: 'advice', label: 'Keep the cell control', text: 'For a stain on cells, a reference on cells is the closer match.' },
      }));
    } else {
      // Independent controls of one dye on one instrument differ by less than 0.03; a difference
      // far beyond that is more than a new lot.
      const far = cmp.maxDiff >= 0.1;
      const lookalike = library.filter((e) => norm(e.fluorochrome) !== norm(ref.name) && e.spectrum?.length === ref.spectrum.length)
        .map((e) => ({ e, cos: cosine(ref.spectrum, e.spectrum) })).sort((a, b) => b.cos - a.cos).find((o) => o.cos >= 0.995);
      findings.push(finding({
        id: `${far ? 'wrong-reference' : 'library-change'}:${ref.name}`,
        kind: far ? 'wrong-reference' : 'library-change',
        subject: ref.name,
        title: far ? `The ${ref.name} control differs from the library's ${ref.name} by more than a new lot does` : `The ${ref.name} control differs from the library`,
        severity: far ? 'medium' : 'low',
        confidence: lookalike ? 'medium' : 'low',
        evidence: [
          `It differs from ${from} by ${where}${far ? ' (independent controls of a dye differ by less than 0.03)' : ''}: ${far ? 'the control may hold another dye or conjugate (a mislabeled tube, a similar dye read in the same channel)' : 'a new lot or conjugate, a realigned laser, or a mislabeled control'}.`,
          lookalike ? `Its spectrum matches the library's ${lookalike.e.fluorochrome} (cosine ${fixed(lookalike.cos, 4)}).` : '',
        ].filter(Boolean),
        measures: { maxDiff: cmp.maxDiff, detector: detectors[cmp.at] ?? null },
        spectrum: Array.from(peakNormalized(ref.spectrum)),
        compare: { name: `Library ${day(entry)}`.trim(), spectrum: Array.from(peakNormalized(entry.spectrum)) },
        fix: { action: 'advice', label: 'Check against a sample', text: 'Run the doctor on a stained sample: it tells which spectrum the sample\'s dye follows.', entryId: entry.id, fluorochrome: ref.name },
      }));
    }
  }
  return findings;
}

// Diagnoses the unmixing of a sample. columns: the sample's raw detector columns, in the order of
// model.detectors (Float32Array or Float64Array each). model: { detectors, spectra: [{ name,
// spectrum }], afSignatures: [{ name, spectrum }] } (as the sample is unmixed: ordinary least
// squares, each event choosing its autofluorescence signature). context: { references (as
// diagnoseControls takes them), library (entries on the detectors), unstainedAF (all signatures
// of the unstained control, used or not), scatter: { sample: { fsc, ssc }, unstained: { fsc, ssc }
// } (scatter of the sample's and the unstained control's events, to check that the unstained
// control holds the sample's cells), unstained: { columns } (the unstained control's detector
// columns, to compare how well the model fits its cells and the sample's) }. options:
// DOCTOR_DEFAULTS, onProgress(fraction, message), signal ({ aborted } stops it).
// Returns { events, eventsInSample, detectors, baseline, findings (most likely first: { id, kind,
// subject, title, severity, confidence, score, evidence, measures, spectrum, compare, fix,
// alternatives, effect }), healthy (no finding above low severity from the sample), checks }.
export function diagnoseUnmixing(columns, model, context = {}, options = {}) {
  const opts = { ...DOCTOR_DEFAULTS, ...options };
  const progress = (f, message) => {
    if (opts.signal?.aborted) throw Object.assign(new Error('The diagnosis was canceled.'), { name: 'AbortError' });
    opts.onProgress?.(f, message);
  };
  const detectors = model.detectors;
  const D = detectors.length;
  if (columns.length !== D) throw new Error(`The sample has ${columns.length} detector columns but the model has ${D} detectors.`);
  if (!model.spectra?.length) throw new Error('The model has no reference spectra.');
  const total = columns[0].length;
  const pick = total > opts.maxEvents ? sampleIndices(total, opts.maxEvents, createRandom(opts.seed)) : null;
  const cols = pick ? columns.map((c) => Float64Array.from(pick, (i) => c[i])) : columns.map((c) => Float64Array.from(c));
  const scatter = context.scatter?.sample && pick ? { fsc: Float64Array.from(pick, (i) => context.scatter.sample.fsc[i]), ssc: Float64Array.from(pick, (i) => context.scatter.sample.ssc[i]) } : context.scatter?.sample ?? null;
  const spectra = model.spectra.map((s) => ({ name: s.name, spectrum: Float64Array.from(s.spectrum) }));
  const afSignatures = (model.afSignatures ?? []).map((s) => ({ name: s.name, spectrum: Float64Array.from(s.spectrum) }));
  const library = (context.library ?? []).filter((e) => e.spectrum?.length === D);
  const unstainedAF = (context.unstainedAF ?? afSignatures).map((s) => ({ name: s.name, spectrum: Float64Array.from(s.spectrum) }));
  const inPanel = new Set(spectra.map((s) => norm(s.name)));
  const references = context.references ?? [];
  const carrierOf = (name) => references.find((r) => norm(r.name) === norm(name))?.carrier ?? null;

  progress(0.05, 'Unmixing with the current model');
  const m = fitModel(cols, spectra, afSignatures);
  const noise = noiseModel(m);
  const baseline = residualSummary(m);
  const findings = [];
  const checks = [];
  const tryFix = (change, probes) => measure(cols, change.spectra ?? spectra, change.afSignatures ?? afSignatures, { tail: opts.tail, ...probes });

  // 1. Light no signature explains.
  progress(0.2, 'Looking for light no signature explains');
  const usedAF = new Set(afSignatures.map((s) => norm(s.name)));
  const candidates = [
    ...library.filter((e) => !inPanel.has(norm(e.fluorochrome))).map((e) => ({ kind: 'library', name: e.fluorochrome, spectrum: Float64Array.from(e.spectrum), entry: e })),
    ...unstainedAF.filter((s) => !usedAF.has(norm(s.name)) && !afSignatures.some((a) => cosine(a.spectrum, s.spectrum) > 0.999)).map((s) => ({ kind: 'autofluorescence', name: s.name, spectrum: s.spectrum })),
  ];
  // Library entries of one dye: keep the latest.
  const latest = new Map();
  for (const c of candidates) if (c.kind !== 'library' || !latest.has(norm(c.name)) || String(c.entry.date ?? '') >= String(latest.get(norm(c.name)).entry.date ?? '')) latest.set(c.kind === 'library' ? norm(c.name) : `af:${c.name}`, c);
  const unexplained = unexplainedSignatures(m, noise, [...latest.values()], opts);
  checks.push({ check: 'unexplained light', result: unexplained.length ? `${unexplained.length} signature${unexplained.length > 1 ? 's' : ''}` : 'none' });
  const excluded = new Set();
  const added = [];
  const afSignals = [];
  unexplained.forEach((sig, k) => {
    progress(0.25 + 0.15 * (k / unexplained.length), 'Estimating an unexplained signature');
    sig.affected.sort((a, b) => sig.t[b] - sig.t[a]);
    const first = estimateSignature(cols, m, sig.affected, sig.u);
    // Light that scales with one dye is that dye's reference missing part of its spectrum: the
    // comparison of references with the sample (below) names it. Light that grows with each
    // event's autofluorescence is autofluorescence the model's signatures do not describe
    // (another cell type, fixation).
    const kind = first && !sig.candidate ? classifySignature(cols, m, noise, sig, first) : { owner: null, followsAF: null };
    if (kind.owner) {
      checks.push({ check: 'unexplained light that belongs to one dye', result: kind.owner.similar ? `${kind.owner.name} (its spectrum resembles ${kind.owner.name}'s, cosine ${fixed(kind.owner.similar, 2)}${kind.owner.rho ? `, and it rises with ${kind.owner.name}: rank correlation ${fixed(kind.owner.rho, 2)}` : ''})` : `${kind.owner.name} (it follows ${kind.owner.name}'s abundance: ratio CV ${fixed(kind.owner.cv, 2)})` });
      return;
    }
    if (kind.nearest) checks.push({ check: 'unexplained light against the dyes', result: `closest to ${kind.nearest.name} (in ${pct(kind.nearest.present)} of its events, ratio ${fixed(kind.nearest.ratio, 2)}, CV ${fixed(kind.nearest.cv, 2)}); against autofluorescence: rank correlation ${fixed(kind.followsAF, 2)}${kind.follows?.length ? `; follows ${kind.follows.slice(0, 3).map((x) => `${x.name} ρ ${fixed(x.rho, 2)} cos ${fixed(x.cos, 2)}`).join(', ')}` : ''}` });
    for (const i of sig.affected) excluded.add(i);
    // With the signature added, it can take a cell's whole autofluorescence and so no longer follow
    // what is left; without it, autofluorescence also absorbs a missing dye near it. So a broad,
    // autofluorescence-like shape that follows the events' autofluorescence in the fit without it
    // counts too.
    const broad = first ? autofluorescenceLike(first, detectors) : false;
    let before = null;
    if (m.afAbundance) {
      const top = sig.affected.slice(0, 2000);
      const projection = Float64Array.from(top, (i) => {
        let p = 0;
        for (let d = 0; d < D; d += 1) p += m.E[i * D + d] * sig.u[d];
        return p;
      });
      before = rankCorrelation(projection, Float64Array.from(top, (i) => m.afAbundance[i]));
    }
    const followsAF = Math.max(kind.followsAF ?? -1, broad && before !== null ? before : -1);
    const asAF = !sig.candidate && followsAF >= 0.75;
    // Narrow light that follows autofluorescence only in the fit without it is either: a dye near
    // the autofluorescence, which absorbs part of it, or autofluorescence the signature takes over.
    const ambiguous = !asAF && !sig.candidate && before !== null && before >= 0.75;
    checks.push({ check: `unexplained light ${k + 1}`, result: `${sig.pos} events; ${m.afAbundance ? `rank correlation with autofluorescence ${fixed(kind.followsAF, 2)} with it in the model, ${fixed(before, 2)} without` : 'no autofluorescence in the model'}; ${broad ? 'broad, autofluorescence-like shape' : 'narrow shape'}` });
    // As autofluorescence, the signature is the cells' whole autofluorescence (each event takes one
    // signature), so it is estimated without the model's.
    const estimate = asAF ? estimateSignature(cols, m, sig.affected, sig.u, { withAF: false }) ?? first : first;
    // Name it: a library dye, an unstained signature, or by its shape.
    let match = null;
    if (sig.candidate) match = { ...sig.candidate, cosine: estimate ? cosine(estimate, sig.candidate.spectrum) : 1, orthogonal: true };
    if (estimate) {
      for (const c of [...latest.values()]) {
        const cos = cosine(estimate, c.spectrum);
        if (cos >= 0.97 && (!match || (!match.orthogonal && cos > match.cosine))) match = { ...c, cosine: cos };
      }
    }
    const shape = estimate ?? Float64Array.from(sig.u, (v) => Math.max(0, v));
    const peak = maxAbs(shape).at;
    const fraction = sig.affected.length / m.n;
    const afLike = match ? match.kind === 'autofluorescence' : asAF || (autofluorescenceLike(shape, detectors) && fraction >= 0.05);
    const spectrum = match?.kind === 'library' ? Float64Array.from(match.spectrum) : shape;
    const name = match?.kind === 'library' ? match.name : afLike ? `AF (${detectors[peak]}, from sample)` : `Unknown (${detectors[peak]})`;
    const change = afLike ? { afSignatures: [...afSignatures, { name, spectrum }] } : { spectra: [...spectra, { name, spectrum }] };
    let effect = null;
    try {
      const after = tryFix(change, { direction: sig.u });
      effect = { before: { brightResidual: baseline.brightResidual, unexplained: sig.pos - sig.neg }, after: { brightResidual: after.brightResidual, unexplained: after.excess } };
    } catch {
      effect = null;
    }
    const helped = effect && effect.after.unexplained < 0.3 * effect.before.unexplained;
    const evidence = [
      `${sig.pos.toLocaleString('en-US')} of ${m.n.toLocaleString('en-US')} events (${pct(fraction)}) carry light along one residual shape beyond ${opts.tail} noise SDs, against ${sig.neg} on the opposite side (noise alone puts as many on each side).`,
      `The unexplained light peaks at ${detectors[peak]}${estimate ? '; its full spectrum, estimated from those events with every abundance non-negative, is shown' : ''}.`,
    ];
    if (match?.kind === 'library') evidence.push(`It matches the library's ${match.name} (${day(match.entry)}${match.entry.file ? `, ${match.entry.file}` : ''}${match.orthogonal ? '' : `; cosine ${fixed(match.cosine)}`}).`);
    if (match?.kind === 'autofluorescence') evidence.push(`It matches the unstained control's autofluorescence signature ${match.name}, which the model does not use.`);
    if (effect) evidence.push(`Adding ${afLike ? 'that signature' : 'it'} leaves ${Math.max(0, effect.after.unexplained)} events unexplained instead of ${effect.before.unexplained}, and the bright events' median residual goes from ${fixed(effect.before.brightResidual)} to ${fixed(effect.after.brightResidual)}.`);
    if (afLike) {
      // Autofluorescence: gathered with the other autofluorescence checks into one finding below.
      added.push({ af: true, name, spectrum });
      afSignals.push({
        name,
        spectrum,
        match: match?.kind === 'autofluorescence' ? match : null,
        fraction,
        events: sig.pos,
        helped,
        effect,
        evidence: [...evidence, match ? '' : asAF ? `It grows with each event's autofluorescence (rank correlation ${fixed(followsAF, 2)} over the events that carry it), as a dye's would not.` : 'Its shape is broad and peaks on the UV, violet or blue laser, as cellular autofluorescence does, and many events carry it.'].filter(Boolean),
      });
    } else {
      added.push({ af: false, name, spectrum });
      const named = match?.kind === 'library';
      const unsure = ambiguous && !named;
      findings.push(finding({
        id: `missing-reference:${named ? match.name : detectors[peak]}`,
        kind: 'missing-reference',
        subject: named ? match.name : null,
        title: named ? `${match.name} is in the sample but has no reference` : unsure ? `Unexplained light peaking at ${detectors[peak]}: a dye without a reference, or autofluorescence` : `A dye peaking at ${detectors[peak]} is in the sample but has no reference`,
        severity: fraction >= 0.05 || sig.pos >= 1000 ? 'high' : 'medium',
        confidence: named ? 'high' : helped && !unsure ? 'medium' : 'low',
        bonus: helped && !unsure ? 0.5 : 0,
        evidence: named ? evidence : [
          ...evidence,
          unsure ? `It rises with the events' autofluorescence as the model fits it (rank correlation ${fixed(before, 2)}) but not once it is added (${fixed(kind.followsAF, 2)}), and its shape is narrow: a dye near the autofluorescence, which takes part of it, or autofluorescence of cells the unstained control lacks. Is a dye in the sample that the panel does not hold?` : 'No library spectrum matches it: add a reference control for the dye, or keep its spectrum estimated from the sample.',
        ],
        alternatives: unsure ? [{ action: 'add-autofluorescence', label: 'Add it as autofluorescence instead', text: 'If no dye in the sample emits there, it is autofluorescence: adds it to the autofluorescence signatures (each event chooses its own).', signatures: [{ name: `AF (${detectors[peak]}, from sample)`, spectrum: Array.from(spectrum) }] }] : [],
        measures: { events: sig.pos, fraction, peak: detectors[peak] },
        spectrum: Array.from(shape),
        compare: named ? { name: `Library ${match.name}`, spectrum: Array.from(peakNormalized(match.spectrum)) } : null,
        fix: named
          ? { action: 'add-library', label: `Add ${match.name} from the library`, text: `Unmixes ${match.name} with its library spectrum.`, entryId: match.entry.id, fluorochrome: match.name }
          : { action: 'add-spectrum', label: 'Add the estimated spectrum', text: 'Adds the spectrum estimated from this sample as a reference (name it after its dye). A reference control of the dye is better.', name: `Unknown ${detectors[peak]}`, spectrum: Array.from(spectrum) },
        effect,
      }));
    }
  });

  // Refit with the unexplained signatures added, so the other checks see the remaining faults.
  let m2 = m;
  let noise2 = noise;
  if (added.length) {
    progress(0.45, 'Refitting with the unexplained signatures');
    try {
      m2 = fitModel(cols, [...spectra, ...added.filter((a) => !a.af)], [...afSignatures, ...added.filter((a) => a.af)]);
      noise2 = noiseModel(m2);
    } catch {
      m2 = m;
      noise2 = noise;
    }
  }

  // 2. Tandems whose emission went to their donor, strongest first: each is corrected before the
  // next is sought, since a leak into a donor shifts the donor for its other tandems too.
  progress(0.55, 'Checking tandems against their donors');
  const extra = { spectra: added.filter((a) => !a.af), af: added.filter((a) => a.af) };
  const leaking = (l) => l.inliers >= 0.4 && l.atZero <= l.inliers / 4 && Math.abs(l.z) >= opts.leakZ && Math.abs(l.slope) >= opts.leakTolerance;
  let tandemSpectra = spectra.slice();
  let mLeak = m2;
  let noiseLeak = noise2;
  const leakFixed = new Set();
  for (let round = 0; round < 3; round += 1) {
    const leaks = tandemLeaks(mLeak, noiseLeak).filter((l) => !leakFixed.has(norm(l.tandem)));
    if (round === 0) checks.push({ check: 'tandem leaks', result: leaks.length ? leaks.map((l) => `${l.tandem}→${l.donor} ${fixed(l.slope)}${leaking(l) ? '' : ' (no consensus)'}`).join(', ') : 'no tandem with its donor in the panel' });
    const leak = leaks.filter(leaking).sort((x, y) => (y.inliers - y.atZero) - (x.inliers - x.atZero))[0];
    if (!leak) break;
    leakFixed.add(norm(leak.tandem));
    const more = leak.slope > 0;
    const t = tandemSpectra.find((s) => norm(s.name) === norm(leak.tandem));
    const dn = tandemSpectra.find((s) => norm(s.name) === norm(leak.donor));
    // The tandem as the sample has it: its reference with the donor's share moved.
    const mixed = peakNormalized(Float64Array.from(t.spectrum, (v, d) => v + leak.slope * dn.spectrum[d]).map((v) => Math.max(0, v)));
    const changed = tandemSpectra.map((s) => (s === t ? { name: s.name, spectrum: mixed } : s));
    let effect = null;
    try {
      const after = measure(cols, [...changed, ...extra.spectra], [...afSignatures, ...extra.af], { tail: opts.tail, leak: { tandem: leak.tandem, donor: leak.donor } });
      effect = { before: { leak: leak.slope, brightResidual: baseline.brightResidual }, after: { leak: after.leak, brightResidual: after.brightResidual } };
    } catch {
      effect = null;
    }
    const lib = library.filter((e) => norm(e.fluorochrome) === norm(leak.tandem)).at(-1);
    findings.push(finding({
      id: `degraded-tandem:sample:${leak.tandem}`,
      kind: 'degraded-tandem',
      subject: leak.tandem,
      title: more ? `${leak.tandem} in the sample has degraded more than its control` : `The ${leak.tandem} control has degraded more than the sample's ${leak.tandem}`,
      severity: Math.abs(leak.slope) >= 0.05 ? 'high' : 'medium',
      confidence: Math.abs(leak.z) >= 20 ? 'high' : 'medium',
      evidence: [
        `As ${leak.tandem} brightens, ${leak.donor}'s negative population ${more ? 'rises' : 'falls'} in proportion: ${fixed(Math.abs(leak.slope))} of ${leak.donor} per unit of ${leak.tandem} (z = ${fixed(leak.z, 1)}). ${pct(leak.inliers)} of the ${leak.tandem}-positive events lie on that line through ${leak.donor}'s negative center, against ${pct(leak.atZero)} on a flat one; across ${leak.tandem}'s range it moves ${leak.donor} by ${fixed(Math.abs(leak.rise / Math.max(leak.spread, 1e-9)), 1)} noise SDs.`,
        more
          ? `A degraded ${leak.tandem} emits partly as ${leak.donor}; in the sample it emits ${pct(Math.abs(leak.slope))} more as ${leak.donor} than its control did (light, heat, fixation or time between staining the control and the sample).`
          : `The control emits more as ${leak.donor} than the sample's ${leak.tandem} does: the control's tandem was the more degraded.`,
        'Its residual is small, because the lost emission is the donor\'s, which the model holds; it shows as a diagonal on a plot of the two.',
      ],
      measures: { slope: leak.slope, z: leak.z, inliers: leak.inliers, atZero: leak.atZero },
      spectrum: Array.from(mixed),
      compare: { name: `${leak.tandem} reference`, spectrum: Array.from(peakNormalized(t.spectrum)) },
      fix: {
        action: 'replace-spectrum',
        label: `Use the ${leak.tandem} spectrum this sample shows`,
        text: `Replaces the reference with ${leak.tandem} plus ${pct(Math.abs(leak.slope))} ${more ? 'more' : 'less'} ${leak.donor} emission. A control stained from the same vial at the same time as the samples is better.${lib ? ` The library holds ${leak.tandem} of ${day(lib)}.` : ''}`,
        fluorochrome: leak.tandem,
        name: leak.tandem,
        spectrum: Array.from(mixed),
      },
      effect,
    }));
    tandemSpectra = changed;
    try {
      mLeak = fitModel(cols, [...tandemSpectra, ...extra.spectra], [...afSignatures, ...extra.af]);
      noiseLeak = noiseModel(mLeak);
    } catch {
      break;
    }
  }

  // 3. References that differ from their dye in the sample, strongest first: each is corrected
  // before the next is sought, so a dye co-expressed with a mismatched one is not blamed for it.
  progress(0.65, 'Comparing each reference with its dye in the sample');
  let current = tandemSpectra;
  let mCurrent = mLeak;
  let noiseCurrent = noiseLeak;
  let testedCount = null;
  let untested = [];
  const corrected = new Set();
  for (let round = 0; round < 4; round += 1) {
    const rows = spectrumMismatches(mCurrent, noiseCurrent, excluded).filter((r) => r.index < current.length && !corrected.has(norm(r.name)));
    if (testedCount === null) {
      testedCount = rows.filter((r) => r.delta).length;
      untested = rows.filter((r) => !r.delta).map((r) => r.name);
    }
    const r = rows.filter((x) => x.delta && Math.abs(x.largest) >= opts.mismatchTolerance && Math.abs(x.zAt) >= opts.mismatchZ)
      .sort((x, y) => Math.abs(y.largest) * Math.min(Math.abs(y.zAt), 50) - Math.abs(x.largest) * Math.min(Math.abs(x.zAt), 50))[0];
    if (!r) break;
    corrected.add(norm(r.name));
    const ref = current[r.index];
    // A tandem whose leak was corrected above but whose spectrum still departs: more than its donor
    // changed, so the leak was part of a reference mismatch (a dye emitting differently on beads, a
    // different conjugate), and both are fixed together.
    const leakFinding = findings.find((f) => f.id === `degraded-tandem:sample:${r.name}`);
    if (leakFinding) findings.splice(findings.indexOf(leakFinding), 1);
    const original = spectra[r.index];
    const sampleSpectrum = peakNormalized(Float64Array.from(ref.spectrum, (v, d) => Math.max(0, v + r.delta[d])));
    const carrier = carrierOf(r.name);
    const onBeads = /bead/i.test(carrier ?? '');
    const withSpectrum = (spectrum) => current.map((s, k) => (k === r.index ? { name: s.name, spectrum } : s));
    const probe = (spectrum) => measure(cols, [...withSpectrum(spectrum), ...extra.spectra], [...afSignatures, ...extra.af], { tail: opts.tail, mismatch: r.name });
    // Library spectra of the dye: does one fit the sample? One on the control's carrier that fits
    // makes the control the odd one; on beads, one on cells that fits makes beads the cause.
    const fits = [];
    for (const entry of library.filter((e) => norm(e.fluorochrome) === norm(r.name)).slice(-4)) {
      try {
        const after = probe(Float64Array.from(entry.spectrum));
        if (after.mismatch !== null) fits.push({ entry, mismatch: after.mismatch, fits: after.mismatch < 0.5 * Math.abs(r.largest) });
      } catch { /* not usable */ }
    }
    const sameCarrier = (e) => !carrier || !e.carrier || /bead/i.test(e.carrier) === onBeads;
    const libraryMatch = fits.filter((x) => x.fits && sameCarrier(x.entry)).sort((x, y) => x.mismatch - y.mismatch)[0] ?? null;
    const cellMatch = onBeads ? fits.filter((x) => x.fits && !sameCarrier(x.entry)).sort((x, y) => x.mismatch - y.mismatch)[0] ?? null : null;
    const beadsAgree = onBeads && fits.some((x) => sameCarrier(x.entry) && !x.fits);
    // Other dyes the sample's spectrum may be (a mislabeled or substituted control).
    const lookalike = library.filter((e) => norm(e.fluorochrome) !== norm(r.name))
      .map((e) => ({ e, cos: cosine(sampleSpectrum, e.spectrum) })).sort((x, y) => y.cos - x.cos).find((o) => o.cos >= 0.995) ?? null;
    let effect = null;
    try {
      const after = probe(sampleSpectrum);
      effect = { before: { mismatch: Math.abs(r.largest) }, after: { mismatch: after.mismatch, brightResidual: after.brightResidual } };
    } catch {
      effect = null;
    }
    const departure = `Over ${r.events.toLocaleString('en-US')} events where ${r.name} is bright, the residual per unit of ${r.name} reaches ${fixed(r.largest)} (peak = 1) at ${detectors[r.at]} (z = ${fixed(r.zAt, 1)}): ${r.name} in the sample emits ${r.largest > 0 ? 'more' : 'less'} there than its reference says.`;
    let kind = 'wrong-reference';
    let title;
    let cause;
    let confidence = Math.abs(r.zAt) >= 15 ? 'high' : 'medium';
    if (libraryMatch) {
      title = `The ${r.name} control does not match the ${r.name} in the sample; the library's does`;
      cause = `The library's ${r.name} (${day(libraryMatch.entry)}${libraryMatch.entry.carrier ? `, on ${libraryMatch.entry.carrier}` : ''}) fits the sample (its departure falls to ${fixed(libraryMatch.mismatch)}): this experiment's control is the odd one, likely holding another dye or conjugate (a mislabeled tube, a similar dye read in the same channel) or another lot.`;
    } else if (onBeads && (cellMatch || beadsAgree || !fits.length)) {
      kind = 'bead-control';
      title = `${r.name}'s bead control does not match ${r.name} on the sample's cells`;
      cause = cellMatch
        ? `The library's ${r.name} on cells (${day(cellMatch.entry)}) fits the sample: ${r.name} emits differently on capture beads than on cells.`
        : beadsAgree
          ? `The library's ${r.name} on beads misfits the sample in the same way: ${r.name} emits differently on capture beads than on cells, so a bead reference misfits stained cells.`
          : `Its reference was measured on capture beads, and some dyes emit differently on beads than on cells. Without another ${r.name} spectrum to compare, a wrong dye in the control is also possible.`;
      if (!cellMatch && !beadsAgree) confidence = 'low';
    } else {
      title = `The ${r.name} reference does not match the dye in the sample`;
      cause = lookalike
        ? `The sample's ${r.name} matches the library's ${lookalike.e.fluorochrome} (cosine ${fixed(lookalike.cos, 4)}): the control may hold another dye.`
        : 'The control may hold a different dye or conjugate than the samples (a mislabeled tube, a similar dye read in the same channel, another lot).';
    }
    const use = libraryMatch ?? cellMatch;
    findings.push(finding({
      id: `${kind}:${r.name}`,
      kind,
      subject: r.name,
      title,
      severity: Math.abs(r.largest) >= 0.08 ? 'high' : 'medium',
      confidence,
      evidence: [departure, leakFinding ? `${leakFinding.evidence[0]} Correcting that alone leaves the departure above.` : '', cause, effect?.after.mismatch !== undefined && effect?.after.mismatch !== null ? `With the spectrum the sample shows, the departure falls to ${fixed(effect.after.mismatch)}.` : ''].filter(Boolean),
      measures: { departure: r.largest, detector: detectors[r.at], z: r.zAt, events: r.events, ...(leakFinding ? { donorSlope: leakFinding.measures.slope } : {}) },
      spectrum: Array.from(sampleSpectrum),
      compare: { name: `${r.name} reference`, spectrum: Array.from(peakNormalized(original.spectrum)) },
      fix: use
        ? { action: 'use-library', label: `Use the library's ${r.name}`, text: `Unmixes ${r.name} with the library's spectrum of ${day(use.entry)}${use.entry.carrier ? ` (${use.entry.carrier})` : ''}, which fits the sample.`, entryId: use.entry.id, fluorochrome: r.name }
        : { action: 'replace-spectrum', label: `Use the ${r.name} spectrum this sample shows`, text: `Replaces the reference with ${r.name} as the sample's bright ${r.name} events show it.${onBeads ? ' A single-stain control on the same cells is better.' : ' Check the control tube first.'}`, fluorochrome: r.name, name: r.name, spectrum: Array.from(sampleSpectrum) },
      effect,
    }));
    current = withSpectrum(sampleSpectrum);
    try {
      mCurrent = fitModel(cols, [...current, ...extra.spectra], [...afSignatures, ...extra.af]);
      noiseCurrent = noiseModel(mCurrent);
    } catch {
      break;
    }
  }
  checks.push({ check: 'spectra against the sample', result: `${testedCount ?? 0} of ${spectra.length} dyes bright enough to check${untested.length ? ` (too few bright events: ${untested.join(', ')})` : ''}` });

  // 4. Autofluorescence the unstained control does not represent.
  progress(0.8, 'Checking autofluorescence');
  const afDyes = autofluorescenceLikeDyes(m2, unstainedAF.length ? unstainedAF : afSignatures);
  const afEvidence = [];
  let afScore = 0;
  let coverage = null;
  if (scatter && context.scatter?.unstained) {
    coverage = scatterCoverage(scatter, context.scatter.unstained);
    if (coverage && coverage.fraction >= 0.05) {
      afScore += coverage.fraction >= 0.15 ? 2 : 1;
      const higher = coverage.uncovered && coverage.covered && coverage.uncovered.ssc > 1.5 * coverage.covered.ssc;
      afEvidence.push(`${pct(coverage.fraction)} of the sample's events lie where the unstained control has almost no cells (scatter)${higher ? `, at higher side scatter (median SSC ${Math.round(coverage.uncovered.ssc).toLocaleString('en-US')} against ${Math.round(coverage.covered.ssc).toLocaleString('en-US')}): granular cells such as monocytes or granulocytes, typically the most autofluorescent` : ''}. Their autofluorescence is not in the unstained control's signatures.`);
    }
    checks.push({ check: 'unstained control covers the sample\'s cells', result: coverage ? `${pct(1 - coverage.fraction)} covered` : 'not checked' });
  }
  // The uncovered events' autofluorescence goes into the dyes that resemble autofluorescence:
  // their negative populations sit higher there than in the covered events.
  if (coverage && coverage.fraction >= 0.05 && afDyes.length) {
    const inside = new Uint8Array(m2.n).fill(1);
    for (const i of coverage.events) inside[i] = 0;
    const shifted = [];
    for (const dye of afDyes) {
      const a = m2.A[dye.f];
      const covered = [];
      const uncovered = [];
      for (let i = 0; i < m2.n; i += 1) (inside[i] ? covered : uncovered).push(a[i]);
      const c = Float64Array.from(covered).sort();
      const u = Float64Array.from(uncovered).sort();
      const spread = c[Math.floor(c.length * 0.5)] - c[Math.floor(c.length * 0.1587)];
      const shift = spread > 0 ? (halfSampleMode(u) - halfSampleMode(c)) / spread : 0;
      if (shift >= 1.5) shifted.push({ name: dye.name, shift });
    }
    if (shifted.length >= 2) {
      afScore += 1;
      afEvidence.push(`In those events the negative populations of ${shifted.map((x) => `${x.name} (${fixed(x.shift, 1)} spreads)`).join(', ')} sit higher than in the rest: dyes that resemble autofluorescence take up the autofluorescence the model lacks.`);
    }
  }
  const driver = m2.afAbundance ?? scatter?.ssc ?? null;
  const rising = [];
  if (driver && afDyes.length) {
    for (const dye of afDyes) {
      const trend = modeTrend(driver, m2.A[dye.f]);
      if (trend && trend.z >= 6 && trend.rise > 2 * trend.spread) rising.push({ ...dye, ...trend });
    }
    checks.push({ check: 'autofluorescence-like dyes against autofluorescence', result: rising.length ? rising.map((r) => r.name).join(', ') : `none of ${afDyes.length} rise` });
    if (rising.length >= 2) {
      afScore += rising.length >= 3 ? 2 : 1;
      afEvidence.push(`The negative populations of ${rising.map((r) => `${r.name} (${fixed(r.rise / r.spread, 1)} spreads)`).join(', ')} rise with the events' ${m2.afAbundance ? 'autofluorescence' : 'side scatter'}: these dyes resemble autofluorescence, and autofluorescence the model lacks is unmixed into them.`);
    }
  }
  // The sample's autofluorescence-dominated events against the unstained control's own, fitted
  // with the same model: the unstained control is fitted as well as its signatures allow, so a
  // sample whose cells fit worse has autofluorescence those signatures lack.
  let afFix = null;
  if (context.unstained?.columns && m.afAbundance) {
    try {
      const uc = context.unstained.columns;
      const un = uc[0].length;
      const upick = un > opts.maxEvents ? sampleIndices(un, opts.maxEvents, createRandom(opts.seed + 1)) : null;
      const ucols = upick ? uc.map((c) => Float64Array.from(upick, (i) => c[i])) : uc.map((c) => Float64Array.from(c));
      const own = autofluorescenceDominated(fitModel(ucols, spectra, afSignatures));
      const here = autofluorescenceDominated(m);
      if (own.events.length < 300 || here.events.length < 300) checks.push({ check: 'autofluorescence-dominated events fit as well as the unstained control\'s', result: `too few such events to compare (${here.events.length} in the sample, ${own.events.length} in the unstained control)` });
      else {
        const ratio = median(here.residuals) / median(own.residuals);
        checks.push({ check: 'autofluorescence-dominated events fit as well as the unstained control\'s', result: `residual ${fixed(median(here.residuals))} against ${fixed(median(own.residuals))} (${fixed(ratio, 2)}×)` });
        if (ratio >= 1.25) {
          afScore += ratio >= 1.5 ? 3 : 2;
          afEvidence.push(`The sample's ${here.events.length.toLocaleString('en-US')} events whose signal is mostly autofluorescence are fitted ${fixed(ratio, 2)} times worse than the unstained control's own (median relative residual ${fixed(median(here.residuals))} against ${fixed(median(own.residuals))}).`);
          // Signatures of the sample's own autofluorescence-dominated cells, tried as a fix.
          if (here.events.length >= 1000) {
            const own2 = extractAutofluorescence(here.events.length ? cols.map((c) => Float64Array.from(here.events, (i) => c[i])) : cols, detectors, { seed: opts.seed, maxSignatures: 4 });
            const sampleAF = own2.signatures.map((x, k) => ({ name: `AF${afSignatures.length + k + 1} (from sample)`, spectrum: Float64Array.from(x.spectrum) }));
            const after = measure(cols, spectra, [...afSignatures, ...sampleAF], { tail: opts.tail, afDominated: true });
            afFix = {
              fix: { action: 'add-autofluorescence', label: `Add ${sampleAF.length} signature${sampleAF.length > 1 ? 's' : ''} from this sample`, text: `Adds the autofluorescence signatures of this sample's autofluorescence-dominated cells (${here.events.length.toLocaleString('en-US')} events) to the unstained control's, each event choosing its own. An unstained control prepared as the samples were is better.`, signatures: sampleAF.map((x) => ({ name: x.name, spectrum: Array.from(x.spectrum) })) },
              effect: { before: { afDominatedResidual: median(here.residuals), brightResidual: baseline.brightResidual }, after: { afDominatedResidual: after.afDominated, brightResidual: after.brightResidual } },
            };
            afEvidence.push(`With ${sampleAF.length} signature${sampleAF.length > 1 ? 's' : ''} extracted from those events added, their residual falls to ${fixed(after.afDominated)} (the unstained control's own: ${fixed(median(own.residuals))}).`);
          }
        }
      }
    } catch { /* the comparison is optional */ }
  }
  const unused = afSignals.find((x) => x.match);
  if (afSignals.length) afScore += unused ? 3 : afSignals.some((x) => x.helped) ? 2 : 1;
  // A weak sign alone (an autofluorescence-like signature that adding does not resolve) is
  // reported as a note.
  if (afScore >= 2 || afSignals.length) {
    const evidence = [...afSignals.flatMap((x) => x.evidence), ...afEvidence];
    // The fix: the unstained control's unused signature; else the sample's own signatures when
    // they fit its autofluorescence-dominated cells better; else the unexplained signatures.
    let fix = null;
    let effect = null;
    const alternatives = [];
    const fromUnexplained = afSignals.filter((x) => !x.match);
    let unexplainedFix = null;
    if (fromUnexplained.length) {
      const signatures = fromUnexplained.map((x) => ({ name: x.name, spectrum: x.spectrum }));
      let joint = null;
      try {
        joint = measure(cols, spectra, [...afSignatures, ...signatures], { tail: opts.tail });
      } catch { /* reported without its effect */ }
      unexplainedFix = {
        fix: { action: 'add-autofluorescence', label: `Add the unexplained signature${signatures.length > 1 ? 's' : ''} as autofluorescence`, text: 'Adds the autofluorescence estimated from the events that carry it to the unstained control\'s signatures (each event chooses its own). An unstained control of the same cells, prepared as the samples were, is better.', signatures: signatures.map((x) => ({ name: x.name, spectrum: Array.from(x.spectrum) })) },
        effect: joint ? { before: { brightResidual: baseline.brightResidual }, after: { brightResidual: joint.brightResidual } } : null,
      };
    }
    if (unused) {
      fix = { action: 'per-event-af', label: 'Unmix with every autofluorescence signature', text: 'Use all of the unstained control\'s signatures, each event choosing its own.' };
      effect = unused.effect;
    } else if (afFix && afFix.effect.after.afDominatedResidual < 0.9 * afFix.effect.before.afDominatedResidual) {
      ({ fix, effect } = afFix);
      if (unexplainedFix) alternatives.push(unexplainedFix.fix);
    } else if (unexplainedFix) {
      ({ fix, effect } = unexplainedFix);
    } else if (unstainedAF.length > afSignatures.length) {
      fix = { action: 'per-event-af', label: 'Unmix with every autofluorescence signature', text: 'Use all of the unstained control\'s signatures, each event choosing its own.' };
    } else {
      fix = { action: 'advice', label: 'Use an unstained control of the same cells', text: 'Extract autofluorescence from an unstained control that holds every cell type of the samples, prepared (fixed, permeabilized) as they were.' };
    }
    const fraction = afSignals.reduce((sum, x) => sum + x.fraction, 0);
    findings.push(finding({
      id: 'autofluorescence',
      kind: 'autofluorescence',
      subject: null,
      title: unused
        ? `Autofluorescence signature ${unused.match.name} of the unstained control is not used`
        : coverage?.fraction >= 0.05 && !afSignals.length
          ? 'The unstained control lacks cells the sample has, and their autofluorescence'
          : afScore < 2
            ? 'A few events carry autofluorescence the model does not describe'
            : 'The sample\'s autofluorescence differs from the unstained control\'s',
      severity: afScore < 2 ? 'low' : afScore >= 3 || fraction >= 0.2 ? 'high' : 'medium',
      confidence: unused || afScore >= 4 ? 'high' : afScore < 2 ? 'low' : 'medium',
      bonus: afSignals.some((x) => x.helped) || (afFix && fix === afFix.fix) ? 0.5 : 0,
      evidence,
      measures: { fraction: fraction || null, uncovered: coverage?.fraction ?? null, dyes: rising.map((r) => r.name) },
      spectrum: afSignals[0] ? Array.from(afSignals[0].spectrum) : null,
      compare: unused ? { name: unused.match.name, spectrum: Array.from(unused.match.spectrum) } : null,
      fix,
      alternatives,
      effect,
    }));
  }

  // 5. The controls on their own.
  progress(0.9, 'Checking the controls');
  if (references.length) {
    const controlFindings = diagnoseControls(references, { detectors, library, afSignatures: unstainedAF.length ? unstainedAF : afSignatures });
    for (const f of controlFindings) {
      // A control check that the sample confirms ranks with the sample's finding.
      const sampleSide = findings.find((s) => s.subject && norm(s.subject) === norm(f.subject) && !s.fromControls);
      if (sampleSide) {
        sampleSide.evidence.push(...f.evidence);
        sampleSide.score += 0.5;
      } else {
        findings.push({ ...f, score: f.score - 1, fromControls: true });
      }
    }
  }

  findings.sort((a, b) => b.score - a.score);
  progress(1, 'Done');
  return {
    events: m.n,
    eventsInSample: total,
    detectors: Array.from(detectors),
    baseline,
    findings,
    healthy: !findings.some((f) => f.severity !== 'low' && !f.fromControls),
    checks,
  };
}
