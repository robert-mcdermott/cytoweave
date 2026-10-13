// Reproducibility certificates (R8): an analysis packed with everything needed to compute its
// numbers again, and the numbers it reported, so that anyone can confirm them later.
//
// A certificate is an ACS container (acs.js) holding the workspace, the FCS files (or only their
// checksums, when the data cannot be shared), the derived channels the analysis stored (clusters,
// embeddings, unmixed channels), the gates as Gating-ML, the methods, a README and
// certificate.json. certificate.json records the CytoWeave version, every input's SHA-256, the
// analyses with their parameters and seeds, the head of the hash-chained change log, the MIFlowCyt
// items with what the workspace says for each, and every reported number:
//   - each population's event count in each sample;
//   - each cell of each table, with its detection-limit status;
//   - each saved comparison of one measure: every sample's value, the test, the group summaries,
//     the effect sizes and the post-hoc tests.
// Its fingerprint is the SHA-256 of its canonical JSON: quoted in a paper, it names exactly what
// was certified.
//
// Verifying reads the files, checks every checksum and the change log, computes every number again
// from the files with the same code, and compares them bit for bit. Numbers are kept in JSON as
// their shortest round-trip text, so equality is exact; NaN and infinities are kept as text.
//
// Both directions work sample by sample from the files' bytes (parseFCS, workspaceView), keeping
// only the samples that others refer to (controls, blanks) loaded, so large cohorts fit in memory
// and the numbers come from the same code path wherever they are computed.

import { createACS, readACS } from './acs.js';
import { analyzeLevels, measureValue } from './compare.js';
import { populationSize, workspaceView } from './engine.js';
import { parseFCS } from './fcs.js';
import { methodsText, miflowcytChecklist } from './methods.js';
import { sha256 } from './sha256.js';
import { tableCells, tableSamples } from './tables.js';
import { ROOT, canonicalJSON, gatePath, parseWorkspace, serializeWorkspace, verifyLog } from './workspace.js';

export const CERTIFICATE_FORMAT = 'cytoweave-certificate';
export const CERTIFICATE_VERSION = 1;
export const CERTIFICATE_NAME = 'certificate.json';
const WORKSPACE_NAME = 'cytoweave-workspace.json';
const README_NAME = 'README.txt';
const METHODS_NAME = 'methods.txt';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Numbers -------------------------------------------------------------------------------------

// A number as certificate.json keeps it: finite numbers as themselves (JSON writes the shortest
// text that reads back to the same double; -0 becomes 0), NaN and infinities as text, a missing
// value as null.
export function encodeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') return value;
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return value === 0 ? 0 : value;
}

// Every number in a value (arrays and objects) encoded.
function encodeAll(value) {
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) return value.map(encodeAll);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeAll(v)]));
  return value ?? null;
}

// The JavaScript engine computing the numbers: transcendental functions (exp, log, pow) can
// differ in their last bit between engines (browsers' versions, Node), so a certificate says which
// one computed it.
export function jsEngine() {
  // Node first: it has a navigator too ("Node.js/22").
  if (typeof process !== 'undefined' && process.versions?.node) return `Node ${process.versions.node} (V8 ${process.versions.v8})`;
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent;
    const found = /(Edg|OPR|Brave|Chrome|Firefox)\/([\d.]+)/.exec(ua) ?? (/Version\/([\d.]+).*Safari/.test(ua) ? ['', 'Safari', /Version\/([\d.]+)/.exec(ua)[1]] : null);
    if (found) return `${{ Edg: 'Edge', OPR: 'Opera' }[found[1]] ?? found[1]} ${found[2]}`;
    return ua;
  }
  return 'unknown';
}

// Numbers equal to 12 significant digits (or within 1e-13): what two JavaScript engines can give
// for the same computation when their transcendental functions differ in the last bit.
export const CLOSE = 1e-12;
const asNumber = (value) => (typeof value === 'number' ? value : value === 'NaN' ? Number.NaN : value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : null);
function closeEnough(a, b) {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const difference = Math.abs(x - y);
  return difference <= CLOSE * Math.max(Math.abs(x), Math.abs(y)) || difference <= 1e-13;
}

export const formatCertified = (value) => (value === null || value === undefined ? '—' : String(value));

// --- Scope ---------------------------------------------------------------------------------------

const singleComparisons = (ws) => (ws.comparisons ?? []).filter((c) => c.kind === 'single' && Array.isArray(c.results?.values));

// What a certificate of this workspace checks: { gateIds, tables: [{ table, rows }], comparisons,
// pinned (samples others refer to: controls, blanks, low-level samples), notChecked: [{ what,
// reason }] }.
export function certificateScope(ws) {
  const gateIds = [ROOT, ...ws.gates.map((g) => g.id)];
  const tables = (ws.tables ?? []).map((table) => ({ table, rows: tableSamples(ws, table).map((s) => s.id) }));
  const comparisons = singleComparisons(ws);
  const pinned = new Set();
  for (const { table } of tables) {
    for (const column of table.columns) {
      if (column.control?.sampleId) pinned.add(column.control.sampleId);
      for (const id of [...(column.limits?.blankIds ?? []), ...(column.limits?.lowIds ?? [])]) pinned.add(id);
    }
  }
  for (const c of comparisons) if (c.measure?.control?.sampleId) pinned.add(c.measure.control.sampleId);
  const known = new Set(ws.samples.map((s) => s.id));
  const notChecked = [];
  for (const c of ws.comparisons ?? []) {
    if (c.kind !== 'single') notChecked.push({ what: `the comparison "${c.name}"`, reason: 'screens (many populations, clusters or marker states at once) are recorded but not computed again by this version of the certificate' });
  }
  for (const d of ws.derived ?? []) {
    const stored = Object.keys(d.files ?? {}).length > 0;
    notChecked.push({ what: `the analysis "${d.name ?? d.method ?? d.kind}" (${d.kind}${d.seed !== undefined ? `, seed ${d.seed}` : ''})`, reason: stored ? 'not run again; the channels it stored are inputs, checked by their checksums, and the numbers computed from them are checked' : 'not run again; its parameters are recorded' });
  }
  return { gateIds, tables, comparisons, pinned: [...pinned].filter((id) => known.has(id)), notChecked };
}

// The levels of a saved comparison, rebuilt from its record with each sample's value recomputed:
// the points keep the record's order (sums depend on it).
function comparisonLevels(record, valueOf) {
  const labels = record.grouping?.levels ?? [];
  const levels = labels.map((label) => ({ key: label, label, points: [] }));
  const byLabel = new Map(levels.map((l) => [l.label, l]));
  const values = [];
  for (const point of record.results.values) {
    const value = valueOf(point.sampleId);
    values.push({ sampleId: point.sampleId, name: point.sample ?? point.sampleId, value });
    const level = byLabel.get(point.group);
    if (level && Number.isFinite(value)) level.points.push({ sampleId: point.sampleId, value, pair: point.pair ?? null });
  }
  return { levels, values };
}

// The numbers of one comparison's analysis.
function comparisonResults(analysis) {
  if (!analysis.design) return { design: null };
  const r = analysis.primary?.result ?? {};
  const df = r.df ?? (r.df1 !== undefined ? [r.df1, r.df2] : null);
  return encodeAll({
    design: analysis.design,
    test: { id: analysis.primary.id, statistic: r.statistic ?? null, df, p: r.p ?? null, error: analysis.primary.error ?? null },
    secondary: analysis.secondary ? { id: analysis.secondary.id, statistic: analysis.secondary.result?.statistic ?? null, p: analysis.secondary.result?.p ?? null } : null,
    groups: analysis.levels.map((level, j) => {
      const s = analysis.summaries[j];
      return { label: level.label, n: s.n, mean: s.mean, sd: s.sd, median: s.median, q1: s.q1, q3: s.q3, ciMean: s.ciMean ?? null, ciMedian: s.ciMedian ?? null };
    }),
    effects: (analysis.effects ?? []).map((e) => ({ label: e.label, estimate: e.estimate, ci: e.ci ?? null })),
    posthoc: analysis.posthoc ? analysis.posthoc.rows.map((row) => ({ group: row.level.label, difference: row.difference, ratio: row.ratio, p: row.p, q: row.q })) : null,
  });
}

// --- Computing the numbers -----------------------------------------------------------------------

// Reads a sample's file and prepares its view as the window does. source: { fcs(sample) → bytes
// or null, derived(sha256) → bytes or null }. Returns { view } or { problem }.
async function loadView(ws, sample, source) {
  const bytes = await source.fcs(sample);
  if (!bytes) return { problem: 'its file is missing' };
  let dataset;
  try {
    dataset = parseFCS(bytes).datasets[sample.datasetIndex ?? 0];
  } catch (error) {
    return { problem: `its file cannot be read: ${error.message}` };
  }
  if (!dataset) return { problem: `its file has no data set ${(sample.datasetIndex ?? 0) + 1}` };
  const columns = [];
  const problems = [];
  for (const record of ws.derived ?? []) {
    for (const [name, ref] of Object.entries(record.files?.[sample.id] ?? {})) {
      if (!ref?.sha256) continue;
      const data = await source.derived(ref.sha256);
      if (!data || data.byteLength !== ref.length * 4) {
        problems.push(`the stored channel "${name}" is missing`);
        continue;
      }
      const copy = data.slice();
      columns.push({ name, column: new Float32Array(copy.buffer, copy.byteOffset, ref.length), version: ref.sha256.slice(0, 16) });
    }
  }
  return { view: workspaceView(ws, sample, dataset, columns), problems };
}

// Every number the certificate reports, computed from the files sample by sample. Returns
// { numbers, problems: [{ sampleId, name, message }] }. options: { onProgress(fraction, text),
// onView(sample, view, viewOf): called while each sample is loaded (review reports draw it) }.
export async function computeNumbers(ws, source, options = {}) {
  const scope = certificateScope(ws);
  const problems = [];
  const pinned = new Map();
  const failed = new Set();
  let current = null;
  const viewOf = (id) => (current?.id === id ? current : pinned.get(id) ?? null);
  const note = (sample, message) => problems.push({ sampleId: sample.id, name: sample.name, message });
  for (const id of scope.pinned) {
    const sample = ws.samples.find((s) => s.id === id);
    const loaded = await loadView(ws, sample, source);
    if (loaded.view) pinned.set(id, loaded.view);
    else {
      note(sample, loaded.problem);
      failed.add(id);
    }
    for (const p of loaded.problems ?? []) note(sample, p);
  }
  // The tables' cells (with their detection limits, found from the pinned samples).
  const tableCellsOf = scope.tables.map(({ table }) => tableCells(ws, table, viewOf));
  const counts = { populations: scope.gateIds.map((id) => ({ id, path: id === ROOT ? 'All events' : gatePath(ws, id) })), samples: [] };
  const tables = scope.tables.map(({ table }, t) => ({ id: table.id, name: table.name ?? `Table ${t + 1}`, columns: tableCellsOf[t].columns.map((c) => c.label), samples: [] }));
  const comparisonValues = scope.comparisons.map(() => new Map());
  const wanted = scope.comparisons.map((c) => new Set(c.results.values.map((v) => v.sampleId)));
  const rowsOf = scope.tables.map(({ rows }) => new Set(rows));
  for (let i = 0; i < ws.samples.length; i += 1) {
    const sample = ws.samples[i];
    await options.onProgress?.(i / ws.samples.length, `Computing ${sample.name} (${i + 1} of ${ws.samples.length})`);
    let view = pinned.get(sample.id) ?? null;
    if (!view && failed.has(sample.id)) {
      counts.samples.push({ id: sample.id, name: sample.name, values: null });
      continue;
    }
    if (!view) {
      const loaded = await loadView(ws, sample, source);
      for (const p of loaded.problems ?? []) note(sample, p);
      if (!loaded.view) {
        note(sample, loaded.problem);
        counts.samples.push({ id: sample.id, name: sample.name, values: null });
        continue;
      }
      view = loaded.view;
    }
    current = view;
    counts.samples.push({ id: sample.id, name: sample.name, values: scope.gateIds.map((id) => encodeNumber(populationSize(view, ws, id))) });
    scope.tables.forEach(({ table }, t) => {
      if (!rowsOf[t].has(sample.id)) return;
      const cells = table.columns.map((_, j) => tableCellsOf[t].cell(j, sample.id));
      tables[t].samples.push({ id: sample.id, name: sample.name, values: cells.map((c) => encodeNumber(c.value)), status: cells.map((c) => c.status ?? null) });
    });
    scope.comparisons.forEach((c, k) => {
      if (wanted[k].has(sample.id)) comparisonValues[k].set(sample.id, measureValue(view, ws, c.measure, { viewOf }));
    });
    await options.onView?.(sample, view, viewOf);
    current = null;
  }
  const comparisons = scope.comparisons.map((record, k) => {
    const { levels, values } = comparisonLevels(record, (id) => comparisonValues[k].get(id) ?? Number.NaN);
    const analysis = analyzeLevels(levels, { pairBy: record.pairing, test: record.test?.id ?? 'auto' });
    return { id: record.id, name: record.name, values: values.map((v) => ({ sampleId: v.sampleId, name: v.name, value: encodeNumber(v.value) })), results: comparisonResults(analysis) };
  });
  await options.onProgress?.(1, 'Computed every number');
  return { numbers: { counts, tables, comparisons }, problems, notChecked: scope.notChecked };
}

// Each number as { key, label, value }, for comparing two sets of numbers and saying which differ.
export function numberItems(numbers) {
  const items = [];
  const { counts, tables, comparisons } = numbers;
  for (const sample of counts.samples) {
    counts.populations.forEach((p, j) => items.push({ key: `count|${sample.id}|${p.id}`, label: `${sample.name}: ${p.path}, count`, value: sample.values ? sample.values[j] : undefined }));
  }
  for (const table of tables) {
    for (const sample of table.samples) {
      table.columns.forEach((label, j) => {
        items.push({ key: `table|${table.id}|${sample.id}|${j}`, label: `${table.name}, ${sample.name}: ${label}`, value: sample.values[j] });
        if (sample.status[j] !== null) items.push({ key: `table-status|${table.id}|${sample.id}|${j}`, label: `${table.name}, ${sample.name}: ${label} (detection status)`, value: sample.status[j] });
      });
    }
  }
  for (const c of comparisons) {
    for (const v of c.values) items.push({ key: `comparison|${c.id}|value|${v.sampleId}`, label: `${c.name}: the value of ${v.name ?? v.sampleId}`, value: v.value });
    const walk = (value, path, label) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, `${label} ${i + 1}`));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, `${label} ${k}`);
      else items.push({ key: `comparison|${c.id}|${path}`, label: `${c.name}:${label}`, value });
    };
    walk(c.results, 'results', '');
  }
  return items;
}

// --- MIFlowCyt -----------------------------------------------------------------------------------

const unique = (values) => [...new Set(values.filter((v) => v !== undefined && v !== null && String(v).trim() !== '').map(String))];
const listOf = (values, limit = 12) => (values.length > limit ? `${values.slice(0, limit).join(', ')} and ${values.length - limit} more` : values.join(', '));

// The MIFlowCyt checklist (methods.js) with what the workspace records for each item.
export function miflowcytRecord(ws) {
  const samples = ws.samples;
  const meta = (field) => unique(samples.map((s) => s.meta?.[field]));
  const acquisition = (field) => unique(samples.map((s) => s.acquisition?.[field]));
  const byRole = samples.reduce((acc, s) => ({ ...acc, [s.role]: (acc[s.role] ?? 0) + 1 }), {});
  const controls = Object.entries(byRole).filter(([role]) => role !== 'sample').map(([role, n]) => `${n} ${role}`);
  const roles = [byRole.sample ? `${byRole.sample} sample${byRole.sample === 1 ? '' : 's'}` : '', controls.length ? `controls: ${controls.join(', ')}` : 'no controls'].filter(Boolean);
  const markers = unique(samples.flatMap((s) => s.channels.filter((c) => c.marker).map((c) => `${c.marker} (${c.name})`)));
  const compensations = unique(samples.map((s) => (s.compensationId === 'none' ? 'none' : s.compensationId === 'file' ? 'the file\'s $SPILLOVER' : ws.compensations.find((c) => c.id === s.compensationId)?.name ?? s.compensationId)));
  const transforms = Object.entries(ws.channelSettings ?? {}).filter(([, v]) => v?.transform).map(([channel, v]) => `${channel}: ${v.transform.type ?? 'custom'}`);
  const values = {
    'Purpose, keywords and experiment variables': [ws.notes?.trim() ? `Notes: ${ws.notes.trim().slice(0, 600)}` : '', meta('condition').length ? `Conditions: ${listOf(meta('condition'))}` : ''].filter(Boolean).join(' · '),
    'Organization, primary contact, date': [acquisition('date').length ? `Acquired: ${listOf(acquisition('date'), 6)}` : '', acquisition('operator').length ? `Operator: ${listOf(acquisition('operator'), 4)}` : ''].filter(Boolean).join(' · '),
    'Specimen description (source, organism, treatment)': ['tissue', 'treatment', 'condition', 'subject'].map((f) => (meta(f).length ? `${f}: ${listOf(meta(f), 8)}` : '')).filter(Boolean).join(' · '),
    'Reagents: analytes, fluorochromes, clones': markers.length ? listOf(markers, 40) : '',
    'Controls (unstained, single-stain, FMO, isotype)': roles.join('; '),
    'Cytometer, configuration and settings': [acquisition('cytometer').length ? `Cytometer: ${listOf(acquisition('cytometer'), 4)}` : '', acquisition('serial').length ? `serial ${listOf(acquisition('serial'), 4)}` : '', acquisition('software').length ? `software: ${listOf(acquisition('software'), 4)}` : ''].filter(Boolean).join(' · '),
    'List-mode data files': `${samples.length} file(s), ${listOf(unique(samples.map((s) => `FCS ${String(s.fcsVersion).replace(/^FCS\s*/i, '')}`)), 4)}`,
    'Compensation description': compensations.length ? `Compensation: ${listOf(compensations, 6)}` : '',
    'Data transformation': transforms.length ? listOf(transforms, 30) : '',
    'Gating description': ws.gates.length ? `${ws.gates.length} gates: ${listOf(ws.gates.map((g) => gatePath(ws, g.id)), 30)}` : '',
  };
  return miflowcytChecklist(ws).map((item) => ({ section: item.section, item: item.item, ok: item.ok, value: values[item.item] ?? '' }));
}

// --- Building ------------------------------------------------------------------------------------

export function certificateFingerprint(certificate) {
  const { fingerprint, ...rest } = certificate;
  return sha256(encoder.encode(canonicalJSON(rest)));
}

export const shortFingerprint = (fingerprint) => (fingerprint ? fingerprint.slice(0, 16).replace(/(.{4})(?!$)/g, '$1-') : '');

// Archive paths for the FCS files: their names, made unique where two differ.
function dataPaths(ws) {
  const bySha = new Map();
  const used = new Set();
  for (const s of ws.samples) {
    if (!s.sha256 || bySha.has(s.sha256)) continue;
    const name = String(s.fileName || `${s.name}.fcs`).replace(/[\\/]/g, '_');
    let path = `data/${name}`;
    if (used.has(path.toLowerCase())) path = `data/${s.sha256.slice(0, 8)}-${name}`;
    used.add(path.toLowerCase());
    bySha.set(s.sha256, path);
  }
  return bySha;
}

// The saved comparisons whose recorded results no longer match the analysis (a gate or an
// annotation changed after saving): [{ name, reason }].
function staleComparisons(ws, computed) {
  const out = [];
  for (const record of singleComparisons(ws)) {
    const c = computed.find((x) => x.id === record.id);
    if (!c) continue;
    const before = new Map(record.results.values.map((v) => [v.sampleId, encodeNumber(v.value)]));
    const changed = c.values.filter((v) => before.get(v.sampleId) !== v.value).length;
    const p = encodeNumber(record.test?.p ?? null);
    if (changed) out.push({ name: record.name, reason: `${changed} sample value(s) differ from those saved` });
    else if (c.results.test && p !== null && c.results.test.p !== p) out.push({ name: record.name, reason: 'its p-value differs from the one saved' });
  }
  return out;
}

function readme(certificate, { gatingML = false } = {}) {
  const omitted = !certificate.inputs.some((i) => i.path);
  const row = (name, text) => `  ${name.padEnd(26)} ${text}`;
  const lines = [
    'CytoWeave reproducibility certificate',
    '=====================================',
    '',
    `Analysis:     ${certificate.workspace.name}`,
    `Created:      ${certificate.created} with CytoWeave ${certificate.software.version}`,
    `Fingerprint:  ${certificate.fingerprint}`,
    `              (short form ${shortFingerprint(certificate.fingerprint)}; cite it with the analysis)`,
    '',
    `This archive holds an analysis of ${certificate.inputs.length} FCS file(s) and the ${certificate.total.toLocaleString('en-US')} numbers it reported.`,
    'Verifying it computes every number again from the files and confirms each one bit for bit.',
    '',
    'To verify it',
    '------------',
    `Install CytoWeave ${certificate.software.version} (https://github.com/robert-mcdermott/cytoweave/releases/tag/v${certificate.software.version}), then either`,
    '  - open this file in CytoWeave (Workspace > Import), which verifies it and shows the result, or',
    `  - run:  cytoweave verify <this file>${omitted ? ' --data <folder with the FCS files>' : ''}`,
    'Another version of CytoWeave can verify it too, and says so: numbers may then differ in their last digits.',
    '',
    'Contents',
    '--------',
    row(CERTIFICATE_NAME, 'what was certified: inputs and their SHA-256, analyses and seeds, the change log, MIFlowCyt, every number'),
    row(WORKSPACE_NAME, 'the CytoWeave workspace (samples, compensation, scales, gates, tables, comparisons)'),
    ...(gatingML ? [row('gating-ml.xml', 'the gates as ISAC Gating-ML 2.0')] : []),
    row(METHODS_NAME, 'the methods paragraph with references'),
    omitted ? `  The FCS files are not included: ${certificate.inputs.length} file(s), identified by their SHA-256 in ${CERTIFICATE_NAME}.` : row('data/', 'the FCS files'),
    ...(certificate.derivedInputs.length ? [row('derived/', 'channels the analysis computed and stored (clusters, embeddings, unmixed channels)')] : []),
    row('acs-toc.xml', 'the table of contents (ISAC Archival Cytometry Standard), with each file\'s SHA-256'),
    '',
    'Not computed again',
    '------------------',
    ...(certificate.notChecked.length ? certificate.notChecked.map((n) => `  - ${n.what}: ${n.reason}`) : ['  (nothing)']),
  ];
  return `${lines.join('\n')}\n`;
}

// Builds a certificate of the workspace. source: { fcs(sample) → bytes or null, derived(sha256) →
// bytes or null }. options: { version, includeData (default true), date, gatingML (text), engine
// (default: this one), onProgress }. Returns { bytes (the archive), certificate, warnings }. Throws when a file is
// missing or a number cannot be computed for want of one.
export async function buildCertificate(ws, source, options = {}) {
  const missing = ws.samples.filter((s) => !s.sha256);
  if (missing.length) throw new Error(`${missing.length} sample(s) have no checksum (${missing.slice(0, 3).map((s) => s.name).join(', ')}): open their files again so they can be certified.`);
  const version = options.version ?? 'unknown';
  const date = options.date ?? new Date();
  const includeData = options.includeData !== false;
  // The bytes read once, kept while the certificate is built.
  const fcsCache = new Map();
  const derivedCache = new Map();
  const cachingSource = {
    fcs: async (sample) => {
      if (!includeData) return source.fcs(sample);
      if (!fcsCache.has(sample.sha256)) fcsCache.set(sample.sha256, await source.fcs(sample));
      return fcsCache.get(sample.sha256);
    },
    derived: async (sha) => {
      if (!derivedCache.has(sha)) derivedCache.set(sha, await source.derived(sha));
      return derivedCache.get(sha);
    },
  };
  const computed = await computeNumbers(ws, cachingSource, { onProgress: options.onProgress });
  if (computed.problems.length) throw new Error(`Some numbers cannot be computed: ${computed.problems.slice(0, 4).map((p) => `${p.name}: ${p.message}`).join('; ')}${computed.problems.length > 4 ? ` and ${computed.problems.length - 4} more` : ''}.`);
  const workspaceText = serializeWorkspace(ws);
  const paths = dataPaths(ws);
  const inputs = [];
  const fcsFiles = [];
  const seen = new Set();
  for (const s of ws.samples) {
    inputs.push({ sampleId: s.id, name: s.name, fileName: s.fileName, sha256: s.sha256, size: s.size ?? null, eventCount: s.eventCount, datasetIndex: s.datasetIndex ?? 0, path: includeData ? paths.get(s.sha256) : null });
    if (!includeData || seen.has(s.sha256)) continue;
    seen.add(s.sha256);
    const bytes = await cachingSource.fcs(s);
    if (sha256(bytes) !== s.sha256) throw new Error(`The file of "${s.name}" no longer matches its checksum.`);
    fcsFiles.push({ name: paths.get(s.sha256), bytes });
  }
  const derivedInputs = [];
  const derivedFiles = [];
  for (const record of ws.derived ?? []) {
    for (const [sampleId, files] of Object.entries(record.files ?? {})) {
      for (const [channel, ref] of Object.entries(files ?? {})) {
        if (!ref?.sha256) continue;
        const path = `derived/${ref.sha256}.f32`;
        derivedInputs.push({ derivedId: record.id, kind: record.kind, sampleId, channel, sha256: ref.sha256, length: ref.length, path });
        if (!derivedFiles.some((f) => f.name === path)) derivedFiles.push({ name: path, bytes: await cachingSource.derived(ref.sha256), mimeType: 'application/octet-stream', description: `Stored channel (32-bit floats, ${ref.length} events)` });
      }
    }
  }
  const log = verifyLog(ws);
  const items = numberItems(computed.numbers);
  const certificate = {
    format: CERTIFICATE_FORMAT,
    version: CERTIFICATE_VERSION,
    created: date.toISOString(),
    software: { name: 'CytoWeave', version, engine: options.engine ?? jsEngine() },
    workspace: { id: ws.id, name: ws.name, path: WORKSPACE_NAME, sha256: sha256(encoder.encode(workspaceText)), modified: ws.modified },
    inputs,
    derivedInputs,
    analyses: (ws.derived ?? []).map((d) => encodeAll({ id: d.id, kind: d.kind, name: d.name ?? null, method: d.method ?? null, seed: d.seed ?? null, params: d.params ?? null, created: d.created ?? null })),
    log: { entries: log.entries, head: log.head, anchor: log.anchor, sealed: log.sealed, ok: log.ok },
    miflowcyt: miflowcytRecord(ws),
    numbers: computed.numbers,
    total: items.length,
    notChecked: computed.notChecked,
  };
  certificate.fingerprint = certificateFingerprint(certificate);
  const methods = `${methodsText(ws, { version })}\n`;
  const bytes = await createACS({
    fcsFiles,
    workspaceJSON: workspaceText,
    gatingML: options.gatingML ?? null,
    extra: [
      { name: CERTIFICATE_NAME, text: `${JSON.stringify(certificate, null, 1)}\n`, mimeType: 'application/json', description: 'CytoWeave reproducibility certificate: inputs, analyses, change log, MIFlowCyt and every reported number' },
      { name: README_NAME, text: readme(certificate, { gatingML: Boolean(options.gatingML) }), mimeType: 'text/plain', description: 'What this certificate is and how to verify it' },
      { name: METHODS_NAME, text: methods, mimeType: 'text/plain', description: 'Methods paragraph with references' },
      ...derivedFiles,
    ],
  }, { date, description: `Reproducibility certificate of "${ws.name}" (${shortFingerprint(certificate.fingerprint)})` });
  const warnings = staleComparisons(ws, computed.numbers.comparisons).map((s) => `The saved comparison "${s.name}" no longer matches the analysis (${s.reason}); the certificate records the numbers it gives now. Save it again in Compare to update it.`);
  if (!log.ok) warnings.push(`The change log's chain is broken at ${log.broken.length} entr${log.broken.length === 1 ? 'y' : 'ies'}; the certificate records it as it is.`);
  return { bytes, certificate, warnings };
}

// --- Reading and verifying -----------------------------------------------------------------------

export const isCertificateArchive = (archive) => archive?.files?.some((f) => f.name === CERTIFICATE_NAME) ?? false;

// Reads a certificate archive: { certificate, ws, workspaceText, files: Map(path → bytes),
// warnings }. Throws when it is not one.
export async function readCertificate(bytes) {
  const archive = await readACS(bytes);
  const file = archive.files.find((f) => f.name === CERTIFICATE_NAME);
  if (!file) throw new Error('This archive is not a CytoWeave certificate (it has no certificate.json).');
  let certificate;
  try {
    certificate = JSON.parse(decoder.decode(file.bytes));
  } catch (error) {
    throw new Error(`certificate.json cannot be read: ${error.message}`);
  }
  if (certificate?.format !== CERTIFICATE_FORMAT) throw new Error('certificate.json is not a CytoWeave certificate.');
  if (!(certificate.version >= 1) || certificate.version > CERTIFICATE_VERSION) throw new Error(`The certificate was written by a newer CytoWeave (format ${certificate.version}); verify it with CytoWeave ${certificate.software?.version ?? 'of that version'} or later.`);
  const files = new Map(archive.files.map((f) => [f.name, f.bytes]));
  const workspaceBytes = files.get(certificate.workspace?.path ?? WORKSPACE_NAME);
  if (!workspaceBytes) throw new Error('The certificate has no workspace.');
  const workspaceText = decoder.decode(workspaceBytes);
  return { certificate, ws: parseWorkspace(workspaceText), workspaceBytes, files, warnings: archive.warnings };
}

// Whether a number (by its key in numberItems) depends on a sample whose file could not be read:
// its own counts and cells, a table whose controls, blanks or low-level samples are among them, or
// a comparison with one of them among its samples or as its control.
function unavailableNumbers(ws, unavailable) {
  if (!unavailable.size) return () => false;
  const scope = certificateScope(ws);
  const tables = new Set(scope.tables.filter(({ table }) => table.columns.some((c) => unavailable.has(c.control?.sampleId) || [...(c.limits?.blankIds ?? []), ...(c.limits?.lowIds ?? [])].some((id) => unavailable.has(id)))).map(({ table }) => table.id));
  const comparisons = new Set(scope.comparisons.filter((c) => unavailable.has(c.measure?.control?.sampleId) || c.results.values.some((v) => unavailable.has(v.sampleId))).map((c) => c.id));
  return (key) => {
    const [kind, a, b] = key.split('|');
    if (kind === 'count') return unavailable.has(a);
    if (kind === 'table' || kind === 'table-status') return tables.has(a) || unavailable.has(b);
    if (kind === 'comparison') return comparisons.has(a);
    return false;
  };
}

// Verifies a certificate (as readCertificate returns it). options: { version (of this CytoWeave),
// data (sha256 → bytes or a function of it: FCS files supplied beside the archive), onProgress }.
// Returns a report: { verdict ('confirmed', 'differs' or 'incomplete'), fingerprint, version,
// workspace, inputs, derived, log, numbers: { checked, same, differ: [{ key, label, recorded,
// computed }], missing }, notChecked, summary }.
export async function verifyCertificate(read, options = {}) {
  const { certificate, ws, workspaceBytes, files } = read;
  const supplied = typeof options.data === 'function' ? options.data : (sha) => options.data?.get?.(sha) ?? null;
  const fingerprint = certificateFingerprint(certificate);
  const report = {
    fingerprint: { recorded: certificate.fingerprint, computed: fingerprint, ok: fingerprint === certificate.fingerprint },
    version: { certificate: certificate.software?.version ?? null, verifier: options.version ?? null, same: (certificate.software?.version ?? null) === (options.version ?? null) },
    engine: { certificate: certificate.software?.engine ?? null, verifier: options.engine ?? jsEngine() },
    workspace: { ok: sha256(workspaceBytes) === certificate.workspace.sha256 },
  };
  // The inputs: each file from the archive or supplied, against its checksum.
  const bySha = new Map();
  report.inputs = [];
  for (const input of certificate.inputs) {
    let bytes = input.path ? files.get(input.path) ?? null : null;
    let from = 'archive';
    if (!bytes) {
      bytes = (await supplied(input.sha256)) ?? null;
      from = 'supplied';
    }
    const status = !bytes ? 'missing' : sha256(bytes) === input.sha256 ? 'ok' : 'changed';
    if (status === 'ok') bySha.set(input.sha256, bytes);
    report.inputs.push({ sampleId: input.sampleId, name: input.name, fileName: input.fileName, sha256: input.sha256, status, from: bytes ? from : null });
  }
  report.derived = [];
  const derivedBySha = new Map();
  for (const input of certificate.derivedInputs ?? []) {
    const bytes = files.get(input.path) ?? null;
    const status = !bytes ? 'missing' : sha256(bytes) === input.sha256 ? 'ok' : 'changed';
    if (status === 'ok') derivedBySha.set(input.sha256, bytes);
    report.derived.push({ ...input, status });
  }
  // The change log: its chain, and its head against the one certified.
  const log = verifyLog(ws);
  report.log = { ok: log.ok && log.head === certificate.log.head, entries: log.entries, head: log.head, recordedHead: certificate.log.head, broken: log.broken.map((b) => ({ index: b.index, time: b.entry.time, action: b.entry.action, reason: b.reason })), sealed: log.sealed };
  // The samples in the workspace must be the inputs certified (same ids and checksums).
  const recordedInputs = new Map(certificate.inputs.map((i) => [i.sampleId, i.sha256]));
  const inputsMatch = ws.samples.length === certificate.inputs.length && ws.samples.every((s) => recordedInputs.get(s.id) === s.sha256);
  // The numbers, computed again.
  const source = { fcs: (sample) => bySha.get(sample.sha256) ?? null, derived: (sha) => derivedBySha.get(sha) ?? null };
  const computed = await computeNumbers(ws, source, { onProgress: options.onProgress });
  const recorded = numberItems(certificate.numbers);
  const now = new Map(numberItems(computed.numbers).map((i) => [i.key, i]));
  const blocked = unavailableNumbers(ws, new Set(computed.problems.map((p) => p.sampleId)));
  const differ = [];
  let same = 0;
  let close = 0;
  let largest = 0;
  let missing = 0;
  for (const item of recorded) {
    const found = now.get(item.key);
    const value = found ? found.value : undefined;
    if (blocked(item.key)) {
      missing += 1;
      continue;
    }
    if (canonicalJSON(value ?? null) === canonicalJSON(item.value ?? null)) same += 1;
    else if (closeEnough(item.value, value)) {
      close += 1;
      largest = Math.max(largest, Math.abs(item.value - value) / Math.max(Math.abs(item.value), Math.abs(value)));
    } else differ.push({ key: item.key, label: item.label, recorded: item.value ?? null, computed: value ?? null });
  }
  // Samples whose numbers could not be computed: their recorded numbers are missing, not different.
  const missingSamples = computed.problems.map((p) => ({ name: p.name, message: p.message }));
  report.numbers = { checked: recorded.length, same, close, largestRelative: largest, differ, missing, problems: missingSamples };
  report.notChecked = certificate.notChecked ?? [];
  report.inputsMatch = inputsMatch;
  const failed = !report.fingerprint.ok || !report.workspace.ok || !report.log.ok || !inputsMatch
    || report.inputs.some((i) => i.status === 'changed') || report.derived.some((d) => d.status === 'changed') || differ.length > 0;
  const incomplete = report.inputs.some((i) => i.status === 'missing') || report.derived.some((d) => d.status === 'missing') || missing > 0;
  report.verdict = failed ? 'differs' : incomplete ? 'incomplete' : 'confirmed';
  report.summary = verificationSummary(certificate, report);
  return report;
}

// One paragraph saying what was found.
export function verificationSummary(certificate, report) {
  const n = (count, word) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
  const { same, close } = report.numbers;
  const engines = report.engine ?? {};
  const why = engines.certificate && engines.verifier && engines.certificate !== engines.verifier
    ? `their last digits differ because another JavaScript engine computed them (certified in ${engines.certificate}, verified in ${engines.verifier}), and engines' logarithms and exponentials can differ in the last bit`
    : 'their last digits differ';
  const agreed = close ? `${n(same, 'number')} are identical and ${n(close, 'number')} equal to 12 significant digits (${why})` : null;
  const parts = [];
  if (report.verdict === 'confirmed') {
    parts.push(close
      ? `Confirmed: all ${n(same + close, 'number')} of "${certificate.workspace.name}" were computed again from the ${n(report.inputs.length, 'file')}: ${agreed}.`
      : `Confirmed: all ${n(same, 'number')} of "${certificate.workspace.name}" were computed again from the ${n(report.inputs.length, 'file')} and are identical.`);
  } else if (report.verdict === 'incomplete') {
    const absent = report.inputs.filter((i) => i.status === 'missing').length;
    parts.push(`Incomplete: ${n(same + close, 'number')} confirmed${close ? ` (${agreed})` : ''}, but ${n(report.numbers.missing, 'number')} could not be computed because ${absent ? `${n(absent, 'file')} ${absent === 1 ? 'is' : 'are'} missing (supply ${absent === 1 ? 'it' : 'them'} beside the certificate)` : 'inputs are missing'}.`);
  } else {
    const reasons = [];
    if (!report.fingerprint.ok) reasons.push('certificate.json was changed after it was written (its fingerprint does not match)');
    if (!report.workspace.ok) reasons.push('the workspace was changed after the certificate was written');
    if (!report.inputsMatch) reasons.push('the workspace\'s samples are not the files certified');
    const changed = report.inputs.filter((i) => i.status === 'changed');
    if (changed.length) reasons.push(`${n(changed.length, 'file')} no longer match${changed.length === 1 ? 'es' : ''} ${changed.length === 1 ? 'its' : 'their'} checksum (${changed.slice(0, 3).map((i) => i.fileName).join(', ')})`);
    if (report.derived.some((d) => d.status === 'changed')) reasons.push('a stored channel was changed');
    if (!report.log.ok) reasons.push(report.log.broken.length ? `the change log was altered (first at entry ${report.log.broken[0].index + 1}, ${report.log.broken[0].action})` : 'the change log is not the one certified');
    if (report.numbers.differ.length) reasons.push(`${n(report.numbers.differ.length, 'number')} differ${report.numbers.differ.length === 1 ? 's' : ''} (first: ${report.numbers.differ[0].label}: ${formatCertified(report.numbers.differ[0].recorded)} certified, ${formatCertified(report.numbers.differ[0].computed)} now)`);
    parts.push(`Not confirmed: ${reasons.join('; ')}.`);
  }
  if (!report.version.same && report.version.certificate) parts.push(`Certified with CytoWeave ${report.version.certificate} and verified with ${report.version.verifier ?? 'another version'}${report.numbers.differ.length ? '; differences can come from changes between the versions' : ''}.`);
  parts.push(`Fingerprint ${shortFingerprint(certificate.fingerprint)}.`);
  return parts.join(' ');
}
