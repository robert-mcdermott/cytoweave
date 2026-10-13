// Cytek SpectroFlo experiment (.Expt) import: the experiment's reference controls (which file
// holds which fluorochrome and marker, on beads or cells, with which unstained control), so a
// SpectroFlo user's controls are set up in CytoWeave's Spectral view without retyping them.
//
// An .Expt file is .NET DataContract XML (the root <Experiment> in the Rainbow.DataPersistence
// namespaces). Its Info/ExperimentDesc/_RefSetupResult holds one SpilloverColumn per reference
// control: the control's description (_RefControlDesc: Fluorochrome, Label, the unstained control
// it is paired with) and its FCS file (_Url), and a vector of one value per detector
// (_SpilloverVectorArea) that is 1 in the detector SpectroFlo gated the control on.
// UnstainedMfiColumn describes the unstained control. Values shared between objects are written
// once (z:Id) and referred to elsewhere (z:Ref).
//
// The vectors are not taken as reference spectra. On the AutoSpectral example data (Burton,
// Dooley and Liston, Mendeley Data, doi:10.17632/ch5dnspd79.1; validation suite `spectroflo`)
// neither they nor the unstained column match the controls' own data (the BUV395 control is 3.8
// times brighter in UV2 than in UV1; its vector is 2.2 times higher in UV1), and AutoSpectral's
// reader warns that they are sometimes odd. CytoWeave computes each spectrum
// from its control file instead; the vector's 1 says which detector SpectroFlo gated it on, which
// is where the control's own spectrum peaks.
//
// The vectors do not name their detectors. Cytek's raw files list them by laser (UV, violet,
// blue, yellow-green, red), each laser's detectors numbered from 1, so the number of values
// gives the instrument's lasers; a raw file of the experiment gives the names themselves.

import { attr, children, parseXMLDocument, textContent } from './xml.js';

const SERIALIZATION = 'http://schemas.microsoft.com/2003/10/Serialization/';

// Detectors per laser on Cytek Aurora and Northern Lights instruments, in the order of their raw
// files.
const LASERS = [['UV', 16], ['V', 16], ['B', 14], ['YG', 10], ['R', 8]];
// Laser combinations Cytek sells, by detector count.
const LAYOUTS = {
  64: ['UV', 'V', 'B', 'YG', 'R'],
  54: ['UV', 'V', 'B', 'R'],
  48: ['V', 'B', 'YG', 'R'],
  38: ['V', 'B', 'R'],
  30: ['V', 'B'],
  22: ['B', 'R'],
  14: ['B'],
};

// The detector names of a Cytek instrument with `count` detectors ("UV1-A" …), or null.
export function cytekDetectors(count) {
  const lasers = LAYOUTS[count];
  if (!lasers) return null;
  return LASERS.filter(([laser]) => lasers.includes(laser)).flatMap(([laser, n]) => Array.from({ length: n }, (_, i) => `${laser}${i + 1}-A`));
}

// Reads a SpectroFlo experiment. options.detectors: the detector names of a raw file of the
// experiment (its $SPILLOVER channels or its fluorescence parameters), used instead of inferring
// them. Returns { name, version, detectors, inferred, references: [{ fluorochrome, marker,
// controlFile, carrier, unstained, gatedDetector, date, storedVector }], unstained: {
// controlFile, carrier, date, storedVector }, unmixing, warnings }.
export function importSpectroFlo(input, options = {}) {
  const doc = parseXMLDocument(input);
  const warnings = doc.warnings.map((w) => `XML: ${w}`);
  const { root } = doc;
  if (root.local !== 'Experiment' || !/Rainbow/.test(root.ns ?? '')) throw new Error(`This is not a SpectroFlo experiment (its root element is <${root.name}>).`);

  // Shared values: z:Id → element; an element with z:Ref takes the referred element's content.
  const byId = new Map();
  const walk = (node) => {
    const id = attr(node, 'Id', SERIALIZATION, { strictNamespace: true });
    if (id) byId.set(id, node);
    for (const c of node.children) walk(c);
  };
  walk(root);
  const resolve = (node) => {
    const ref = node ? attr(node, 'Ref', SERIALIZATION, { strictNamespace: true }) : null;
    return ref ? byId.get(ref) ?? node : node;
  };
  const kid = (node, local) => resolve(node?.children.find((c) => c.local === local) ?? null);
  const text = (node, local) => {
    const el = kid(node, local);
    if (!el || attr(el, 'nil', 'http://www.w3.org/2001/XMLSchema-instance', { strictNamespace: true }) === 'true') return null;
    return textContent(el).trim();
  };
  const find = (node, local) => {
    if (!node) return null;
    for (const c of node.children) {
      if (c.local === local) return resolve(c);
      const deep = find(c, local);
      if (deep) return deep;
    }
    return null;
  };
  const numbers = (el) => (el ? children(el).map((c) => Number.parseFloat(textContent(c))) : null);

  const info = kid(root, 'Info');
  const name = text(info, 'Name');
  const version = text(root, 'Version');
  const setup = find(info, '_RefSetupResult');
  if (!setup) throw new Error('The SpectroFlo experiment holds no reference controls (no _RefSetupResult).');
  const columns = children(kid(setup, 'SpilloverColumnList') ?? { children: [] }, 'SpilloverColumn').map(resolve);
  const read = (column) => {
    const desc = kid(column, '_RefControlDesc');
    const vector = numbers(kid(column, '_SpilloverVectorArea'));
    const url = text(column, '_Url') ?? text(desc, '_Url');
    return {
      fluorochrome: text(desc, 'Fluorochrome'),
      marker: text(desc, 'Label') ?? '',
      vector,
      controlFile: url ? url.split(/[\\/]/).pop() : null,
      unstained: text(desc, 'NameOfSeparateUnstained') || null,
      date: text(column, '_DateTimeCreated'),
    };
  };
  const refs = columns.map(read);
  const unstainedColumn = kid(setup, 'UnstainedMfiColumn');
  const unstained = unstainedColumn ? read(unstainedColumn) : null;

  const lengths = [...new Set(refs.map((r) => r.vector?.length).filter(Boolean))];
  if (lengths.length > 1) throw new Error(`The reference spectra have different lengths (${lengths.join(', ')}).`);
  const count = lengths[0] ?? 0;
  let detectors = options.detectors?.length === count ? options.detectors.slice() : null;
  let inferred = false;
  if (options.detectors && !detectors) warnings.push(`The raw file names ${options.detectors.length} detectors but the spectra have ${count} values; the detectors were inferred from the count.`);
  if (!detectors) {
    detectors = cytekDetectors(count);
    inferred = true;
    if (!detectors) throw new Error(`The reference spectra have ${count} values, which matches no Cytek instrument; open a raw file of the experiment with it to name the detectors.`);
  }

  const references = [];
  for (const r of refs) {
    if (!r.fluorochrome) {
      warnings.push('A reference control names no fluorochrome; it was left out.');
      continue;
    }
    if (!r.vector || r.vector.some((v) => !Number.isFinite(v))) {
      warnings.push(`The reference spectrum of ${r.fluorochrome} is missing or has invalid values; it was left out.`);
      continue;
    }
    const gated = r.vector.findIndex((v) => v === 1);
    references.push({
      fluorochrome: r.fluorochrome,
      marker: r.marker,
      controlFile: r.controlFile,
      carrier: carrierOf(r.controlFile),
      unstained: r.unstained,
      // The vector is 1 in the detector SpectroFlo gated the control on.
      gatedDetector: gated >= 0 ? detectors[gated] : null,
      date: r.date,
      storedVector: r.vector.slice(),
    });
  }
  const scheme = text(find(info, 'ExperimentDesc') ?? info, '_UnmixingScheme') ?? textOf(find(info, '_UnmixingScheme'));
  return {
    name,
    version,
    detectors,
    inferred,
    references,
    unstained: unstained ? { controlFile: unstained.controlFile, carrier: carrierOf(unstained.controlFile), date: unstained.date, storedVector: unstained.vector } : null,
    unmixing: { scheme: scheme ?? null },
    warnings,
  };
}

function carrierOf(file) {
  return /\(beads?\)/i.test(file ?? '') ? 'beads' : /\(cells?\)/i.test(file ?? '') ? 'cells' : null;
}

function textOf(el) {
  return el ? textContent(el).trim() || null : null;
}

// Matches an experiment's controls to samples (by file name, then by name) and the changes that
// set them up for the Spectral view: [{ kind: 'reference' | 'unstained', reference, sample,
// patch }] (sample and patch null when no sample matches).
export function planSpectroFloControls(result, samples) {
  const key = (name) => String(name ?? '').toLowerCase().replace(/\.(fcs|lmd)$/i, '').trim();
  const find = (file) => (file ? samples.find((s) => key(s.fileName) === key(file)) ?? samples.find((s) => key(s.name) === key(file)) ?? null : null);
  const rows = result.references.map((reference) => {
    const sample = find(reference.controlFile);
    const meta = { ...(sample?.meta ?? {}), fluorochrome: reference.fluorochrome, ...(reference.marker ? { marker: reference.marker } : {}), ...(reference.carrier ? { carrier: reference.carrier } : {}) };
    return { kind: 'reference', reference, sample, patch: sample ? { role: 'single-stain', stain: reference.fluorochrome, meta } : null };
  });
  if (result.unstained?.controlFile) {
    const sample = find(result.unstained.controlFile);
    rows.push({ kind: 'unstained', reference: result.unstained, sample, patch: sample ? { role: 'unstained', stain: null, meta: { ...(sample.meta ?? {}), ...(result.unstained.carrier ? { carrier: result.unstained.carrier } : {}) } } : null });
  }
  return rows;
}
