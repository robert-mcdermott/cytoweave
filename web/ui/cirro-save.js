// Save to Cirro: the analysis as a new dataset in a Cirro project, the files `cytoweave run` writes
// to its output folder: the workspace, its gates as Gating-ML, the methods, the tables, the figures
// and, on request, a review report and a FlowJo workspace. FCS files that are not yet in Cirro go
// with it, so the analysis opens again anywhere its project can be read. The dataset is tagged as
// CytoWeave's and carries a note saying what made it from what.

import { h, clear, formatBytes } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { prefs } from './storage.js';
import { serializeWorkspace, updateSample } from '../lib/workspace.js';
import { FILES_PROCESS, manifestPath, portalUrl } from '../lib/cirro.js';

const safeName = (name, fallback) => String(name ?? '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function saveToCirro(app, session) {
  const { store } = app;
  const ws = store.ws;
  const base = safeName(ws.name, 'analysis');
  // FCS files not yet in this Cirro, once each (a file with several data sets is several samples).
  const local = [...new Map(ws.samples.filter((s) => s.sha256 && s.cirro?.host !== session.host).map((s) => [s.sha256, s])).values()];
  const localBytes = local.reduce((sum, s) => sum + (s.size ?? 0), 0);

  const parts = [
    { id: 'gatingml', label: 'Gates as Gating-ML 2.0', when: ws.gates.length > 0, on: true },
    { id: 'methods', label: 'Methods, with references (text)', when: ws.samples.length > 0, on: true },
    { id: 'tables', label: `Tables as an Excel workbook (${plural(ws.tables.length, 'table')})`, when: ws.tables.length > 0, on: true },
    { id: 'figures', label: `Figures as PDF (${plural(ws.figures.length, 'figure')})`, when: ws.figures.length > 0, on: true },
    { id: 'review', label: 'Review report (HTML): every number traced, readable without CytoWeave; takes longer', when: ws.samples.length > 0, on: false },
    { id: 'flowjo', label: 'FlowJo workspace (.wsp)', when: ws.samples.length > 0, on: false },
    { id: 'fcs', label: `The ${plural(local.length, 'FCS file')} not yet in this Cirro (${formatBytes(localBytes)}), so the analysis opens anywhere`, when: local.length > 0, on: true },
  ].filter((p) => p.when);
  const checks = new Map(parts.map((p) => [p.id, h('input', { type: 'checkbox', checked: p.on })]));

  const project = h('select.input', { 'aria-label': 'Project' }, h('option', { value: '' }, 'Reading your projects…'));
  const name = h('input.input', { value: ws.name, 'aria-label': 'Dataset name' });
  const description = h('textarea.input', { rows: 2, 'aria-label': 'Description' }, `CytoWeave analysis: ${plural(ws.samples.length, 'sample')}, ${plural(ws.gates.length, 'population')}.`);
  const status = h('div');
  const dialog = showDialog({
    title: `Save to Cirro · ${session.tenantName}`,
    content: [
      h('p', 'The analysis is saved as a new dataset in the project, which its members see in Cirro. Each save makes a new dataset; open its workspace from Cirro to go on with the analysis.'),
      h('label.field', h('span', 'Project'), project),
      h('label.field', h('span', 'Dataset name'), name),
      h('label.field', h('span', 'Description'), description),
      h('div.field', h('span', 'With the workspace'), ...parts.map((p) => h('label.check', checks.get(p.id), p.label))),
      status,
    ],
    buttons: [
      { label: 'Cancel' },
      { label: 'Save to Cirro', primary: true, onClick: () => {
        if (!project.value) {
          clear(status).append(h('div.callout.danger', 'Choose a project.'));
          return false;
        }
        if (!name.value.trim()) {
          clear(status).append(h('div.callout.danger', 'Name the dataset.'));
          return false;
        }
        const chosen = new Set(parts.filter((p) => checks.get(p.id).checked).map((p) => p.id));
        save(app, session, { projectId: project.value, name: name.value.trim(), description: description.value.trim(), base, chosen, local: chosen.has('fcs') ? local : [] });
        return true;
      } },
    ],
  });

  try {
    const projects = (await session.projects()).sort((a, b) => a.name.localeCompare(b.name));
    // The project most of the samples came from, else the last one used.
    const counts = new Map();
    for (const s of ws.samples) if (s.cirro?.host === session.host) counts.set(s.cirro.projectId, (counts.get(s.cirro.projectId) ?? 0) + 1);
    const last = prefs.get('cirroLast', null);
    const preferred = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (last?.host === session.host ? last.projectId : null);
    clear(project).append(h('option', { value: '' }, 'Choose a project'), ...projects.map((p) => h('option', { value: p.id, selected: p.id === preferred }, p.name)));
  } catch (error) {
    clear(status).append(h('div.callout.danger', error.message));
    project.disabled = true;
  }
}

// Builds the chosen files, creates the dataset and uploads them, records where the uploaded FCS
// files now are in the workspace, and leaves a note on the dataset.
async function save(app, session, { projectId, name, description, base, chosen, local }) {
  const { store, data } = app;
  const sameWorkspace = store.sameWorkspace();
  const progress = progressToast(`Saving ${name} to Cirro…`);
  let created = null;
  try {
    const files = [];
    const add = (fileName, content) => files.push({ name: fileName, blob: content instanceof Blob ? content : new Blob([content]) });
    progress.update(0.02, 'Writing the analysis…');
    if (chosen.has('gatingml')) {
      const { exportGatingML } = await import('../lib/gatingml.js');
      const result = exportGatingML(store.ws);
      add(`${base}.gating-ml.xml`, typeof result === 'string' ? result : result.xml);
    }
    if (chosen.has('methods')) {
      const { methodsText } = await import('../lib/methods.js');
      add(`${base}.methods.txt`, `${methodsText(store.ws, { version: app.version })}\n`);
    }
    if (chosen.has('tables')) {
      const { tablesWorkbookBlob } = await import('./mode-tables.js');
      add(`${base}.xlsx`, await tablesWorkbookBlob(app));
    }
    if (chosen.has('figures')) {
      const { figurePDF } = await import('./figure-export.js');
      const used = new Set();
      for (const figure of store.ws.figures) {
        let fileName = `figures/${safeName(figure.name, 'figure')}.pdf`;
        for (let k = 2; used.has(fileName); k += 1) fileName = `figures/${safeName(figure.name, 'figure')}_${k}.pdf`;
        used.add(fileName);
        progress.update(0.05, `Drawing ${figure.name}…`);
        add(fileName, await figurePDF(app, figure));
      }
    }
    if (chosen.has('review')) {
      const { makeReviewReport } = await import('./review.js');
      const report = await makeReviewReport(app, { onProgress: (fraction, text) => progress.update(0.05 + 0.1 * fraction, text) });
      add(report.fileName, report.html);
    }
    if (chosen.has('flowjo')) {
      progress.update(0.15, 'Writing the FlowJo workspace…');
      const out = await app.buildFlowJoExport({ counts: true, files: false, deidentify: false });
      add(`${base}.wsp`, out.bytes);
    }
    // FCS files keep their names, made unique where two share one. The samples of a file with
    // several data sets are named "x [2].fcs"; the file is x.fcs.
    const fcsNames = new Map();
    const taken = new Set();
    for (const sample of local) {
      const several = store.ws.samples.filter((s) => s.sha256 === sample.sha256).length > 1;
      const own = several ? sample.fileName.replace(/ \[\d+\](\.\w+)$/, '$1') : sample.fileName;
      let fileName = `fcs/${own}`;
      if (taken.has(fileName.toLowerCase())) fileName = `fcs/${sample.sha256.slice(0, 8)}-${own}`;
      taken.add(fileName.toLowerCase());
      fcsNames.set(sample.sha256, fileName);
    }
    const fcsFiles = [];
    for (const sample of local) {
      progress.update(0.18, `Reading ${sample.fileName}…`);
      const blob = await fcsBlob(data, sample);
      if (!blob) throw new Error(`The FCS file of "${sample.name}" is not in the library. Add the file again, or save without the FCS files.`);
      fcsFiles.push({ name: fcsNames.get(sample.sha256), blob });
    }
    const workspaceName = `${base}.cwz`;
    created = await session.createDataset(projectId, { name, description, processId: FILES_PROCESS, fileNames: [workspaceName, ...files.map((f) => f.name), ...fcsNames.values()] });

    // The workspace that is saved names where each uploaded FCS file now is, so it opens elsewhere.
    let saved = store.ws;
    const origins = new Map([...fcsNames].map(([sha256, fileName]) => [sha256, { host: session.host, projectId, datasetId: created.id, path: manifestPath(created.uploadPath, created.id, fileName) }]));
    for (const sample of saved.samples) if (origins.has(sample.sha256)) saved = updateSample(saved, sample.id, { cirro: origins.get(sample.sha256) });
    files.unshift({ name: workspaceName, blob: new Blob([serializeWorkspace(saved)], { type: 'application/json' }) });
    files.push(...fcsFiles);
    const total = files.reduce((sum, f) => sum + f.blob.size, 0);
    await session.uploadFiles(projectId, created, files, (fraction, fileName) => progress.update(0.2 + 0.78 * fraction, `Uploading ${fileName} (${formatBytes(total)} in all)…`));

    if (origins.size && sameWorkspace()) {
      let next = store.ws;
      for (const sample of next.samples) if (origins.has(sample.sha256)) next = updateSample(next, sample.id, { cirro: origins.get(sample.sha256) });
      store.commit(next, `Record where in Cirro ${plural(origins.size, 'FCS file')} ${origins.size === 1 ? 'is' : 'are'}`);
    }
    prefs.set('cirroLast', { host: session.host, projectId });
    const url = portalUrl(session.host, projectId, created.id);
    progress.done();
    toast(`Saved ${name} to Cirro: ${plural(files.length, 'file')}, ${formatBytes(total)}.`, { kind: 'ok', timeout: 12000, action: { label: 'Open in Cirro', onClick: () => window.open(url, '_blank', 'noopener') } });
    await session.addNote(projectId, created.id, { title: 'Saved by CytoWeave', subtitle: `CytoWeave ${app.version}`, text: await provenanceNote(app, session, saved, files, created.id) })
      .catch((error) => toast(`The dataset was saved, but its note saying what made it was not: ${error.message}`));
  } catch (error) {
    progress.fail(`The analysis was not saved to Cirro: ${error.message}${created ? ` Cirro keeps the incomplete dataset "${name}"; delete it there.` : ''}`);
  }
}

// The file of a sample as a Blob, from wherever the library or this session keeps it.
async function fcsBlob(data, sample) {
  const source = await data.sourceFor(sample);
  if (!source) return null;
  if (source instanceof Blob) return source;
  if (source instanceof Uint8Array) return new Blob([source]);
  if (source.kind === 'blob') return source.blob;
  const response = await fetch(source.url);
  if (!response.ok) return null;
  return response.blob();
}

// What a reader of the dataset in Cirro needs to know: what made it, from which data, and what it
// holds (Cirro-app-kit docs/building-on-cirro.md, provenance by default).
async function provenanceNote(app, session, ws, files, datasetId) {
  const sources = new Map();
  for (const s of ws.samples) {
    if (s.cirro?.host !== session.host || s.cirro.datasetId === datasetId) continue;
    const key = `${s.cirro.projectId}/${s.cirro.datasetId}`;
    sources.set(key, { ...s.cirro, samples: (sources.get(key)?.samples ?? 0) + 1 });
  }
  const sourceLines = [];
  for (const source of sources.values()) {
    const detail = await session.dataset(source.projectId, source.datasetId).catch(() => null);
    sourceLines.push(`- ${detail?.name ?? source.datasetId} (${plural(source.samples, 'sample')}): ${portalUrl(session.host, source.projectId, source.datasetId)}`);
  }
  return [
    `Saved by ${session.userName || 'a CytoWeave user'} with CytoWeave ${app.version} (https://github.com/robert-mcdermott/cytoweave) on ${new Date().toISOString().slice(0, 10)}.`,
    `Analysis "${ws.name}": ${plural(ws.samples.length, 'sample')}, ${plural(ws.gates.length, 'population')}, ${plural(ws.tables.length, 'table')}, ${plural(ws.figures.length, 'figure')}. Open ${files[0].name} in CytoWeave (Open from Cirro) to see or continue it; its samples' files are read from Cirro.`,
    sourceLines.length ? `FCS files from:\n${sourceLines.join('\n')}` : null,
    `Files:\n${files.map((f) => `- ${f.name} (${formatBytes(f.blob.size)})`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}
