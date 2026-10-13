import assert from 'node:assert/strict';
import test from 'node:test';
import { miflowcytChecklist, toBibTeX, writeMethods } from './methods.js';
import { analysisSnapshot, diffAnalyses, geometryShift } from './diff.js';
import { addCompensation, addGates, createWorkspace, setGateGeometry, setChannelTransform, updateGate } from './workspace.js';

const linear = { type: 'linear', min: 0, max: 1000 };

function workspace() {
  let ws = createWorkspace('Methods');
  ws = { ...ws, samples: [
    { id: 's1', name: 'A', role: 'sample', fcsVersion: 'FCS3.1', technology: 'conventional', compensationId: 'file', acquisition: { cytometer: 'LSRFortessa' }, channels: [{ name: 'FITC-A', marker: 'CD3', type: 'fluorescence' }], keywords: { $CYT: 'LSRFortessa', $DATE: '01-OCT-2026' }, meta: { condition: 'ctrl' } },
    { id: 's2', name: 'B', role: 'single-stain', fcsVersion: 'FCS3.1', technology: 'conventional', compensationId: 'file', acquisition: { cytometer: 'LSRFortessa' }, channels: [], keywords: {}, meta: {} },
  ] };
  ws = addGates(ws, [{ id: 'g1', name: 'Lymphocytes', parentId: null, type: 'polygon', dims: [{ channel: 'FSC-A', transform: linear }, { channel: 'SSC-A', transform: linear }], geometry: { vertices: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]] } }]).ws;
  ws = addGates(ws, [{ id: 'g2', name: 'T cells', parentId: 'g1', type: 'range', dims: [{ channel: 'FITC-A', transform: linear }], geometry: { min: 0.5, max: null } }]).ws;
  ws = setChannelTransform(ws, 'FITC-A', { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  return ws;
}

test('the methods paragraph cites what the workspace used, in order', () => {
  const { paragraphs, references } = writeMethods(workspace(), { version: '0.1.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /1 sample and 1 control, acquired on LSRFortessa/);
  assert.match(text, /\$SPILLOVER/);
  assert.match(text, /logicle \(T = 262144, M = 4.5, A = 0, W = 0.5\) for 1 channel/);
  assert.match(text, /Lymphocytes → T cells/);
  assert.equal(references[0].key, 'fcs31');
  assert.ok(references.some((r) => r.key === 'logicle'));
  assert.ok(references.some((r) => r.key === 'miflowcyt'));
  // The notes lack a contact, so MIFlowCyt is not claimed, only counted.
  assert.match(text, /documents 9 of the 10 MIFlowCyt items/);
  assert.doesNotMatch(text, /Reporting follows MIFlowCyt/);
  const complete = writeMethods({ ...workspace(), notes: 'Lab of Cytometry, contact: lab@example.org' }, { version: '0.1.0' }).paragraphs.join(' ');
  assert.match(complete, /Reporting follows MIFlowCyt/);
  // Citation numbers in the text match the reference list.
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...cited), references.length);
  assert.match(toBibTeX(references), /doi = \{10.1002\/cyto.a.20825\}/);
});

test('the MIFlowCyt checklist reflects the workspace', () => {
  const items = miflowcytChecklist(workspace());
  assert.ok(items.find((i) => i.item.startsWith('Controls')).ok);
  assert.ok(items.find((i) => i.item.startsWith('Gating')).ok);
  assert.ok(items.find((i) => i.item.startsWith('Cytometer')).ok);
});

test('analysis diffs describe gate, compensation and scale changes', () => {
  const before = workspace();
  let after = setGateGeometry(before, 'g1', { vertices: [[0.12, 0.1], [0.5, 0.1], [0.5, 0.5]] });
  after = updateGate(after, 'g2', { name: 'CD3+' });
  after = setGateGeometry(after, 'g2', { min: 0.55, max: null }, { sampleId: 's1' });
  after = addCompensation(after, { name: 'Computed', channels: ['FITC-A', 'PE-A'], matrix: [1, 0.1, 0, 1], source: 'computed' }).ws;
  after = setChannelTransform(after, 'FITC-A', { type: 'arcsinh', cofactor: 150 });
  const { changes, summary } = diffAnalyses(analysisSnapshot(before), analysisSnapshot(after));
  const g1 = changes.find((c) => c.id === 'g1');
  assert.match(g1.detail, /boundary moved by up to 2.0% of the axis/);
  const g2 = changes.find((c) => c.id === 'g2');
  assert.match(g2.detail, /renamed from "T cells"/);
  assert.match(g2.detail, /adjusted for 1 more sample/);
  assert.ok(changes.some((c) => c.kind === 'compensation' && c.action === 'added'));
  assert.ok(changes.some((c) => c.kind === 'scale' && c.detail.startsWith('arcsinh')));
  assert.match(summary, /2 gate change/);
  assert.equal(diffAnalyses(analysisSnapshot(before), analysisSnapshot(before)).changes.length, 0);
  assert.equal(geometryShift('split', { threshold: 0.2 }, { threshold: 0.25 }).toFixed(2), '0.05');
});

test('methods describe clustering and embedding of one result, samples placed on a map, and agent gates', async () => {
  const { addDerived } = await import('./workspace.js');
  let ws = workspace();
  ws = addDerived(ws, { kind: 'umap', method: 'k-means and UMAP', seed: 7, params: { clustering: 'kmeans', embedding: 'umap', k: 9, markers: ['A', 'B'], events: 4000, nNeighbors: 15, minDist: 0.1, placed: ['C', 'D'] } }).ws;
  ws = addDerived(ws, { kind: 'louvain', method: 'Louvain', seed: 7, params: { clustering: 'louvain', embedding: 'none', leidenK: 20, resolution: 0.8, markers: ['A'] } }).ws;
  ws = { ...ws, gates: ws.gates.map((g) => (g.id === 'g2' ? { ...g, meta: { ...g.meta, proposedBy: 'Claude Code', acceptedBy: 'the user' } } : g)) };
  const { paragraphs, references } = writeMethods(ws, { version: '0.2.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /clustered by k-means \[\d+\] into 9 clusters/);
  assert.match(text, /embedded with UMAP \[\d+\] \(15 neighbors/);
  assert.match(text, /2 further sample\(s\) \(C, D\) were placed on the finished map/);
  assert.match(text, /Louvain community detection \[\d+\] \(resolution 0.8\) on a 20-nearest-neighbor graph/);
  assert.match(text, /1 gate\(s\) were proposed by an AI agent \(Claude Code\) and reviewed and accepted by the analyst/);
  for (const key of ['kmeans', 'kmeansPlusPlus', 'hamerly', 'umap', 'louvain', 'phenograph']) assert.ok(references.some((r) => r.key === key), key);
});

test('methods describe an autogating run: what was applied and what was left for review', () => {
  let ws = workspace();
  ws = { ...ws, derived: [{ kind: 'autogating', name: 'Autogating of T cells', gateId: 'g2', params: { confident: 0.8 }, results: { s1: { status: 'adjust', confidence: 0.93, applied: true }, s3: { status: 'review', confidence: 0.41, applied: false }, s4: { status: 'keep', confidence: 0.97, applied: false } } }] };
  const { paragraphs, references } = writeMethods(ws, { version: '0.3.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /T cells was adapted to each sample by landmark registration/);
  assert.match(text, /confidence of at least 0.8 were applied after review by the analyst \(1 sample-gate adjustment\); 1 sample-gate pair was flagged as uncertain/);
  assert.ok(references.some((r) => r.key === 'gaussNorm'));
});

test('methods describe instrument characterization runs', () => {
  let ws = workspace();
  ws = { ...ws, derived: [{ kind: 'instrument-qc', instrument: { name: 'LSR II (H1)' }, runs: [
    { method: 'beads', product: 'Spherotech 8-peak (Rainbow)', peaks: 8, date: '2026-03-02T00:00:00.000Z' },
    { method: 'beads', product: 'Spherotech 8-peak (Rainbow)', peaks: 8, date: '2026-03-03T00:00:00.000Z' },
    { method: 'beads', product: 'Spherotech 8-peak (Rainbow)', peaks: 8, date: '2026-03-04T00:00:00.000Z' },
  ] }] };
  const { paragraphs, references } = writeMethods(ws, { version: '0.3.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /efficiency \(Q\) and optical background \(B\) of each fluorescence detector of LSR II \(H1\) were measured from 3 runs of Spherotech 8-peak \(Rainbow\) beads between 2026-03-02 and 2026-03-04/);
  assert.match(text, /Levey–Jennings charts with Westgard rules/);
  assert.ok(references.some((r) => r.key === 'parksQB') && references.some((r) => r.key === 'westgard'));
});

test('methods say which reference spectra came from the spectral library', () => {
  let ws = workspace();
  ws = { ...ws, derived: [{ kind: 'unmixing', method: 'Ordinary least squares', params: { references: [{ fluorochrome: 'PE', sampleId: 's9' }, { fluorochrome: 'PE-Cy7', sampleId: null, library: { date: '2026-05-20T00:00:00.000Z', file: 'Ref_PE-Cy7.fcs' } }] } }] };
  const text = writeMethods(ws, { version: '0.3.0' }).paragraphs.join(' ');
  assert.match(text, /reference spectra of PE-Cy7 \(acquired 2026-05-20\) came from the instrument's spectral library/);
});

test('methods describe how autofluorescence was unmixed and cite per-cell matching only when it was used', () => {
  const methods = (afMode, autofluorescence) => {
    const ws = { ...workspace(), derived: [{ kind: 'unmixing', method: 'Ordinary least squares. Autofluorescence: help text for the view.', params: { method: 'ols', afMode, autofluorescence, references: [] } }] };
    const { paragraphs, references } = writeMethods(ws, {});
    return { text: paragraphs.find((p) => p.startsWith('Spectral')), keys: references.map((r) => r.key) };
  };
  const none = methods('none', []);
  assert.equal(none.text, 'Spectral data were unmixed by ordinary least squares [3].');
  assert.ok(!none.keys.includes('autofluorescence') && !none.keys.includes('autospectral'));
  const single = methods('single', ['AF1']);
  assert.match(single.text, /an autofluorescence signature unmixed as an additional channel\.$/);
  assert.ok(!single.keys.includes('autospectral'));
  const perEvent = methods('perEvent', ['AF1', 'AF2', 'AF3']);
  assert.match(perEvent.text, /with 3 autofluorescence signatures \[4\] and each event unmixed with the signature that fit it best \(per-cell autofluorescence matching\) \[5\]\.$/);
  assert.deepEqual(perEvent.keys.filter((k) => k === 'autofluorescence' || k === 'autospectral'), ['autofluorescence', 'autospectral']);
  // A workspace that recorded only the description still names its method.
  const ws = { ...workspace(), derived: [{ kind: 'unmixing', method: 'Non-negative least squares', params: {} }] };
  assert.match(writeMethods(ws, {}).paragraphs.join(' '), /unmixed by non-negative least squares \[\d\]\./);
});

test('confirmed Cell Ontology terms are named in the methods, with the reference', async () => {
  const { writeMethods } = await import('./methods.js');
  const { createWorkspace, addGates } = await import('./workspace.js');
  let ws = createWorkspace('t');
  ws = addGates(ws, [{ name: 'T cells', parentId: null, type: 'range', dims: [{ channel: 'CD3', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { min: 0.5, max: null }, ontology: { id: 'CL:0000084', label: 'T cell', status: 'confirmed' } }]).ws;
  const { paragraphs, references } = writeMethods(ws, {});
  assert.ok(paragraphs.some((p) => /T cells as T cell \(CL:0000084\)/.test(p)));
  assert.ok(references.some((r) => r.doi === '10.1186/s13326-016-0088-7'));
});

test('methods describe a titration and a voltage walk, with their references', async () => {
  const { addDerived } = await import('./workspace.js');
  let ws = createWorkspace('Setup');
  ws = addDerived(ws, { kind: 'titration', mode: 'titration', channel: 'PE-A', marker: 'CD4', population: 'Lymphocytes', steps: [{ label: '1.95 ng' }, { label: '125 ng' }, { label: '1000 ng' }], summary: { recommended: '125 ng', c90: '40.6 ng' } }).ws;
  ws = addDerived(ws, { kind: 'titration', mode: 'voltage', channel: 'PE-A', steps: [{ label: '300 V' }, { label: '750 V' }], summary: { rsdEN: 25.1, noiseSource: 'estimated', minimum: 507.2, maximum: 566.8, recommended: 510 } }).ws;
  const { paragraphs, references } = writeMethods(ws, { version: '0.5.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /CD4 reagent \(PE-A\) was titrated in 3 steps from 1\.95 ng to 1000 ng among Lymphocytes/);
  assert.match(text, /125 ng was chosen as at least twice the amount giving 90% of saturating staining \(40\.6 ng\)/);
  assert.match(text, /2\.5 times the detector's electronic noise \(25\.1, estimated from the walk\)/);
  assert.match(text, /507 V.*567 V; 510 V was chosen/);
  for (const key of ['stainIndex', 'separationIndex', 'titration', 'voltageSetup']) assert.ok(references.some((r) => r.key === key), key);
});

test('comparisons, rare-event intervals and detection limits in tables are described and cited', () => {
  let ws = createWorkspace('t');
  ws = {
    ...ws,
    samples: [{ id: 'c', name: 'FMO CD25', role: 'fmo', channels: [] }],
    tables: [{ id: 't', name: 'T', columns: [
      { id: 'a', stat: 'sed', gateId: 'root', channel: 'FITC-A', control: { sampleId: 'c' } },
      { id: 'b', stat: 'pbT', gateId: 'root', channel: 'FITC-A', control: { sampleId: 'c' } },
      { id: 'd', stat: 'countLow', gateId: 'root' },
      { id: 'e', stat: 'freqParent', gateId: 'root', limits: { blankIds: ['c', 'x'], method: 'nonparametric', cvTarget: 10 } },
    ] }],
  };
  const { paragraphs, references } = writeMethods(ws);
  const text = paragraphs.join('\n');
  assert.match(text, /control sample \(FMO CD25\) on the channel, using enhanced normalized subtraction \(SED in FlowJo\) \[\d\] and probability binning \(the T\(χ\) metric\)/);
  assert.match(text, /counts with exact Poisson \[\d\] 95% confidence intervals/);
  assert.match(text, /95th percentile.*CV of 10%, never below the 100 events/);
  for (const key of ['bagwell', 'probabilityBinning', 'garwood', 'detectionLimits', 'eventsNeeded']) assert.ok(references.some((r) => r.key === key), key);
});

test('formula channels, bead calibrations and absolute counts are described and cited', () => {
  let ws = createWorkspace('t');
  ws = addGates(ws, [{ id: 'gb', name: 'Counting beads', parentId: null, type: 'range', dims: [{ channel: 'PE-A', transform: linear }], geometry: { min: 0.9, max: null } }]).ws;
  ws = {
    ...ws,
    samples: [{ id: 's1', name: 'A', role: 'sample', channels: [] }],
    derived: [
      { id: 'f', kind: 'formula', inputs: ['PE-A', 'APC-A'], outputs: ['CD4/CD8'], params: { expression: '[PE-A] / [APC-A]' } },
      { id: 'c', kind: 'calibration', inputs: ['FITC-A'], outputs: ['FITC-A MEFL'], params: { m: 1.0753, b: 2.298, unit: 'MEFL', beads: 'Beads 1', levels: [{ used: false }, { used: true }, { used: true }, { used: true }] }, samples: ['s1'] },
    ],
    tables: [{ id: 't', name: 'T', columns: [{ id: 'k', stat: 'absoluteCount', gateId: 'root', counting: { beadGateId: 'gb', beads: 50000, volume: 50 }, dilution: 2 }] }],
  };
  const { paragraphs, references } = writeMethods(ws);
  const text = paragraphs.join('\n');
  assert.match(text, /CD4\/CD8 = \[PE-A\] \/ \[APC-A\]/);
  assert.match(text, /FITC-A was converted to MEFL with the multi-level calibration beads of Beads 1 as in FlowCal \[\d\].*3 of 4 levels.*m = 1\.0753.*1 sample/);
  assert.match(text, /Absolute counts were obtained with counting beads \[\d\]: cells per µL = \(cell events \/ bead events, gated as Counting beads\) × \(50,000 beads \/ 50 µL of sample\), times each sample's dilution/);
  assert.ok(references.some((r) => r.key === 'flowcal') && references.some((r) => r.key === 'absoluteCounts'));
});

test('methods describe dose-response curves and a bead immunoassay, with their references', async () => {
  const { addDerived } = await import('./workspace.js');
  let ws = createWorkspace('Plates');
  ws = addDerived(ws, { kind: 'dose-response', name: 'Dose-response · Screen plate 1 · CD69+: % of parent', params: { groupField: 'compound', model: 'LL.4', weighting: 'none', normalize: 'inhibition', fixed: { c: 0, d: 100 } }, summary: { zPrime: 0.7951, rows: [] } }).ws;
  ws = addDerived(ws, { kind: 'bead-assay', name: 'Bead assay', params: { classification: 'APC-A', reporter: 'PE-A', statistic: 'median', model: 'LL.5', weighting: '1/y2', top: 10000, unit: 'pg/mL', factor: 4 }, summary: { analytes: [{}, {}, {}] } }).ws;
  const { paragraphs, references } = writeMethods(ws, { version: '0.7.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /fitted per compound by least squares to a four-parameter log-logistic model/);
  assert.match(text, /% inhibition relative to the plate's positive and negative control wells/);
  assert.match(text, /Z′ \[\d+\] from its control wells was 0\.80/);
  assert.match(text, /immunoassay of 3 analytes/);
  assert.match(text, /weighted 1\/Y²/);
  for (const key of ['drc', 'zPrime', 'fivePL', 'bmv']) assert.ok(references.some((r) => r.key === key), key);
});
