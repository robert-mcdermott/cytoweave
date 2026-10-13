// The spectral workflow without its view: the reference library's state, reference spectra from
// single-stain controls, autofluorescence signatures from the unstained control, and unmixing.
// The Spectral view (mode-spectral.js) and agents (remote.js) both run it; neither progress toasts
// nor dialogs are shown here (callers pass onProgress and track to follow and cancel the jobs).
//
// The reference library is one derived record, { id: SETUP_ID, kind: 'spectral-setup', … }.

import { population } from '../lib/engine.js';
import { ROOT, appendLog, gatePath } from '../lib/workspace.js';
import { complexityIndex } from '../lib/spectral.js';
import { spectrumOn } from '../lib/spectral-library.js';
import {
  AF_CHANNEL,
  AF_MODES,
  AF_TYPE_CHANNEL,
  METHODS,
  RESIDUAL_CHANNEL,
  abundanceTransform,
  commonDetectors,
  copyColumns,
  guessFluorochrome,
  peakHint,
  residualTransform,
  serializeSpectrum,
  spectralDetectors,
  thinIndices,
  unmixedChannel,
} from '../lib/spectral-ui.js';

export const SETUP_ID = 'spectral-setup';
export const SEED = 1;
export const LIMITS = { control: 100000, unstained: 30000, af: 60000, check: 30000, compare: 20000, ribbon: 40000, doctor: 20000 };

// The spectral state of a workspace: controls, the reference library and its settings.
export function spectralState(ws) {
  const setup = ws.derived.find((d) => d.id === SETUP_ID) ?? null;
  const controls = ws.samples.filter((s) => s.role === 'single-stain');
  const unstainedList = ws.samples.filter((s) => s.role === 'unstained');
  const chosen = setup?.params?.unstainedId;
  const unstainedSample = unstainedList.find((s) => s.id === chosen) ?? unstainedList[0] ?? null;
  const controlSettings = (id) => setup?.controlSettings?.[id] ?? {};

  // The detectors shared by the controls and the unstained control (or by any sample).
  const panelDetectors = () => {
    const involved = [...controls, ...unstainedList];
    const pool = involved.length ? involved : ws.samples;
    return commonDetectors(pool.map((s) => spectralDetectors(s.channels, s.technology)));
  };

  const detectorRange = (detectors) => {
    let range = 0;
    for (const sample of ws.samples) {
      for (const c of sample.channels) if (detectors.includes(c.name) && c.range > range) range = c.range;
      if (range) break;
    }
    return range;
  };

  // References of current controls, in the order the controls are listed, named from the sample,
  // then library spectra added for fluorochromes without a control (a stand-in sample, no events).
  const references = () => {
    const refs = setup?.references ?? [];
    const detectors = setup?.params?.detectors ?? panelDetectors();
    const fromControls = controls.map((sample) => {
      const ref = refs.find((r) => r.sampleId === sample.id);
      return { sample, ref, name: guessFluorochrome(sample, detectors), marker: sample.meta?.marker ?? '', excluded: Boolean(controlSettings(sample.id).excluded) };
    });
    const fromLibrary = (setup?.libraryReferences ?? []).map((e) => {
      const id = `lib:${e.id}`;
      const ref = { spectrum: e.spectrum, peakDetector: e.peakDetector, computed: e.added, fromLibrary: true, entry: e, brightness: e.quality?.brightness ?? null, separation: e.quality?.separation ?? null, stainIndex: e.quality?.stainIndex ?? null, heterogeneity: e.quality?.heterogeneity ?? null, warnings: [], positiveEvents: null, negativeEvents: null };
      return { sample: { id, name: `Library · ${(e.date ?? e.added ?? '').slice(0, 10)} · ${e.file ?? ''}`, library: true, role: 'library', meta: {} }, ref, name: e.fluorochrome, marker: e.marker ?? '', excluded: Boolean(controlSettings(id).excluded) };
    });
    return [...fromControls, ...fromLibrary];
  };

  const activeRefs = () => references().filter((r) => r.ref?.spectrum && !r.excluded);
  const afSignatures = () => setup?.autofluorescence?.signatures ?? [];
  const settings = () => {
    const s = setup?.settings ?? {};
    const af = afSignatures();
    return { method: s.method ?? 'ols', afMode: af.length ? (s.afMode ?? (af.length > 1 ? 'perEvent' : 'single')) : 'none' };
  };
  const panelSpectra = () => activeRefs().map((r) => ({ name: r.name, spectrum: r.ref.spectrum }));
  const duplicateNames = () => {
    const seen = new Map();
    for (const r of activeRefs()) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  };
  const panelComplexity = () => {
    const spectra = panelSpectra();
    if (!spectra.length) return Number.NaN;
    try {
      return complexityIndex(spectra);
    } catch {
      return Infinity;
    }
  };
  const unmixProblems = () => {
    const problems = [];
    const refs = activeRefs();
    if (!refs.length) problems.push('Compute reference spectra from the controls first.');
    const dups = duplicateNames();
    if (dups.length) problems.push(`Two controls are named ${dups.join(', ')}; give each fluorochrome a unique name.`);
    if (refs.length && !Number.isFinite(panelComplexity())) problems.push('The reference spectra are linearly dependent; exclude the duplicate control.');
    return problems;
  };
  return { setup, controls, unstainedList, unstainedSample, controlSettings, panelDetectors, detectorRange, references, activeRefs, afSignatures, settings, panelSpectra, duplicateNames, panelComplexity, unmixProblems };
}

// A new reference library record.
export function baseSetup(state, version) {
  return {
    id: SETUP_ID,
    kind: 'spectral-setup',
    name: 'Spectral reference library',
    method: 'Reference spectra from single-stain controls: per detector, median(positive) − median(negative), normalized to a peak of 1. Controls are gated automatically without scatter gates (autoGateControl): positives are the brightest events above the negative on the peak detector; negatives are matched in autofluorescence on dye-dark detectors.',
    params: { detectors: state.panelDetectors(), seed: SEED },
    seed: SEED,
    software: `CytoWeave ${version ?? ''}`.trim(),
    outputs: [],
    references: [],
    autofluorescence: null,
    controlSettings: {},
    settings: {},
    spreading: null,
  };
}

function detectorColumns(view, detectors) {
  return detectors.map((name) => {
    const column = view.raw.get(name);
    if (!column) throw new Error(`"${view.record.name}" has no detector ${name}.`);
    return column;
  });
}

// The unstained control's detector columns (thinned), or null without one. cache: a Map the
// caller keeps between calls.
export async function unstainedColumns(app, state, detectors, cache = new Map()) {
  const sample = state.unstainedSample;
  if (!sample) return null;
  const key = `${sample.id}|${detectors.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const view = await app.data.ensure(sample.id);
  const columns = copyColumns(detectorColumns(view, detectors), thinIndices(null, view.eventCount, LIMITS.unstained));
  cache.clear();
  cache.set(key, columns);
  return columns;
}

// Reference spectra of the controls (all, or the ids in `only`), each gated automatically.
// Returns { references (the library's references with these replaced), params, computed (the
// entries of this run), canceled } without changing the workspace. options: onProgress(fraction,
// message), track(job) (each worker job, to cancel), isCanceled(), cache.
export async function computeReferences(app, options = {}) {
  const { only = null, onProgress, track = (job) => job, isCanceled = () => false, cache } = options;
  const ws = app.store.ws;
  const state = spectralState(ws);
  const detectors = state.panelDetectors();
  if (!detectors.length) throw new Error('The controls have no raw spectral detectors in common.');
  const list = state.controls.filter((s) => !only || only.includes(s.id));
  const refs = [...(state.setup?.references ?? [])];
  const range = state.detectorRange(detectors);
  const needUnstained = list.some((s) => state.controlSettings(s.id).negative === 'unstained');
  const unstained = needUnstained ? await unstainedColumns(app, state, detectors, cache) : null;
  const computed = [];
  const worker = app.worker('spectral');
  for (let i = 0; i < list.length; i += 1) {
    if (isCanceled()) return { canceled: true };
    const sample = list[i];
    const name = guessFluorochrome(sample, detectors);
    onProgress?.(i / list.length, `Gating ${name} (${i + 1}/${list.length})`);
    const entry = { sampleId: sample.id, sampleName: sample.name, fluorochrome: name, marker: sample.meta?.marker ?? '', computed: new Date().toISOString() };
    try {
      const view = await app.data.ensure(sample.id);
      const columns = copyColumns(detectorColumns(view, detectors), thinIndices(null, view.eventCount, LIMITS.control));
      const settings = { negative: state.controlSettings(sample.id).negative ?? 'internal', peakDetector: state.controlSettings(sample.id).peakDetector ?? peakHint(sample, detectors), name, seed: SEED, range };
      const job = track(worker.run('referenceFromControl', { columns, detectors, unstained: settings.negative === 'unstained' ? unstained : null, options: settings }, { transfer: columns.map((c) => c.buffer) }));
      const result = await job.promise;
      const ref = result.reference;
      Object.assign(entry, {
        eventsUsed: columns[0].length,
        peakDetector: ref?.peakDetector ?? result.gate.peakDetector,
        positiveEvents: result.gate.positiveEvents,
        negativeEvents: result.gate.negativeEvents,
        negativeSource: result.gate.negativeSource,
        matchedNegatives: result.gate.matchedNegatives,
        spectrum: ref ? serializeSpectrum(ref.spectrum) : null,
        separation: ref?.quality.separation ?? null,
        stainIndex: ref?.quality.stainIndex ?? null,
        heterogeneity: Number.isFinite(ref?.quality.heterogeneity) ? ref.quality.heterogeneity : null,
        mixture: ref?.quality.mixture ? serializeSpectrum(ref.quality.mixture) : null,
        brightness: ref?.quality.brightness ?? null,
        warnings: [...result.gate.warnings, ...(ref?.quality.warnings ?? [])].filter((w, k, all) => all.indexOf(w) === k),
        error: ref ? null : (result.error ?? 'No spectrum could be computed.'),
      });
    } catch (error) {
      if (error.canceled) return { canceled: true };
      entry.error = error.message;
      entry.warnings = [];
      entry.spectrum = null;
    }
    computed.push(entry);
    const at = refs.findIndex((r) => r.sampleId === sample.id);
    if (at >= 0) refs[at] = entry;
    else refs.push(entry);
  }
  const params = { ...(state.setup?.params ?? {}), detectors, seed: SEED, unstainedId: state.unstainedSample?.id ?? null, maxEventsPerControl: LIMITS.control };
  return { references: refs.filter((r) => ws.samples.some((s) => s.id === r.sampleId)), params, computed, canceled: false };
}

// Autofluorescence signatures of the unstained control, within a population of it (gateId) when
// it applies. Returns { autofluorescence, afMode } (null when canceled) without changing the
// workspace. options: onProgress, track.
export async function findAutofluorescence(app, options = {}) {
  const { gateId = null, onProgress, track = (job) => job } = options;
  const ws = app.store.ws;
  const state = spectralState(ws);
  const sample = state.unstainedSample;
  const detectors = state.panelDetectors();
  if (!sample) throw new Error('Mark an unstained control first (its role "unstained").');
  if (!detectors.length) throw new Error('The controls have no raw spectral detectors in common.');
  const view = await app.data.ensure(sample.id);
  let indices = null;
  let label = 'All events';
  if (gateId && gateId !== ROOT) {
    try {
      const pop = population(view, ws, gateId);
      if (pop) {
        indices = pop;
        label = gatePath(ws, gateId);
      }
    } catch { /* all events */ }
  }
  const columns = copyColumns(detectorColumns(view, detectors), thinIndices(indices, view.eventCount, LIMITS.af));
  let result;
  try {
    const job = track(app.worker('spectral').run('extractAutofluorescence', { columns, detectors, options: { seed: SEED, maxSignatures: 6 } }, { transfer: columns.map((c) => c.buffer), onProgress }));
    result = await job.promise;
  } catch (error) {
    if (error.canceled) return null;
    throw error;
  }
  const autofluorescence = {
    sampleId: sample.id,
    sampleName: sample.name,
    population: label,
    method: 'Spherical k-means++ on unit-normalized event spectra (Roet et al. 2024 approach); signatures are per-detector medians normalized to peak 1; signatures are added while each removes at least 10% of the remaining non-noise misfit and 0.5% of the signal energy.',
    params: { seed: SEED, maxSignatures: 6, minImprovement: 0.1, minSignalGain: 0.005, eventsSent: columns[0].length },
    k: result.k,
    misfitByK: result.misfitByK,
    residualByK: result.residualByK,
    noiseFraction: result.noiseFraction,
    eventsUsed: result.eventsUsed,
    signatures: result.signatures.map((s) => ({ name: s.name, spectrum: serializeSpectrum(s.spectrum), fraction: s.fraction, count: s.count, brightness: s.brightness })),
    computed: new Date().toISOString(),
  };
  return { autofluorescence, afMode: result.k > 1 ? 'perEvent' : 'single' };
}

// An unmixing model for the worker from the reference library and settings.
export async function buildModel(app, state, method, afMode, name, cache) {
  const spectra = state.panelSpectra();
  const af = state.afSignatures();
  const model = { name, method, spectra, options: {} };
  if (afMode === 'single' && af.length) model.spectra = [...spectra, { name: 'AF', spectrum: af[0].spectrum }];
  if (afMode === 'perEvent' && af.length) {
    if (af.length === 1) model.spectra = [...spectra, { name: 'AF', spectrum: af[0].spectrum }];
    else model.afSignatures = af.map((s) => ({ name: s.name, spectrum: s.spectrum }));
  }
  if (method === 'wls' || method === 'wls-fixed') {
    const unstained = await unstainedColumns(app, state, state.setup?.params?.detectors ?? state.panelDetectors(), cache);
    if (unstained) model.options.unstainedColumns = unstained;
  }
  return model;
}

// Unmixes samples with the reference library. Returns { result (a derived result for saveDerived,
// with perSample), outputs, skipped, channelSettings (display scales for new channels; null when
// none change), canceled } without changing the workspace. options: method and afMode (default:
// the library's settings), onProgress, track, isCanceled, cache.
export async function unmixSamples(app, samples, options = {}) {
  const { onProgress, track = (job) => job, isCanceled = () => false, cache } = options;
  const ws = app.store.ws;
  const state = spectralState(ws);
  const problems = state.unmixProblems();
  if (problems.length) throw new Error(problems[0]);
  if (!samples.length) throw new Error('Choose the samples to unmix.');
  const detectors = state.setup?.params?.detectors ?? state.panelDetectors();
  const defaults = state.settings();
  const method = options.method ?? defaults.method;
  const afMode = state.afSignatures().length ? (options.afMode ?? defaults.afMode) : 'none';
  const methodInfo = METHODS.find((m) => m.id === method);
  const afInfo = AF_MODES.find((m) => m.id === afMode);
  if (!methodInfo) throw new Error(`Unknown method ${method}. Methods: ${METHODS.map((m) => m.id).join(', ')}.`);
  if (!afInfo) throw new Error(`Unknown autofluorescence mode ${afMode}. Modes: ${AF_MODES.map((m) => m.id).join(', ')}.`);
  const model = await buildModel(app, state, method, afMode, methodInfo.label, cache);
  const perSample = new Map();
  const summaries = [];
  const skipped = [];
  const worker = app.worker('spectral');
  for (let i = 0; i < samples.length; i += 1) {
    if (isCanceled()) return { canceled: true };
    const sample = samples[i];
    onProgress?.(i / samples.length, `Unmixing ${sample.name} (${i + 1}/${samples.length})`);
    let view;
    let columns;
    try {
      view = await app.data.ensure(sample.id);
      columns = copyColumns(detectorColumns(view, detectors));
    } catch (error) {
      skipped.push(`${sample.name}: ${error.message}`);
      continue;
    }
    let result;
    try {
      const job = track(worker.run('unmixModel', { columns, model, options: { seed: SEED } }, {
        transfer: columns.map((c) => c.buffer),
        onProgress: (f, note) => onProgress?.((i + f) / samples.length, `${sample.name}: ${note}`),
      }));
      result = await job.promise;
    } catch (error) {
      if (error.canceled) return { canceled: true };
      skipped.push(`${sample.name}: ${error.message}`);
      continue;
    }
    const channels = {};
    result.names.forEach((name, f) => { channels[name === 'AF' ? AF_CHANNEL : unmixedChannel(name)] = result.abundances[f]; });
    if (result.afIndex) channels[AF_TYPE_CHANNEL] = Float32Array.from(result.afIndex, (v) => v + 1);
    if (result.residuals) channels[RESIDUAL_CHANNEL] = result.residuals;
    perSample.set(sample.id, channels);
    const sorted = Float32Array.from(result.residuals ?? []).sort();
    summaries.push({ sampleId: sample.id, sample: sample.name, events: view.eventCount, medianResidual: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(5) : null });
  }
  if (!perSample.size) throw new Error(skipped[0] ?? 'No sample could be unmixed.');
  const outputs = Object.keys(perSample.values().next().value);
  const refs = state.activeRefs();
  const unstained = state.unstainedSample;
  const derived = {
    kind: 'unmixing',
    name: `Spectral unmixing · ${methodInfo.label}${afMode !== 'none' ? ` · AF ${afInfo.label.toLowerCase()}` : ''}`,
    method: `${methodInfo.long}. Autofluorescence: ${afInfo.text}`,
    params: {
      method,
      afMode,
      detectors,
      fluorochromes: refs.map((r) => r.name),
      references: refs.map((r) => ({ fluorochrome: r.name, sampleId: r.sample.library ? null : r.sample.id, peakDetector: r.ref.peakDetector, computed: r.ref.computed, ...(r.sample.library ? { library: { file: r.ref.entry.file, date: r.ref.entry.date, workspace: r.ref.entry.workspace, sha256: r.ref.entry.sha256 } } : {}) })),
      // The signatures the unmixing used: one signature uses the first.
      autofluorescence: afMode === 'none' ? [] : state.afSignatures().slice(0, afMode === 'single' ? 1 : undefined).map((s) => s.name),
      referenceLibrary: SETUP_ID,
      weights: method.startsWith('wls') ? (unstained ? `background variance from ${unstained.name}` : 'background variance from the dimmest 10% of events') : null,
    },
    seed: SEED,
    outputs,
    perSample,
    summary: { samples: summaries, complexityIndex: state.panelComplexity(), software: `CytoWeave ${app.version ?? ''}`.trim(), skipped },
  };
  // Display scales and labels for the new channels (kept if the user already set them).
  const first = perSample.values().next().value;
  const range = state.detectorRange(detectors);
  const channelSettings = { ...ws.channelSettings };
  let changed = false;
  for (const name of outputs) {
    if (channelSettings[name]?.transform) continue;
    let transform;
    if (name === RESIDUAL_CHANNEL) transform = residualTransform(first[name]);
    else if (name === AF_TYPE_CHANNEL) transform = { type: 'linear', min: 0.5, max: state.afSignatures().length + 0.5 };
    else transform = abundanceTransform(first[name], range);
    const ref = refs.find((r) => unmixedChannel(r.name) === name);
    channelSettings[name] = { ...(channelSettings[name] ?? {}), transform, ...(ref?.marker ? { label: `${ref.marker} · ${name}` } : {}) };
    changed = true;
  }
  return { result: derived, outputs, skipped, channelSettings: changed ? channelSettings : null, methodLabel: methodInfo.label, canceled: false };
}

// The workspace with display scales for unmixed channels (as unmixSamples returns them).
export function withChannelSettings(ws, channelSettings, count) {
  if (!channelSettings) return ws;
  const time = new Date().toISOString();
  return { ...ws, channelSettings, modified: time, ...appendLog(ws, 'scale', `unmixed channels: ${count}`, time) };
}

// The scatter of a sample's events (FSC-A and SSC-A, or the first forward and side scatter areas),
// or null without them.
function scatterColumns(view, indices) {
  const names = [...view.raw.keys()];
  const pick = (exact, pattern) => (view.raw.has(exact) ? exact : names.find((n) => pattern.test(n)) ?? null);
  const fsc = pick('FSC-A', /^FSC.*-A$/i);
  const ssc = pick('SSC-A', /^SSC.*-A$/i);
  if (!fsc || !ssc) return null;
  const [f, s] = copyColumns([view.raw.get(fsc), view.raw.get(ssc)], indices);
  return { fsc: f, ssc: s };
}

// Diagnoses the unmixing of a sample's population (lib/spectral-doctor.js) with the reference
// library and its settings: the population thinned to LIMITS.doctor events, the unstained control
// (its detectors and scatter, to check that it represents the sample's autofluorescence), the
// controls' carriers and mixture checks, and the instrument's spectral library (options.library,
// its record). The doctor fits ordinary least squares with the library's autofluorescence
// signatures whatever unmixing method is chosen: the faults it looks for are the references'.
// Returns { result, sample, population, events } or null when canceled. options: gateId,
// library, onProgress, track.
export async function diagnose(app, sampleId, options = {}) {
  const { gateId = null, onProgress, track = (job) => job } = options;
  const ws = app.store.ws;
  const state = spectralState(ws);
  const problems = state.unmixProblems();
  if (problems.length) throw new Error(problems[0]);
  const sample = ws.samples.find((s) => s.id === sampleId);
  if (!sample) throw new Error('Choose a sample to diagnose.');
  const detectors = state.setup?.params?.detectors ?? state.panelDetectors();
  const view = await app.data.ensure(sample.id);
  let indices = null;
  let label = 'All events';
  if (gateId && gateId !== ROOT) {
    try {
      const pop = population(view, ws, gateId);
      if (pop) {
        indices = pop;
        label = gatePath(ws, gateId);
      }
    } catch { /* all events */ }
  }
  const thinned = thinIndices(indices, view.eventCount, LIMITS.doctor);
  const columns = copyColumns(detectorColumns(view, detectors), thinned);
  const context = {
    references: state.activeRefs().filter((r) => !r.sample.library).map((r) => ({ name: r.name, spectrum: r.ref.spectrum, carrier: r.sample.meta?.carrier ?? null, mixture: r.ref.mixture ?? null, heterogeneity: r.ref.heterogeneity ?? null })),
    library: (options.library?.entries ?? []).map((e) => {
      const on = spectrumOn(e, detectors);
      return on ? { id: e.id, fluorochrome: e.fluorochrome, spectrum: Array.from(on), carrier: e.carrier ?? null, date: e.date ?? null, added: e.added ?? null, file: e.file ?? null } : null;
    }).filter(Boolean),
    unstainedAF: state.afSignatures().map((s) => ({ name: s.name, spectrum: s.spectrum })),
  };
  const sampleScatter = scatterColumns(view, thinned);
  const unstained = state.unstainedSample;
  if (unstained) {
    const uview = await app.data.ensure(unstained.id);
    const uidx = thinIndices(null, uview.eventCount, LIMITS.unstained);
    context.unstained = { columns: copyColumns(detectorColumns(uview, detectors), uidx) };
    const unstainedScatter = scatterColumns(uview, uidx);
    if (sampleScatter && unstainedScatter) context.scatter = { sample: sampleScatter, unstained: unstainedScatter };
  }
  const af = state.afSignatures();
  const { afMode } = state.settings();
  const model = {
    detectors,
    spectra: state.panelSpectra(),
    afSignatures: afMode === 'none' ? [] : (afMode === 'single' ? af.slice(0, 1) : af).map((s) => ({ name: s.name, spectrum: s.spectrum })),
  };
  const transfer = [...columns, ...(context.unstained?.columns ?? []), ...(context.scatter ? [context.scatter.sample.fsc, context.scatter.sample.ssc, context.scatter.unstained.fsc, context.scatter.unstained.ssc] : [])].map((c) => c.buffer);
  try {
    const job = track(app.worker('spectral').run('diagnoseUnmixing', { columns, model, context, options: { seed: SEED, maxEvents: LIMITS.doctor } }, { transfer, onProgress }));
    const result = await job.promise;
    return { result, sample: sample.name, sampleId: sample.id, population: label, gateId: gateId ?? ROOT, events: columns[0].length };
  } catch (error) {
    if (error.canceled) return null;
    throw error;
  }
}
