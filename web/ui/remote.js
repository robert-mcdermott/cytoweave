// Remote control: actions sent by programs on this computer (AI agents through "cytoweave mcp",
// or scripts through /api/remote/action) are performed here, in the open window, where the user
// sees them and can undo them. Each action returns { ok, message, data }.

import { COMPARISONS, channelTransform, computeStatistic, countOf, describePopulation, gateRobustness, population, populationColumns, populationSet } from '../lib/engine.js';
import { createTransform } from '../lib/transforms.js';
import { drawScene } from '../lib/plot.js';
import { newId, quadrantGates, quadrantNames, splitGates } from '../lib/gates.js';
import { densityGateAt, suggestSinglets, valleyThreshold } from '../lib/autogate.js';
import { ROOT, SAMPLE_ROLES, channelLabel, gateById, gatePath, uniqueGateName } from '../lib/workspace.js';
import { describeProposal, openProposals, proposalHistory, proposeAnnotations, proposeCompensation, proposeDerived, proposeFigure, proposeGateAdjustments, proposeGateEdit, proposeGateRemoval, proposeGates, proposeRootGate } from '../lib/proposals.js';
import { spilloverFromControls } from './controls.js';
import { describe } from '../lib/stats.js';
import { toast } from './overlays.js';
import { WorkspaceChangedError, presentSamples } from './store.js';

export class ActionError extends Error {}

function rasterImage(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

const round = (v, digits = 4) => (Number.isFinite(v) ? +v.toPrecision(digits) : null);

export function installRemote(app) {
  const { store, data } = app;
  const ws = () => store.ws;
  // Who sent the action being performed (an MCP client's name, or a script's).
  let author = 'an AI agent';

  // --- Resolution of names ------------------------------------------------------------------------

  function resolveSample(ref) {
    const samples = ws().samples;
    if (!ref) {
      const current = samples.find((s) => s.id === store.ui.sampleId) ?? samples[0];
      if (!current) throw new ActionError('The workspace has no samples; open FCS files first.');
      return current;
    }
    const lower = String(ref).toLowerCase();
    const found = samples.find((s) => s.id === ref) ?? samples.find((s) => s.name.toLowerCase() === lower || s.fileName?.toLowerCase() === lower)
      ?? samples.find((s) => s.name.toLowerCase().includes(lower));
    if (!found) throw new ActionError(`No sample "${ref}". Samples: ${samples.slice(0, 20).map((s) => s.name).join(', ')}${samples.length > 20 ? '…' : ''}`);
    return found;
  }

  function resolvePopulation(ref) {
    if (!ref || /^(all events|all|root|ungated)$/i.test(String(ref).trim())) return ROOT;
    const gates = ws().gates;
    const direct = gates.find((g) => g.id === ref);
    if (direct) return direct.id;
    const text = String(ref).trim();
    if (text.includes('/')) {
      const parts = text.split('/').map((p) => p.trim().toLowerCase()).filter(Boolean);
      if (parts[0] === 'all events') parts.shift();
      let parentId = null;
      let gate = null;
      for (const part of parts) {
        gate = gates.find((g) => (g.parentId ?? null) === parentId && g.name.toLowerCase() === part);
        if (!gate) break;
        parentId = gate.id;
      }
      if (gate) return gate.id;
      // A path may skip levels: match by its last part and check the ancestry contains the rest.
      const last = parts[parts.length - 1];
      const candidates = gates.filter((g) => g.name.toLowerCase() === last && parts.every((p) => gatePath(ws(), g.id).toLowerCase().includes(p)));
      if (candidates.length === 1) return candidates[0].id;
    }
    const byName = gates.filter((g) => g.name.toLowerCase() === text.toLowerCase());
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) throw new ActionError(`"${ref}" names ${byName.length} populations; use a path: ${byName.map((g) => gatePath(ws(), g.id)).join(' | ')}`);
    throw new ActionError(`No population "${ref}". Populations: ${gates.slice(0, 30).map((g) => gatePath(ws(), g.id)).join(' | ') || 'none yet'}`);
  }

  function resolveChannel(view, ref) {
    if (!ref) throw new ActionError('A channel is required.');
    const text = String(ref).trim();
    const lower = text.toLowerCase();
    const params = view.parameters;
    const found = params.find((p) => p.name === text) ?? params.find((p) => p.name.toLowerCase() === lower)
      ?? params.find((p) => p.marker && p.marker.toLowerCase() === lower) ?? params.find((p) => p.label && p.label.toLowerCase() === lower)
      ?? params.find((p) => p.marker && p.marker.toLowerCase().startsWith(lower));
    if (found) return found.name;
    // Derived and computed channels (clusters, formulas, calibrated channels) by name.
    const computed = [...view.computed.keys()].filter((name) => view.hasChannel(name));
    for (const name of [...view.derived.keys(), ...computed]) if (name.toLowerCase() === lower) return name;
    throw new ActionError(`No channel "${ref}" in ${view.record.name}. Channels: ${[...params.map((p) => (p.marker ? `${p.name} (${p.marker})` : p.name)), ...computed].join(', ')}`);
  }

  // A plate by name (default the first), from platesOf().
  function resolvePlate(plates, ref) {
    if (!ref) return plates[0];
    const lower = String(ref).toLowerCase();
    const found = plates.find((p) => p.name === ref) ?? plates.find((p) => p.name.toLowerCase() === lower);
    if (!found) throw new ActionError(`No plate "${ref}". Plates: ${plates.map((p) => p.name).join(', ')}`);
    return found;
  }

  async function loadedView(sample) {
    const view = await data.ensure(sample.id);
    // Derived channels kept in the library (clusters, maps, QC) arrive after the sample loads.
    await data.restoreDerived(view);
    view.syncWorkspace?.(ws());
    return view;
  }

  function populationRows(view) {
    const rows = [];
    const walk = (parentId, depth) => {
      for (const gate of ws().gates.filter((g) => (g.parentId ?? null) === parentId)) {
        const indices = populationSet(view, ws(), gate.id);
        const parent = populationSet(view, ws(), gate.parentId ?? ROOT);
        const count = indices === undefined ? null : countOf(indices, view);
        rows.push({
          path: gatePath(ws(), gate.id),
          id: gate.id,
          type: gate.type,
          channels: gate.dims.map((d) => d.channel),
          count,
          percentOfParent: count === null ? null : round((100 * count) / (countOf(parent, view) || 1)),
          percentOfTotal: count === null ? null : round((100 * count) / view.eventCount),
          adjustedForThisSample: Boolean(gate.overrides?.[view.id]),
          origin: gate.meta?.origin ?? 'manual',
        });
        walk(gate.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }

  // --- Actions ------------------------------------------------------------------------------------

  const actions = {
    async workspace_summary() {
      const w = ws();
      const current = w.samples.find((s) => s.id === store.ui.sampleId);
      let tree = null;
      if (current) tree = populationRows(await loadedView(current));
      return {
        message: `${w.name}: ${w.samples.length} samples, ${w.gates.length} gates.`,
        data: {
          workspace: w.name,
          samples: w.samples.map((s) => ({ name: s.name, events: s.eventCount, role: s.role, meta: s.meta, technology: s.technology, compensation: s.compensationId, cytometer: s.acquisition?.cytometer || undefined })),
          channels: current ? current.channels.map((c) => ({ name: c.name, marker: c.marker || undefined, type: c.type })) : [],
          groups: w.groups.map((g) => ({ name: g.name, samples: g.sampleIds.length })),
          populationsOfCurrentSample: tree,
          compensations: w.compensations.map((c) => ({ name: c.name, source: c.source, channels: c.channels.length })),
          derivedResults: w.derived.map((d) => ({ name: d.name, kind: d.kind, method: d.method, outputs: d.outputs })),
          window: { view: store.ui.mode, sample: current?.name ?? null, population: store.ui.gateId ? gatePath(w, store.ui.gateId) : 'All events' },
        },
      };
    },

    async open_files(args, event) {
      const files = event.files ?? [];
      const items = [];
      for (const file of files) {
        const response = await fetch(file.url);
        if (!response.ok) continue;
        items.push(Object.assign(new File([await response.arrayBuffer()], file.name), { folder: file.folder ?? null }));
      }
      const before = ws().samples.length;
      const opened = await app.importFiles(items, { interactive: false });
      const added = ws().samples.slice(before);
      // CSV files of events: how each was read, each column's kind and scale, and the checks.
      const csv = opened?.csv ?? [];
      const csvNote = csv.length ? ` CSV events: ${csv.map((c) => `${c.file} (${c.rows} rows; ${c.columns.length} columns imported${c.dropped ? `; ${c.dropped} rows with missing values left out` : ''}${c.problems.length ? `; ${c.problems.join(' ')}` : ''})`).join('; ')}. Each column's kind, scale and check are in data.csv; tell the user about columns that look wrong (the scales can be changed in the Gate view).` : '';
      return { message: `Opened ${items.length} file(s); ${added.length} new sample(s).${csvNote}`, data: { samples: added.map((s) => ({ name: s.name, events: s.eventCount, role: s.role })), ...(csv.length ? { csv } : {}) } };
    },

    async open_example(args) {
      await app.openExample(args.id);
      return { message: `Opened the example ${args.id}.`, data: { samples: ws().samples.map((s) => ({ name: s.name, role: s.role, events: s.eventCount, meta: s.meta })) } };
    },

    async select(args) {
      if (args.view) await app.setMode(args.view);
      if (args.sample) app.selectSample(resolveSample(args.sample).id);
      if (args.population !== undefined) {
        const id = resolvePopulation(args.population);
        app.selectGate(id === ROOT ? null : id, { keepMode: Boolean(args.view) });
      }
      return { message: `Showing ${store.ui.mode}${store.ui.sampleId ? `, ${resolveSample().name}` : ''}${store.ui.gateId ? `, ${gatePath(ws(), store.ui.gateId)}` : ''}.` };
    },

    async list_populations(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      return { message: `${ws().gates.length} population${ws().gates.length === 1 ? '' : 's'} in ${sample.name} (${view.eventCount} events).`, data: { sample: sample.name, events: view.eventCount, populations: populationRows(view) } };
    },

    async population_statistics(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const gateId = resolvePopulation(args.population);
      const indices = populationSet(view, ws(), gateId);
      if (indices === undefined) throw new ActionError('That population does not apply to this sample.');
      const channels = args.channels?.length ? args.channels.map((c) => resolveChannel(view, c)) : view.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name);
      const stats = describePopulation(view, ws(), gateId, channels);
      const gate = gateById(ws(), gateId);
      const parent = populationSet(view, ws(), gate?.parentId ?? ROOT);
      const count = countOf(indices, view);
      return {
        message: `${gate ? gatePath(ws(), gateId) : 'All events'} in ${sample.name}: ${count} events.`,
        data: {
          sample: sample.name,
          population: gate ? gatePath(ws(), gateId) : 'All events',
          count,
          percentOfParent: round((100 * count) / (countOf(parent, view) || 1)),
          percentOfTotal: round((100 * count) / view.eventCount),
          compensated: Boolean(view.compensation),
          channels: Object.fromEntries(Object.entries(stats ?? {}).map(([channel, d]) => [channel, { marker: view.channelInfo(channel)?.marker || undefined, median: round(d.median), mean: round(d.mean), geomean: round(d.geomean), sd: round(d.sd), robustSD: round(d.rsd), cv: round(d.cv), robustCV: round(d.rcv), p5: round(d.p5), p95: round(d.p95) }])),
        },
      };
    },

    async statistics_table(args) {
      const w = ws();
      const group = args.group ? w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase()) : null;
      if (args.group && !group) throw new ActionError(`No group "${args.group}".`);
      const samples = w.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample' || s.role === 'reference'));
      const gateIds = args.populations?.length ? args.populations.map(resolvePopulation) : w.gates.map((g) => g.id);
      const stat = args.statistic ?? 'freqParent';
      // Absolute counts need the counting beads; concentration and absolute counts take a dilution.
      let counting;
      if (stat === 'absoluteCount') {
        if (!args.beadPopulation || !(Number(args.beadsPerTube) > 0) || !(Number(args.sampleVolume) > 0)) throw new ActionError('absoluteCount needs beadPopulation (the counting beads\' gate), beadsPerTube and sampleVolume (µL of sample in the tube).');
        counting = { beadGateId: resolvePopulation(args.beadPopulation), beads: Number(args.beadsPerTube), volume: Number(args.sampleVolume) };
      }
      const dilution = args.dilution === undefined || args.dilution === null || args.dilution === '' ? undefined : Number.isFinite(Number(args.dilution)) ? Number(args.dilution) : { field: String(args.dilution) };
      // Comparison statistics (overton, sed, pbPositive, pbT, ksD) need a control sample.
      let control;
      let context = {};
      if (COMPARISONS.has(stat)) {
        if (!args.control) throw new ActionError(`${stat} compares each sample with a control sample: name it with control (e.g. an FMO).`);
        const controlSample = resolveSample(args.control);
        const controlView = await loadedView(controlSample);
        control = { sampleId: controlSample.id, ...(args.controlPopulation ? { gateId: resolvePopulation(args.controlPopulation) } : {}) };
        context = { viewOf: (id) => (id === controlSample.id ? controlView : null) };
      }
      const rows = [];
      for (const sample of samples) {
        const view = await loadedView(sample);
        const channel = args.channel ? resolveChannel(view, args.channel) : undefined;
        const values = {};
        for (const id of gateIds) values[id === ROOT ? 'All events' : gatePath(w, id)] = round(computeStatistic(view, w, { stat, gateId: id, channel, control, counting, dilution }, context), 6);
        rows.push({ sample: sample.name, meta: sample.meta, values });
      }
      return { message: `${stat}${args.channel ? ` of ${args.channel}` : ''}${control ? ` against ${args.control}` : ''} for ${gateIds.length} population(s) in ${samples.length} sample(s).`, data: { statistic: stat, channel: args.channel, control: args.control, rows } };
    },

    async add_formula_channel(args) {
      const { resolveFormula, evaluateColumns } = await import('../lib/formula.js');
      const w = ws();
      const { channelCatalog } = await import('../lib/workspace.js');
      const catalog = channelCatalog(w).filter((c) => c.type !== 'time');
      let resolved;
      try {
        resolved = resolveFormula(String(args.expression ?? ''), catalog);
      } catch (error) {
        throw new ActionError(`${error.message}${Number.isFinite(error.position) ? ` (at character ${error.position + 1})` : ''} Channels go in square brackets by marker or detector, as in [CD4] / [CD8].`);
      }
      const name = String(args.name ?? '').trim() || resolved.text.replace(/[[\]]/g, '').slice(0, 40);
      if (catalog.some((c) => c.name === name)) throw new ActionError(`A channel is already called "${name}".`);
      const record = { kind: 'formula', name, inputs: resolved.inputs, outputs: [name], params: { expression: resolved.text, source: String(args.expression) } };
      store.commit(proposeDerived(w, author, record).ws, `${author} proposed the formula channel ${name}`);
      const sample = w.samples.find((x) => x.id === store.ui.sampleId) ?? w.samples[0];
      let summary = '';
      if (sample) {
        const view = await loadedView(sample);
        const values = evaluateColumns(resolved.tree, (input) => view.column(input), view.eventCount);
        const finite = Float64Array.from(values.filter(Number.isFinite)).sort();
        summary = ` On ${sample.name}: median ${round(finite[Math.floor(finite.length / 2)])}${finite.length < values.length ? `, ${values.length - finite.length} events without a value (division by zero or the log of a value ≤ 0)` : ''}.`;
      }
      return { message: `Proposed the formula channel "${name}" = ${resolved.text}, computed for every event of every sample from the compensated values; it can be used in gates, plots and statistics at once.${summary}`, data: { name, expression: resolved.text, inputs: resolved.inputs } };
    },

    async calibrate_beads(args) {
      const lib = await import('../lib/calibration.js');
      const { defaultUnit } = await import('./qc-calibration.js');
      const w = ws();
      const beads = resolveSample(args.sample);
      const view = await loadedView(beads);
      const given = args.values ?? {};
      const channels = Object.keys(given).map((c) => resolveChannel(view, c));
      if (!channels.length) throw new ActionError('Give values: { channel: [value of each level, dimmest first; null for a level without one] } from the beads\' datasheet.');
      const values = Object.fromEntries(Object.entries(given).map(([c, v]) => [resolveChannel(view, c), v.map((x) => (x === null || x === undefined ? null : Number(x)))]));
      const clustering = (args.clustering?.length ? args.clustering.map((c) => resolveChannel(view, c)) : channels);
      const needed = [...new Set([...clustering, ...channels])];
      const columns = Object.fromEntries(needed.map((c) => [c, view.column(c)]));
      const scatter = ['FSC-A', 'FSC', 'FSC-H'].find((c) => view.hasChannel(c));
      const side = ['SSC-A', 'SSC', 'SSC-H'].find((c) => view.hasChannel(c));
      if (scatter && side) Object.assign(columns, { [scatter]: view.column(scatter), [side]: view.column(side) });
      let events = null;
      if (args.population) {
        const set = populationSet(view, w, resolvePopulation(args.population));
        events = set === null || set === undefined ? null : typeof set.toIndices === 'function' ? set.toIndices() : set;
      }
      const bounds = Object.fromEntries(channels.map((c) => {
        const p = view.parameters.find((x) => x.name === c);
        return [c, lib.channelBounds(view.dataset.keywords, p.index, p.range)];
      }));
      const units = Object.fromEntries(channels.map((c) => [c, args.unit?.[c] ?? (typeof args.unit === 'string' ? args.unit : defaultUnit(c, view.channelInfo(c)?.marker))]));
      let result;
      try {
        result = lib.calibrateBeads(columns, { channels, values, clustering, events, scatter: scatter && side ? [scatter, side] : null, bounds, unit: units });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const targets = args.applyTo?.length ? args.applyTo.map((ref) => resolveSample(ref).id) : null;
      const r4 = (v) => (Number.isFinite(v) ? +v.toPrecision(4) : null);
      const out = {};
      let next = ws();
      for (const channel of channels) {
        const c = result.channels[channel];
        out[channel] = { unit: units[channel], levels: c.levels.map((l) => ({ events: l.n, median: r4(l.median), value: l.value, used: l.used, ...(l.why ? { why: l.why } : {}) })), slope: r4(c.fit?.m), intercept: r4(c.fit?.b), beadAutofluorescence: r4(c.fit?.autofluorescence), error: c.error ?? undefined };
        if (c.fit && targets) next = proposeDerived(next, author, lib.calibrationRecord(channel, c, { unit: units[channel], beads: beads.name, samples: targets })).ws;
      }
      if (targets) store.commit(next, `${author} proposed calibrated channels from ${beads.name}`);
      const lines = channels.map((ch) => (out[ch].slope ? `${ch} → ${out[ch].unit}: slope ${out[ch].slope} from ${result.channels[ch].levels.filter((l) => l.used).length} of ${result.levels} levels` : `${ch}: ${out[ch].error}`));
      return { message: `${beads.name}: ${result.levels} bead levels in ${result.events.length} events. ${lines.join('; ')}.${targets ? ` Proposed "<channel> <unit>" channels for ${targets.length} sample(s).` : ' Give applyTo (the samples acquired with the beads\' settings) to add the calibrated channels.'}`, data: { sample: beads.name, events: result.events.length, channels: out, appliedTo: targets ? targets.length : 0 } };
    },

    async compare_distributions(args) {
      const { ksTest, overtonSubtraction, probabilityBinning, sedSubtraction } = await import('../lib/distribution.js');
      const w = ws();
      if (!args.control) throw new ActionError('Name the control sample (an FMO, isotype or unstained sample, or a reference sample).');
      const controlSample = resolveSample(args.control);
      const controlView = await loadedView(controlSample);
      const names = args.channels?.length ? args.channels : args.channel ? [args.channel] : null;
      if (!names) throw new ActionError('Name the channel (or channels) to compare.');
      const channels = names.map((c) => resolveChannel(controlView, c));
      const populationId = resolvePopulation(args.population);
      const controlPopulationId = args.controlPopulation ? resolvePopulation(args.controlPopulation) : populationId;
      const control = populationColumns(controlView, w, controlPopulationId, channels);
      if (!control || control[0].length < 2) throw new ActionError(`The control's population has fewer than two events.`);
      const samples = args.samples?.length ? args.samples.map(resolveSample) : w.samples.filter((s) => s.id !== controlSample.id && (s.role === 'sample' || s.role === 'reference'));
      const r = (v) => (Number.isFinite(v) ? +v.toPrecision(5) : null);
      const rows = [];
      for (const sample of samples) {
        const view = await loadedView(sample);
        const test = populationColumns(view, w, populationId, channels.map((c) => resolveChannel(view, c)));
        if (!test || !test[0].length) {
          rows.push({ sample: sample.name, events: 0, note: 'The population is empty or does not apply.' });
          continue;
        }
        const pb = probabilityBinning(channels.length > 1 ? control : control[0], channels.length > 1 ? test : test[0]);
        const row = { sample: sample.name, events: test[0].length, probabilityBinning: { T: r(pb.T), pbStat: r(pb.pbStat), percentPositive: r(pb.percentPositive), bins: pb.bins } };
        if (channels.length === 1) {
          const sed = sedSubtraction(control[0], test[0]);
          const ks = ksTest(control[0], test[0]);
          Object.assign(row, { overton: r(overtonSubtraction(control[0], test[0]).percentPositive), sed: r(sed.percentPositive), enhancedDmax: r(sed.enhancedDmax), ksD: r(ks.D), ksP: ks.p < 1e-300 ? 0 : r(ks.p) });
        }
        rows.push(row);
      }
      const what = `${channels.join(' × ')} of ${populationId === ROOT ? 'all events' : gatePath(w, populationId)}`;
      const lines = rows.filter((x) => x.events).map((x) => (channels.length === 1 ? `${x.sample}: ${x.sed}% positive (SED), ${x.overton}% (Overton), T(χ) ${x.probabilityBinning.T}` : `${x.sample}: T(χ) ${x.probabilityBinning.T}, ${x.probabilityBinning.percentPositive}% in excess of the control`));
      return {
        message: `${what} against ${controlSample.name}. ${lines.join('; ')}. T(χ) above 4 means the distributions differ (p < 0.01, Roederer 2001); SED is Bagwell's enhanced normalized subtraction, Overton's cumulative subtraction is the K-S Dmax and underestimates the positive fraction. With many events the K-S p-value calls trivial differences significant.`,
        data: { control: controlSample.name, controlPopulation: controlPopulationId === ROOT ? 'All events' : gatePath(w, controlPopulationId), population: populationId === ROOT ? 'All events' : gatePath(w, populationId), channels, controlEvents: control[0].length, rows },
      };
    },

    async rare_events(args) {
      const { binomialInterval, classifyValue, countPrecision, detectionLimits, eventsNeeded, poissonInterval } = await import('../lib/rare-events.js');
      const w = ws();
      const populationId = resolvePopulation(args.population);
      if (populationId === ROOT) throw new ActionError('Name the rare population (a gate).');
      const gate = gateById(w, populationId);
      const statistic = args.statistic === 'count' ? 'count' : 'freqParent';
      const cv = Number(args.cv) > 0 ? Number(args.cv) : 20;
      const measure = async (sample) => {
        const view = await loadedView(sample);
        const members = populationSet(view, w, populationId);
        if (members === undefined) return null;
        const count = countOf(members, view);
        const parentCount = countOf(populationSet(view, w, gate.parentId ?? ROOT), view);
        return { count, parentCount, value: statistic === 'count' ? count : parentCount ? (100 * count) / parentCount : Number.NaN };
      };
      const r = (v) => (Number.isFinite(v) ? +v.toPrecision(5) : null);
      let limits = null;
      if (args.blanks?.length) {
        const blanks = [];
        for (const ref of args.blanks) {
          const m = await measure(resolveSample(ref));
          if (m) blanks.push(m.value);
        }
        const groups = new Map();
        for (const ref of args.low ?? []) {
          const sample = resolveSample(ref);
          const m = await measure(sample);
          if (!m) continue;
          const key = args.lowGroupBy ? String(sample.meta?.[args.lowGroupBy] ?? '') : 'low';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(m.value);
        }
        limits = detectionLimits(blanks, [...groups.values()], { method: args.method === 'nonparametric' ? 'nonparametric' : 'parametric', cvTarget: cv });
      }
      const excluded = new Set([...(args.blanks ?? []), ...(args.low ?? [])].map((ref) => resolveSample(ref).id));
      const samples = args.samples?.length ? args.samples.map(resolveSample) : w.samples.filter((s) => !excluded.has(s.id) && (s.role === 'sample' || s.role === 'reference'));
      const rows = [];
      for (const sample of samples) {
        const m = await measure(sample);
        if (!m) {
          rows.push({ sample: sample.name, note: 'The population does not apply.' });
          continue;
        }
        const [lo, hi] = poissonInterval(m.count);
        const [flo, fhi] = binomialInterval(m.count, m.parentCount);
        const need = eventsNeeded(cv, m.parentCount ? (100 * m.count) / m.parentCount : null);
        const row = { sample: sample.name, count: m.count, countInterval: [r(lo), r(hi)], parentEvents: m.parentCount, percentOfParent: r((100 * m.count) / m.parentCount), percentInterval: [r(100 * flo), r(100 * fhi)], countingCV: r(countPrecision(m.count, m.parentCount)), parentEventsForTargetCV: need.parentEvents };
        if (limits) {
          const poissonLimit = statistic === 'count' ? need.events : (100 * need.events) / m.parentCount;
          const loq = Math.max(...[limits.loq, limits.lod, poissonLimit].filter(Number.isFinite));
          row.lloq = r(loq);
          row.status = classifyValue(m.value, { lob: limits.lob, loq });
        }
        rows.push(row);
      }
      const name = gatePath(w, populationId);
      const limitText = limits ? ` Limit of blank ${r(limits.lob)}${statistic === 'count' ? ' events' : '%'} from ${limits.blankCount} blank(s)${Number.isFinite(limits.lod) ? `, limit of detection ${r(limits.lod)}` : ''}; each sample's lower limit of quantification is the larger of the limit of detection and the ${eventsNeeded(cv).events} events that give a ${cv}% counting CV.${limits.notes.length ? ` ${limits.notes.join(' ')}` : ''}` : '';
      return {
        message: `${name}: counts with exact Poisson 95% intervals, ${statistic === 'count' ? 'counts' : 'frequencies'} with exact binomial intervals, and the parent events needed for a ${cv}% CV (${eventsNeeded(cv).events} events of the population).${limitText}`,
        data: { population: name, statistic, targetCV: cv, limits: limits && { method: limits.method, lob: r(limits.lob), lod: r(limits.lod), loq: r(limits.loq), blanks: limits.blankCount, blankMean: r(limits.blankMean), blankSD: r(limits.blankSD), lowSD: r(limits.lowSD), lowGroups: limits.lowGroups.map((g) => ({ n: g.n, mean: r(g.mean), sd: r(g.sd), cv: r(g.cv) })), notes: limits.notes }, rows },
      };
    },

    async render_plot(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const x = resolveChannel(view, args.x);
      const y = args.y ? resolveChannel(view, args.y) : null;
      const gateId = resolvePopulation(args.population);
      const width = Math.min(1600, Math.max(200, Number(args.width) || 520));
      const height = Math.min(1600, Math.max(200, Number(args.height) || 480));
      const spec = { populationId: gateId, x, y, type: y ? (args.type && args.type !== 'histogram' ? args.type : 'pseudocolor') : 'histogram', options: {} };
      const scene = app.buildExportScene(ws(), view, spec, { width, height, theme: 'light', title: `${sample.name} · ${gateId === ROOT ? 'All events' : gatePath(ws(), gateId)}` });
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      drawScene(ctx, scene, rasterImage);
      return { message: `${spec.type} of ${gateId === ROOT ? 'all events' : gatePath(ws(), gateId)} in ${sample.name}: ${y ? `${x} × ${y}` : x}.`, data: { image: canvas.toDataURL('image/png'), width: width * 2, height: height * 2, sample: sample.name } };
    },

    async create_gate(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const parentRef = resolvePopulation(args.parent);
      const parentId = parentRef === ROOT ? null : parentRef;
      const x = resolveChannel(view, args.x);
      const oneD = args.type === 'range' || args.type === 'split';
      const y = oneD ? null : resolveChannel(view, args.y);
      const tx = channelTransform(ws(), view, x);
      const ty = y ? channelTransform(ws(), view, y) : null;
      const fx = createTransform(tx).forward;
      const fy = ty ? createTransform(ty).forward : null;
      const dims = [{ channel: x, transform: { ...tx } }, ...(y ? [{ channel: y, transform: { ...ty } }] : [])];
      const c = args.coordinates ?? {};
      const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
      let gates;
      const marker = (channel) => view.channelInfo(channel)?.marker || channel.replace(/-[AHW]$/, '');
      switch (args.type) {
        case 'rectangle': {
          const [x0, x1, y0, y1] = [num(c.xMin), num(c.xMax), num(c.yMin), num(c.yMax)];
          gates = [{ type: 'rectangle', geometry: { min: [x0 === null ? null : fx(x0), y0 === null ? null : fy(y0)], max: [x1 === null ? null : fx(x1), y1 === null ? null : fy(y1)] } }];
          break;
        }
        case 'polygon': {
          if (!Array.isArray(c.vertices) || c.vertices.length < 3) throw new ActionError('A polygon needs at least three vertices: {"vertices": [[x, y], ...]}.');
          gates = [{ type: 'polygon', geometry: { vertices: c.vertices.map(([vx, vy]) => [fx(Number(vx)), fy(Number(vy))]) } }];
          break;
        }
        case 'ellipse': {
          const [cx, cy] = c.center ?? [];
          const [rx, ry] = c.semiAxes ?? [0.08, 0.08];
          gates = [{ type: 'ellipse', geometry: { center: [fx(Number(cx)), fy(Number(cy))], radii: [Number(rx), Number(ry)], angle: ((Number(c.angle) || 0) * Math.PI) / 180 } }];
          break;
        }
        case 'range':
          gates = [{ type: 'range', geometry: { min: num(c.min) === null ? null : fx(num(c.min)), max: num(c.max) === null ? null : fx(num(c.max)) } }];
          break;
        case 'quadrant': {
          const [qx, qy] = c.at ?? [];
          gates = quadrantGates({ parentId, dims, center: [fx(Number(qx)), fy(Number(qy))], names: quadrantNames(marker(x), marker(y)) });
          break;
        }
        case 'split':
          gates = splitGates({ parentId, dims, threshold: fx(Number(c.threshold)), xName: marker(x) });
          break;
        default:
          throw new ActionError('type must be rectangle, polygon, ellipse, range, quadrant or split.');
      }
      return commitGates(gates, { parentId, dims, name: args.name, view, origin: 'agent' });
    },

    // A virtual FMO (lib/virtual-fmo.js): where the population's negative for a channel's dye
    // would end without that dye, predicted from the spread model.
    async virtual_fmo(args) {
      const { DEFAULT_QUANTILE, fmoControlFor, fmoThreshold, spreadFor, virtualFMO } = await import('../lib/virtual-fmo.js');
      const { unstainedFor } = await import('./virtual-fmo-view.js');
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const populationId = resolvePopulation(args.population);
      const channel = resolveChannel(view, args.channel);
      const versus = args.versus ? resolveChannel(view, args.versus) : null;
      const quantile = args.quantile === undefined ? DEFAULT_QUANTILE : Number(args.quantile);
      if (!(quantile > 0.5 && quantile < 1)) throw new ActionError('quantile is between 0.5 and 1 (default 0.995).');
      const w = ws();
      const found = spreadFor(w, sample, channel);
      if (!found) throw new ActionError(`No spread model covers ${channel} in ${sample.name}: compute the compensation from the single-stain controls (propose_compensation, accepted) or the spectral spreading matrix in the Spectral view first.`);
      const unstainedSample = unstainedFor(w);
      if (!unstainedSample) throw new ActionError('A virtual FMO needs an unstained control (a sample with the role "unstained").');
      const unstained = await loadedView(unstainedSample);
      let result;
      try {
        result = virtualFMO({ ws: w, view, unstained, populationId, channel, record: found.record, quantile, yChannel: versus });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const marker = view.channelInfo(channel)?.marker || null;
      const fmoSample = fmoControlFor(w, channel, marker);
      let real = null;
      if (fmoSample) {
        try {
          real = fmoThreshold({ ws: w, view: await loadedView(fmoSample), populationId, channel, quantile, yChannel: versus });
        } catch {
          real = null;
        }
      }
      const population = populationId === ROOT ? 'All events' : gatePath(w, populationId);
      const data = {
        sample: sample.name,
        population,
        channel,
        marker,
        quantile,
        threshold: round(result.threshold, 6),
        unstainedOnly: round(result.unstainedThreshold, 6),
        realFMO: real ? { sample: fmoSample.name, threshold: round(real.threshold, 6) } : null,
        events: result.events,
        spreadFrom: result.contributions.slice(0, 6).map((c) => ({ channel: c.channel, dye: c.dye, share: round(c.share, 4) })),
        curve: result.curve ? result.curve.map((c) => ({ [versus]: round(c.y, 6), threshold: round(c.threshold, 6), events: c.n })) : null,
        spreadModel: found.source.label,
        unstained: unstainedSample.name,
        method: result.method,
      };
      let proposed = null;
      if (args.addGate) {
        const tx = channelTransform(w, view, channel);
        const fx = createTransform(tx).forward;
        proposed = commitGates([{ type: 'range', geometry: { min: fx(result.threshold), max: null } }], { parentId: populationId === ROOT ? null : populationId, dims: [{ channel, transform: { ...tx } }], name: args.name ?? `${marker || channel}+`, view, origin: 'agent', method: 'virtual FMO', explanation: `From the virtual FMO's ${(100 * quantile).toFixed(1)}th percentile.` });
      }
      const message = `Virtual FMO of ${marker ? `${marker} (${channel})` : channel} in ${population} of ${sample.name}: the negative ends at ${round(result.threshold, 4)} (${(100 * quantile).toFixed(1)}th percentile of the predicted values without the dye; the unstained control alone would say ${round(result.unstainedThreshold, 4)}${real ? `; the FMO control ${fmoSample.name} says ${round(real.threshold, 4)}` : ''}). The spread comes mostly from ${data.spreadFrom.slice(0, 3).map((c) => `${c.channel} (${Math.round(100 * c.share)}%)`).join(', ') || 'no other dye'}. It is a prediction of spread, a guide for gating, not a replacement for a real FMO on dim or critical markers.${proposed ? ` ${proposed.message}` : ''}`;
      return { message, data: { ...data, ...(proposed ? { proposal: proposed.data } : {}) } };
    },

    async auto_gate(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const parentRef = resolvePopulation(args.parent);
      const parentId = parentRef === ROOT ? null : parentRef;
      const parentIndices = population(view, ws(), parentRef);
      if (parentIndices === undefined) throw new ActionError('The parent population does not apply to this sample.');
      const x = resolveChannel(view, args.x);
      const tx = channelTransform(ws(), view, x);
      const xs = view.scaled(x, tx);
      if (args.method === 'valley') {
        const result = valleyThreshold(xs, parentIndices);
        const name = view.channelInfo(x)?.marker || x.replace(/-[AHW]$/, '');
        return commitGates(splitGates({ parentId, dims: [{ channel: x, transform: { ...tx } }], threshold: result.threshold, xName: name }), { parentId, view, origin: 'auto', method: 'valley', explanation: result.explanation });
      }
      const y = resolveChannel(view, args.y);
      const ty = channelTransform(ws(), view, y);
      const ys = view.scaled(y, ty);
      const dims = [{ channel: x, transform: { ...tx } }, { channel: y, transform: { ...ty } }];
      let proposal;
      if (args.method === 'singlets') {
        proposal = suggestSinglets(view.column(x), view.column(y), parentIndices, createTransform(tx), createTransform(ty));
        if (!proposal) throw new ActionError('Too few events to propose a singlet gate.');
        if (!args.name) args.name = 'Singlets';
      } else {
        const [ax, ay] = args.at ?? [];
        if (!Number.isFinite(Number(ax)) || !Number.isFinite(Number(ay))) throw new ActionError('density needs "at": [x, y] in data values, a point inside the population.');
        proposal = densityGateAt(xs, ys, parentIndices, createTransform(tx).forward(Number(ax)), createTransform(ty).forward(Number(ay)));
        if (!proposal) throw new ActionError('No population was found at that point.');
      }
      return commitGates([{ type: proposal.type, geometry: proposal.geometry }], { parentId, dims, name: args.name, view, origin: 'auto', method: args.method, explanation: proposal.explanation });
    },

    async edit_gate(args) {
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('All events is not a gate.');
      const gate = gateById(ws(), id);
      if (args.delete) {
        const result = proposeGateRemoval(ws(), author, id);
        store.commit(result.ws, `${author} ${result.held ? 'proposed deleting' : 'deleted'} ${gate.name}`);
        if (result.held) toast(`${author} proposes deleting ${gate.name}. Review the proposal to accept or reject it.`);
        return { message: result.held ? `Proposed deleting ${gate.name} and its subpopulations; it stays until the user accepts your proposal.` : `Deleted ${gate.name}, which you had proposed, with its subpopulations.`, data: { proposal: proposalSummary() } };
      }
      const patch = {};
      if (args.name && String(args.name) !== gate.name) patch.name = uniqueGateName(ws(), gate.parentId, String(args.name));
      if (args.color && /^#[0-9a-f]{6}$/i.test(args.color)) patch.color = args.color;
      if (!Object.keys(patch).length) throw new ActionError('Give a new name, a color or delete: true.');
      const result = proposeGateEdit(ws(), author, id, patch);
      store.commit(result.ws, `${author} ${result.held ? 'proposed changing' : 'changed'} ${gate.name}`);
      return { message: result.held ? `Proposed the change to ${gatePath(ws(), id)}; it applies when the user accepts your proposal.` : `Updated ${gatePath(ws(), id)}.`, data: { proposal: proposalSummary() } };
    },

    async review_gate(args) {
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Name a gated population.');
      const gate = gateById(ws(), id);
      const rows = [];
      for (const sample of ws().samples.filter((s) => s.role === 'sample' || s.role === 'reference')) {
        const view = await loadedView(sample);
        const indices = populationSet(view, ws(), id);
        if (indices === undefined) continue;
        const parent = populationSet(view, ws(), gate.parentId ?? ROOT);
        const robustness = gateRobustness(view, ws(), id);
        rows.push({ sample: sample.name, count: countOf(indices, view), percentOfParent: (100 * countOf(indices, view)) / (countOf(parent, view) || 1), boundary: robustness?.rating, sensitivity: round(robustness?.sensitivity), adjusted: Boolean(gate.overrides?.[sample.id]) });
      }
      const freqs = rows.map((r) => r.percentOfParent).sort((a, b) => a - b);
      const median = freqs[Math.floor(freqs.length / 2)] ?? 0;
      const mad = (freqs.map((f) => Math.abs(f - median)).sort((a, b) => a - b)[Math.floor(freqs.length / 2)] ?? 0) * 1.4826 || 1e-9;
      for (const row of rows) {
        row.z = round((row.percentOfParent - median) / mad, 3);
        row.percentOfParent = round(row.percentOfParent);
      }
      rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const outliers = rows.filter((r) => Math.abs(r.z) > 3).map((r) => r.sample);
      return { message: `${gate.name}: median ${median.toFixed(2)}% of parent across ${rows.length} samples${outliers.length ? `; outliers: ${outliers.join(', ')}` : '; no outliers'}.`, data: { population: gatePath(ws(), id), median: round(median), rows } };
    },

    async adapt_gate(args) {
      const { adaptAcrossSamples, autogatingRecord, cannotAdapt } = await import('../lib/autogating.js');
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Name a gated population.');
      let gate = gateById(ws(), id);
      // Quadrants and splits move as a family: adapt their first member.
      if (gate.linkId) gate = ws().gates.find((g) => g.linkId === gate.linkId) ?? gate;
      const reason = cannotAdapt(gate);
      if (reason) throw new ActionError(`${gate.name}: ${reason}.`);
      const views = new Map();
      for (const sample of ws().samples.filter((s) => s.role === 'sample' || s.role === 'reference' || gate.overrides?.[s.id] || gate.meta?.drawnOn === s.id)) {
        const view = await loadedView(sample).catch(() => null);
        if (view) views.set(sample.id, view);
      }
      let run;
      try {
        run = adaptAcrossSamples(ws(), gate.id, views, { groupBy: args.groupBy || undefined });
      } catch (error) {
        throw new ActionError(`${gate.name}: ${error.message}`);
      }
      const name = (sampleId) => ws().samples.find((s) => s.id === sampleId)?.name ?? sampleId;
      const confident = run.results.filter((r) => r.status === 'adjust');
      if (confident.length) {
        const record = { ...autogatingRecord(ws(), gate, run, confident.map((r) => r.sampleId), app.version), proposedBy: author };
        const result = proposeGateAdjustments(ws(), author, gate.id, Object.fromEntries(confident.map((r) => [r.sampleId, r.geometry])), Object.fromEntries(confident.map((r) => [r.sampleId, round(r.confidence, 3)])), record);
        store.commit(result.ws, `${author} ${result.held ? 'proposed adapting' : 'adapted'} ${gate.name} to ${confident.length} sample${confident.length === 1 ? '' : 's'}`);
        if (result.held) toast(`${author} proposes adjusting ${gate.name} for ${confident.length} sample${confident.length === 1 ? '' : 's'}. Review the proposal to accept or reject it.`);
      }
      const order = { review: 0, adjust: 1, keep: 2 };
      const rows = run.results.slice().sort((a, b) => order[a.status] - order[b.status] || a.confidence - b.confidence).map((r) => ({
        sample: name(r.sampleId),
        group: r.group ?? undefined,
        status: r.status,
        confidence: round(r.confidence, 3),
        percentOfParentNow: round(100 * r.frequencies.current),
        percentOfParentAdapted: round(100 * r.frequencies.adapted),
        reason: r.reason,
      }));
      const counts = { adjust: 0, keep: 0, review: 0 };
      for (const r of run.results) counts[r.status] += 1;
      const review = rows.filter((r) => r.status === 'review').map((r) => r.sample);
      return {
        message: `${gate.name}, learned from ${run.exemplars.map((e) => `${name(e.sampleId)} (${e.kind})`).join(', ')}: ${counts.keep} sample${counts.keep === 1 ? '' : 's'} already fit; ${counts.adjust ? `proposed adjustments for ${counts.adjust}, which apply when the user accepts your proposal` : 'nothing to adjust'}; ${review.length ? `${review.length} uncertain, for the user to check by hand: ${review.join(', ')}` : 'none uncertain'}.${run.skipped.length ? ` Not adapted: ${run.skipped.map((s) => `${name(s.sampleId)} (${s.reason})`).join('; ')}.` : ''}`,
        data: { population: gatePath(ws(), gate.id), learnedFrom: run.exemplars.map((e) => ({ sample: name(e.sampleId), kind: e.kind })), rows, skipped: run.skipped.map((s) => ({ sample: name(s.sampleId), reason: s.reason })), proposal: proposalSummary() },
      };
    },

    async propose_compensation(args) {
      const gateId = args.population ? resolvePopulation(args.population) : ROOT;
      const unstained = args.unstained ? resolveSample(args.unstained) : null;
      const method = args.method === 'regression' ? 'regression' : 'median';
      let result;
      try {
        result = await spilloverFromControls(data, ws(), { gateId: gateId === ROOT ? null : gateId, unstainedId: unstained?.id ?? null, method });
      } catch (error) {
        throw new ActionError(`${error.message} Single-stain controls have the role "single-stain" and a stained channel (workspace_summary lists the samples).`);
      }
      const targets = args.samples?.length ? args.samples.map((s) => resolveSample(s)) : ws().samples.filter((s) => s.role !== 'single-stain' && s.role !== 'unstained');
      if (!targets.length) throw new ActionError('No samples to apply the matrix to.');
      const name = `Proposed by ${author} (${method}, ${new Date().toLocaleDateString()})`;
      const proposed = proposeCompensation(ws(), author, { name, channels: result.detectors, matrix: result.matrix, source: 'computed', method, report: result.report, ...(result.spread ? { spread: result.spread } : {}) }, targets.map((s) => s.id));
      store.commit(proposed.ws, `${author} proposed a compensation matrix`);
      toast(`${author} proposes a compensation matrix from ${result.controls.length} controls. Review the proposal to accept or reject it.`);
      const n = result.detectors.length;
      const largest = [];
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) largest.push({ from: result.detectors[i], into: result.detectors[j], spillover: round(result.matrix[i * n + j], 3) });
      largest.sort((a, b) => b.spillover - a.spillover);
      const warnings = result.report.flatMap((r) => (r.warnings ?? []).map((w) => `${r.control}: ${w}`));
      return { message: `Proposed a ${n}×${n} matrix from ${result.controls.length} single-stain controls for ${targets.length} sample${targets.length === 1 ? '' : 's'}; it applies when the user accepts your proposal.${warnings.length ? ` Warnings: ${warnings.slice(0, 4).join(' ')}` : ''}`, data: { detectors: result.detectors, largest: largest.slice(0, 12), warnings, proposal: proposalSummary() } };
    },

    // A compensation checked against the single-stain controls (lib/compensation.js
    // controlResiduals, as Compensate → Check against the controls): each control compensated
    // with the matrix, and what remains of its dye in every other detector is that entry's error.
    async check_compensation(args) {
      const { compensationOf } = await import('../lib/engine.js');
      const { controlResiduals } = await import('../lib/compensation.js');
      const w = ws();
      const sample = args.sample ? resolveSample(args.sample) : w.samples.find((s) => s.role === 'sample') ?? w.samples[0];
      if (!sample) throw new ActionError('The workspace has no samples.');
      let spill;
      let source;
      if (args.compensation) {
        const comp = w.compensations.find((c) => c.name === args.compensation || c.id === args.compensation);
        if (!comp) throw new ActionError(`No compensation named ${args.compensation}. Compensations: ${w.compensations.map((c) => c.name).join(', ') || 'none'}.`);
        spill = { channels: comp.channels, matrix: comp.matrix };
        source = `the compensation "${comp.name}"`;
      } else {
        const view = await loadedView(sample);
        spill = compensationOf(w, sample, view);
        if (!spill) throw new ActionError(`${sample.name} is not compensated; name a compensation to check.`);
        source = sample.compensationId === 'file' ? `the matrix in ${sample.name}'s file ($SPILLOVER)` : `the compensation "${w.compensations.find((c) => c.id === sample.compensationId)?.name ?? sample.compensationId}"`;
      }
      const controls = w.samples.filter((s) => s.role === 'single-stain' && s.stain && spill.channels.includes(s.stain));
      if (!controls.length) throw new ActionError('No single-stain controls with a stained channel of the matrix: mark them with annotate_samples (role "single-stain", stain the channel).');
      const inputs = [];
      for (const control of controls) {
        const view = await loadedView(control);
        inputs.push({ channel: control.stain, columns: Object.fromEntries(spill.channels.filter((c) => view.raw.has(c)).map((c) => [c, view.raw.get(c)])) });
      }
      const rows = controlResiduals(inputs, { channels: spill.channels, matrix: spill.matrix }, { threshold: 0.002 });
      const percent = (v) => round(100 * v, 4);
      const errors = rows.filter((r) => !r.broad).slice(0, 12).map((r) => ({ from: r.from, into: r.to, current: percent(r.current), suggested: percent(r.suggested), residual: percent(r.residual) }));
      const broad = [...new Set(rows.filter((r) => r.broad).map((r) => r.from))];
      const top = errors[0];
      return {
        message: `Checked ${source} against ${inputs.length} single-stain controls. ${top ? `The largest error: ${top.from} into ${top.into} is ${top.current}% and the controls say ${top.suggested}% (${top.residual > 0 ? 'under' : 'over'}-compensated by ${Math.abs(top.residual)} points).` : 'No entry is off by 0.2 points or more.'}${broad.length ? ` The positives of ${broad.join(', ')} are brighter than their negatives in several detectors at once, which spillover does not explain (more autofluorescent positive cells, as in a viability control).` : ''} Values are percent spillover (row dye into column detector); a fix is a new matrix (propose_compensation computes one from the controls).`,
        data: { checked: source, controls: inputs.length, errors, broad },
      };
    },

    async annotate_samples(args) {
      const list = Array.isArray(args.samples) ? args.samples : [];
      if (!list.length) throw new ActionError('Give samples: [{ "sample": "name", "meta": { "condition": "stim" }, "role": "single-stain", "stain": "FITC-A" }, ...].');
      const changes = {};
      const described = [];
      for (const entry of list) {
        const sample = resolveSample(entry.sample);
        const change = {};
        if (entry.meta && typeof entry.meta === 'object') {
          change.meta = {};
          for (const [field, value] of Object.entries(entry.meta)) {
            const key = String(field).trim();
            if (!key) continue;
            change.meta[key] = value === null || value === undefined || value === '' ? null : String(value);
          }
        }
        if (entry.role !== undefined) {
          if (!SAMPLE_ROLES.includes(entry.role)) throw new ActionError(`Role "${entry.role}" is not one of ${SAMPLE_ROLES.join(', ')}.`);
          change.role = entry.role;
        }
        if (entry.stain !== undefined) {
          if (entry.stain === null || entry.stain === '') change.stain = null;
          else {
            const channel = sample.channels.find((c) => c.name === entry.stain || c.name.toLowerCase() === String(entry.stain).toLowerCase() || (c.marker && c.marker.toLowerCase() === String(entry.stain).toLowerCase()));
            if (!channel) throw new ActionError(`${sample.name} has no channel "${entry.stain}". Channels: ${sample.channels.map((c) => c.name).join(', ')}`);
            change.stain = channel.name;
          }
        }
        if (!Object.keys(change).length) continue;
        changes[sample.id] = { ...(changes[sample.id] ?? {}), ...change, meta: { ...(changes[sample.id]?.meta ?? {}), ...(change.meta ?? {}) } };
        described.push(`${sample.name}: ${[...Object.entries(change.meta ?? {}).map(([k, v]) => `${k} = ${v ?? '(removed)'}`), ...(change.role ? [`role ${change.role}`] : []), ...(change.stain !== undefined ? [`stained channel ${change.stain ?? '(none)'}`] : [])].join(', ')}`);
      }
      if (!described.length) throw new ActionError('Nothing to annotate: give meta, role or stain for each sample.');
      const result = proposeAnnotations(ws(), author, changes);
      store.commit(result.ws, `${author} proposed annotating ${described.length} sample${described.length === 1 ? '' : 's'}`);
      toast(`${author} proposes annotations for ${described.length} sample${described.length === 1 ? '' : 's'}. Review the proposal to accept or reject them.`);
      return { message: `Proposed annotations for ${described.length} sample${described.length === 1 ? '' : 's'}; they apply when the user accepts your proposal (until then, compare and the other tools see the current annotations).`, data: { annotations: described, proposal: proposalSummary() } };
    },

    async run_qc(args) {
      const qc = await import('./qc-run.js');
      const w = ws();
      const chosen = args.samples?.length ? args.samples.map((s) => resolveSample(s)) : w.samples.filter((s) => s.role === 'sample' || s.role === 'reference' || (args.includeControls && s.role !== 'bead'));
      if (!chosen.length) throw new ActionError('No samples to check.');
      const existing = w.derived.find((d) => d.kind === 'qc' && !d.proposal && d.outputs?.includes(qc.QC_CHANNEL));
      const proposed = w.derived.find((d) => d.kind === 'qc' && d.proposal && d.proposedBy === author);
      const already = chosen.filter((s) => existing?.files?.[s.id]);
      const todo = chosen.filter((s) => !existing?.files?.[s.id]);
      const settings = structuredClone(app.qcState?.settings ?? qc.DEFAULT_SETTINGS);
      if (args.variant) {
        if (!['refined', 'classic'].includes(args.variant)) throw new ActionError('variant is refined or classic.');
        settings.variant = args.variant;
      }
      if (args.mad !== undefined) settings.mad = Number(args.mad);
      const results = new Map();
      for (const sample of todo) {
        const result = await qc.runQC(app, sample, settings);
        results.set(sample.id, result);
        app.qcState?.results?.set(sample.id, result);
      }
      if (results.size) {
        const perSample = new Map();
        const summaries = { ...(proposed?.summary?.perSample ?? {}) };
        for (const [id, result] of results) {
          perSample.set(id, { [qc.QC_CHANNEL]: Float32Array.from(result.mask) });
          summaries[id] = result.persisted;
        }
        await proposeResult({
          id: proposed?.id,
          kind: 'qc',
          name: 'Acquisition QC',
          method: 'PeacoQC + flow rate + margins',
          params: qc.paramsOf(settings),
          seed: 1,
          outputs: [qc.QC_CHANNEL],
          files: proposed?.files ?? {},
          summary: { version: 1, software: `CytoWeave ${app.version ?? ''}`.trim(), references: [qc.QC_CITE.peacoqc, qc.QC_CITE.flowai], perSample: summaries },
        }, perSample, `${author} proposed acquisition QC of ${results.size} sample${results.size === 1 ? '' : 's'}`);
      }
      let gate = null;
      if (args.addGate) {
        if (w.gates.some((g) => g.dims.some((d) => d.channel === qc.QC_CHANNEL))) gate = 'a gate on QC pass exists already';
        else {
          store.commit(proposeRootGate(ws(), author, qc.qcPassGate()).ws, `${author} proposed a QC pass gate at the top`);
          gate = 'proposed at the top of the gating tree';
        }
      }
      if (results.size || gate) toast(`${author} proposes ${[results.size ? `acquisition QC of ${results.size} sample${results.size === 1 ? '' : 's'}` : '', gate === 'proposed at the top of the gating tree' ? 'a “QC pass” gate at the top' : ''].filter(Boolean).join(' and ')}. Review the proposal to accept or reject it.`);
      const rows = [...results.entries()].map(([id, r]) => {
        const p = r.persisted;
        return { sample: p.name, score: p.score, grade: p.grade, percentRemoved: round(p.percentRemoved, 3), events: p.eventCount, removed: p.removed, findings: p.findings.filter((f) => f.method !== 'summary' && f.severity !== 'info').slice(0, 4).map((f) => f.text), drifted: p.drifted };
      }).sort((a, b) => a.score - b.score);
      const low = rows.filter((r) => r.score < 70).map((r) => `${r.sample} (${r.score})`);
      return {
        message: `${rows.length ? `Checked ${rows.length} sample${rows.length === 1 ? '' : 's'} (${settings.variant ?? 'refined'} PeacoQC, flow rate, margins, drift): ${low.length ? `low scores: ${low.join(', ')}` : 'all scored 70 or more'}. The results are proposed: their "${qc.QC_CHANNEL}" channel (1 = passed) can be gated at once.` : 'No sample needed checking.'}${already.length ? ` Already checked by the user (their result stands): ${already.map((s) => s.name).join(', ')}.` : ''}${gate ? ` QC pass gate: ${gate}${gate.startsWith('proposed') ? '; it moves every population beneath it when the user accepts' : ''}.` : ''}`,
        data: { rows, alreadyChecked: already.map((s) => s.name), gate, proposal: proposalSummary() },
      };
    },

    async unmix(args) {
      const run = await import('./spectral-run.js');
      const { AF_MODES, METHODS } = await import('../lib/spectral-ui.js');
      let state = run.spectralState(ws());
      if (!state.controls.length) throw new ActionError('Spectral unmixing needs single-stain reference controls: give them the role "single-stain" (annotate_samples; the user must accept), and an unstained control the role "unstained" for autofluorescence.');
      const steps = [];
      const setup = state.setup;
      const mine = setup?.proposal && setup.proposedBy === author;
      const hasSpectra = state.activeRefs().length > 0;
      // The user's reference library is used as it is; the agent builds (or rebuilds) only its own.
      if (setup && !setup.proposal && !hasSpectra) throw new ActionError('The reference library has no spectra yet. The user computes them in the Spectral view (or, with no library, unmix computes a proposed one).');
      if (!setup || (mine && (args.recompute || !hasSpectra))) {
        const refs = await run.computeReferences(app, {});
        let record = { ...(setup ?? run.baseSetup(state, app.version)), references: refs.references, params: refs.params, spreading: null, modified: new Date().toISOString() };
        record = proposeDerived(ws(), author, record);
        store.commit(record.ws, `${author} proposed reference spectra from ${refs.computed.length} controls`, ['derived']);
        const failed = refs.computed.filter((r) => r.error);
        steps.push(`reference spectra from ${refs.computed.length - failed.length} of ${refs.computed.length} controls${failed.length ? ` (failed: ${failed.map((r) => `${r.sampleName}: ${r.error}`).join('; ')})` : ''}`);
        state = run.spectralState(ws());
        if (state.unstainedSample && args.autofluorescence !== false) {
          const gateId = args.unstainedPopulation ? resolvePopulation(args.unstainedPopulation) : null;
          const af = await run.findAutofluorescence(app, { gateId });
          if (af) {
            const next = proposeDerived(ws(), author, { ...state.setup, autofluorescence: af.autofluorescence, settings: { ...(state.setup.settings ?? {}), afMode: af.afMode }, modified: new Date().toISOString() });
            store.commit(next.ws, `${author} proposed ${af.autofluorescence.k} autofluorescence signature${af.autofluorescence.k > 1 ? 's' : ''}`, ['derived']);
            steps.push(`${af.autofluorescence.k} autofluorescence signature${af.autofluorescence.k > 1 ? 's' : ''} from ${state.unstainedSample.name} (${af.autofluorescence.population})`);
          }
        }
        state = run.spectralState(ws());
      } else {
        steps.push(`the ${setup.proposal ? 'proposed' : "user's"} reference library (${state.activeRefs().length} spectra, ${state.afSignatures().length} autofluorescence signature${state.afSignatures().length === 1 ? '' : 's'})`);
      }
      const existing = ws().derived.find((d) => d.kind === 'unmixing' && !d.proposal);
      const chosen = args.samples?.length ? args.samples.map((x) => resolveSample(x)) : ws().samples.filter((x) => x.role === 'sample' || x.role === 'reference');
      const already = chosen.filter((x) => existing?.files?.[x.id]);
      const todo = chosen.filter((x) => !existing?.files?.[x.id]);
      if (args.method && !METHODS.some((m) => m.id === args.method)) throw new ActionError(`method is one of ${METHODS.map((m) => m.id).join(', ')}.`);
      if (args.autofluorescenceMode && !AF_MODES.some((m) => m.id === args.autofluorescenceMode)) throw new ActionError(`autofluorescenceMode is one of ${AF_MODES.map((m) => m.id).join(', ')}.`);
      let unmixed = null;
      if (todo.length) {
        try {
          unmixed = await run.unmixSamples(app, todo, { method: args.method, afMode: args.autofluorescenceMode });
        } catch (error) {
          throw new ActionError(`${error.message}${steps.length ? ` (done so far, proposed: ${steps.join('; ')})` : ''}`);
        }
        const { perSample, ...record } = unmixed.result;
        await proposeResult(record, perSample, `${author} proposed unmixing ${perSample.size} sample${perSample.size === 1 ? '' : 's'} (${unmixed.methodLabel})`);
        if (unmixed.channelSettings) store.commit(run.withChannelSettings(ws(), unmixed.channelSettings, unmixed.outputs.length), 'Scales for unmixed channels', ['ws']);
        toast(`${author} proposes unmixing ${perSample.size} sample${perSample.size === 1 ? '' : 's'}. Review the proposal to accept or reject it.`);
      }
      const refs = state.activeRefs().map((r) => ({ fluorochrome: r.name, control: r.sample.name, peakDetector: r.ref.peakDetector, stainIndex: round(r.ref.stainIndex, 3), warnings: r.ref.warnings?.length ? r.ref.warnings : undefined }));
      const complexity = state.panelComplexity();
      return {
        message: `${unmixed ? `Unmixed ${unmixed.result.perSample.size} sample${unmixed.result.perSample.size === 1 ? '' : 's'} (${unmixed.methodLabel}${unmixed.result.params.afMode !== 'none' ? `, autofluorescence ${unmixed.result.params.afMode}` : ''}) into ${unmixed.outputs.length} channels, proposed: they can be gated at once (e.g. ${unmixed.outputs.slice(0, 3).join(', ')}).` : 'No sample needed unmixing.'} Used ${steps.join('; ')}. Panel complexity index ${round(complexity, 3)}.${already.length ? ` Already unmixed by the user (their channels stand): ${already.map((x) => x.name).join(', ')}.` : ''}${unmixed?.skipped.length ? ` Skipped: ${unmixed.skipped.join('; ')}.` : ''}`,
        data: { channels: unmixed?.outputs ?? existing?.outputs ?? [], references: refs, complexityIndex: round(complexity, 4), samples: unmixed?.result.summary.samples.map((x) => ({ sample: x.sample, events: x.events, medianResidual: x.medianResidual })) ?? [], alreadyUnmixed: already.map((x) => x.name), proposal: proposalSummary() },
      };
    },

    async kinetics(args) {
      const { guessMeasure, kineticsOfView } = await import('./kinetics.js');
      const gateId = resolvePopulation(args.population);
      const samples = args.samples?.length ? args.samples.map((x) => resolveSample(x)) : ws().samples.filter((x) => x.role === 'sample' || x.role === 'reference');
      if (!samples.length) throw new ActionError('There are no samples to measure.');
      if (args.statistic && !['median', 'mean'].includes(args.statistic)) throw new ActionError('statistic is median or mean.');
      const options = {
        statistic: args.statistic ?? 'median',
        binWidth: args.binWidth > 0 ? args.binWidth : undefined,
        smoothing: args.smoothing ?? 3,
        stimulus: Number.isFinite(args.stimulus) ? args.stimulus : undefined,
        responseEnd: Number.isFinite(args.responseEnd) ? args.responseEnd : undefined,
        threshold: Number.isFinite(args.threshold) ? args.threshold : undefined,
      };
      const rows = [];
      let label = null;
      for (const sample of samples) {
        const view = await loadedView(sample);
        const indices = population(view, ws(), gateId);
        if (indices === undefined) {
          rows.push({ sample: sample.name, error: 'the population does not apply' });
          continue;
        }
        let measure;
        if (args.numerator || args.denominator) measure = { numerator: resolveChannel(view, args.numerator), denominator: resolveChannel(view, args.denominator) };
        else if (args.channel) measure = { channel: resolveChannel(view, args.channel) };
        else {
          const guess = guessMeasure(view);
          measure = guess.mode === 'ratio' ? { numerator: guess.numerator, denominator: guess.denominator } : { channel: guess.channel };
        }
        const name = (channel) => channelLabel(ws(), channel, { short: true });
        if (measure.numerator) Object.assign(measure, { numeratorLabel: name(measure.numerator), denominatorLabel: name(measure.denominator) });
        else measure.label = name(measure.channel);
        try {
          const { result: r, measure: m } = kineticsOfView(view, indices, measure, options);
          label ??= m.label;
          rows.push({
            sample: sample.name,
            events: r.events,
            stimulus: r.stimulus ? { time: round(r.stimulus.time, 5), source: r.stimulus.source, resume: round(r.stimulus.resume, 5) } : null,
            baseline: round(r.baseline, 4),
            peak: round(r.peak, 4),
            timeToPeak: round(r.timeToPeak, 4),
            halfMaxTime: round(r.halfMaxTime, 4),
            amplitude: round(r.amplitude, 4),
            fold: round(r.fold, 3),
            area: round(r.area, 4),
            endLevel: round(r.endLevel, 4),
            respondingPercent: round(r.respondingNet, 3),
            responded: r.responded ?? false,
            threshold: round(r.threshold, 4),
            binWidth: r.binWidth,
            warnings: r.warnings.length ? r.warnings : undefined,
          });
        } catch (error) {
          rows.push({ sample: sample.name, error: error.message });
        }
      }
      const ok = rows.filter((r) => !r.error);
      return {
        message: `Kinetics of ${label ?? 'the signal'} in ${gatePath(ws(), gateId) || 'all events'} for ${ok.length} sample${ok.length === 1 ? '' : 's'}: ${ok.map((r) => (r.stimulus ? `${r.sample} ${r.responded ? `peak ${r.peak} at +${r.timeToPeak} s, ${r.respondingPercent}% responding` : 'no response'}` : `${r.sample} no stimulus found`)).join('; ')}.${rows.length > ok.length ? ` Not measured: ${rows.filter((r) => r.error).map((r) => `${r.sample} (${r.error})`).join(', ')}.` : ''}`,
        data: { measure: label, population: gatePath(ws(), gateId) || 'All events', statistic: options.statistic, rows },
      };
    },

    async plate(args) {
      const { platesOf, paddedWellName, wellName } = await import('../lib/plates.js');
      const { PLATE_STATISTICS, annotationFields, controlWells, plateValues, plateZPrime } = await import('./plate-analysis.js');
      const all = platesOf(ws().samples);
      if (!all.length) throw new ActionError('No sample has a well. Wells come from the files\' $WELLID or WELL ID keywords, names such as Plate1_A01.fcs, or a "well" annotation (annotate_samples or plate_layout).');
      const plate = resolvePlate(all, args.plate);
      const byId = new Map(ws().samples.map((s) => [s.id, s]));
      const samples = plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean);
      const fields = annotationFields(samples);
      const summary = {
        plates: all.map((p) => ({ name: p.name, format: p.format, wells: p.placed.length })),
        plate: plate.name,
        format: plate.format,
        wellSources: [...new Set(plate.placed.map((p) => p.source))],
        duplicates: plate.duplicates.length ? plate.duplicates : undefined,
        fields: Object.fromEntries(fields.map((f) => [f, [...new Set(samples.map((s) => s.meta?.[f]).filter((v) => v !== undefined && v !== ''))].slice(0, 24)])),
      };
      if (!args.statistic && !args.population) {
        return { message: `${all.length} plate${all.length === 1 ? '' : 's'}; ${plate.name}: ${plate.format}-well, ${plate.placed.length} wells with a sample (wells from ${summary.wellSources.join(' and ')}); layout fields: ${fields.join(', ') || 'none'}.`, data: summary };
      }
      const stat = args.statistic ?? 'freqParent';
      const def = PLATE_STATISTICS.find((s) => s.id === stat);
      if (!def) throw new ActionError(`statistic is one of ${PLATE_STATISTICS.map((s) => s.id).join(', ')}.`);
      const gateId = resolvePopulation(args.population);
      const first = await loadedView(samples[0]);
      const spec = { stat, gateId, ...(def.needsChannel ? { channel: resolveChannel(first, args.channel) } : {}), ...(def.needsValue ? { value: Number(args.value ?? (stat === 'percentile' ? 50 : 0)) } : {}) };
      const values = await plateValues(ws(), plate, spec, (id) => loadedView(byId.get(id)));
      const grid = [];
      for (let r = 0; r < plate.rows; r += 1) {
        const row = [];
        for (let c = 0; c < plate.columns; c += 1) {
          const id = plate.wells[r * plate.columns + c][0];
          row.push(id ? round(values.get(id)?.value, 5) : null);
        }
        grid.push(row);
      }
      const controlField = args.controlField ?? fields.find((f) => /^(control|type|well ?type)$/i.test(f)) ?? null;
      const z = controlField ? plateZPrime(values, controlWells(samples, controlField), Boolean(args.robust)) : null;
      const few = plate.placed.filter((p) => (values.get(p.sampleId)?.events ?? 0) < (args.minEvents ?? 100)).map((p) => paddedWellName(p.row, p.column));
      return {
        message: `${gatePath(ws(), gateId) || 'All events'}: ${stat}${spec.channel ? ` of ${spec.channel}` : ''} across ${plate.name} (${values.size} wells)${z ? `; Z′ ${round(z.z, 3)} (${z.rating}) from ${z.positive.n} positive and ${z.negative.n} negative control wells ("${controlField}")` : ''}${few.length ? `; ${few.length} wells with fewer than ${args.minEvents ?? 100} events` : ''}.`,
        data: {
          ...summary,
          statistic: stat,
          population: gatePath(ws(), gateId) || 'All events',
          channel: spec.channel,
          rows: Array.from({ length: plate.rows }, (_, r) => wellName(r, 0).replace(/\d+$/, '')),
          grid,
          zPrime: z ? { value: round(z.z, 4), rating: z.rating, robust: z.robust, field: controlField, positive: { n: z.positive.n, mean: round(z.positive.mean, 5), sd: round(z.positive.sd, 4) }, negative: { n: z.negative.n, mean: round(z.negative.mean, 5), sd: round(z.negative.sd, 4) } } : null,
          fewEvents: few.length ? few : undefined,
        },
      };
    },

    async plate_layout(args) {
      const { platesOf, parseLayout, layoutChanges } = await import('../lib/plates.js');
      const all = platesOf(ws().samples);
      if (!all.length) throw new ActionError('No sample has a well yet: give wells first with annotate_samples (meta.well), or open files whose keywords or names carry them.');
      if (!args.layout) throw new ActionError('layout is the CSV text: a "well" column (A01 …), an optional "plate" column and one column per field; or plate maps (a block per field: its name, then 1, 2, …; rows A, B, …).');
      let layout;
      try {
        layout = parseLayout(String(args.layout));
      } catch (error) {
        throw new ActionError(error.message);
      }
      const targets = layout.entries.some((e) => e.plate) ? all : [resolvePlate(all, args.plate)];
      const byId = new Map(ws().samples.map((s) => [s.id, s]));
      const changes = {};
      let matched = 0;
      const unmatched = [];
      for (const plate of targets) {
        const result = layoutChanges(layout, plate, byId);
        for (const [id, meta] of Object.entries(result.changes)) changes[id] = { meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])) };
        matched += result.matched;
        unmatched.push(...result.unmatched);
      }
      if (!matched) throw new ActionError(`None of the layout's ${layout.entries.length} wells has a sample on ${targets.map((p) => p.name).join(', ')}.`);
      const result = proposeAnnotations(ws(), author, changes);
      store.commit(result.ws, `${author} proposed a plate layout`);
      toast(`${author} proposes a plate layout for ${matched} wells (${layout.fields.join(', ')}). Review the proposal to accept or reject it.`);
      return { message: `Proposed ${layout.fields.join(', ')} for ${matched} wells${unmatched.length ? `; ${unmatched.length} of the layout's wells have no sample` : ''}. They apply when the user accepts your proposal.`, data: { format: layout.format, fields: layout.fields, wells: matched, unmatched: unmatched.length ? unmatched : undefined, warnings: layout.warnings.length ? layout.warnings : undefined, proposal: proposalSummary() } };
    },

    async dose_response(args) {
      const { platesOf } = await import('../lib/plates.js');
      const { PLATE_STATISTICS, doseResponseData, fitGroups, guessFields, plateValues, plateZPrime, controlWells } = await import('./plate-analysis.js');
      const all = platesOf(ws().samples);
      if (!all.length) throw new ActionError('No sample has a well: plates come from the files\' $WELLID keywords, their names or "well" annotations.');
      const plate = resolvePlate(all, args.plate);
      const byId = new Map(ws().samples.map((s) => [s.id, s]));
      const samples = plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean);
      const guessed = guessFields(samples);
      const stat = args.statistic ?? 'freqParent';
      const def = PLATE_STATISTICS.find((s) => s.id === stat);
      if (!def) throw new ActionError(`statistic is one of ${PLATE_STATISTICS.map((s) => s.id).join(', ')}.`);
      const gateId = resolvePopulation(args.population);
      const first = await loadedView(samples[0]);
      const spec = { stat, gateId, ...(def.needsChannel ? { channel: resolveChannel(first, args.channel) } : {}), ...(def.needsValue ? { value: Number(args.value ?? 0) } : {}) };
      const doseField = args.doseField ?? guessed.dose;
      if (!doseField) throw new ActionError('Name the annotation that holds each well\'s dose (doseField); plate_layout or annotate_samples sets it.');
      const normalize = args.normalize ?? 'none';
      if (!['none', 'controls', 'inhibition'].includes(normalize)) throw new ActionError('normalize is none, controls or inhibition.');
      const model = args.model ?? 'LL.4';
      if (!['LL.4', 'LL.5'].includes(model)) throw new ActionError('model is LL.4 or LL.5.');
      const controlField = args.controlField ?? guessed.control;
      const values = await plateValues(ws(), plate, spec, (id) => loadedView(byId.get(id)));
      let set;
      try {
        set = doseResponseData(samples, values, { doseField, groupField: args.groupField ?? guessed.group, controlField, normalize });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const fixed = {};
      if (normalize !== 'none') {
        const falling = set.groups.every((g) => {
          const doses = [...new Set(g.x)].sort((a, b) => a - b);
          const at = (d) => g.y.filter((_, i) => g.x[i] === d).reduce((s, v, _, a) => s + v / a.length, 0);
          return at(doses[0]) >= at(doses.at(-1));
        });
        if (args.fixBottom !== false) fixed[falling ? 'c' : 'd'] = 0;
        if (args.fixTop !== false) fixed[falling ? 'd' : 'c'] = 100;
      }
      const fits = fitGroups(set, { model, weighting: args.weighting ?? 'none', fixed });
      const z = controlField ? plateZPrime(values, controlWells(samples, controlField)) : null;
      const rows = fits.map((f) => ({
        group: f.name,
        wells: f.x.length,
        ec50: f.fit && !f.fit.flags.includes('no-effect') ? round(f.fit.ec50, 5) : null,
        ec50CI: f.fit && !f.fit.flags.includes('no-effect') ? f.fit.ec50CI.map((v) => round(v, 4)) : null,
        hill: f.fit ? round(f.fit.hill, 4) : null,
        bottom: f.fit ? round(f.fit.bottom, 5) : null,
        top: f.fit ? round(f.fit.top, 5) : null,
        asymmetry: model === 'LL.5' && f.fit ? round(f.fit.parameters.f, 4) : undefined,
        r2: f.fit ? round(f.fit.r2, 4) : null,
        noEffectP: f.fit ? round(f.fit.noEffect.p, 3) : null,
        flags: f.fit ? f.fit.flags : ['no fit'],
        error: f.error ?? undefined,
      }));
      return {
        message: `Dose-response of ${gatePath(ws(), gateId) || 'all events'} ${stat}${normalize !== 'none' ? ` (as ${normalize === 'inhibition' ? '% inhibition' : '% of controls'})` : ''} on ${plate.name}, ${model}: ${rows.map((r) => (r.flags.includes('no-effect') ? `${r.group} no dose-response` : r.ec50 !== null ? `${r.group} EC50 ${r.ec50} ${set.unit}${r.flags.length ? ` (${r.flags.join(', ')})` : ''}` : `${r.group} not fitted`)).join('; ')}${z ? `. Z′ ${round(z.z, 3)} (${z.rating})` : ''}.`,
        data: { plate: plate.name, population: gatePath(ws(), gateId) || 'All events', statistic: stat, channel: spec.channel, normalize, model, weighting: args.weighting ?? 'none', fixed, doseField, unit: set.unit, rows, zPrime: z ? round(z.z, 4) : null },
      };
    },

    async bead_assay(args) {
      const { platesOf } = await import('../lib/plates.js');
      const { beadAssay } = await import('../lib/beadassay.js');
      const { beadAssayInput, guessBeadChannels, guessFields } = await import('./plate-analysis.js');
      const groupsArg = Array.isArray(args.groups) ? args.groups : [];
      if (!groupsArg.length) throw new ActionError('groups: [{ "population": "Beads A", "analytes": ["IL-2", "IL-4", …] }, …], the analytes of each bead group from its dimmest bead to its brightest.');
      const all = platesOf(ws().samples);
      const plate = all.length ? resolvePlate(all, args.plate) : null;
      const byId = new Map(ws().samples.map((s) => [s.id, s]));
      const samples = plate ? plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean) : ws().samples.filter((s) => s.role === 'sample');
      const guessed = guessFields(samples);
      const first = await loadedView(samples[0]);
      const channels = guessBeadChannels(first.parameters);
      const classification = args.classificationChannel ? resolveChannel(first, args.classificationChannel) : channels.classification;
      const reporter = args.reporterChannel ? resolveChannel(first, args.reporterChannel) : channels.reporter;
      const standardField = args.standardField ?? guessed.standard;
      if (!standardField) throw new ActionError('Name the annotation that marks the standard wells (standardField), e.g. standard = C0 … C7.');
      if (!(Number(args.top) > 0) && !args.tops) throw new ActionError('top is the top standard\'s concentration (e.g. 10000 for 10 000 pg/mL); tops gives it per analyte.');
      const gateIds = groupsArg.map((g) => resolvePopulation(g.population));
      const wells = await beadAssayInput(ws(), samples, gateIds, { classification, reporter }, (id) => loadedView(byId.get(id)));
      const tops = args.tops && typeof args.tops === 'object' ? new Proxy({ ...args.tops }, { get: (t, k) => (k in t ? Number(t[k]) : Number(args.top)) }) : Number(args.top);
      let result;
      try {
        result = beadAssay(wells, {
          groups: groupsArg.map((g, k) => ({ name: gatePath(ws(), gateIds[k]) || 'All events', analytes: (g.analytes ?? []).map(String) })),
          statistic: args.statistic ?? 'median',
          standardField,
          standardMode: args.standardMode ?? 'auto',
          top: tops,
          factor: Number(args.factor ?? 4),
          unit: args.unit ?? 'pg/mL',
          dilutionField: args.dilutionField ?? guessed.dilution,
          sampleField: args.sampleField ?? guessed.specimen,
          model: args.model ?? 'LL.5',
          weighting: args.weighting ?? '1/y2',
          minBeads: Number(args.minBeads ?? 50),
        });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const unit = args.unit ?? 'pg/mL';
      return {
        message: `Bead assay of ${result.analytes.length} analytes on ${plate?.name ?? 'the samples'}: ${result.analytes.filter((a) => a.curve.fit).length} standard curves; ${result.samples.length} samples. Quantifiable ranges (${unit}): ${result.analytes.map((a) => `${a.name} ${round(a.curve.lloq, 4)}–${round(a.curve.uloq, 4)}`).join(', ')}.${result.notes.length ? ` Notes: ${result.notes.join(' ')}` : ''}`,
        data: {
          unit,
          channels: { classification, reporter },
          analytes: result.analytes.map((a) => ({
            name: a.name,
            group: a.group,
            classificationLevel: round(a.center, 5),
            lloq: round(a.curve.lloq, 5),
            uloq: round(a.curve.uloq, 5),
            lod: round(a.curve.lod, 4),
            curve: a.curve.fit ? Object.fromEntries(Object.entries(a.curve.fit.parameters).map(([k, v]) => [k, round(v, 6)])) : null,
            standards: (a.curve.levels ?? []).map((l) => ({ concentration: round(l.concentration, 5), recovery: round(l.recovery, 4), cv: round(l.cv, 3) })),
            error: a.curve.error,
          })),
          samples: result.samples.map((s) => ({ name: s.name, wells: s.wells, concentrations: Object.fromEntries(Object.entries(s.results).map(([k, r]) => [k, { mean: round(r.mean, 5), cv: round(r.cv, 3), flags: r.flags.length ? r.flags : undefined }])) })),
          notes: result.notes.length ? result.notes : undefined,
        },
      };
    },

    // The panel optimizer (lib/panel-optimizer.js through ui/panel-design.js): which dye each
    // marker should carry, from the experiment's reference or compensation controls, or from an
    // instrument's spectral library. Nothing in the workspace changes.
    async design_panel(args) {
      const design = await import('./panel-design.js');
      const run = await import('./spectral-run.js');
      const { SPECTRA_RECORDS } = await import('../lib/spectral-library.js');
      const { INSTRUMENT_RECORDS, instrumentOf } = await import('../lib/instrument-record.js');
      const { levelLabel } = await import('../lib/panel-optimizer.js');
      const w = ws();
      if (!Array.isArray(args.markers) || !args.markers.length) throw new ActionError('markers: a list of { name, level (high, medium, low or molecules per cell), dye (optional: fixed) }.');
      const markers = args.markers.map((m) => (typeof m === 'string' ? { name: m, level: 'medium' } : { name: String(m.name ?? '').trim(), level: m.level ?? 'medium', dye: m.dye ?? null }));
      if (markers.some((m) => !m.name)) throw new ActionError('Every marker needs a name.');
      const names = markers.map((m) => m.name);
      const groups = args.groups === undefined ? [{ name: 'All markers', markers: names }] : (args.groups ?? []).map((g, k) => (Array.isArray(g) ? { name: `Group ${k + 1}`, markers: g } : { name: g.name ?? `Group ${k + 1}`, markers: g.markers ?? [] }));
      for (const g of groups) for (const m of g.markers) if (!names.includes(m)) throw new ActionError(`The group ${g.name} names ${m}, which is not among the markers.`);
      const library = async (id) => (app.library?.getRecord ? (await app.library.getRecord(SPECTRA_RECORDS, id).catch(() => null)) ?? null : null);
      const runsOf = async (id) => (app.library?.getRecord ? ((await app.library.getRecord(INSTRUMENT_RECORDS, id).catch(() => null))?.runs ?? []) : []);
      const state = run.spectralState(w);
      const want = args.from ?? null;
      let inputs = null;
      let from;
      if ((!want || want === 'spectral') && state.activeRefs().length >= 2) {
        const inst = instrumentOf((state.controls[0] ?? w.samples[0])?.keywords ?? {});
        inputs = design.spectralInputs(w, { library: inst ? await library(inst.id) : null, runs: inst ? await runsOf(inst.id) : [], instrumentName: inst?.name });
        from = 'the reference controls of this experiment and the instrument\'s spectral library';
      } else if ((!want || want === 'compensation') && w.compensations.some((c) => c.spread?.noise)) {
        const comp = args.compensation ? w.compensations.find((c) => c.name === args.compensation || c.id === args.compensation) : w.compensations.find((c) => c.spread?.noise);
        if (!comp?.spread?.noise) throw new ActionError(`No compensation named ${args.compensation} has a spread model (compute it from single-stain controls).`);
        inputs = design.compensationInputs(w, comp);
        from = `the single-stain controls of the compensation "${comp.name}"`;
      } else if (!want || want === 'library') {
        const records = app.library?.listRecords ? (await app.library.listRecords(SPECTRA_RECORDS).catch(() => [])) ?? [] : [];
        const pick = args.instrument ? records.find((r) => r.id === args.instrument || r.name === args.instrument) : records[0];
        if (!pick) throw new ActionError(records.length ? `No spectral library is kept for ${args.instrument}; there are: ${records.map((r) => r.name || r.id).join(', ')}.` : 'There is nothing to design from: no reference controls with spectra, no compensation computed from single-stain controls, and no spectral library of an instrument.');
        const record = await library(pick.id);
        inputs = design.libraryInputs(record, design.libraryDetectors(record), await runsOf(pick.id));
        from = `the spectral library of ${record?.name ?? pick.id}`;
      } else throw new ActionError(`Nothing to design from ${want}: from is spectral (reference controls), compensation (a compensation computed from single-stain controls) or library.`);
      const exclude = Array.isArray(args.dyes) ? inputs.candidates.map((c) => c.name).filter((n) => !args.dyes.some((d) => String(d).toLowerCase() === n.toLowerCase())) : [];
      const unknown = Array.isArray(args.dyes) ? args.dyes.filter((d) => !inputs.candidates.some((c) => c.name.toLowerCase() === String(d).toLowerCase())) : [];
      if (unknown.length) throw new ActionError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among the dyes: ${inputs.candidates.map((c) => c.name).join(', ')}.`);
      let result;
      try {
        result = await design.runDesign(app, inputs, { markers, groups, exclude, brightness: args.brightness ?? {}, source: args.noise ?? null, seed: args.seed ?? 1 });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const r = result.result;
      const compared = r.compared.find((c) => c.rows);
      const data = {
        from,
        kind: inputs.kind,
        noise: result.noise,
        background: result.background,
        method: r.method,
        assignmentsTried: r.assignmentsTried ?? undefined,
        dyeSetsTried: r.method === 'local search' ? r.evaluations : undefined,
        cost: round(r.cost, 6),
        assignments: r.assignments.map((a) => ({
          marker: a.marker,
          expression: levelLabel(a.level),
          dye: a.dye,
          fixed: a.fixed || undefined,
          stainIndex: round(a.stainIndex, 4),
          group: a.group ?? undefined,
          background: round(a.background, 3),
          spreadFrom: a.from.slice(0, 3).map((f) => ({ marker: f.marker, dye: f.dye, share: round(f.share, 3) })),
          alternatives: a.alternatives.map((x) => ({ dye: x.dye, swapWith: x.swapWith ?? undefined, stainIndex: round(x.stainIndex, 4), costIncrease: round(x.increase, 6) })),
        })),
        comparedWithThisPanel: compared ? { costRatio: round(r.cost / compared.cost, 4), assignments: compared.rows.map((x) => ({ marker: x.marker, dye: x.dye, stainIndex: round(x.stainIndex, 4) })) } : undefined,
        dimmestOnBrightestCostRatio: r.rule ? round(r.cost / r.rule.cost, 4) : undefined,
        energyTransfer: r.energyTransfer.map((e) => ({ markers: e.markers, kind: e.kind, donor: e.donor, acceptor: e.acceptor, note: e.note })),
        warnings: r.warnings,
        settings: r.settings,
      };
      const worst = [...r.assignments].sort((a, b) => a.stainIndex - b.stainIndex)[0];
      const message = `Designed ${r.assignments.length} markers from ${from} (${r.method === 'exhaustive' ? `best of all ${r.assignmentsTried} assignments` : `local search, ${r.evaluations} dye sets tried`}; noise: ${result.noise}; background: ${result.background}): ${r.assignments.map((a) => `${a.marker} ${a.dye}`).join(', ')}. The least resolved marker is ${worst.marker} on ${worst.dye} (predicted stain index ${round(worst.stainIndex, 3)}).${compared ? ` Its noise-to-signal is ${Math.round((100 * r.cost) / compared.cost)}% of this experiment's panel.` : ''}${args.groups === undefined ? ' No groups were given, so every marker was taken to be on the same cells (the most conservative assumption).' : ''}${r.energyTransfer.length ? ` ${r.energyTransfer.length} pair(s) of dyes on the same cells can pass energy (see energyTransfer).` : ''} A prediction from the spread model: it assumes the expression levels given and does not predict degraded tandems.`;
      return { message, data };
    },

    async diagnose_unmixing(args) {
      const run = await import('./spectral-run.js');
      const { SPECTRA_RECORDS } = await import('../lib/spectral-library.js');
      const { instrumentOf } = await import('../lib/instrument-record.js');
      const state = run.spectralState(ws());
      if (!state.activeRefs().length) throw new ActionError('The reference library has no spectra yet: unmix first (or the user computes them in the Spectral view).');
      const sample = args.sample ? resolveSample(args.sample) : ws().samples.find((x) => x.id === store.ui.sampleId && x.role !== 'single-stain' && x.role !== 'unstained') ?? ws().samples.find((x) => x.role === 'sample');
      if (!sample) throw new ActionError('Name the sample to diagnose (a stained sample, not a control).');
      const gateId = args.population ? resolvePopulation(args.population) : null;
      const control = state.controls[0] ?? sample;
      const inst = instrumentOf(control.keywords);
      const library = inst && app.library?.getRecord ? ((await app.library.getRecord(SPECTRA_RECORDS, inst.id).catch(() => null)) ?? null) : null;
      const diagnosis = await run.diagnose(app, sample.id, { gateId, library });
      if (!diagnosis) throw new ActionError('The diagnosis was canceled.');
      const { result } = diagnosis;
      const findings = result.findings.map((f) => ({
        kind: f.kind,
        subject: f.subject ?? undefined,
        title: f.title,
        severity: f.severity,
        confidence: f.confidence,
        fromControlsAlone: f.fromControls ? true : undefined,
        evidence: f.evidence,
        fix: f.fix ? { action: f.fix.action, label: f.fix.label, text: f.fix.text } : undefined,
        alternatives: f.alternatives?.length ? f.alternatives.map((x) => ({ action: x.action, label: x.label, text: x.text })) : undefined,
        effect: f.effect ?? undefined,
      }));
      const notable = findings.filter((f) => f.severity !== 'low');
      return {
        message: `${result.healthy && !notable.length ? `No fault found in ${diagnosis.sample} (${diagnosis.population}, ${result.events} events): the references and autofluorescence explain it.` : `${notable.length || findings.length} likely cause${(notable.length || findings.length) === 1 ? '' : 's'} in ${diagnosis.sample} (${diagnosis.population}, ${result.events} events), the most likely first: ${findings.slice(0, 3).map((f, k) => `${k + 1}. ${f.title} (${f.severity} impact, ${f.confidence} confidence; fix: ${f.fix?.label ?? 'none'})`).join(' ')}`} The user applies a fix in the Spectral view's Diagnose tab; then unmix again.`,
        data: { sample: diagnosis.sample, population: diagnosis.population, events: result.events, healthy: result.healthy, baseline: result.baseline, findings, checks: result.checks },
      };
    },

    async explore(args) {
      const run = await import('./explore-run.js');
      const { markerCandidates } = await import('../lib/explore.js');
      const w = ws();
      const popId = resolvePopulation(args.population);
      let samples;
      if (args.samples?.length) samples = args.samples.map((x) => resolveSample(x));
      else if (args.group) {
        const group = w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase());
        if (!group) throw new ActionError(`No group "${args.group}". Groups: ${w.groups.map((g) => g.name).join(', ') || 'none'}.`);
        samples = w.samples.filter((x) => group.sampleIds.includes(x.id));
      } else samples = w.samples.filter((x) => x.role === 'sample' || x.role === 'reference');
      if (!samples.length) throw new ActionError('No samples to analyze.');
      const first = await loadedView(samples[0]);
      const markers = args.markers?.length ? args.markers.map((m) => resolveChannel(first, m)) : markerCandidates(first).filter((c) => c.selected).map((c) => c.name);
      const clustering = args.clustering ?? 'flowsom';
      const embedding = args.embedding ?? 'umap';
      if (!run.CLUSTERINGS.some((c) => c.id === clustering)) throw new ActionError(`clustering is one of ${run.CLUSTERINGS.map((c) => c.id).join(', ')}.`);
      if (!run.EMBEDDINGS.some((e) => e.id === embedding)) throw new ActionError(`embedding is one of ${run.EMBEDDINGS.map((e) => e.id).join(', ')}.`);
      const settings = { ...run.DEFAULT_SETTINGS, markers, clustering, embedding };
      for (const key of ['k', 'seed', 'nNeighbors', 'minDist', 'perplexity', 'resolution']) if (args[key] !== undefined) settings[key] = Number(args[key]);
      if (args.neighbors !== undefined) settings.leidenK = Number(args.neighbors);
      if (args.eventsPerSample !== undefined) settings.perSample = Number(args.eventsPerSample);
      const outputs = [...(embedding !== 'none' ? [`${run.EMBEDDINGS.find((e) => e.id === embedding).axis} 1`] : []), ...(clustering !== 'none' ? [run.CLUSTERINGS.find((c) => c.id === clustering).channel] : [])];
      const taken = w.derived.find((d) => !d.proposal && d.outputs?.some((o) => outputs.includes(o)));
      if (taken) throw new ActionError(`The workspace already has ${taken.name} with the channel${outputs.length > 1 ? 's' : ''} ${outputs.join(', ')}; the user's result stands. Choose another method, or ask the user to remove it.`);
      let computed;
      try {
        computed = await run.runExplore(app, { settings, samples, popId });
      } catch (error) {
        throw new ActionError(error.message);
      }
      // A proposal of the same method replaces the agent's earlier one.
      const earlier = w.derived.find((d) => d.proposal && d.proposedBy === author && d.outputs?.some((o) => computed.result.outputs.includes(o)));
      const { perSample, ...record } = computed.result;
      await proposeResult({ ...record, id: earlier?.id }, perSample, `${author} proposed ${record.name}`);
      const r = computed.run;
      let populations = null;
      if (args.populations && r.k) {
        const gates = run.clusterGates(ws(), { popId, k: r.k, names: r.names, clustering: r.clustering, mem: r.summary?.mem?.labels });
        if (gates.length) {
          const result = proposeGates(ws(), author, gates);
          store.commit(result.ws, `${author} proposed ${gates.length} cluster populations`);
          populations = gates.map((g) => gatePath(store.ws, g.id));
        }
      }
      toast(`${author} proposes ${record.name}${populations ? ` and ${populations.length} cluster populations` : ''}. Review the proposal to accept or reject it.`);
      const q = r.quality;
      const clusters = r.k ? Array.from({ length: r.k }, (_, c) => ({ cluster: c, name: r.names[c], frequency: round(r.summary?.summary?.frequencies?.[c] ?? 0, 4), enrichment: r.summary?.mem?.labels?.[c] ?? undefined, abundanceBySample: Object.fromEntries(r.loaded.map((l, i) => [l.sample.name, round(r.abundance[i][c], 4)])) })) : [];
      return {
        message: `${record.name} of ${popId === ROOT ? 'all events' : gatePath(w, popId)} in ${r.loaded.length} sample${r.loaded.length === 1 ? '' : 's'} on ${markers.length} markers${r.k ? `: ${r.k} clusters` : ''}${r.embedding ? `, a map of ${r.n} events${q ? ` (trustworthiness ${round(q.trustworthiness, 3)}, continuity ${round(q.continuity, 3)})` : ''}` : ''}. Proposed: the channels ${computed.result.outputs.join(', ')} can be gated and plotted at once${populations ? `; ${populations.length} cluster populations proposed` : r.k ? '; pass populations: true to propose the clusters as populations' : ''}.${q?.warnings?.length ? ` Map warnings: ${q.warnings.join(' ')}` : ''}`,
        data: { channels: computed.result.outputs, markers, clusters, quality: q ? { trustworthiness: round(q.trustworthiness, 4), continuity: round(q.continuity, 4), knnPreservation: round(q.knnPreservation, 4), sampleMixing: q.batch ?? undefined, warnings: q.warnings } : null, populations, proposal: proposalSummary() },
      };
    },

    async build_figure(args) {
      const { gatingStrategyFigure, samplesGridFigure } = await import('../lib/figures.js');
      const { plotsOf } = await import('../lib/workspace.js');
      const w = ws();
      const popId = resolvePopulation(args.population);
      let figure;
      if ((args.kind ?? 'gating-strategy') === 'gating-strategy') {
        if (popId === ROOT) throw new ActionError('Name the population whose gating strategy to show.');
        const sample = resolveSample(args.sample);
        try {
          figure = gatingStrategyFigure(w, popId, sample.id);
        } catch (error) {
          throw new ActionError(error.message);
        }
      } else if (args.kind === 'across-samples') {
        let samples;
        let groupName = null;
        if (args.samples?.length) samples = args.samples.map((x) => resolveSample(x));
        else if (args.group) {
          const group = w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase());
          if (!group) throw new ActionError(`No group "${args.group}".`);
          samples = w.samples.filter((x) => group.sampleIds.includes(x.id));
          groupName = group.name;
        } else samples = w.samples.filter((x) => x.role === 'sample');
        if (!samples.length) throw new ActionError('No samples to show.');
        const view = await loadedView(samples[0]);
        const plots = args.plots?.length
          ? args.plots.map((p) => ({ x: resolveChannel(view, p.x), y: p.y ? resolveChannel(view, p.y) : null, type: p.type ?? (p.y ? 'pseudocolor' : 'histogram') }))
          : plotsOf(w, popId).map((p) => ({ x: p.x, y: p.y, type: p.type, options: p.options }));
        if (!plots.length) throw new ActionError('Give plots: [{ "x": "CD4", "y": "CD8" }, ...] (the population has no plots shown in the Gate view to copy).');
        figure = samplesGridFigure(w, popId, plots, samples, groupName);
      } else {
        throw new ActionError('kind is gating-strategy or across-samples.');
      }
      if (args.name) figure.name = String(args.name);
      const result = proposeFigure(ws(), author, figure);
      store.commit(result.ws, `${author} proposed the figure ${figure.name}`, ['figures']);
      toast(`${author} proposes the figure “${figure.name}”. Review the proposal to accept or reject it.`, { action: { label: 'Open Figures', onClick: () => app.setMode('figures') } });
      const plots = figure.items.filter((i) => i.kind === 'plot');
      return { message: `Proposed the figure "${figure.name}" (${plots.length} plot${plots.length === 1 ? '' : 's'}, ${figure.width} × ${figure.height} px). It stays live until exported; export_figure writes it as SVG, PNG or PDF.`, data: { figure: figure.name, plots: plots.map((p) => ({ sample: ws().samples.find((x) => x.id === p.sampleId)?.name, population: p.spec.populationId === ROOT ? 'All events' : gatePath(ws(), p.spec.populationId), x: p.spec.x, y: p.spec.y, type: p.spec.type })), proposal: proposalSummary() } };
    },

    async export_flowjo(args) {
      requireExtension(args.path, args.files ? ['.zip'] : ['.wsp'], args.files ? 'a ZIP of the workspace and its FCS files' : 'a FlowJo workspace');
      if (!ws().samples.length) throw new ActionError('The workspace has no samples.');
      const samples = args.samples?.length ? args.samples.map((x) => resolveSample(x).id) : undefined;
      const out = await app.buildFlowJoExport({ counts: args.counts !== false, files: Boolean(args.files), deidentify: Boolean(args.deidentify), samples });
      const { exact, approximated, omitted } = out.report.summary;
      const notExact = [...new Map(out.report.populations.filter((p) => p.status !== 'exact').map((p) => [`${p.status}|${p.path}`, { population: p.path, status: p.status === 'approximated' ? 'traced' : 'not exported', why: p.detail }])).values()];
      return {
        file: out.bytes,
        message: `FlowJo workspace: ${exact} population-sample pairs exact${approximated ? `, ${approximated} traced on another scale` : ''}${omitted ? `, ${omitted} not exported` : ''}${args.files ? `, with ${ws().samples.length - out.missing} FCS files` : '; keep the FCS files beside it (FlowJo 11 asks to reconnect them once)'}${args.deidentify ? ', de-identified' : ''}.${out.missing ? ` ${out.missing} FCS files were not in the library and are left out.` : ''}`,
        data: { notExact: notExact.slice(0, 50), warnings: out.report.warnings },
      };
    },

    async export_fcs(args) {
      const format = requireExtension(args.path, ['.zip', '.acs'], 'de-identified FCS files (.zip), or the workspace with them (.acs)') === '.acs' ? 'acs' : 'zip';
      const samples = args.samples?.length ? args.samples.map((x) => resolveSample(x).id) : undefined;
      const out = await app.buildDeidentified({ keepDates: Boolean(args.keepDates), format, samples });
      if (!out.files) throw new ActionError('None of the FCS files is in the library.');
      return { file: out.bytes, message: `${out.files} de-identified FCS file${out.files === 1 ? '' : 's'}${format === 'acs' ? ' with the workspace (ACS archive)' : ''}: only technical keywords kept, ${out.removed.length} kinds of keyword removed, the events copied byte for byte. Files are named after their samples, whose names are kept.${out.missing ? ` ${out.missing} files were not in the library.` : ''}`, data: { removed: out.removed } };
    },

    async export_figure(args) {
      const extension = requireExtension(args.path, ['.svg', '.png', '.pdf'], 'a figure');
      const figures = ws().figures;
      if (!figures.length) throw new ActionError('The workspace has no figures; build_figure makes one.');
      const fig = args.figure ? figures.find((f) => f.name.toLowerCase() === String(args.figure).toLowerCase()) ?? figures.find((f) => f.name.toLowerCase().includes(String(args.figure).toLowerCase())) : figures.at(-1);
      if (!fig) throw new ActionError(`No figure "${args.figure}". Figures: ${figures.map((f) => f.name).join(', ')}.`);
      const exporter = await import('./figure-export.js');
      const provenance = args.provenance !== false;
      const file = extension === '.svg' ? await exporter.figureSVG(app, fig, { provenance }) : extension === '.png' ? await exporter.figurePNG(app, fig, { provenance }) : await exporter.figurePDF(app, fig, { provenance });
      return { file, message: `The figure "${fig.name}" as ${extension.slice(1).toUpperCase()}${extension === '.pdf' ? ' (vector)' : extension === '.png' ? ' (3×)' : ''}${provenance ? ', carrying the analysis behind its plots (opening it in CytoWeave shows what changed since)' : ''}.${fig.proposal ? ' The figure is still part of your proposal.' : ''}` };
    },

    async export_table(args) {
      const extension = requireExtension(args.path, ['.csv', '.tsv', '.xlsx', '.pzfx'], 'a table');
      if (extension === '.xlsx' || extension === '.pzfx') return exportSpreadsheet(args, extension);
      if (args.table) {
        // A Tables table, as the Tables view's CSV export writes it.
        const w = ws();
        const table = w.tables.find((t) => t.name.toLowerCase() === String(args.table).toLowerCase());
        if (!table) throw new ActionError(`No table "${args.table}". Tables: ${w.tables.map((t) => t.name).join(', ') || 'none'}.`);
        const { delimitedText, tableControlSamples, tableMatrix, tableSamples } = await import('../lib/tables.js');
        const rows = tableSamples(w, table);
        for (const x of [...rows, ...tableControlSamples(w, table)]) await loadedView(x);
        const matrix = tableMatrix(w, table, rows, (id) => app.data.view(id));
        return { file: delimitedText(matrix, extension === '.tsv' ? '\t' : ','), message: `The table ${table.name}: ${rows.length} rows, ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}.` };
      }
      const table = await actions.statistics_table(args);
      const separator = extension === '.tsv' ? '\t' : ',';
      const quote = (v) => {
        const text = v === null || v === undefined ? '' : String(v);
        return /[",\t\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const rows = table.data.rows;
      const fields = [...new Set(rows.flatMap((r) => Object.keys(r.meta ?? {})))];
      const columns = rows.length ? Object.keys(rows[0].values) : [];
      const lines = [['Sample', ...fields, ...columns].map(quote).join(separator), ...rows.map((r) => [r.sample, ...fields.map((f) => r.meta?.[f] ?? ''), ...columns.map((c) => r.values[c])].map(quote).join(separator))];
      return { file: `${lines.join('\n')}\n`, message: `${table.message} ${rows.length} rows, ${columns.length} population column${columns.length === 1 ? '' : 's'}.` };
    },

    async export_workspace(args) {
      requireExtension(args.path, ['.cwz'], 'a workspace');
      const { serializeWorkspace } = await import('../lib/workspace.js');
      const w = ws();
      const open = openProposals(w);
      return { file: serializeWorkspace(w), message: `The workspace ${w.name}: ${w.samples.length} samples, ${w.gates.length} populations, ${w.tables.length} tables, ${w.figures.length} figures${open.length ? `; ${open.length} proposal${open.length === 1 ? '' : 's'} still open (saved as proposals)` : ''}.` };
    },

    // A reproducibility certificate of the analysis (lib/certificate.js), and its verification.
    async export_certificate(args) {
      requireExtension(args.path, ['.acs'], 'a certificate');
      const { makeCertificate } = await import('./certificates.js');
      const { shortFingerprint } = await import('../lib/certificate.js');
      const includeData = args.includeData !== false;
      let out;
      try {
        out = await makeCertificate(app, { includeData });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const c = out.certificate;
      return {
        file: out.bytes,
        message: `A certificate of ${c.workspace.name}: ${c.total.toLocaleString('en-US')} numbers from ${c.inputs.length} files${includeData ? ' (included)' : ' (not included: verifying needs them)'}; fingerprint ${c.fingerprint} (short ${shortFingerprint(c.fingerprint)}).${c.notChecked.length ? ` Not computed again: ${c.notChecked.map((n) => n.what).join('; ')}.` : ''}${out.warnings.length ? ` Warnings: ${out.warnings.join(' ')}` : ''}`,
        data: { fingerprint: c.fingerprint, numbers: c.total, files: c.inputs.length, includeData, warnings: out.warnings, notChecked: c.notChecked, log: c.log },
      };
    },

    async export_review_report(args) {
      requireExtension(args.path, ['.html', '.htm'], 'a review report');
      const { makeReviewReport } = await import('./review.js');
      const plots = args.plots ?? 'all';
      if (!['all', 'none'].includes(plots)) throw new ActionError('plots is "all" (every sample\'s gates drawn) or "none".');
      let out;
      try {
        out = await makeReviewReport(app, { plots, includeControls: Boolean(args.includeControls) });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const numbers = (out.html.match(/<button type="button" class="n/g) ?? []).length;
      const w = ws();
      return {
        file: out.html,
        message: `A review report of ${w.name}: one HTML file (${(out.html.length / 1e6).toFixed(1)} MB) with ${numbers.toLocaleString('en-US')} numbers, each traced to its source${plots === 'all' ? ', and every sample\'s gates drawn' : ''}. It opens in any browser without CytoWeave and loads nothing from the network.${out.warnings.length ? ` Warnings: ${out.warnings.join(' ')}` : ''}`,
        data: { numbers, bytes: out.html.length, samples: w.samples.length, figures: w.figures.length, tables: w.tables.length, comparisons: out.model.comparisons.length, warnings: out.warnings },
      };
    },

    async verify_certificate(args, event) {
      const { readCertificate, verifyCertificate } = await import('../lib/certificate.js');
      const { sha256 } = await import('../lib/sha256.js');
      const [first, ...rest] = event.files ?? [];
      if (!first) throw new ActionError('verify_certificate needs the path of the certificate.');
      const fetchBytes = async (file) => {
        const response = await fetch(file.url);
        if (!response.ok) throw new ActionError(`${file.name} could not be read.`);
        return new Uint8Array(await response.arrayBuffer());
      };
      let read;
      try {
        read = await readCertificate(await fetchBytes(first));
      } catch (error) {
        throw new ActionError(`${first.name}: ${error.message}`);
      }
      // Supplied files, by checksum, read only when the certificate asks for one.
      const wanted = new Set(read.certificate.inputs.filter((i) => !i.path).map((i) => i.sha256));
      const data = new Map();
      for (const file of rest) {
        if (!wanted.size) break;
        const bytes = await fetchBytes(file);
        const digest = sha256(bytes);
        if (wanted.has(digest)) data.set(digest, bytes);
      }
      const report = await verifyCertificate(read, { version: app.version, data });
      const c = read.certificate;
      return {
        message: report.summary,
        data: {
          verdict: report.verdict,
          analysis: c.workspace.name,
          certified: { created: c.created, version: c.software.version, fingerprint: c.fingerprint },
          verifiedWith: app.version,
          fingerprintOK: report.fingerprint.ok,
          workspaceOK: report.workspace.ok && report.inputsMatch,
          files: { total: report.inputs.length, ok: report.inputs.filter((i) => i.status === 'ok').length, missing: report.inputs.filter((i) => i.status === 'missing').map((i) => i.fileName), changed: report.inputs.filter((i) => i.status === 'changed').map((i) => i.fileName) },
          storedChannels: { total: report.derived.length, ok: report.derived.filter((d) => d.status === 'ok').length },
          log: report.log,
          engines: report.engine,
          numbers: { checked: report.numbers.checked, identical: report.numbers.same, equalTo12Digits: report.numbers.close, largestRelativeDifference: report.numbers.largestRelative, differ: report.numbers.differ.length, notComputed: report.numbers.missing, firstDifferences: report.numbers.differ.slice(0, 50) },
          notChecked: report.notChecked,
        },
      };
    },

    async export_events(args) {
      const extension = requireExtension(args.path, ['.fcs', '.zip', '.h5ad'], 'events (.fcs: the samples concatenated; .zip: an FCS file per sample; .h5ad: AnnData)');
      const w = ws();
      const group = args.group ? w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase()) : null;
      if (args.group && !group) throw new ActionError(`No group "${args.group}". Groups: ${w.groups.map((g) => g.name).join(', ') || 'none'}.`);
      const sampleIds = args.samples?.length ? args.samples.map((x) => resolveSample(x).id) : w.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample')).map((s) => s.id);
      if (!sampleIds.length) throw new ActionError('No samples to export.');
      const count = Number(args.eventsPerSample);
      const fraction = Number(args.fraction);
      if (args.eventsPerSample !== undefined && args.fraction !== undefined) throw new ActionError('Give eventsPerSample or fraction, not both.');
      if (args.eventsPerSample !== undefined && !(count > 0)) throw new ActionError('eventsPerSample must be a positive number.');
      if (args.fraction !== undefined && !(fraction > 0 && fraction <= 1)) throw new ActionError('fraction is a share of each sample\'s events, between 0 and 1.');
      const downsample = args.eventsPerSample !== undefined ? { mode: 'count', value: count, seed: Number(args.seed) || 1 } : args.fraction !== undefined ? { mode: 'fraction', value: fraction, seed: Number(args.seed) || 1 } : { mode: 'none' };
      let channels;
      if (args.channels?.length) {
        const view = await loadedView(w.samples.find((s) => s.id === sampleIds[0]));
        channels = args.channels.map((c) => resolveChannel(view, c));
      }
      const format = extension === '.h5ad' ? 'h5ad' : extension === '.zip' ? 'zip' : 'fcs';
      if (args.values && !['raw', 'compensated'].includes(args.values)) throw new ActionError('values is raw or compensated.');
      let out;
      try {
        out = await app.buildEventsExport({ sampleIds, populationId: args.population ? resolvePopulation(args.population) : ROOT, downsample, format, values: args.values, channels, xValues: args.x === 'compensated' ? 'compensated' : 'arcsinh', cofactor: args.cofactor ? Number(args.cofactor) : undefined });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const r = out.report;
      const what = format === 'h5ad' ? `AnnData: X ${r.events} events × ${r.X.length} channels (${r.values === 'arcsinh' ? `arcsinh, cofactor ${r.cofactor}` : 'compensated values'}); obs ${r.obs.join(', ')}${r.obsm.length ? `; obsm ${r.obsm.join(', ')}` : ''}`
        : format === 'zip' ? `${r.samples.length} FCS files (raw values with each sample's spillover)`
          : `one FCS file of ${r.events} events: ${r.channels.length} channels (${r.values} values${r.spillover ? ', with the spillover matrix' : ''}), SampleID numbering the samples and SourceEvent each event's index in its own file${r.dropped.length ? `; left out, as not in every sample: ${r.dropped.join(', ')}` : ''}`;
      return { file: out.bytes, message: `${what}. ${r.samples.map((x) => `${x.sample} ${x.events} of ${x.of}`).join(', ')}.${out.notes.length ? ` ${out.notes.join(' ')}` : ''}`, data: { report: r, notes: out.notes } };
    },

    async export_report(args) {
      const extension = requireExtension(args.path, ['.pdf', '.pptx'], 'a report');
      const figures = ws().figures;
      if (!figures.length) throw new ActionError('The workspace has no figures; build_figure or apply_template makes one.');
      let fig = args.figure ? figures.find((f) => f.name.toLowerCase() === String(args.figure).toLowerCase()) ?? figures.find((f) => f.name.toLowerCase().includes(String(args.figure).toLowerCase())) : figures.at(-1);
      if (!fig) throw new ActionError(`No figure "${args.figure}". Figures: ${figures.map((f) => f.name).join(', ')}.`);
      const { reportFields } = await import('../lib/reports.js');
      const by = args.by ? String(args.by) : fig.batch?.by ?? 'sample';
      const fields = reportFields(ws());
      const field = by.toLowerCase() === 'sample' ? 'sample' : fields.find((f) => f.toLowerCase() === by.toLowerCase());
      if (!field) throw new ActionError(`by is sample or an annotation field; the samples have ${fields.length ? fields.join(', ') : 'no annotations (annotate_samples sets them)'}.`);
      const group = args.group ? ws().groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase()) : null;
      if (args.group && !group) throw new ActionError(`No group "${args.group}". Groups: ${ws().groups.map((g) => g.name).join(', ') || 'none'}.`);
      const sampleId = args.sample ? resolveSample(args.sample).id : undefined;
      // A table to list on each page, below the plots, when the figure has none.
      if (args.table && !fig.items.some((i) => i.kind === 'stats')) {
        const table = ws().tables.find((t) => t.name.toLowerCase() === String(args.table).toLowerCase());
        if (!table) throw new ActionError(`No table "${args.table}". Tables: ${ws().tables.map((t) => t.name).join(', ') || 'none'}.`);
        const bottom = Math.max(0, ...fig.items.map((i) => i.y + i.h));
        fig = { ...fig, height: Math.max(fig.height, bottom + 240), items: [...fig.items, { id: 'agent-stats', kind: 'stats', x: 40, y: bottom + 20, w: fig.width - 80, h: 200, tableId: table.id, rows: 'page', size: 11 }] };
      }
      const exporter = await import('./figure-export.js');
      const options = { by: field, groupId: group?.id ?? null, ...(sampleId ? { sampleId } : {}), provenance: args.provenance !== false };
      let out;
      try {
        out = extension === '.pptx' ? await exporter.reportPPTX(app, fig, options) : await exporter.reportPDF(app, fig, options);
      } catch (error) {
        throw new ActionError(error.message);
      }
      const { report, trace } = out;
      const fromTables = trace.filter((t) => t.source === 'table').length;
      return {
        file: out.bytes,
        message: `"${fig.name}" by ${field}: ${report.pages.length} page${report.pages.length === 1 ? '' : 's'} as ${extension === '.pptx' ? 'a PowerPoint deck (statistics as native tables)' : 'a PDF'}; ${trace.length} numbers traced (${fromTables} to table columns, ${trace.length - fromTables} gate labels to their gates' % of parent)${options.provenance ? ', with the analysis and the record embedded' : ''}.${report.notes.length ? ` Notes: ${report.notes.join(' ')}` : ''}`,
        data: { pages: report.pages.slice(0, 100).map((p) => ({ page: p.index + 1, label: p.label, samples: p.sampleIds.map((id) => ws().samples.find((x) => x.id === id)?.name) })), notes: report.notes, numbers: trace.length },
      };
    },

    async list_templates() {
      const list = await app.listTemplates();
      const templates = [];
      for (const t of list.slice(0, 50)) {
        const template = await app.loadTemplate(t.id).catch(() => null);
        if (template) templates.push({ name: template.name, saved: t.modified, populations: template.gates.length, markers: Object.values(template.channels).map((c) => c.marker || c.name), notes: template.notes });
      }
      const { STRATEGIES } = await import('../lib/strategies.js');
      const strategies = STRATEGIES.map((t) => ({ id: t.id, name: t.name, description: t.description, citation: t.citation, populations: t.gates.length, markers: Object.values(t.channels).map((c) => c.marker || c.name), substitutions: t.substitutions }));
      return { message: `${templates.length ? `${templates.length} template${templates.length === 1 ? '' : 's'} in the library: ${templates.map((t) => t.name).join(', ')}.` : 'No templates in the library; save_template keeps one.'} Published gating strategies, placed on the data by apply_template: ${strategies.map((t) => `${t.id} (${t.name})`).join(', ')}.`, data: { templates, strategies } };
    },

    async save_template(args) {
      const { buildTemplate } = await import('../lib/templates.js');
      if (!ws().gates.length) throw new ActionError('The workspace has no gates to keep.');
      const gateIds = args.population ? [resolvePopulation(args.population)].filter((id) => id !== ROOT) : null;
      const template = buildTemplate(ws(), { name: String(args.name ?? `${ws().name} template`), gateIds: gateIds?.length ? gateIds : null, version: app.version });
      await app.storeTemplate(template);
      return { message: `Saved the template "${template.name}" to the library: ${template.gates.length} populations on ${Object.keys(template.channels).length} channels (${Object.values(template.channels).map((c) => c.marker || c.name).join(', ')}), ${template.plots.length} plots, ${template.tables.length} tables, ${template.figures.length} figures.${template.notes.length ? ` Notes: ${template.notes.join(' ')}` : ''}`, data: { name: template.name, notes: template.notes } };
    },

    async apply_template(args) {
      const { applyTemplate } = await import('../lib/templates.js');
      const { STRATEGIES } = await import('../lib/strategies.js');
      const wanted = String(args.template ?? '').toLowerCase();
      // A template file's contents (a .cwt), else a published strategy by id (omip-101) or name,
      // else a template in the library.
      let template = null;
      if (args.templateJSON) {
        const { parseTemplate } = await import('../lib/templates.js');
        try {
          template = parseTemplate(typeof args.templateJSON === 'string' ? args.templateJSON : JSON.stringify(args.templateJSON));
        } catch (error) {
          throw new ActionError(error.message);
        }
      }
      if (!template && !wanted) throw new ActionError('Name the template (a template in the library, or a strategy id such as omip-101), or give templateJSON, a template file\'s contents.');
      template ??= STRATEGIES.find((t) => t.id === wanted || t.name.toLowerCase() === wanted || t.name.toLowerCase().startsWith(`${wanted}:`)) ?? null;
      if (!template) {
        const list = await app.listTemplates();
        const entry = list.find((t) => (t.name ?? '').toLowerCase() === wanted) ?? list.find((t) => t.id === args.template) ?? list.find((t) => (t.name ?? '').toLowerCase().includes(wanted));
        if (!entry) throw new ActionError(`No template "${args.template}" in the library. Templates: ${list.map((t) => t.name).join(', ') || 'none'}; published strategies: ${STRATEGIES.map((t) => t.id).join(', ')}.`);
        template = await app.loadTemplate(entry.id);
      }
      if (!ws().samples.length) throw new ActionError('Open the samples first: the template is matched to their channels.');
      // A strategy's recipe gates are placed on one sample's events.
      let place;
      let placedOn = null;
      if (template.gates.some((g) => g.type === 'recipe')) {
        const { placeOnSample } = await import('../lib/recipes.js');
        placedOn = resolveSample(args.sample);
        place = placeOnSample(await loadedView(placedOn), placedOn.name);
      }
      const parentId = args.parent ? resolvePopulation(args.parent) : ROOT;
      const overrides = {};
      for (const [marker, channel] of Object.entries(args.channels ?? {})) {
        const key = Object.keys(template.channels).find((k) => (template.channels[k].marker || template.channels[k].name).toLowerCase() === marker.toLowerCase());
        if (!key) throw new ActionError(`The template has no channel "${marker}".`);
        overrides[key] = resolveChannel(await loadedView(ws().samples[0]), channel);
      }
      const before = ws();
      const result = applyTemplate(before, template, { parentId, overrides, scales: 'keep', figures: args.figures !== false, place, sampleId: store.ui.sampleId ?? undefined });
      // Gates and figures are proposed; plots, tables and scales for channels without one follow.
      let next = proposeGates(before, author, result.gates).ws;
      next = { ...next, plots: result.ws.plots, tables: result.ws.tables, channelSettings: result.ws.channelSettings };
      for (const figure of result.ws.figures.filter((f) => !before.figures.some((g) => g.id === f.id))) next = proposeFigure(next, author, figure).ws;
      store.commit(next, `${author} proposed the template ${template.name}`);
      toast(`${author} proposes the template “${template.name}”: ${result.report.gates.applied} populations. Review the proposal to accept or reject it.`);
      const r = result.report;
      return {
        message: `${template.builtIn ? 'Strategy' : 'Template'} "${template.name}": ${r.gates.applied} of ${template.gates.length} populations proposed${parentId !== ROOT ? ` under ${gatePath(ws(), parentId)}` : ''}, ${r.plots} plots, ${r.tables} tables, ${r.figures} figures; ${r.matched} of ${r.channels.length} channels matched.${r.gates.skipped.length ? ` Not applied: ${r.gates.skipped.map((x) => `${x.gate} (${x.reason})`).join('; ')}.` : ''}${placedOn ? ` Its gates were placed on the events of ${placedOn.name} and are shared by every sample: review_gate and adapt_gate check and adjust them per sample. Populations carry a suggested Cell Ontology term for the user to confirm. ${template.citation ?? ''}` : ' Gates keep their position in data values: on another instrument, review_gate and adapt_gate check and adjust them.'}${template.compensation?.source === 'file' && !template.builtIn ? " The template's samples used their files' compensation." : ''}`,
        data: { placedOn: placedOn?.name ?? null, substitutions: template.substitutions ?? [], channels: r.channels.map((c) => ({ template: c.template, channel: c.channel, how: c.how, note: c.note })), skipped: r.gates.skipped, notes: r.notes, proposal: proposalSummary() },
      };
    },

    async titration(args) {
      const lib = await import('../lib/titration.js');
      const { detectWalk } = await import('./qc-titration.js');
      const w = ws();
      const mode = args.mode === 'voltage' ? 'voltage' : 'titration';
      const named = args.samples?.length ? args.samples.map((ref) => resolveSample(ref)) : null;
      let chosen;
      if (mode === 'voltage') {
        chosen = named ? named.map((sample) => ({ sample })) : detectWalk(w.samples).map(({ sample }) => ({ sample }));
      } else {
        const series = lib.titrationSeries(named ?? w.samples);
        if (named && series.steps.length < named.length) {
          const missing = named.filter((s) => !series.steps.some((x) => x.sample.id === s.id) && !series.unstained.includes(s));
          if (missing.length) throw new ActionError(`No amount in the name or "amount" annotation of ${missing.map((s) => s.name).join(', ')} ("125 ng", "1:200", "2.5 uL").`);
        }
        chosen = series.steps;
      }
      if (chosen.length < 3) throw new ActionError(mode === 'voltage' ? 'Fewer than three samples at different voltages were found; name them with samples.' : 'Fewer than three samples with an amount of antibody were found; name the files with the amount ("125 ng", "1:200") or annotate an "amount" field.');
      const views = new Map();
      for (const x of chosen) views.set(x.sample.id, await loadedView(x.sample));
      const channel = args.channel ? resolveChannel(views.get(chosen[0].sample.id), args.channel) : lib.guessChannel(w, chosen.map((x) => x.sample), views, mode);
      if (!channel) throw new ActionError('The samples have no fluorescence channel.');
      const populationId = args.population ? resolvePopulation(args.population) : (w.gates.find((g) => /lymph/i.test(g.name))?.id ?? ROOT);
      const items = mode === 'voltage'
        ? lib.voltageSeries(chosen.map((x) => x.sample), views, channel).map(({ sample, voltage }) => ({ sample, view: views.get(sample.id), label: `${voltage} V`, voltage }))
        : chosen.map(({ sample, amount }) => ({ sample, view: views.get(sample.id), label: amount.label, amount }));
      const steps = lib.stepsFrom(w, items, { channel, populationId });
      const options = { rsdEN: Number(args.rsdEN) > 0 ? Number(args.rsdEN) : undefined, linearMax: Number(args.linearMax) > 0 ? Number(args.linearMax) : undefined };
      const analysis = mode === 'voltage' ? lib.analyzeVoltageWalk(steps, options) : lib.analyzeTitration(steps);
      const info = w.samples[0]?.channels.find((c) => c.name === channel);
      const populationName = populationId === ROOT ? 'All events' : gatePath(w, populationId);
      const r3 = (v) => (Number.isFinite(v) ? +v.toPrecision(4) : null);
      const rows = analysis.rows.map((x) => ({ step: mode === 'voltage' ? `${x.voltage} V` : x.amount.label, positiveMedian: r3(x.positive?.median), negativeMedian: r3(x.negative?.median), negativeRSD: r3(x.negative?.rsd), positiveP99: r3(x.positive?.p99), stainIndex: r3(x.stainIndex), separationIndex: r3(x.separationIndex), percentPositive: Number.isFinite(x.fraction) ? r3(100 * x.fraction) : null, resolved: x.resolved, ...(mode === 'voltage' ? { withinLinearRange: x.inRange } : {}) }));
      let message;
      if (mode === 'voltage') {
        message = analysis.recommended
          ? `${channel} voltage walk (${rows.length} steps, within ${populationName}): ${Math.round(analysis.minimum.voltage)}–${Math.round(analysis.maximum.voltage)} V. Minimum: the negative cells' rSD reaches 2.5 × the electronic noise (rSD_EN ${r3(analysis.noise.rsdEN)}, ${analysis.noise.source === 'given' ? 'given' : 'estimated from the walk'}); maximum: the positive cells' 99th percentile reaches the top of the linear range. Recommended ${analysis.recommended.voltage} V. Signal ∝ V^${analysis.exponent.toFixed(2)}.`
          : `${channel} voltage walk (${rows.length} steps): no voltage range.`;
      } else {
        message = analysis.recommended
          ? `${info?.marker ? `${info.marker} (${channel})` : channel} titration (${rows.length} steps, within ${populationName}): recommended ${analysis.recommended.row.amount.label} per test, the first amount tested at or above twice the amount giving 90% of saturating staining (${lib.formatAmount(analysis.c90, analysis.rows[0].amount.kind)}, from a saturation curve fitted to the stain index). Highest stain index ${r3(analysis.best.row.stainIndex)} at ${analysis.best.row.amount.label}.`
          : `${channel} titration (${rows.length} steps): no recommendation.`;
      }
      if (analysis.notes.length) message += ` Notes: ${analysis.notes.join(' ')}`;
      let proposed = false;
      if (args.save) {
        const record = lib.titrationRecord(analysis, { mode, channel, marker: info?.marker || null, population: populationName, sampleIds: items.map((x) => x.sample.id), params: options });
        store.commit(proposeDerived(ws(), author, record).ws, `${author} proposed the ${mode === 'voltage' ? 'voltage walk' : 'titration'} of ${channel}`);
        proposed = true;
        message += ' The result is proposed for the workspace (the methods describe it once accepted).';
      }
      return {
        message,
        data: {
          mode, channel, marker: info?.marker || null, population: populationName, rows, notes: analysis.notes, proposed,
          ...(mode === 'voltage'
            ? { exponent: r3(analysis.exponent), rsdEN: r3(analysis.noise?.rsdEN), noiseSource: analysis.noise?.source ?? null, minimumVoltage: r3(analysis.minimum?.voltage), maximumVoltage: r3(analysis.maximum?.voltage), recommendedVoltage: analysis.recommended?.voltage ?? null }
            : { c90: analysis.c90 ? lib.formatAmount(analysis.c90, analysis.rows[0].amount.kind) : null, recommended: analysis.recommended?.row.amount.label ?? null, best: analysis.best?.row.amount.label ?? null }),
        },
      };
    },

    async suggest_cell_types(args) {
      const { suggestForPopulation } = await import('../lib/ontology.js');
      const w = ws();
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const ids = args.populations?.length ? args.populations.map(resolvePopulation).filter((id) => id !== ROOT) : w.gates.filter((g) => g.type !== 'boolean').map((g) => g.id);
      const rows = [];
      let proposed = 0;
      let next = w;
      for (const id of ids) {
        const gate = gateById(w, id);
        const { phenotype, scatter, suggestions } = suggestForPopulation(view, w, id);
        const top = suggestions[0];
        rows.push({ population: gatePath(w, id), phenotype: phenotype.markers, scatter: scatter ?? undefined, confirmed: gate.ontology?.status === 'confirmed' ? `${gate.ontology.label} (${gate.ontology.id})` : undefined, suggestions: suggestions.map((x) => ({ term: x.label, id: x.id, confidence: x.confidence, from: x.reason })) });
        if (args.propose && top && gate.ontology?.status !== 'confirmed') {
          next = proposeGateEdit(next, author, id, { ontology: { id: top.id, label: top.label, status: 'confirmed', by: author, at: new Date().toISOString(), evidence: top.reason } }).ws;
          proposed += 1;
        }
      }
      if (proposed) {
        store.commit(next, `${author} proposed cell types for ${proposed} population${proposed === 1 ? '' : 's'}`);
        toast(`${author} proposes Cell Ontology terms for ${proposed} population${proposed === 1 ? '' : 's'}. Review the proposal to accept or reject them.`);
      }
      return {
        message: `Cell Ontology terms suggested from each population's marker phenotype in ${sample.name} (from the gates' sides and the data, not the names): ${rows.filter((r) => r.suggestions.length).length} of ${rows.length} populations have one.${proposed ? ` Proposed the top term for ${proposed}; they apply when the user accepts.` : args.propose ? ' Nothing new to propose.' : ' Pass propose: true to propose the top terms for the user to confirm.'}`,
        data: { rows, proposal: proposalSummary() },
      };
    },

    async watch_folder(args) {
      const live = app.live;
      if (!live?.available) throw new ActionError('Folder watching needs the CytoWeave program (it is not available when the page is served as a web site).');
      const action = args.action ?? 'status';
      if (action === 'start') {
        if (!args.path) throw new ActionError('Give the folder\'s absolute path.');
        if (args.qc !== undefined) live.options.qc = Boolean(args.qc);
        if (args.beads !== undefined) live.options.beads = Boolean(args.beads);
        await live.start(String(args.path)).catch((error) => { throw new ActionError(error.message); });
        if (args.existing) await live.handOverExisting();
      } else if (action === 'stop') {
        if (live.status?.watching) await live.stop();
      } else if (action === 'existing') {
        if (!live.status?.watching) throw new ActionError('No folder is being watched.');
        await live.handOverExisting();
      } else if (action !== 'status') {
        throw new ActionError('action is start, stop, existing or status.');
      }
      const status = live.status ?? {};
      const files = live.queue.map((q) => ({ file: q.name, state: q.state, sample: q.sampleId ? ws().samples.find((s) => s.id === q.sampleId)?.name : undefined, score: q.score, percentRemoved: q.percentRemoved === undefined ? undefined : round(q.percentRemoved, 3), finding: q.finding ?? undefined, detectorsOutOfControl: q.rejected, error: q.error }));
      return {
        message: status.watching ? `Watching ${status.folder}: ${files.length} file${files.length === 1 ? '' : 's'} so far${status.pending?.length ? `, ${status.pending.length} still being written` : ''}${status.existing ? `; ${status.existing} were there before (action existing checks them)` : ''}. Each finished FCS file is added to the workspace and checked at once (acquisition QC for samples, Q and B for bead files); the folder is only read.` : `No folder is being watched${files.length ? ` (${files.length} files handled earlier)` : ''}.`,
        data: { watching: Boolean(status.watching), folder: status.folder ?? null, pending: status.pending ?? [], existing: status.existing ?? 0, options: { ...live.options }, files },
      };
    },

    async proposals() {
      const history = proposalHistory(ws(), 10).map((e) => ({ time: e.time, decision: e.action === 'accept-proposal' ? 'accepted' : 'rejected', detail: e.detail }));
      const mine = proposalSummary();
      const others = openProposals(ws()).filter((p) => p.author !== author).map((p) => ({ author: p.author, changes: describeProposal(ws(), p).map((i) => i.text) }));
      return { message: `${mine ? `Your open proposal: ${mine.changes.join('; ') || 'nothing left'}.` : 'You have no open proposal.'}${history.length ? ` Latest decision: ${history[0].decision} (${history[0].time}).` : ''}`, data: { open: mine, others, decisions: history } };
    },

    async compare(args) {
      const hypothesis = await import('../lib/hypothesis.js');
      const w = ws();
      const id = resolvePopulation(args.population);
      const stat = args.statistic ?? 'freqParent';
      const field = String(args.groupBy);
      const samples = w.samples.filter((s) => (s.role === 'sample' || s.role === 'reference') && s.meta?.[field] !== undefined && s.meta[field] !== '');
      if (!samples.length) throw new ActionError(`No sample has the metadata field "${field}". Annotate samples first (fields in use: ${[...new Set(w.samples.flatMap((s) => Object.keys(s.meta ?? {})))].join(', ') || 'none'}).`);
      let control;
      let context = {};
      if (COMPARISONS.has(stat)) {
        if (!args.control) throw new ActionError(`${stat} compares each sample with a control sample: name it with control.`);
        const controlSample = resolveSample(args.control);
        const controlView = await loadedView(controlSample);
        control = { sampleId: controlSample.id };
        context = { viewOf: (sampleId) => (sampleId === controlSample.id ? controlView : null) };
      }
      const groups = new Map();
      for (const sample of samples) {
        const view = await loadedView(sample);
        const channel = args.channel ? resolveChannel(view, args.channel) : undefined;
        const value = computeStatistic(view, w, { stat, gateId: id, channel, control }, context);
        if (!Number.isFinite(value)) continue;
        const key = String(sample.meta[field]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ sample: sample.name, value, pair: args.pairBy ? sample.meta?.[args.pairBy] : undefined });
      }
      const names = [...groups.keys()];
      const values = names.map((n) => groups.get(n).map((r) => r.value));
      const summary = names.map((n, i) => ({ group: n, n: values[i].length, median: round(describe(Float32Array.from(values[i])).median), mean: round(values[i].reduce((a, b) => a + b, 0) / values[i].length), samples: groups.get(n) }));
      const tests = [];
      if (names.length === 2) {
        const [a, b] = values;
        let paired = null;
        if (args.pairBy) {
          const map = new Map(groups.get(names[1]).map((r) => [String(r.pair), r.value]));
          const pa = []; const pb = [];
          for (const r of groups.get(names[0])) if (map.has(String(r.pair))) { pa.push(r.value); pb.push(map.get(String(r.pair))); }
          if (pa.length >= 2) paired = [pa, pb];
        }
        const attempt = (fn) => { try { tests.push(fn()); } catch (error) { tests.push({ method: 'not computed', note: error.message }); } };
        if (paired) {
          attempt(() => hypothesis.pairedTTest(paired[0], paired[1]));
          attempt(() => hypothesis.wilcoxonSignedRank(paired[0], paired[1]));
        } else {
          attempt(() => hypothesis.welchTTest(a, b));
          attempt(() => hypothesis.mannWhitneyU(a, b));
          attempt(() => ({ method: 'Hedges g', ...hypothesis.cohensD(a, b) }));
        }
      } else if (names.length > 2) {
        tests.push(hypothesis.welchAnova(values), hypothesis.kruskalWallis(values));
      }
      const label = `${stat}${args.channel ? ` of ${args.channel}` : ''} of ${id === ROOT ? 'all events' : gatePath(w, id)}`;
      const clean = JSON.parse(JSON.stringify(tests, (k, v) => (typeof v === 'number' ? round(v, 6) : v)));
      return { message: `${label} by ${field}: ${summary.map((s) => `${s.group} median ${s.median} (n=${s.n})`).join(' vs ')}${clean[0]?.p !== undefined ? `; ${clean[0].method} p = ${clean[0].p}` : ''}. Each sample is one observation.`, data: { measure: label, groupBy: field, pairBy: args.pairBy, groups: summary, tests: clean } };
    },

    // Differential state (diffcyt-DS-limma: marker medians per cluster or population and sample)
    // or abundance (cluster counts, quasi-binomial GLM) between groups of samples.
    async differential_analysis(args) {
      const differential = await import('../lib/differential.js');
      const hypothesis = await import('../lib/hypothesis.js');
      const w = ws();
      const test = args.test ?? 'state';
      if (!['state', 'abundance'].includes(test)) throw new ActionError('test is "state" (marker medians) or "abundance" (cluster frequencies).');
      const field = String(args.groupBy ?? '');
      const inGroups = w.samples.filter((s) => (s.role === 'sample' || s.role === 'reference') && s.meta?.[field] !== undefined && String(s.meta[field]).trim() !== '');
      if (!inGroups.length) throw new ActionError(`No sample has the metadata field "${field}". Annotate samples first (fields in use: ${[...new Set(w.samples.flatMap((s) => Object.keys(s.meta ?? {})))].join(', ') || 'none'}).`);
      const levels = args.groups?.length ? args.groups.map(String) : [...new Set(inGroups.map((s) => String(s.meta[field])))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      if (levels.length < 2) throw new ActionError(`"${field}" needs at least two groups; it has ${levels.join(', ')}.`);
      const contrast = args.contrast !== undefined ? String(args.contrast) : levels[1];
      if (!levels.includes(contrast) || contrast === levels[0]) throw new ActionError(`contrast must be one of ${levels.slice(1).join(', ')} (tested against ${levels[0]}, the first group).`);
      let chosen = inGroups.filter((s) => levels.includes(String(s.meta[field])));
      // The views themselves are kept: a large cohort can push early samples out of memory.
      let views = [];
      for (const sample of chosen) views.push(await loadedView(sample));
      const pairField = args.pairBy ? String(args.pairBy) : null;
      const covariates = (args.covariates ?? []).map(String).filter((f) => f !== field);
      const parentId = args.parent ? resolvePopulation(args.parent) : ROOT;
      let units;
      let unitName;
      let channel = null;
      let unitsLabel;
      if (args.populations?.length) {
        if (test === 'abundance') throw new ActionError('Differential abundance tests clusters; for populations use compare (a frequency per sample).');
        const gateIds = args.populations.map((p) => resolvePopulation(p));
        // Only the samples where the populations apply take part (a gate beneath a QC result
        // applies only to the samples checked).
        const apply = views.map((view) => gateIds.some((id) => population(view, w, id) !== undefined));
        chosen = chosen.filter((_, i) => apply[i]);
        views = views.filter((_, i) => apply[i]);
        if (chosen.length < 3) throw new ActionError(`The populations apply to only ${chosen.length} of the samples in these groups.`);
        units = { kind: 'populations', gateIds };
        unitName = (id) => (id === ROOT ? 'All events' : gatePath(w, id));
        unitsLabel = `${gateIds.length} populations`;
      } else {
        const channels = differential.clusterChannels(w, app.data.views.values());
        channel = args.clusters ? channels.find((c) => c.name.toLowerCase() === String(args.clusters).toLowerCase()) : channels[0];
        if (!channel) throw new ActionError(channels.length ? `No cluster channel "${args.clusters}". Cluster channels: ${channels.map((c) => c.name).join(', ')}.` : 'There is no cluster channel: cluster the samples first (explore), or test populations.');
        // Only the samples that carry the clusters (with events in the parent) take part.
        const carry = views.map((view) => differential.clusterCounts(view, w, channel.name, parentId)?.total > 0);
        chosen = chosen.filter((_, i) => carry[i]);
        views = views.filter((_, i) => carry[i]);
        if (chosen.length < 3) throw new ActionError(`Only ${chosen.length} of the samples in these groups carry the channel "${channel.name}" with events in the parent population.`);
        const labels = new Set();
        for (const view of views) for (const k of differential.clusterCounts(view, w, channel.name, parentId)?.counts.keys() ?? []) labels.add(k);
        units = { kind: 'clusters', channel: channel.name, parentId, labels: [...labels].sort((a, b) => a - b) };
        unitName = (k) => differential.clusterNameOf(channel.record, k);
        unitsLabel = `${units.labels.length} clusters (${channel.name}${parentId !== ROOT ? ` of ${gatePath(w, parentId)}` : ''})`;
      }
      const designSamples = chosen.map((s) => ({ group: String(s.meta[field]), meta: s.meta }));
      let built;
      try {
        built = differential.buildDesign(designSamples, { levels, contrast, pairField, covariates });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const finish = (rows, extra) => {
        const sorted = [...rows].sort((a, b) => (Number.isFinite(a.p) ? a.p : 2) - (Number.isFinite(b.p) ? b.p : 2));
        const limit = Math.max(1, Math.min(500, Number(args.limit ?? 40)));
        const significant = rows.filter((r) => r.padj < 0.05).length;
        return { sorted: sorted.slice(0, limit), significant, total: rows.length, extra };
      };
      if (test === 'abundance') {
        const counts = views.map((view) => differential.clusterCounts(view, w, units.channel, parentId));
        const da = hypothesis.differentialAbundance(counts.map((c) => units.labels.map((k) => c?.counts.get(k) ?? 0)), counts.map((c) => c?.total ?? 0), built.design, { coefficient: built.coefficient, clusterNames: units.labels.map(unitName) });
        const rows = da.results.map((r, i) => ({ cluster: r.cluster, label: units.labels[i], log2OddsRatio: round(r.log2OddsRatio), p: r.p, padj: r.padj, note: r.note }));
        const out = finish(rows);
        const methods = `Differential abundance of ${unitsLabel} between ${contrast} and ${levels[0]} was tested per cluster with a quasi-binomial generalized linear model (logit link; cluster cells out of ${parentId === ROOT ? 'all events' : gatePath(w, parentId)} per sample; design ~ group${built.covariates.length ? ` + ${built.covariates.join(' + ')}` : ''}) by likelihood-ratio F test, approximating diffcyt (Weber et al. 2019), with p-values adjusted across clusters by the Benjamini–Hochberg procedure, in CytoWeave ${app.version ?? ''}.`;
        return {
          message: `Differential abundance of ${unitsLabel}, ${contrast} vs ${levels[0]} (design ${built.design.names.join(' + ')}; ${chosen.length} samples): ${out.significant} of ${out.total} clusters at adjusted p < 0.05${out.sorted[0] ? `; lowest p: ${out.sorted[0].cluster} (log2 odds ratio ${out.sorted[0].log2OddsRatio}, p ${round(out.sorted[0].p, 3)}, adjusted ${round(out.sorted[0].padj, 3)})` : ''}.`,
          data: { test, groupBy: field, groups: levels, contrast, design: built.design.names, samples: chosen.map((s) => s.name), significant: out.significant, tested: out.total, rows: out.sorted.map((r) => ({ ...r, p: round(r.p, 6), padj: round(r.padj, 6) })), methods },
        };
      }
      const { candidates, state } = differential.stateMarkerCandidates(views[0], channel?.record ?? null);
      const markers = args.markers?.length ? args.markers.map((m) => resolveChannel(views[0], m)) : state.map((c) => c.name);
      if (!markers.length) throw new ActionError('No markers to test: name them with markers.');
      const markerName = (name) => candidates.find((c) => c.name === name)?.marker || views[0].parameters.find((p) => p.name === name)?.marker || name;
      const cofactor = Number(args.cofactor ?? differential.defaultCofactor(chosen[0]));
      const perSample = views.map((view) => differential.stateMedians(view, w, units, markers, cofactor));
      const minCells = Number(args.minCells ?? 3);
      let result;
      try {
        result = differential.differentialState({ counts: perSample.map((p) => p.counts), medians: perSample.map((p) => p.medians), design: built.design, coefficient: built.coefficient, units: perSample[0].units, markers, minCells, minSamples: args.minSamples !== undefined ? Number(args.minSamples) : null });
      } catch (error) {
        throw new ActionError(error.message);
      }
      const rows = result.rows.map((r) => ({ [units.kind === 'clusters' ? 'cluster' : 'population']: unitName(r.unit), marker: markerName(r.marker), channel: r.marker, logFC: round(r.logFC), average: round(r.aveExpr), t: round(r.t), p: r.p, padj: r.padj, samples: r.samples }));
      const out = finish(rows);
      const methods = differential.stateMethods({ unitsLabel, markers, contrastLabel: contrast, referenceLabel: levels[0], covariates: built.covariates, cofactor, minCells, minSamples: result.minSamples, tested: rows.length, version: app.version ?? '' });
      const top = out.sorted[0];
      return {
        message: `Differential state of ${markers.length} markers in ${unitsLabel}, ${contrast} vs ${levels[0]} (diffcyt-DS-limma; design ${built.design.names.join(' + ')}; ${chosen.length} samples; arcsinh cofactor ${cofactor}): ${out.significant} of ${out.total} ${units.kind === 'clusters' ? 'cluster' : 'population'} × marker tests at adjusted p < 0.05${top ? `; lowest p: ${top.marker} in ${top.cluster ?? top.population} (difference of medians ${top.logFC}, p ${round(top.p, 3)}, adjusted ${round(top.padj, 3)})` : ''}${result.filtered.length ? `. Left out (fewer than ${minCells} cells in more than half the samples): ${result.filtered.map(unitName).join(', ')}` : ''}.`,
        data: { test, groupBy: field, groups: levels, contrast, design: built.design.names, samples: chosen.map((s) => s.name), markers: markers.map(markerName), cofactor, kept: result.kept.map(unitName), filtered: result.filtered.map(unitName), priorDf: round(result.dfPrior), significant: out.significant, tested: out.total, rows: out.sorted.map((r) => ({ ...r, p: round(r.p, 6), padj: round(r.padj, 6) })), methods, citations: differential.STATE_CITATIONS },
      };
    },

    async check_robustness(args) {
      const { checkRobustness } = await import('./robustness.js');
      const { methodsSentence } = await import('../lib/multiverse.js');
      const w = ws();
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Choose a gated population: the check varies its gates.');
      const field = String(args.groupBy);
      const samples = w.samples.filter((s) => (s.role === 'sample' || s.role === 'reference') && s.meta?.[field] !== undefined && s.meta[field] !== '');
      const levels = args.groups?.length ? args.groups.map(String) : [...new Set(samples.map((s) => String(s.meta[field])))].sort();
      if (levels.length !== 2) throw new ActionError(`The check compares two groups; "${field}" has ${levels.length} (${levels.join(', ')}). Pass groups: [reference, other].`);
      const chosen = samples.filter((s) => levels.includes(String(s.meta[field])));
      for (const sample of chosen) await loadedView(sample);
      const stat = args.statistic ?? 'freqParent';
      const statistic = { stat, gateId: id, channel: args.channel ? resolveChannel(await loadedView(chosen[0]), args.channel) : undefined };
      const design = args.pairBy ? 'paired-two' : 'two';
      const { summary, choices } = await checkRobustness(app, {
        statistic,
        samples: chosen.map((s) => ({ id: s.id, group: levels.indexOf(String(s.meta[field])), pair: args.pairBy ? s.meta?.[args.pairBy] ?? null : null })),
        design,
        pairField: args.pairBy,
        labels: levels,
        qcReruns: Boolean(args.rerunQC),
      });
      const r = summary.declared?.result;
      const clean = (list) => list.map((d) => ({ choice: d.choice, alternative: d.option, conclusion: d.conclusion, difference: round(d.estimate, 4), p: round(d.p, 6) }));
      return {
        message: `${stat} of ${gatePath(w, id)}, ${levels[1]} vs ${levels[0]}${args.pairBy ? `, paired by ${args.pairBy}` : ''}: ${summary.verdict}. ${summary.text}${summary.verdict !== 'undetermined' ? ` ${methodsSentence(summary, choices)}` : ''}`,
        data: {
          verdict: summary.verdict,
          analyses: summary.total,
          agree: summary.agree,
          declared: r ? { conclusion: summary.declared.conclusion, difference: round(r.estimate, 4), ci: r.ci.map((v) => round(v, 4)), p: round(r.p, 6) } : null,
          dependsOn: clean(summary.dependsOn ?? []),
          sizeDependsOn: clean(summary.sizeDependsOn ?? []),
          choices: choices.map((c) => ({ choice: c.label, alternatives: c.options.slice(1).map((o) => o.label), omitted: c.omitted ?? undefined })),
        },
      };
    },

    async methods() {
      const { methodsText } = await import('../lib/methods.js');
      return { message: methodsText(ws(), { version: app.version }) };
    },

    async export_gating_ml() {
      const { exportGatingML } = await import('../lib/gatingml.js');
      const result = exportGatingML(ws());
      const xml = typeof result === 'string' ? result : result.xml;
      return { message: xml, data: { warnings: result.warnings ?? [] } };
    },
  };

  // The extension of an export's path, which must be one of `allowed`.
  // Excel and Prism exports of a Tables table, every table, or a statistic given as statistics_table
  // takes it (made into a table of one column per population, not kept).
  async function exportSpreadsheet(args, extension) {
    const w = ws();
    let tables;
    if (args.table) {
      const table = w.tables.find((t) => t.name.toLowerCase() === String(args.table).toLowerCase());
      if (!table) throw new ActionError(`No table "${args.table}". Tables: ${w.tables.map((t) => t.name).join(', ') || 'none'}.`);
      tables = [table];
    } else if (args.statistic || args.populations?.length || extension === '.pzfx' || !w.tables.length) {
      const group = args.group ? w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase()) : null;
      if (args.group && !group) throw new ActionError(`No group "${args.group}".`);
      const stat = args.statistic ?? 'freqParent';
      const gateIds = args.populations?.length ? args.populations.map(resolvePopulation) : w.gates.map((g) => g.id);
      const first = w.samples.find((x) => (group ? group.sampleIds.includes(x.id) : x.role === 'sample'));
      const channel = args.channel && first ? resolveChannel(await loadedView(first), args.channel) : undefined;
      const control = args.control ? { sampleId: resolveSample(args.control).id, ...(args.controlPopulation ? { gateId: resolvePopulation(args.controlPopulation) } : {}) } : undefined;
      const counting = args.beadPopulation ? { beadGateId: resolvePopulation(args.beadPopulation), beads: Number(args.beadsPerTube), volume: Number(args.sampleVolume) } : undefined;
      const dilution = args.dilution === undefined || args.dilution === null || args.dilution === '' ? undefined : Number.isFinite(Number(args.dilution)) ? Number(args.dilution) : { field: String(args.dilution) };
      tables = [{ id: 'agent-table', name: `${stat}${args.channel ? ` ${args.channel}` : ''}`, groupId: group?.id ?? null, includeControls: Boolean(group), columns: gateIds.map((id, k) => ({ id: `c${k}`, gateId: id, stat, channel, control, counting, ...(dilution !== undefined ? { dilution } : {}) })) }];
    } else {
      tables = w.tables;
    }
    const { tableSamples, tableControlSamples } = await import('../lib/tables.js');
    for (const table of tables) {
      const ids = new Set([...tableSamples(w, table), ...tableControlSamples(w, table)].map((x) => x.id));
      for (const c of table.columns) for (const id of [...(c.limits?.blankIds ?? []), ...(c.limits?.lowIds ?? [])]) ids.add(id);
      for (const id of ids) await loadedView(w.samples.find((x) => x.id === id));
    }
    const viewOf = (id) => app.data.view(id);
    if (extension === '.xlsx') {
      const { tablesWorkbook } = await import('../lib/spreadsheets.js');
      const { writeXLSX } = await import('../lib/xlsx.js');
      const book = tablesWorkbook(w, tables, viewOf, { version: app.version });
      return { file: await writeXLSX(book.sheets, { title: `${w.name} tables` }), message: `Excel workbook: ${tables.map((t) => t.name).join(', ')} (${book.traced.length} values in full precision), with sheets Columns (each column's definition), Samples (files and checksums), Populations and About (with the methods).` };
    }
    const fields = [...new Set(w.samples.flatMap((x) => Object.keys(x.meta ?? {})))];
    const groupBy = args.groupBy ? fields.find((f) => f.toLowerCase() === String(args.groupBy).toLowerCase()) : null;
    if (args.groupBy && !groupBy) throw new ActionError(`No annotation "${args.groupBy}". Annotations: ${fields.join(', ') || 'none'}.`);
    const { prismTables } = await import('../lib/spreadsheets.js');
    const { writePZFX } = await import('../lib/pzfx.js');
    const out = prismTables(w, tables[0], viewOf, { groupBy });
    return { file: writePZFX(out.tables, { version: app.version, project: w.name, notes: `Exported from CytoWeave by ${author}: ${w.name}, ${tables[0].name}.` }), message: `Prism project: ${out.tables.length} table${out.tables.length === 1 ? '' : 's'} (${tables[0].name}${groupBy ? `, and one column table per statistic grouped by ${groupBy}` : ''}).${out.notes.length ? ` ${out.notes.join(' ')}` : ''}` };
  }

  function requireExtension(path, allowed, what) {
    const match = /\.[a-z0-9]+$/i.exec(String(path ?? ''));
    const extension = match ? match[0].toLowerCase() : '';
    if (!allowed.includes(extension)) throw new ActionError(`The path for ${what} must end in ${allowed.join(' or ')}.`);
    return extension;
  }

  // Records a computed result as part of the agent's proposal: attaches the per-event columns to
  // the samples, stores them in the library, and adds the record marked as proposed.
  //   record: as app.saveDerived's result without perSample (files: columns already stored);
  //   perSample: Map(sampleId → { channel: Float32Array }).
  async function proposeResult(record, perSample, label) {
    const files = { ...(record.files ?? {}) };
    const sameWorkspace = store.sameWorkspace();
    for (const [sampleId, columns] of presentSamples(ws(), perSample)) {
      files[sampleId] = {};
      for (const [name, column] of Object.entries(columns)) {
        data.setDerived(sampleId, name, column);
        files[sampleId][name] = await data.persistColumn(column);
      }
    }
    // Storing the columns takes a while: another workspace may have been opened meanwhile.
    if (!sameWorkspace()) throw new WorkspaceChangedError();
    const result = proposeDerived(ws(), author, { ...record, files });
    store.commit(result.ws, label, ['derived', 'data']);
    return result.derived;
  }

  // Adds gates as a proposal of the agent, for the user to review.
  function commitGates(gates, { parentId, dims, name, view, origin, method, explanation }) {
    const w = ws();
    const meta = { origin, method, note: explanation, created: new Date().toISOString() };
    const records = gates.map((g) => ({
      id: g.id ?? newId('g'),
      parentId,
      dims: g.dims ?? dims,
      linkId: g.linkId,
      type: g.type,
      geometry: g.geometry,
      name: uniqueGateName(w, parentId, g.name ?? name ?? defaultName(view, g.dims ?? dims, g)),
      meta,
    }));
    const result = proposeGates(w, author, records);
    store.commit(result.ws, `${author} proposed ${records.map((r) => r.name).join(', ')}`);
    app.selectGate(records[records.length > 1 ? 1 : 0].id, { keepMode: true });
    toast(`${author} proposed ${records.map((r) => r.name).join(', ')}. Review the proposal to keep or discard it.`);
    const parent = populationSet(view, store.ws, parentId ?? ROOT);
    const created = records.map((r) => {
      const indices = populationSet(view, store.ws, r.id);
      return { population: gatePath(store.ws, r.id), count: indices === undefined ? null : countOf(indices, view), percentOfParent: indices === undefined ? null : round((100 * countOf(indices, view)) / (countOf(parent, view) || 1)) };
    });
    return { message: `Proposed ${created.map((c) => `${c.population}: ${c.percentOfParent}% of parent (${c.count} events)`).join('; ')} in ${view.record.name}.${explanation ? ` ${explanation}` : ''} The user will accept or reject your proposal; meanwhile the populations can be used as parents.`, data: { created, proposal: proposalSummary() } };
  }

  function proposalSummary() {
    const proposal = openProposals(ws()).find((p) => p.author === author);
    return proposal ? { id: proposal.id, opened: proposal.opened, changes: describeProposal(ws(), proposal).map((i) => i.text) } : null;
  }

  function defaultName(view, dims, gate) {
    const label = (channel) => view.channelInfo(channel)?.marker || channel.replace(/-[AHW]$/, '');
    if (dims.length === 1) return `${label(dims[0].channel)}+`;
    return `${label(dims[0].channel)} × ${label(dims[1].channel)}`;
  }

  // --- Connection ---------------------------------------------------------------------------------

  // Actions only "cytoweave run" sends (the program marks its own events trusted; agents' and
  // scripts' actions never are): the run stands for the user who started it.
  const trusted = {
    async accept_proposals() {
      const { acceptProposal } = await import('../lib/proposals.js');
      const open = openProposals(ws());
      const changes = open.flatMap((p) => describeProposal(ws(), p).map((i) => i.text));
      let next = ws();
      // The run's own proposals are the user's own changes; any other author's stay attributed.
      for (const p of open) next = acceptProposal(next, p.id, 'cytoweave run', { own: p.author === author });
      if (open.length) store.commit(next, `Accept ${open.length} proposal${open.length === 1 ? '' : 's'} (cytoweave run)`);
      return { message: open.length ? `Accepted ${open.length} proposal${open.length === 1 ? '' : 's'}: ${changes.join('; ')}.` : 'No open proposals.', data: { accepted: open.length, changes } };
    },
  };

  async function perform(event) {
    let outcome;
    try {
      const handler = event.trusted && trusted[event.action] ? trusted[event.action] : actions[event.action];
      if (!handler) throw new ActionError(`Unknown action "${event.action}". Actions: ${Object.keys(actions).join(', ')}.`);
      const args = typeof event.args === 'object' && event.args ? event.args : {};
      author = event.client || 'a program on this computer';
      const result = await handler(args, event);
      let message = result.message ?? 'Done.';
      // An export: the file goes to the program, which writes it where the caller asked.
      if (result.file !== undefined) {
        if (!event.output) throw new ActionError('Writing files needs the CytoWeave program.');
        const response = await fetch(event.output, { method: 'POST', body: result.file, headers: { 'Content-Type': 'application/octet-stream' } });
        const written = await response.json().catch(() => ({}));
        if (!response.ok) throw new ActionError(`The file could not be written: ${written.error ?? `HTTP ${response.status}`}`);
        message = `Wrote ${written.path} (${written.bytes} bytes). ${message}`;
      }
      outcome = { ok: true, message, data: result.data ?? null };
    } catch (error) {
      outcome = { ok: false, message: error.message ?? String(error) };
    }
    await fetch(`api/remote/result/${encodeURIComponent(event.id)}`, { method: 'POST', body: JSON.stringify(outcome), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  }

  let source = null;
  const connect = () => {
    source = new EventSource('api/remote/events');
    source.addEventListener('action', (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      perform(event);
    });
    source.onerror = () => {
      source.close();
      setTimeout(connect, 2000);
    };
  };
  connect();
  app.remoteActions = actions;
  return { disconnect: () => source?.close() };
}
