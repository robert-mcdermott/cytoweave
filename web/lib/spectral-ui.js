// Pure helpers for the Spectral view (web/ui/mode-spectral.js): detector discovery and laser
// bands, fluorochrome names for controls, display scales for unmixed channels, plain-language
// interpretation of panel diagnostics and model comparisons, and the "spectral ribbon" grid.
// No DOM, so everything here is testable in Node.

import { LASER_ORDER, parseDetectorName, detectorOrder } from './spectral.js';
import { estimateLogicleW, quantile } from './transforms.js';

export const UNMIXED_SUFFIX = ' (unmixed)';
export const AF_CHANNEL = `AF${UNMIXED_SUFFIX}`;
export const AF_TYPE_CHANNEL = `AF signature${UNMIXED_SUFFIX}`;
export const RESIDUAL_CHANNEL = `Residual${UNMIXED_SUFFIX}`;

export function unmixedChannel(name) {
  return `${name}${UNMIXED_SUFFIX}`;
}

// The raw spectral detectors of a sample, in laser order (UV, V, B, YG, R, IR). Area ('-A') or
// unsuffixed detectors are used; heights and widths are ignored. Vendors whose detector names
// are not recognized still work when the file is marked spectral and has at least 16
// fluorescence detectors: those are used in file order.
export function spectralDetectors(channels, technology = null) {
  const recognized = [];
  for (const channel of channels) {
    const info = parseDetectorName(channel.name);
    if (info && (info.measurement === 'A' || info.measurement === null)) recognized.push(channel.name);
  }
  if (recognized.length >= 8) return detectorOrder(recognized);
  if (technology === 'spectral') {
    const fluorescence = channels.filter((c) => c.type === 'fluorescence' && !/-[HW]$/i.test(c.name)).map((c) => c.name);
    if (fluorescence.length >= 16) return fluorescence;
  }
  return [];
}

// Detectors shared by every sample (in the first sample's order).
export function commonDetectors(lists) {
  const valid = lists.filter((list) => list.length);
  if (!valid.length) return [];
  const [first, ...rest] = valid;
  const sets = rest.map((list) => new Set(list));
  return first.filter((name) => sets.every((set) => set.has(name)));
}

// Consecutive runs of detectors on the same laser: [{ laser, start, end (exclusive) }].
export function laserBands(detectors) {
  const bands = [];
  detectors.forEach((name, i) => {
    const laser = parseDetectorName(name)?.laser ?? '';
    const last = bands[bands.length - 1];
    if (last && last.laser === laser) last.end = i + 1;
    else bands.push({ laser, start: i, end: i + 1 });
  });
  return bands;
}

export const LASER_LABELS = { UV: 'UV 355', V: 'Violet 405', B: 'Blue 488', YG: 'Yellow-green 561', R: 'Red 640', IR: 'IR 808' };

// A short tick label for a detector: its number on the laser ("7" for V7-A), else the name.
export function detectorTick(name) {
  const info = parseDetectorName(name);
  return info ? String(info.index) : name.replace(/-[AHW]$/i, '');
}

export function laserRank(laser) {
  const i = LASER_ORDER.indexOf(laser);
  return i < 0 ? LASER_ORDER.length : i;
}

// A fluorochrome name for a single-stain control: the user's name (meta.fluorochrome), else the
// control's stain when it names a dye rather than a detector ("FITC-A" → "FITC"), else a name
// cleaned from the file name ("Ref_BV421.fcs" → "BV421", "PE-Cy7 Stained Control" → "PE-Cy7").
export function guessFluorochrome(sample, detectors = []) {
  if (sample.meta?.fluorochrome) return sample.meta.fluorochrome;
  const stain = sample.stain;
  if (stain && !detectors.includes(stain) && !parseDetectorName(stain)) return stain.replace(/-[AHW]$/i, '');
  let name = String(sample.name ?? '').replace(/\.(fcs|lmd)$/i, '');
  name = name.replace(/^(ref(erence)?|comp(ensation)?|ss|single[ _-]?stain(ed)?|ctrl|control)[ _-]+/i, '');
  name = name.replace(/[ _-]+(stained[ _-]+control|single[ _-]?stain(ed)?|control|ctrl|beads?|cells?|reference|ref|comp)$/i, '');
  name = name.replace(/[ _-]*\((beads?|cells?)\)$/i, '');
  return name.trim() || String(sample.name ?? 'Control');
}

// The peak detector a control names in `stain`, when it is one of the detectors.
export function peakHint(sample, detectors) {
  return sample.stain && detectors.includes(sample.stain) ? sample.stain : null;
}

// A spectrum as a compact JSON-safe array (6 significant decimals).
export function serializeSpectrum(values) {
  return Array.from(values, (v) => (Number.isFinite(v) ? +v.toFixed(6) : 0));
}

// Display scale for an unmixed abundance channel: logicle with the top at the detectors' range
// (abundances are in peak-detector units), M decades (5.6 for a 2²² range, 4.5 for 2¹⁸) and the
// linear width estimated from the channel's negative tail (Parks et al. 2006).
export function abundanceTransform(values, range) {
  let T = range > 0 ? range : 0;
  if (!T && values?.length) T = Math.max(1000, quantile(values, 0.9999) * 1.5);
  T = Math.max(T, 1000);
  const M = Math.min(5.6, Math.max(3, Math.log10(T) - 1));
  const W = values?.length ? estimateLogicleW(values, T, M) : 0.5;
  return { type: 'logicle', T, W: +W.toFixed(3), M: +M.toFixed(2), A: 0 };
}

// Display scale for the residual channel (‖r − âS‖ / ‖r‖, 0 to about 1).
export function residualTransform(values) {
  const top = values?.length ? quantile(values, 0.998) : 1;
  return { type: 'linear', min: 0, max: Math.max(0.05, Math.min(1.5, Math.ceil(top * 1.2 * 20) / 20)) };
}

// Plain-language reading of the complexity index (condition number of the reference matrix).
// The bands are rules of thumb from published high-parameter panels (40-color Aurora panels
// sit around 40–60), not hard limits.
export function complexityInterpretation(ci, count) {
  if (!Number.isFinite(ci)) {
    return { level: 'danger', label: 'Not unmixable', text: 'At least one spectrum is a combination of others, so their abundances cannot be separated. Remove or replace the duplicate.' };
  }
  const per = count ? ` for ${count} signatures` : '';
  if (ci < 5) return { level: 'ok', label: 'Low', text: `The spectra overlap little${per}; unmixing adds little spread.` };
  if (ci < 20) return { level: 'ok', label: 'Moderate', text: `Typical of a mid-size panel${per}. Expect some spreading between the most similar pairs.` };
  if (ci < 60) return { level: 'warn', label: 'High', text: `Typical of 30–40-color panels${per}. Spreading between similar dyes will limit resolution of dim markers on them; check the similar pairs below.` };
  return { level: 'danger', label: 'Very high', text: `Unmixing will amplify noise strongly${per}. Consider replacing one dye of the most similar pairs, or moving dim markers to bright, distinct dyes.` };
}

// Off-diagonal pairs of a similarity matrix at or above a threshold, most similar first.
export function similarPairs(sim, threshold = 0.9) {
  return sim.pairs.filter((p) => p.similarity >= threshold);
}

export function similarityLevel(value) {
  if (value >= 0.98) return 'danger';
  if (value >= 0.9) return 'warn';
  return 'ok';
}

// Reads a compareUnmixing report: which model resolves best, in a sentence, with caveats.
export function recommendFromComparison(report) {
  const caveats = [];
  const ranking = report.ranking ?? [];
  if (!ranking.length) return { model: null, sentence: 'No models were compared.', caveats };
  const baseline = report.models[0];
  const fair = ranking.filter((r) => !r.clipped);
  const pool = fair.length ? fair : ranking;
  const best = pool[0];
  const gain = 1 - best.relativeSpread;
  let sentence;
  if (best.name === baseline.name || Math.abs(gain) < 0.03) {
    sentence = `The models resolve negatives about equally on this sample (within 3% of ${baseline.name}); ${baseline.name} is the simplest choice.`;
  } else if (gain > 0) {
    sentence = `${best.name} resolves best: its negative populations are ${(100 * gain).toFixed(0)}% narrower than with ${baseline.name} (geometric mean over dyes).`;
  } else {
    sentence = `${baseline.name} resolves best; the alternatives widen negative populations.`;
  }
  const bestModel = report.models.find((m) => m.name === best.name);
  const minResidual = Math.min(...report.models.map((m) => m.brightResidual).filter(Number.isFinite));
  if (bestModel && Number.isFinite(bestModel.brightResidual) && bestModel.brightResidual > 1.5 * minResidual) {
    const fitter = report.models.find((m) => m.brightResidual === minResidual);
    caveats.push(`${fitter.name} fits bright events better (residual ${formatFraction(minResidual)} vs ${formatFraction(bestModel.brightResidual)}): a model that leaves more signal unexplained can look narrower while being biased.`);
  }
  for (const model of report.models) {
    if (!model.autofluorescence) continue;
    const plain = report.models.find((m) => !m.autofluorescence && m.method === model.method);
    if (plain && plain.brightResidual > 0 && model.brightResidual < 0.8 * plain.brightResidual) {
      caveats.push(`Modeling autofluorescence (${model.name}) explains more of the signal: bright-event residual ${formatFraction(model.brightResidual)} vs ${formatFraction(plain.brightResidual)} without it.`);
    }
  }
  for (const r of ranking) {
    if (!r.clipped) continue;
    const model = report.models.find((m) => m.name === r.name);
    const zero = Math.max(...model.fluorochromes.map((f) => f.zeroFraction));
    caveats.push(`${r.name} clips values at zero (up to ${(100 * zero).toFixed(0)}% of negatives sit exactly at 0); its narrower negatives are compression, not better resolution, and dim populations are biased upward.`);
  }
  const source = report.negativeSource === 'unstained' ? 'unstained-control events'
    : report.negativeSource === 'given' ? 'the negatives you chose'
      : 'the dimmest half of events at each dye\'s peak detector';
  caveats.push(`Spread is the robust SD of ${source} (${report.events.toLocaleString('en-US')} events); another population may rank the models differently.`);
  return { model: best.name, sentence, caveats };
}

function formatFraction(v) {
  return Number.isFinite(v) ? v.toFixed(3) : '—';
}

// The "spectral ribbon": counts of events per (detector, intensity bin), from display-scaled
// detector columns (0–1). Returns Float32Array(bins × D), row b = bin b from the bottom.
export function ribbonCounts(scaled, indices, bins) {
  const D = scaled.length;
  const grid = new Float32Array(bins * D);
  const n = indices ? indices.length : (scaled[0]?.length ?? 0);
  for (let d = 0; d < D; d += 1) {
    const column = scaled[d];
    for (let k = 0; k < n; k += 1) {
      const v = column[indices ? indices[k] : k];
      if (!(v === v)) continue;
      let b = Math.floor(v * bins);
      if (b < 0) b = 0;
      else if (b >= bins) b = bins - 1;
      grid[b * D + d] += 1;
    }
  }
  return grid;
}

// Every k-th index so at most `max` events are used (deterministic, order-preserving).
export function thinIndices(indices, total, max) {
  const n = indices ? indices.length : total;
  if (n <= max) return indices ?? null;
  const step = n / max;
  const out = new Uint32Array(max);
  for (let i = 0; i < max; i += 1) out[i] = indices ? indices[Math.floor(i * step)] : Math.floor(i * step);
  return out;
}

// Copies the given detector columns (all events, or `indices`) into fresh Float32Arrays that
// can be transferred to a worker without detaching the sample's own data.
export function copyColumns(columns, indices = null) {
  return columns.map((column) => {
    if (!indices) return column.slice();
    const out = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) out[i] = column[indices[i]];
    return out;
  });
}

export const METHODS = [
  { id: 'ols', label: 'OLS', long: 'Ordinary least squares', text: 'The standard (SpectroFlo) method: unbiased, negatives spread symmetrically around zero.' },
  { id: 'wls-fixed', label: 'WLS (fixed)', long: 'Weighted least squares, fixed weights', text: 'Down-weights detectors that are noisy in the unstained control. As fast as OLS.' },
  { id: 'wls', label: 'WLS (per event)', long: 'Weighted least squares, reweighted per event', text: 'Also down-weights each event\'s own bright detectors (photon noise), which narrows the spread bright co-stains impose. About 10× slower.' },
  { id: 'nnls', label: 'NNLS', long: 'Non-negative least squares', text: 'Forbids negative abundances. Negatives pile up at zero and dim populations are biased upward; use for display, not for gating dim markers.' },
];

export const AF_MODES = [
  { id: 'none', label: 'None', text: 'Autofluorescence is left in the fluorochrome channels (raises their background, most in violet and UV dyes).' },
  { id: 'single', label: 'One signature', text: 'The main autofluorescence signature is unmixed as an extra channel, AF (unmixed).' },
  { id: 'perEvent', label: 'Per event', text: 'Each event uses the autofluorescence signature that fits it best (per-cell autofluorescence matching, as in AutoSpectral by Burton et al.); its abundance goes to AF (unmixed) and its choice to AF signature (unmixed).' },
];
