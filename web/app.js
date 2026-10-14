// CytoWeave: application bootstrap, modes, shortcuts, file import and autosave.

import { h, icon, clear, debounce, isTyping, formatBytes, formatCount, downloadBlob, modKey } from './ui/dom.js';
import { showMenu, showDialog, promptDialog, confirmDialog, toast, progressToast, closeMenu } from './ui/overlays.js';
import { createStore } from './ui/store.js';
import { DataStore } from './ui/data.js';
import { createLibrary, detectBackend, prefs } from './ui/storage.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountInspector } from './ui/inspector.js';
import { installActions } from './ui/actions.js';
import { installExportDialogs } from './ui/export-dialogs.js';
import { installEventsIO } from './ui/events-io.js';
import { installTemplateDialogs } from './ui/template-dialogs.js';
import { installChannelDialogs } from './ui/channel-dialogs.js';
import { installFigureProvenance } from './ui/figure-provenance-dialog.js';
import { installAutogating } from './ui/autogate-dialog.js';
import { installLiveQC } from './ui/live-qc.js';
import { installExercises } from './ui/exercises.js';
import { installCirro, finishCirroSignIn } from './ui/cirro.js';
import { colorVisionFriendly, setColorVisionFriendly } from './lib/colormaps.js';
import { openPalette } from './ui/palette.js';
import { GATE_TOOL_KEYS } from './ui/mode-gate.js';
import { WorkerClient } from './ui/workers.js';
import { defaultTransform } from './lib/transforms.js';
import {
  ROOT,
  addGates,
  addGroup,
  addPlot,
  updateGate,
  addSamples,
  createWorkspace,
  gateById,
  gateChildren,
  parseWorkspace,
  rename,
  serializeWorkspace,
  setSampleMeta,
  updateSample,
} from './lib/workspace.js';

const VERSION = '0.8.1';

const MODES = [
  { id: 'welcome', label: 'Start', icon: 'flask', hidden: true, load: () => import('./ui/mode-welcome.js').then((m) => m.mountWelcome) },
  { id: 'gate', label: 'Gate', icon: 'gate', load: () => import('./ui/mode-gate.js').then((m) => m.mountGateMode) },
  { id: 'qc', label: 'QC', icon: 'qc', load: () => import('./ui/mode-qc.js').then((m) => m.mountQCMode) },
  { id: 'compensate', label: 'Compensate', icon: 'compensate', load: () => import('./ui/mode-compensate.js').then((m) => m.mountCompensateMode) },
  { id: 'spectral', label: 'Spectral', icon: 'spectral', load: () => import('./ui/mode-spectral.js').then((m) => m.mountSpectralMode) },
  'sep',
  { id: 'explore', label: 'Explore', icon: 'explore', load: () => import('./ui/mode-explore.js').then((m) => m.mountExploreMode) },
  { id: 'tables', label: 'Tables', icon: 'table', load: () => import('./ui/mode-tables.js').then((m) => m.mountTablesMode) },
  { id: 'plates', label: 'Plates', icon: 'plate', load: () => import('./ui/mode-plates.js').then((m) => m.mountPlatesMode) },
  { id: 'compare', label: 'Compare', icon: 'compare', load: () => import('./ui/mode-compare.js').then((m) => m.mountCompareMode) },
  'sep',
  { id: 'figures', label: 'Figures', icon: 'figure', load: () => import('./ui/mode-figures.js').then((m) => m.mountFiguresMode) },
  { id: 'report', label: 'Report', icon: 'report', load: () => import('./ui/mode-report.js').then((m) => m.mountReportMode) },
];

// --- Theme ---------------------------------------------------------------------------------------

function applyTheme(preference) {
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// Color-vision-friendly colors (a setting): the palettes (colormaps.js) and status colors.
function applyColorVision(on) {
  setColorVisionFriendly(on);
  if (on) document.documentElement.dataset.cvd = '';
  else delete document.documentElement.dataset.cvd;
}

async function start() {
  const themePref = prefs.get('theme', 'system');
  applyTheme(themePref);
  applyColorVision(prefs.get('colorVision', false));
  const info = await detectBackend();
  const library = createLibrary(info);

  // CytoWeave starts on the start page with a new, empty workspace: the last one is a click away
  // in its recent workspaces (marked as last opened), and files named on the command line go into
  // a workspace of their own rather than the last one.
  const store = createStore(createWorkspace());
  store.state.ui.theme = themePref;
  store.state.ui.tileSize = prefs.get('tileSize', 330);
  store.state.ui.colormap = prefs.get('colormap', 'classic');
  const app = { store, library, info, version: VERSION };
  const data = new DataStore({ library, getWorkspace: () => store.ws, onChange: (topics) => store.notify(topics) });
  app.data = data;
  app.workers = {};
  app.worker = (name) => {
    app.workers[name] ??= new WorkerClient(`../workers/${name}-worker.js`, { max: 1 });
    return app.workers[name];
  };

  installActions(app);
  installExportDialogs(app);
  installEventsIO(app);
  installTemplateDialogs(app);
  installChannelDialogs(app);
  installFigureProvenance(app);
  installAutogating(app);
  installCirro(app);
  app.applySpectroFloImport = (result, fileName) => import('./ui/import-spectroflo.js').then((m) => m.applySpectroFloImport(app, result, fileName));
  app.applyFlowJoImport = (result, fileName) => import('./ui/import-flowjo.js').then((m) => m.applyFlowJoImport(app, result, fileName));
  app.exportCLR = () => import('./ui/import-flowjo.js').then((m) => m.exportCLRDialog(app));
  app.compareColumn = (table, column) => {
    store.state.ui.compare = { ...(store.state.ui.compare ?? {}), tab: 'one', source: 'table', tableId: table.id, columnId: column.id };
    app.setMode('compare');
  };
  app.showFlowJoReport = () => import('./ui/import-flowjo.js').then((m) => m.showMigrationReport(app));
  app.sidebar = mountSidebar(app);
  app.inspector = mountInspector(app);

  // --- Modes -------------------------------------------------------------------------------------

  const workbench = document.getElementById('workbench');
  const switcher = document.getElementById('mode-switcher');
  let current = null;
  let currentId = null;
  let mounting = 0;

  function renderSwitcher() {
    clear(switcher);
    for (const mode of MODES) {
      if (mode === 'sep') {
        switcher.append(h('span.mode-sep'));
        continue;
      }
      if (mode.hidden) continue;
      switcher.append(h(`button.mode-tab${store.ui.mode === mode.id ? '.active' : ''}`, { type: 'button', role: 'tab', title: mode.label, onclick: () => app.setMode(mode.id) }, icon(mode.icon), h('span', mode.label)));
    }
  }

  app.setMode = async (id) => {
    if (id === currentId && current) return;
    const mode = MODES.find((m) => m !== 'sep' && m.id === id) ?? MODES[1];
    const token = ++mounting;
    store.setUI({ mode: mode.id }, ['mode']);
    document.getElementById('app').dataset.mode = mode.id;
    renderSwitcher();
    current?.destroy();
    current = null;
    currentId = mode.id;
    clear(workbench);
    let mount;
    try {
      mount = await mode.load();
    } catch (error) {
      if (token !== mounting) return;
      workbench.append(h('div.workbench-scroll', h('div.empty', icon(mode.icon), h('h3', `${mode.label} is not available in this build`), h('p', error.message))));
      return;
    }
    if (token !== mounting) return;
    current = mount(app, workbench);
    current.update?.(new Set(['ws', 'data', 'sample', 'gate', 'selection', 'mode']));
  };

  // --- Selection -------------------------------------------------------------------------------

  app.selectSample = (id) => {
    if (!id) {
      store.setUI({ sampleId: null }, ['sample']);
      return;
    }
    data.pinned.clear();
    data.pinned.add(id);
    store.setUI({ sampleId: id }, ['sample']);
    data.ensure(id).catch((error) => { if (error.name !== 'AbortError') toast(error.message, { kind: 'error' }); });
  };

  app.stepSample = (delta) => {
    const list = app.sidebar.visibleSamples();
    if (!list.length) return;
    const index = list.findIndex((s) => s.id === store.ui.sampleId);
    const next = list[(index + delta + list.length) % list.length];
    app.selectSample(next.id);
    // Prefetch the following sample so stepping through a plate feels instant.
    const after = list[(index + 2 * delta + list.length) % list.length];
    if (after) data.ensure(after.id).catch(() => {});
  };

  app.selectGate = (id, options = {}) => {
    store.setUI({ gateId: id ?? null }, ['gate', 'lineage']);
    if (!options.keepMode && store.ui.mode !== 'gate' && store.ui.mode !== 'tables' && store.ui.mode !== 'plates' && store.ui.mode !== 'compare' && store.ui.mode !== 'explore') app.setMode('gate');
  };

  app.openPopulation = (id) => app.selectGate(id);

  // Renames a population in a small field next to where it was created or clicked.
  app.renameGateInline = (id, anchor) => {
    const gate = gateById(store.ws, id);
    if (!gate) return;
    const rect = (anchor ?? document.querySelector('.tree-row.selected') ?? document.getElementById('workbench')).getBoundingClientRect();
    const input = h('input.input', { value: gate.name, 'aria-label': 'Population name', style: { width: '240px' } });
    const box = h('div.menu', { style: { left: `${Math.min(rect.left + 10, window.innerWidth - 270)}px`, top: `${Math.min(rect.top + 34, window.innerHeight - 90)}px`, padding: '8px', minWidth: '0' } },
      h('div.field-label', { style: { margin: '0 0 6px 2px' } }, 'Name the population'), input,
      h('div.muted', { style: { fontSize: '11px', margin: '6px 2px 0' } }, 'Enter to save · Esc to keep'));
    document.getElementById('overlay-root').append(box);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      box.remove();
      const name = input.value.trim();
      if (save && name && name !== gate.name) store.commit(updateGate(store.ws, id, { name }), `Rename ${gate.name} to ${name}`);
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  };

  app.plotChannel = (channel) => {
    app.setMode('gate');
    const pop = store.ui.gateId ?? ROOT;
    store.commit(addPlot(store.ws, { populationId: pop, x: channel, y: null, type: 'histogram' }).ws, `Plot ${channel}`, ['plots']);
  };

  app.loadAll = async () => {
    const samples = store.ws.samples;
    const progress = progressToast(`Loading ${samples.length} samples…`);
    let done = 0;
    for (const sample of samples) {
      await data.ensure(sample.id).catch(() => {});
      done += 1;
      progress.update(done / samples.length);
    }
    progress.done(`Loaded ${done} samples.`);
  };

  // --- Files ---------------------------------------------------------------------------------

  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  app.pickFiles = (accept) => {
    fileInput.accept = accept ?? '.fcs,.lmd,.cwz,.json,.wsp,.wspt,.flowjo,.xml,.expt,.csv,.acs,.zip,.cwt';
    fileInput.value = '';
    fileInput.click();
  };
  app.pickFolder = () => {
    folderInput.value = '';
    folderInput.click();
  };
  fileInput.addEventListener('change', () => app.importFiles([...fileInput.files]));
  folderInput.addEventListener('change', () => app.importFiles([...folderInput.files]));

  // Imports dropped or picked files by type. Entries: File objects or { name, bytes, folder }; a
  // File opened from Cirro also carries cirro (where in Cirro it is).
  // options.interactive (default true): false imports CSV events with the guessed settings (agents).
  // Returns { csv: the CSV event imports }.
  app.importFiles = async (files, options = {}) => {
    const items = files.map((file, order) => ({ file, name: file.name, folder: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(-2, -1)[0] : file.folder ?? null, cirro: file.cirro ?? null, order }));
    const fcs = items.filter((item) => /\.(fcs|lmd)$/i.test(item.name) || (!/\.\w+$/.test(item.name) && item.file.size > 256));
    const workspaces = items.filter((item) => /\.(cwz|json)$/i.test(item.name));
    const flowjo = items.filter((item) => /\.(wspt?|flowjo)$/i.test(item.name));
    const gatingml = items.filter((item) => /\.xml$/i.test(item.name));
    const tables = items.filter((item) => /\.(csv|tsv|txt)$/i.test(item.name));
    const archives = items.filter((item) => /\.(acs|zip)$/i.test(item.name));
    const figures = items.filter((item) => /\.(svg|png|pdf)$/i.test(item.name));
    const templates = items.filter((item) => /\.cwt$/i.test(item.name));
    const experiments = items.filter((item) => /\.expt$/i.test(item.name));
    for (const item of workspaces) await openWorkspaceFile(item);
    if (fcs.length) await importFCSItems(fcs);
    for (const item of archives) await importArchive(item);
    for (const item of flowjo) await importFlowJo(item);
    for (const item of gatingml) await importGatingML(item);
    // A CSV of numbers (in the first column too) holds events; otherwise sample annotations.
    const eventTables = [];
    for (const item of tables) {
      const text = new TextDecoder().decode(await readBytes(item));
      const { looksLikeEvents } = await import('./lib/csv-events.js');
      if (looksLikeEvents(text)) eventTables.push({ name: item.name, text });
      else await importMetadataTable({ ...item, bytes: new TextEncoder().encode(text) });
    }
    const csv = eventTables.length ? await app.importEventCSVs(eventTables, { interactive: options.interactive !== false }) : [];
    for (const item of figures) await app.openFigureFile(item);
    for (const item of templates) await app.openTemplateFile(item);
    // SpectroFlo experiments name the reference controls, so they come after the FCS files.
    for (const item of experiments) await importSpectroFloItem(item);
    if (!fcs.length && !workspaces.length && !flowjo.length && !gatingml.length && !tables.length && !archives.length && !figures.length && !templates.length && !experiments.length && files.length) toast('CytoWeave opens FCS files and folders of them, CytoWeave workspaces (.cwz), ACS archives, FlowJo workspaces (.wsp) and FlowJo 11 workbenches (.flowjo), FACSDiva experiments and Gating-ML (.xml), SpectroFlo experiments (.Expt), sample annotation tables (.csv, .tsv), templates (.cwt) and figures it exported (.svg, .png, .pdf), and events in CSV files.', { kind: 'error' });
    return { csv };
  };

  async function readBytes(item) {
    if (item.bytes) return item.bytes;
    return new Uint8Array(await item.file.arrayBuffer());
  }

  async function importFCSItems(items, options = {}) {
    const progress = progressToast(`Reading ${items.length} FCS file${items.length > 1 ? 's' : ''}…`);
    const sameWorkspace = store.sameWorkspace();
    // Files are handed over as they are (a File is read in parts by the worker), not read here.
    const files = items.map((item) => ({ name: item.name, file: item.bytes ? null : item.file instanceof Blob ? item.file : null, bytes: item.bytes ?? null, localUrl: item.localUrl ?? null, size: item.file?.size ?? item.size, order: item.order, folder: item.folder, cirro: item.cirro ?? null }));
    const { records, problems } = await data.importFCS(files, (done, total, name) => progress.update(done / total, `Reading ${name} (${Math.min(total, Math.floor(done) + 1)}/${total})`));
    if (!records.length) {
      progress.fail(problems[0] ?? 'No FCS data could be read.');
      return [];
    }
    if (!sameWorkspace()) {
      progress.fail('Another workspace was opened while the files were read, so they were not added to it. Add them again.');
      return [];
    }
    let next = addSamples(store.ws, records);
    // Folders become groups.
    const byFolder = new Map();
    records.forEach((record) => {
      const file = files.find((f) => f.name === record.fileName || record.fileName?.startsWith(f.name.replace(/\.(fcs|lmd)$/i, '')));
      if (file?.folder) {
        if (!byFolder.has(file.folder)) byFolder.set(file.folder, []);
        byFolder.get(file.folder).push(record.id);
      }
    });
    if (byFolder.size > 1 || (byFolder.size === 1 && !options.noGroups)) {
      for (const [folder, ids] of byFolder) {
        const existing = next.groups.find((g) => g.name === folder);
        next = existing ? { ...next, groups: next.groups.map((g) => (g === existing ? { ...g, sampleIds: [...new Set([...g.sampleIds, ...ids])] } : g)) } : addGroup(next, folder, ids).ws;
      }
    }
    next = seedChannelSettings(next, records);
    store.commit(next, `Add ${records.length} sample${records.length > 1 ? 's' : ''}`, ['samples']);
    progress.done(`Added ${records.length} sample${records.length > 1 ? 's' : ''}${problems.length ? `; ${problems.length} problem(s)` : ''}.`);
    for (const problem of problems.slice(0, 3)) toast(problem, { kind: 'error' });
    const first = records.find((r) => r.role === 'sample') ?? records[0];
    if (!store.ui.sampleId || options.select !== false) app.selectSample(first.id);
    if (store.ui.mode === 'welcome') app.setMode('gate');
    // Files that carry the gates FACSChorus recorded: offer them.
    const recorded = records.filter((r) => r.acquisitionGates);
    if (recorded.length && options.offerGates !== false) {
      const offered = store.sameWorkspace();
      toast(`${recorded.length === 1 ? 'This file carries' : `${recorded.length} files carry`} the gates FACSChorus recorded.`, { action: { label: 'Import the gates', onClick: () => (offered() ? app.importAcquisitionGates(recorded.map((r) => r.id)) : toast('Those gates belong to the workspace that was open when they were offered.')) } });
    }
    return records;
  }

  // Imports the gates FACSChorus recorded in samples' files (all samples that have them when
  // sampleIds is omitted), through the migration dialog.
  app.importAcquisitionGates = async (sampleIds) => {
    const samples = store.ws.samples.filter((s) => s.acquisitionGates && (!sampleIds || sampleIds.includes(s.id)));
    if (!samples.length) {
      toast('No sample carries gates recorded by FACSChorus.');
      return null;
    }
    const { importChorus } = await import('./lib/chorus.js');
    return app.applyFlowJoImport?.(importChorus(samples), samples.length === 1 ? samples[0].fileName : `${samples.length} FACSChorus files`);
  };
  app.importFCSItems = importFCSItems;

  // Records a default scale for every new channel, so the workspace states the scales it uses.
  function seedChannelSettings(ws, records) {
    const settings = { ...ws.channelSettings };
    let changed = false;
    for (const record of records) {
      const view = data.view(record.id);
      if (!view) continue;
      for (const p of view.parameters) {
        if (settings[p.name]?.transform) continue;
        settings[p.name] = { transform: defaultTransform(p, record.technology, p.type === 'fluorescence' || p.type === 'time' || p.type === 'instrument' ? view.column(p.name) : null) };
        changed = true;
      }
    }
    return changed ? { ...ws, channelSettings: settings } : ws;
  }

  async function openWorkspaceFile(item) {
    let text = new TextDecoder().decode(await readBytes(item));
    if (text.charCodeAt(0) === 0x1f) {
      const stream = new Blob([await readBytes(item)]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    }
    let doc;
    try {
      doc = parseWorkspace(text);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
      return;
    }
    await loadWorkspace(doc);
    toast(`Opened ${doc.name}.`, { kind: 'ok' });
  }

  async function importArchive(item) {
    try {
      const { readACS } = await import('./lib/acs.js');
      const bytes = await readBytes(item);
      const archive = await readACS(bytes);
      // A certificate is verified first; its analysis opens on request.
      const { isCertificateArchive } = await import('./lib/certificate.js');
      if (isCertificateArchive(archive)) {
        const { showVerification } = await import('./ui/certificates.js');
        await showVerification(app, bytes, item.name, { open: () => openArchive(archive, item.name) });
        return;
      }
      await openArchive(archive, item.name);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
    }
  }

  async function openArchive(archive, name) {
    try {
      const fcsFiles = archive.files.filter((f) => /\.(fcs|lmd)$/i.test(f.name)).map((f, order) => ({ name: f.name.split('/').pop(), bytes: f.bytes, order }));
      const workspaceFile = archive.files.find((f) => f.name === 'cytoweave-workspace.json') ?? archive.files.find((f) => /\.(cwz|json)$/i.test(f.name) && f.name !== 'certificate.json');
      // Channels a certificate stored (derived/<sha256>.f32), where the workspace looks for them.
      for (const f of archive.files) {
        const sha = /^derived\/([0-9a-f]{64})\.f32$/.exec(f.name)?.[1];
        if (!sha) continue;
        data.session.set(sha, f.bytes);
        await library.putFile(sha, f.bytes).catch(() => {});
      }
      if (workspaceFile) {
        await openWorkspaceFile({ name: workspaceFile.name, bytes: workspaceFile.bytes });
        if (fcsFiles.length) {
          const { records } = await data.importFCS(fcsFiles);
          data.forget(records.map((r) => r.id));
          for (const sample of store.ws.samples) data.status.delete(sample.id);
          if (store.ui.sampleId) app.selectSample(store.ui.sampleId);
        }
      } else if (fcsFiles.length) {
        await importFCSItems(fcsFiles);
      }
    } catch (error) {
      toast(`${name}: ${error.message}`, { kind: 'error' });
    }
  }

  async function importFlowJo(item) {
    try {
      let result;
      if (/\.flowjo$/i.test(item.name)) {
        const { importFlowJo11 } = await import('./lib/flowjo11.js');
        result = await importFlowJo11(await readBytes(item));
      } else {
        const flowjo = await import('./lib/flowjo.js');
        result = flowjo.importFlowJo(new TextDecoder().decode(await readBytes(item)));
      }
      await app.applyFlowJoImport?.(result, item.name);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
    }
  }

  async function importSpectroFloItem(item) {
    try {
      const { importSpectroFlo } = await import('./lib/spectroflo.js');
      // The detectors of the workspace's raw spectral files name the experiment's vectors.
      const raw = store.ws.samples.find((s) => s.channels.filter((c) => c.type === 'fluorescence' && /-A$/.test(c.name)).length >= 14);
      const detectors = raw?.channels.filter((c) => c.type === 'fluorescence' && /-A$/.test(c.name)).map((c) => c.name);
      const result = importSpectroFlo(new TextDecoder().decode(await readBytes(item)), { detectors });
      await app.applySpectroFloImport(result, item.name);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
    }
  }

  async function importGatingML(item) {
    try {
      const text = new TextDecoder().decode(await readBytes(item));
      // A FACSDiva experiment (File → Export → Experiment as XML) opens like a FlowJo workspace.
      if (/<bdfacs[\s>]/.test(text.slice(0, 4096))) {
        const { importDiva } = await import('./lib/diva.js');
        await app.applyFlowJoImport?.(importDiva(text), item.name);
        return;
      }
      const gml = await import('./lib/gatingml.js');
      const result = gml.importGatingML(text);
      const { addGates, addCompensation, addDerived } = await import('./lib/workspace.js');
      let next = store.ws;
      for (const comp of result.compensations ?? []) next = addCompensation(next, { ...comp, source: 'imported' }).ws;
      // Ratio dimensions (fratio) become channels computed from their inputs.
      for (const record of result.derived ?? []) if (!next.derived.some((d) => d.kind === 'ratio' && d.outputs?.[0] === record.outputs[0])) next = addDerived(next, record).ws;
      next = addGates(next, result.gates.map((g) => ({ ...g, meta: { ...(g.meta ?? {}), origin: 'imported' } })), 'import-gating-ml').ws;
      store.commit(next, `Import ${result.gates.length} gates from ${item.name}`);
      toast(`Imported ${result.gates.length} gates${result.warnings?.length ? ` with ${result.warnings.length} warning(s)` : ''}.`, { kind: result.warnings?.length ? undefined : 'ok' });
      for (const warning of (result.warnings ?? []).slice(0, 3)) toast(warning);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
    }
  }

  // A CSV whose first column names samples and whose other columns are metadata fields.
  async function importMetadataTable(item) {
    const text = new TextDecoder().decode(await readBytes(item));
    // A plate layout (a "well" column, or plate maps) annotates the samples by their wells.
    const { parseLayout } = await import('./lib/plates.js');
    let layout = null;
    try {
      layout = parseLayout(text);
    } catch {
      layout = null;
    }
    // Tables keyed by sample name (in the first column) stay sample annotations even with a well column.
    const firstColumn = text.split(/\r?\n/).slice(1).map((line) => line.split(/[,;\t]/)[0]?.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const byName = firstColumn.some((key) => store.ws.samples.some((s) => s.name === key || s.fileName === key || s.fileName === `${key}.fcs`));
    if (layout?.entries.length && (layout.format === 'map' || !byName)) {
      const { applyLayoutText } = await import('./ui/mode-plates.js');
      try {
        applyLayoutText(app, text, item.name);
      } catch (error) {
        toast(error.message, { kind: 'error' });
      }
      return;
    }
    const delimiter = item.name.toLowerCase().endsWith('.tsv') || text.split('\n')[0].includes('\t') ? '\t' : ',';
    const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, '')));
    if (rows.length < 2) return;
    const [header, ...body] = rows;
    let next = store.ws;
    let matched = 0;
    for (const row of body) {
      const key = row[0];
      const sample = next.samples.find((s) => s.name === key || s.fileName === key || s.fileName === `${key}.fcs`);
      if (!sample) continue;
      matched += 1;
      const meta = { ...sample.meta };
      header.slice(1).forEach((field, i) => { if (row[i + 1] !== undefined && row[i + 1] !== '') meta[field.toLowerCase()] = row[i + 1]; });
      next = updateSample(next, sample.id, { meta });
    }
    store.commit(next, `Annotate from ${item.name}`);
    toast(`Annotated ${matched} of ${body.length} rows' samples from ${item.name}.`, { kind: matched ? 'ok' : 'error' });
  }

  // --- Examples -------------------------------------------------------------------------------

  app.showExamples = async () => {
    const { EXAMPLES } = await import('./lib/examples.js');
    const list = h('div.welcome-grid');
    // A larger copy of an example (ten times the events of every file) tries CytoWeave at scale.
    const size = h('select', { 'aria-label': 'Example size' },
      h('option', { value: '1' }, 'As designed'),
      h('option', { value: '10' }, 'Ten times the events (to try large files)'));
    const dialog = showDialog({ title: 'Example experiments', width: 'wide', content: [
      h('div.row', { style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, h('p', { style: { margin: 0, flex: 1 } }, 'Simulated experiments that behave like real data. Each opens as a new workspace.'), h('label.field.inline', h('span', 'Size'), size)),
      list] });
    for (const example of EXAMPLES) {
      list.append(h('div.card.clickable', { onclick: () => { dialog.close(); app.openExample(example.id, size.value === '1' ? {} : { scale: Number(size.value) }); } }, h('h4', example.title), h('p', example.description), h('div.tags', ...(example.tags ?? []).map((t) => h('span.badge', t)))));
    }
  };

  // Files that come with an example besides its FCS files (a CSV table, another program's
  // experiment or workspace), for the workspace it opened, until another is opened: imported on
  // request, as if the user had dropped them.
  const exampleFiles = new Map();
  app.exampleFiles = () => exampleFiles.get(store.ws.id) ?? [];
  // A file of the example as the program saves it (a FlowJo 11 workbench is zipped when needed).
  const attachmentFile = async (a) => {
    if (a.zip) {
      const { createZip } = await import('./lib/zip.js');
      return new File([await createZip(a.zip.map((entry) => ({ name: entry.name, data: entry.text })))], a.name, { type: 'application/zip' });
    }
    return new File([a.bytes ?? a.text], a.name, { type: a.text !== undefined ? 'text/plain' : 'application/octet-stream' });
  };
  app.showExampleFiles = () => {
    const files = app.exampleFiles();
    if (!files.length) return;
    const dialog = showDialog({ title: 'Files that came with this example', content: [
      h('p.muted', 'Import a file as if you had dropped it on the window, or save a copy to try it elsewhere.'),
      h('div.stack', ...files.map((a) => h('div.card',
        h('h4', icon('file'), a.name),
        a.about ? h('p', a.about) : null,
        h('div.btn-row',
          h('button.btn.small.primary', { type: 'button', onclick: async () => { dialog.close(); await app.importFiles([await attachmentFile(a)]); } }, icon('upload'), 'Import'),
          h('button.btn.small', { type: 'button', onclick: async () => downloadBlob(await attachmentFile(a), a.name) }, icon('download'), 'Save a copy'))))),
    ], buttons: [{ label: 'Close' }] });
  };

  // options: generation options (seed, scale, tandemDegradation; see examples.js), for scripts.
  // setup (exercises.js): { name, hideTruth, gates (add the suggested gates), onOpened(result,
  // records) }; an exercise's example opens without its truth, fault annotations or the files
  // and suggestions that come with it.
  app.openExample = async (id, options = {}, setup = null) => {
    const { EXAMPLES } = await import('./lib/examples.js');
    const example = EXAMPLES.find((e) => e.id === id);
    if (!example) return;
    if (store.ws.samples.length) {
      await saveNow();
    }
    const progress = progressToast(`Generating ${example.title}…`);
    try {
      const worker = app.worker('simulate');
      const result = await worker.call('generateExample', { id, options }, { onProgress: (f, message) => progress.update(f * 0.6, message) });
      await loadWorkspace(createWorkspace(setup?.name ?? example.title));
      const items = result.files.map((file, order) => ({ name: file.name, bytes: new Uint8Array(file.bytes), order, folder: null }));
      progress.update(0.65, 'Reading the generated files…');
      const records = await importFCSItems(items, { noGroups: true, select: false });
      progress.done();
      // Another example (or workspace) opened meanwhile: this one's annotations are not its.
      if (!records.length) return;
      applyExampleHints(records, result, setup);
      if (setup) {
        await setup.onOpened?.(result, records);
        return;
      }
      // Workspaces that come with an example (a FlowJo .wsp) open in their import dialog; not
      // awaited, so a script or agent that opened the example is not held by the dialog. Other
      // files are offered.
      const others = [];
      for (const attachment of result.attachments ?? []) {
        if (attachment.kind === 'flowjo') importFlowJo({ name: attachment.name, bytes: attachment.bytes ?? new TextEncoder().encode(attachment.text) });
        else others.push(attachment);
      }
      if (others.length) {
        exampleFiles.set(store.ws.id, others);
        toast(`This example comes with ${others.length === 1 ? 'a file' : `${others.length} files`} to import: ${others.map((a) => a.name).join(', ')}.`, { timeout: 15000, action: { label: 'Show', onClick: () => app.showExampleFiles() } });
      }
    } catch (error) {
      progress.fail(`The example could not be generated: ${error.message}`);
    }
  };

  // Applies an example's annotations: roles, stains and metadata per file, groups, channel scales
  // and (on request) its suggested gating strategy. Ground-truth labels, when the simulator gives
  // them, are attached for this session as a derived channel for checking clustering.
  function applyExampleHints(records, result, setup = null) {
    const hints = result.workspaceHints ?? {};
    let next = store.ws;
    const byFile = new Map(records.map((r) => [r.fileName, r]));
    for (const file of result.files) {
      const record = byFile.get(file.name);
      if (!record) continue;
      const meta = { ...(hints.sampleMeta?.[file.name] ?? {}), ...(file.meta ?? {}) };
      const patch = {};
      if (meta.role) patch.role = meta.role;
      if (meta.stain) patch.stain = meta.stain;
      if (hints.barcodeKeys?.[file.name]) patch.barcodeKey = hints.barcodeKeys[file.name];
      // A bead lot's datasheet values (QC → Calibration fills them in).
      if (hints.beadDatasheets?.[file.name]) patch.beadDatasheet = hints.beadDatasheets[file.name];
      // An exercise does not say which file holds a planted fault.
      const hidden = ['role', 'stain', 'truth', 'channels', 'eventCount', 'truthNames', ...(setup?.hideTruth ? ['anomaly'] : [])];
      const fields = Object.fromEntries(Object.entries(meta).filter(([k, v]) => !hidden.includes(k) && v !== undefined && v !== null && v !== '' && typeof v !== 'object'));
      if (Object.keys(fields).length) patch.meta = { ...record.meta, ...fields };
      if (Object.keys(patch).length) next = updateSample(next, record.id, patch);
      // The simulator's per-event population index (meta.truth.labels; −1 for events outside any).
      const truth = meta.truth?.labels;
      if (truth && truth.length === record.eventCount && !setup?.hideTruth) data.setDerived(record.id, 'Truth (simulated)', Float32Array.from(truth));
    }
    for (const group of hints.groups ?? []) {
      const ids = (group.files ?? group.samples ?? []).map((name) => byFile.get(name)?.id).filter(Boolean);
      if (ids.length) next = addGroup(next, group.name, ids, { color: group.color }).ws;
    }
    if (hints.channelSettings) next = { ...next, channelSettings: { ...next.channelSettings, ...hints.channelSettings } };
    const suggested = hints.suggestedGates ?? [];
    if (setup?.gates && suggested.length) {
      next = addGates(next, suggested.map((g) => ({ ...g, overrides: g.overrides ?? {} })), 'add-suggested-gates').ws;
    }
    store.commit(next, 'Annotate example');
    const first = next.samples.find((s) => s.role === 'sample') ?? next.samples[0];
    if (first) app.selectSample(first.id);
    app.setMode('gate');
    if (suggested.length && !setup) {
      // The suggestion is this example's: not another workspace opened while the toast shows.
      const offered = store.sameWorkspace();
      toast(`This example comes with a suggested gating strategy (${suggested.length} gates). Gate it yourself, or add the suggestion.`, {
        timeout: 15000,
        action: {
          label: 'Add suggested gates',
          onClick: async () => {
            if (!offered()) {
              toast('That suggestion was for the example that was open when it was offered.');
              return;
            }
            const { addGates } = await import('./lib/workspace.js');
            store.commit(addGates(store.ws, suggested.map((g) => ({ ...g, overrides: g.overrides ?? {} })), 'add-suggested-gates').ws, 'Add the suggested gates');
          },
        },
      });
    }
  }

  // --- Workspaces -------------------------------------------------------------------------------

  async function loadWorkspace(doc) {
    data.forget(store.ws.samples.map((s) => s.id));
    store.reset(doc);
    prefs.set('lastWorkspace', doc.id);
    store.setUI({ sampleId: null, gateId: null, selectedSamples: new Set(), groupFilter: null }, ['sample', 'gate', 'selection']);
    const first = doc.samples.find((s) => s.role === 'sample') ?? doc.samples[0];
    if (first) app.selectSample(first.id);
    app.setMode(doc.samples.length ? 'gate' : 'welcome');
    updateTitle();
  }
  app.loadWorkspace = loadWorkspace;

  app.openWorkspace = async (id) => {
    try {
      await saveNow();
      const doc = parseWorkspace(await library.loadWorkspace(id));
      await loadWorkspace(doc);
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  };

  const saveState = document.getElementById('save-state');
  // The save under way, if any. A save asked for meanwhile (opening another workspace) waits for
  // it, then saves what changed since: returning at once would lose those edits.
  let saving = null;
  async function writeWorkspace(ws) {
    saveState.className = 'save-state saving';
    saveState.setAttribute('aria-label', 'Saving');
    try {
      await library.saveWorkspace(ws.id, serializeWorkspace(ws));
      prefs.set('lastWorkspace', ws.id);
      // Another workspace may have been opened while this one was written.
      if (store.ws.id === ws.id) store.markSaved(ws);
      saveState.className = 'save-state';
      saveState.title = `Saved to ${library.kind === 'desktop' ? library.location : 'this browser'}`;
      saveState.setAttribute('aria-label', 'Saved');
    } catch (error) {
      saveState.className = 'save-state error';
      saveState.title = `Not saved: ${error.message}`;
      saveState.setAttribute('aria-label', 'Not saved');
    }
  }
  async function saveNow() {
    while (saving) await saving;
    const ws = store.ws;
    if (!store.isDirty()) return;
    if (!ws.samples.length && !ws.gates.length) return;
    saving = writeWorkspace(ws);
    try {
      await saving;
    } finally {
      saving = null;
    }
    if (store.isDirty()) autosave();
  }
  app.saveNow = saveNow;
  const autosave = debounce(saveNow, 1200);

  app.newWorkspace = async () => {
    await saveNow();
    await loadWorkspace(createWorkspace());
  };

  async function openLibraryDialog() {
    let list = [];
    try {
      list = await library.listWorkspaces();
    } catch (error) {
      toast(error.message, { kind: 'error' });
      return;
    }
    const body = h('tbody');
    const dialog = showDialog({
      title: 'Open a workspace',
      width: 'wide',
      content: [h('p', `Workspaces in ${library.kind === 'desktop' ? library.location : 'this browser'}.`), h('div', { style: { maxHeight: '60vh', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Name'), h('th.r', 'Samples'), h('th', 'Modified'), h('th'))), body))],
    });
    for (const item of list) {
      body.append(h(`tr${item.id === store.ws.id ? '.selected' : ''}`, { style: { cursor: 'pointer' }, onclick: () => { dialog.close(); app.openWorkspace(item.id); } },
        h('td', item.name || 'Untitled'), h('td.r', String(item.samples ?? '')), h('td', new Date(item.modified).toLocaleString()),
        h('td.r', h('button.icon-button.small', {
          type: 'button',
          title: 'Delete',
          onclick: async (event) => {
            event.stopPropagation();
            if (!(await confirmDialog({ title: 'Delete workspace?', message: `Delete "${item.name}"? ${library.kind === 'desktop' ? 'It is moved to the library\'s trash folder.' : 'This cannot be undone.'}`, confirm: 'Delete', danger: true }))) return;
            await library.deleteWorkspace(item.id);
            event.target.closest('tr').remove();
          },
        }, icon('trash')))));
    }
    if (!list.length) body.append(h('tr', h('td', { colSpan: 4 }, h('span.muted', 'No saved workspaces yet.'))));
  }

  function exportWorkspaceFile() {
    const text = serializeWorkspace(store.ws);
    downloadBlob(new Blob([text], { type: 'application/json' }), `${store.ws.name.replace(/[^\w.-]+/g, '_') || 'workspace'}.cwz`);
  }

  async function exportGatingML() {
    try {
      const { exportGatingML: write } = await import('./lib/gatingml.js');
      const xml = write(store.ws);
      downloadBlob(new Blob([typeof xml === 'string' ? xml : xml.xml], { type: 'application/xml' }), `${store.ws.name.replace(/[^\w.-]+/g, '_') || 'gates'}.gating-ml.xml`);
    } catch (error) {
      toast(`Gating-ML export failed: ${error.message}`, { kind: 'error' });
    }
  }

  async function exportBundle() {
    const progress = progressToast('Packing the workspace with its FCS files…');
    try {
      const { createACS } = await import('./lib/acs.js');
      const fcsFiles = [];
      const seen = new Set();
      for (const sample of store.ws.samples) {
        if (!sample.sha256 || seen.has(sample.sha256)) continue;
        seen.add(sample.sha256);
        const bytes = data.session.get(sample.sha256) ?? await library.getFile(sample.sha256);
        if (bytes) fcsFiles.push({ name: sample.fileName, bytes });
        progress.update(seen.size / store.ws.samples.length);
      }
      let gatingML = null;
      try {
        const { exportGatingML: write } = await import('./lib/gatingml.js');
        const result = write(store.ws);
        gatingML = typeof result === 'string' ? result : result.xml;
      } catch { /* optional */ }
      const bytes = await createACS({ fcsFiles, workspaceJSON: serializeWorkspace(store.ws), gatingML });
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), `${store.ws.name.replace(/[^\w.-]+/g, '_') || 'workspace'}.acs`);
      progress.done('Packed the workspace and its data as an ACS archive.');
    } catch (error) {
      progress.fail(`Packing failed: ${error.message}`);
    }
  }

  document.getElementById('workspace-menu').addEventListener('click', (event) => {
    showMenu(event.currentTarget, [
      { label: 'New workspace', icon: 'plus', onSelect: () => app.newWorkspace() },
      { label: 'Open…', icon: 'library', hint: `${modKey}⇧O`, onSelect: openLibraryDialog },
      { label: 'Rename…', icon: 'edit', onSelect: async () => {
        const name = await promptDialog({ title: 'Rename workspace', label: 'Name', value: store.ws.name });
        if (name) store.commit(rename(store.ws, name), 'Rename workspace');
      } },
      { label: 'Save now', icon: 'save', hint: `${modKey}S`, onSelect: async () => { await saveNow(); toast('Saved.', { kind: 'ok' }); } },
      '-',
      { section: 'Channels' },
      { label: 'Computed channels…', icon: 'layers', onSelect: () => app.computedChannelsDialog() },
      { label: 'New formula channel…', icon: 'plus', onSelect: () => app.formulaDialog() },
      '-',
      { section: 'Templates' },
      { label: 'Save as a template…', icon: 'layers', onSelect: () => app.saveTemplate() },
      { label: 'Apply a template…', icon: 'layers', onSelect: () => app.applyTemplateDialog() },
      '-',
      { section: 'Export' },
      { label: 'Workspace file (.cwz)', icon: 'download', onSelect: exportWorkspaceFile },
      { label: 'Workspace with FCS files (ACS archive)', icon: 'download', onSelect: exportBundle },
      { label: 'Review report (HTML)…', icon: 'report', onSelect: async () => { await app.setMode('report'); app.showReviewReport?.(); } },
      { label: 'Reproducibility certificate…', icon: 'report', onSelect: async () => { await app.setMode('report'); app.showCertificate?.(); } },
      { label: 'Gates as Gating-ML 2.0', icon: 'download', onSelect: exportGatingML },
      { label: 'Population memberships (CLR)…', icon: 'download', onSelect: () => app.exportCLR() },
      { label: 'FlowJo workspace (.wsp)…', icon: 'download', onSelect: () => app.exportFlowJo() },
      { label: 'De-identified FCS files…', icon: 'download', onSelect: () => app.exportDeidentified() },
      { label: 'Events: concatenated FCS, downsampled, AnnData…', icon: 'download', onSelect: () => app.exportEventsDialog() },
      { label: 'Tables as an Excel workbook', icon: 'download', onSelect: () => import('./ui/mode-tables.js').then((m) => m.exportTablesWorkbook(app)) },
      ...(store.ws.migrations?.length ? [{ label: 'Migration report (FlowJo, FACSDiva, FACSChorus)…', icon: 'report', onSelect: () => app.showFlowJoReport() }] : []),
      '-',
      { section: 'Import' },
      { label: 'FCS files…', icon: 'file', onSelect: () => app.pickFiles() },
      { label: 'Workspace, FlowJo (.wsp, .flowjo), Gating-ML or ACS…', icon: 'upload', onSelect: () => app.pickFiles('.cwz,.json,.wsp,.wspt,.flowjo,.xml,.acs,.zip') },
      ...(store.ws.samples.some((x) => x.acquisitionGates) ? [{ label: 'Gates FACSChorus recorded in the files…', icon: 'upload', onSelect: () => app.importAcquisitionGates() }] : []),
      { label: 'Events or sample annotations (CSV)…', icon: 'tag', onSelect: () => app.pickFiles('.csv,.tsv,.txt') },
      '-',
      ...(app.cirro.enabled ? [
        { section: 'Cirro' },
        { label: 'Open from Cirro…', icon: 'globe', onSelect: () => app.cirro.open() },
        { label: 'Save to Cirro…', icon: 'upload', onSelect: () => app.cirro.save() },
        { label: app.cirro.session?.signedIn ? `Signed in to ${app.cirro.session.tenantName}…` : 'Connect to Cirro…', icon: 'link', onSelect: () => app.cirro.connect() },
        '-',
      ] : []),
      { label: 'Example experiments…', icon: 'flask', onSelect: () => app.showExamples() },
      { label: 'Exercises…', icon: 'school', onSelect: () => app.showExercises() },
      ...(app.exampleFiles().length ? [{ label: 'Files that came with this example…', icon: 'file', onSelect: () => app.showExampleFiles() }] : []),
      { label: 'Start page', icon: 'grid', onSelect: () => app.setMode('welcome') },
    ]);
  });

  // --- Commands (palette) ----------------------------------------------------------------------

  app.commands = () => [
    ...MODES.filter((m) => m !== 'sep').map((m) => ({ label: `Go to ${m.label}`, icon: m.icon, run: () => app.setMode(m.id), keywords: m.id })),
    { label: 'Add FCS files', icon: 'file', hint: `${modKey}O`, run: () => app.pickFiles() },
    { label: 'Open a folder of FCS files', icon: 'folder', run: () => app.pickFolder() },
    ...(app.cirro.enabled ? [
      { label: 'Open files from Cirro', icon: 'globe', run: () => app.cirro.open(), keywords: 'cirro cloud project dataset download' },
      { label: 'Save the analysis to Cirro', icon: 'upload', run: () => app.cirro.save(), keywords: 'cirro cloud project dataset upload share' },
      { label: 'Connect to Cirro (sign in or out)', icon: 'link', run: () => app.cirro.connect(), keywords: 'cirro tenant login sign in account' },
    ] : []),
    { label: 'Open an example experiment', icon: 'flask', run: () => app.showExamples() },
    { label: 'Start an exercise', icon: 'school', run: () => app.showExercises(), keywords: 'teaching learn practice tutorial training exercise class course' },
    ...(app.exampleFiles().length ? [{ label: 'Files that came with this example', icon: 'file', run: () => app.showExampleFiles(), keywords: 'attachment csv diva spectroflo flowjo import' }] : []),
    { label: 'New workspace', icon: 'plus', run: () => app.newWorkspace() },
    { label: 'Open a saved workspace', icon: 'library', run: openLibraryDialog },
    { label: 'Save workspace now', icon: 'save', hint: `${modKey}S`, run: saveNow },
    { label: 'Export workspace file', icon: 'download', run: exportWorkspaceFile },
    { label: 'Export gates as Gating-ML', icon: 'download', run: exportGatingML },
    { label: 'Export as a FlowJo workspace', icon: 'download', run: () => app.exportFlowJo(), keywords: 'wsp flowjo' },
    { label: 'Import the gates FACSChorus recorded in the files', icon: 'upload', run: () => app.importAcquisitionGates(), keywords: 'chorus s8 a8 discover gates' },
    { label: 'Export de-identified FCS files', icon: 'download', run: () => app.exportDeidentified(), keywords: 'anonymize anonymize privacy keywords' },
    { label: 'Export events (concatenated FCS, downsampled, AnnData)', icon: 'download', run: () => app.exportEventsDialog(), keywords: 'concatenate downsample h5ad anndata scanpy merge subsample' },
    { label: 'Export tables to Excel', icon: 'download', run: () => import('./ui/mode-tables.js').then((m) => m.exportTablesWorkbook(app)), keywords: 'xlsx spreadsheet workbook statistics' },
    { label: 'Annotate samples', icon: 'tag', run: () => app.annotateSamples(store.ws.samples.map((s) => s.id)) },
    { label: 'Save as a template', icon: 'layers', run: () => app.saveTemplate(), keywords: 'template reuse strategy panel' },
    { label: 'Apply a template', icon: 'layers', run: () => app.applyTemplateDialog(), keywords: 'template reuse strategy panel omip' },
    { label: 'New formula channel', icon: 'plus', run: () => app.formulaDialog(), keywords: 'formula ratio derived parameter channel calculate' },
    { label: 'Computed channels', icon: 'layers', run: () => app.computedChannelsDialog(), keywords: 'formula calibration mef derived parameters' },
    { label: 'Calibrate fluorescence with beads', icon: 'gauge', run: () => app.openCalibration(), keywords: 'mef mefl erf calibration beads rainbow units' },
    { label: 'Dose-response curves of a plate', icon: 'wave', run: () => import('./ui/dose-response.js').then((m) => m.openDoseResponse(app, {})), keywords: 'ec50 ic50 4pl 5pl hill curve plate screen inhibition' },
    { label: 'Bead immunoassay (LEGENDplex, CBA)', icon: 'flask', run: () => import('./ui/bead-assay.js').then((m) => m.openBeadAssay(app, {})), keywords: 'legendplex cba cytokine standard curve concentration plate beads multiplex' },
    { label: 'Toggle backgating', icon: 'backgate', hint: 'B', run: () => store.setUI({ backgate: !store.ui.backgate }, ['backgate']) },
    { label: 'Review the selected gate across samples', icon: 'target', run: () => store.ui.gateId && app.reviewGate(store.ui.gateId) },
    { label: 'Adapt the selected gate to each sample', icon: 'sparkles', run: () => store.ui.gateId && app.adaptGate(store.ui.gateId), keywords: 'autogating autogate adjust learn' },
    { label: 'Toggle dark theme', icon: 'moon', run: () => toggleTheme() },
    { label: 'Color-vision-friendly colors (on or off)', icon: 'eye', run: () => toggleColorVision(), keywords: 'color color blind accessibility deuteranopia protanopia palette' },
    { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: showHelp },
    { label: 'Load every sample', icon: 'download', run: () => app.loadAll() },
  ];

  // --- Top bar ----------------------------------------------------------------------------------

  const undoButton = document.getElementById('undo-button');
  const redoButton = document.getElementById('redo-button');
  const themeButton = document.getElementById('theme-button');
  undoButton.append(icon('undo'));
  redoButton.append(icon('redo'));
  document.getElementById('help-button').append(icon('help'));
  document.getElementById('help-button').addEventListener('click', showHelp);
  document.getElementById('command-button').addEventListener('click', () => openPalette(app));
  undoButton.addEventListener('click', () => doUndo());
  redoButton.addEventListener('click', () => doRedo());
  themeButton.addEventListener('click', () => showMenu(themeButton, [
    { section: 'Appearance' },
    ...[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match the system', 'settings']].map(([id, label, glyph]) => ({ label, icon: glyph, checked: prefs.get('theme', 'system') === id, onSelect: () => setTheme(id) })),
    '-',
    { label: 'Color-vision-friendly colors', icon: 'eye', checked: colorVisionFriendly(), onSelect: () => toggleColorVision() },
  ]));

  function doUndo() {
    const label = store.undo();
    if (label) toast(`Undid: ${label}`, { timeout: 1800 });
  }
  function doRedo() {
    const label = store.redo();
    if (label) toast(`Redid: ${label}`, { timeout: 1800 });
  }

  function toggleTheme() {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
  function toggleColorVision() {
    const next = !colorVisionFriendly();
    prefs.set('colorVision', next);
    applyColorVision(next);
    store.notify(['theme', 'colors']);
    toast(next ? 'Color-vision-friendly colors: populations, clusters, heat maps and status colors stay distinguishable with red–green and blue–yellow color blindness.' : 'Default colors.', { timeout: 3500 });
  }
  function setTheme(next) {
    prefs.set('theme', next);
    store.state.ui.theme = next;
    applyTheme(next);
    renderTheme();
    store.notify(['theme']);
  }
  function renderTheme() {
    clear(themeButton).append(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
  }
  renderTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.get('theme', 'system') === 'system') {
      applyTheme('system');
      renderTheme();
      store.notify(['theme']);
    }
  });

  function updateTitle() {
    document.getElementById('workspace-name').textContent = store.ws.name;
    document.title = `${store.ws.name} · CytoWeave`;
    undoButton.disabled = !store.canUndo();
    redoButton.disabled = !store.canRedo();
    undoButton.title = store.canUndo() ? `Undo ${store.undoLabel()} (${modKey}Z)` : 'Nothing to undo';
    redoButton.title = store.canRedo() ? `Redo ${store.redoLabel()} (⇧${modKey}Z)` : 'Nothing to redo';
    if (!saveState.classList.contains('error') && !saveState.classList.contains('saving')) {
      saveState.className = `save-state${store.isDirty() ? ' dirty' : ''}`;
      saveState.setAttribute('aria-label', store.isDirty() ? 'Unsaved changes' : 'Saved');
    }
  }

  // --- Status bar -------------------------------------------------------------------------------

  const statusbar = document.getElementById('statusbar');
  function renderStatus() {
    clear(statusbar);
    const busy = [...store.state.busy.values()];
    const watch = app.live?.status?.watching ? app.live.status : null;
    statusbar.append(...[
      h('span.item', h(`span.dot${busy.length ? '.busy' : ''}`), busy.length ? busy[0] : 'Ready'),
      h('span.item', icon('library'), library.kind === 'desktop' ? `Library: ${library.location}` : 'Library: this browser'),
      h('span.item', `${store.ws.samples.length} sample${store.ws.samples.length === 1 ? '' : 's'} · ${store.ws.gates.length} gate${store.ws.gates.length === 1 ? '' : 's'}`),
      h('span.item', `${data.views.size} loaded · ${formatBytes(data.totalBytes())}`),
      watch ? h('button.item.statusbar-link', { type: 'button', title: `Watching ${watch.folder}: open QC → Live`, onclick: () => app.openLiveQC() }, icon('play'), `Watching ${watch.name} · ${app.live.queue.length} file${app.live.queue.length === 1 ? '' : 's'}`) : null,
      app.cirro.session?.signedIn ? h('button.item.statusbar-link', { type: 'button', title: `Signed in to ${app.cirro.session.host}${app.cirro.session.userName ? ` as ${app.cirro.session.userName}` : ''}`, onclick: () => app.cirro.connect() }, icon('globe'), `Cirro: ${app.cirro.session.tenantName}`) : null,
      h('span.spacer'),
      store.ui.editScope === 'sample' ? h('span.item', h('span.badge.warn', 'Editing this sample only')) : null,
      h('span.item', `CytoWeave ${VERSION}${info ? '' : ' · web'}`),
      h('span.item.muted', 'Research use only')].filter(Boolean));
  }

  function showHelp() {
    const rows = [
      ['Search and commands', `${modKey}K`],
      ['Undo / redo', `${modKey}Z / ⇧${modKey}Z`],
      ['Add FCS files', `${modKey}O`],
      ['Save now', `${modKey}S`],
      ['Previous / next sample', '↑ / ↓'],
      ['Select tool', 'V'],
      ['Rectangle, polygon, ellipse, freehand', 'R, P, E, L'],
      ['Quadrant, range, split', 'Q, H, S'],
      ['Magic wand (density basin, histogram valley)', 'W'],
      ['Keep a tool for several gates', '⇧ with its key, or double-click it'],
      ['Finish a polygon', 'double-click, Enter, or click the first vertex'],
      ['Nudge the selected gate', 'arrow keys (⇧ for larger steps)'],
      ['Delete the selected gate', '⌫ / Delete'],
      ['Rename the selected population', 'F2'],
      ['Backgate', 'B'],
      ['Go to a view', `${modKey}1 … ${modKey}9`],
      ['Toggle sidebar / inspector', `${modKey}\\ / ${modKey}⇧\\`],
    ];
    showDialog({
      title: 'Keyboard shortcuts',
      content: h('table.data', h('tbody', ...rows.map(([action, keys]) => h('tr', h('td', action), h('td.r', h('kbd', keys)))))),
    });
  }

  // --- Keyboard ---------------------------------------------------------------------------------

  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette(app);
      return;
    }
    if (isTyping(event)) return;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      doRedo();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow().then(() => toast('Saved.', { kind: 'ok', timeout: 1500 }));
      return;
    }
    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      if (event.shiftKey) openLibraryDialog();
      else app.pickFiles();
      return;
    }
    if (mod && event.key === '\\') {
      event.preventDefault();
      const el = document.getElementById('app');
      el.classList.toggle(event.shiftKey ? 'inspector-closed' : 'sidebar-closed');
      store.notify(['layout']);
      return;
    }
    if (mod && /^[1-9]$/.test(event.key)) {
      const modes = MODES.filter((m) => m !== 'sep' && !m.hidden);
      const mode = modes[Number(event.key) - 1];
      if (mode) {
        event.preventDefault();
        app.setMode(mode.id);
      }
      return;
    }
    if (mod || event.altKey) return;
    if (event.key === '?') {
      showHelp();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (document.activeElement?.closest?.('.plot-card') && store.ui.gateId) return; // nudging a gate
      event.preventDefault();
      app.stepSample(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (store.ui.mode === 'gate') {
      const tool = GATE_TOOL_KEYS[event.key.toLowerCase()];
      if (tool) {
        store.setUI({ tool, stickyTool: event.shiftKey && tool !== 'pointer' }, ['tool']);
        return;
      }
      if (event.key.toLowerCase() === 'b') {
        store.setUI({ backgate: !store.ui.backgate }, ['backgate']);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.ui.gateId) {
        event.preventDefault();
        app.deleteGate(store.ui.gateId);
        return;
      }
      if (event.key === 'F2' && store.ui.gateId) {
        app.renameGateInline(store.ui.gateId);
        return;
      }
      if (event.key === 'Escape') {
        closeMenu();
        if (store.ui.tool !== 'pointer') store.setUI({ tool: 'pointer', stickyTool: false }, ['tool']);
      }
    }
  });

  // --- Drag and drop ----------------------------------------------------------------------------

  const dropOverlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = await collectDropped(event.dataTransfer);
    app.importFiles(files);
  });

  // Walks dropped folders (Chromium and Safari support webkitGetAsEntry).
  async function collectDropped(transfer) {
    const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...transfer.files];
    const out = [];
    const walk = async (entry, folder) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        if (folder) Object.defineProperty(file, 'folder', { value: folder });
        out.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          for (const child of batch) if (!child.name.startsWith('.')) await walk(child, entry.name);
        } while (batch.length);
      }
    };
    for (const entry of entries) await walk(entry, null);
    return out;
  }

  // --- Store subscription ---------------------------------------------------------------------

  store.subscribe((topics) => {
    if (topics.has('ws') || topics.has('history') || topics.has('saved')) updateTitle();
    if (topics.has('ws')) {
      data.syncAll();
      autosave();
      // A selection that no longer exists (after undo or delete) falls back to its parent.
      if (store.ui.gateId && !gateById(store.ws, store.ui.gateId)) store.setUI({ gateId: null }, ['gate']);
      if (store.ui.sampleId && !store.ws.samples.some((s) => s.id === store.ui.sampleId)) store.setUI({ sampleId: store.ws.samples[0]?.id ?? null }, ['sample']);
      const present = [...store.ui.selectedSamples].filter((id) => store.ws.samples.some((s) => s.id === id));
      if (present.length !== store.ui.selectedSamples.size) store.setUI({ selectedSamples: new Set(present) }, ['selection']);
    }
    if (topics.has('tiles')) prefs.set('tileSize', store.ui.tileSize);
    app.sidebar.update(topics);
    app.inspector.update(topics);
    current?.update?.(topics);
    renderStatus();
  });

  window.addEventListener('beforeunload', (event) => {
    if (store.isDirty() && (store.ws.samples.length || store.ws.gates.length)) {
      saveNow();
      event.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  // --- Start ------------------------------------------------------------------------------------

  renderSwitcher();
  updateTitle();
  renderStatus();
  app.sidebar.render();
  app.inspector.render();
  const first = store.ws.samples.find((s) => s.role === 'sample') ?? store.ws.samples[0];
  if (first) {
    app.selectSample(first.id);
    await app.setMode('gate');
  } else {
    await app.setMode('welcome');
  }

  // Files named on the command line of the desktop program (or by a later launch), opened once
  // per program run; files already in the workspace are not read again.
  app.openStartupFiles = async (files) => {
    const opened = new Set(prefs.get(`opened:${info.session}`, []));
    const known = new Set(store.ws.samples.map((s) => s.fileName));
    const pending = files.filter((file) => ['fcs', 'workspace', 'flowjo', 'archive', 'gatingml', 'table', 'figure', 'spectroflo'].includes(file.kind) && !opened.has(file.url) && !(file.kind === 'fcs' && known.has(file.name)));
    for (const file of files) opened.add(file.url);
    prefs.set(`opened:${info.session}`, [...opened]);
    if (!pending.length) return;
    const items = [];
    for (const file of pending) {
      // FCS files stay where they are: the program copies them into the library and the worker
      // reads them in parts. Other files are small and read here.
      if (file.kind === 'fcs') {
        items.push({ file: { size: file.size }, size: file.size, name: file.name, localUrl: file.url, folder: file.folder ?? null, order: items.length });
        continue;
      }
      const response = await fetch(file.url);
      if (!response.ok) continue;
      items.push({ file: { size: file.size }, name: file.name, bytes: new Uint8Array(await response.arrayBuffer()), folder: file.folder ?? null, order: items.length });
    }
    // As for dropped files: CytoWeave workspaces first, then the FCS files, then what refers to
    // them (FlowJo workspaces match their samples, Gating-ML, tables, archives).
    const fcs = items.filter((item) => /\.(fcs|lmd)$/i.test(item.name));
    const workspaces = items.filter((item) => /\.(cwz|json)$/i.test(item.name));
    const asFile = (item) => Object.assign(new File([item.bytes], item.name), { folder: item.folder });
    for (const item of workspaces) await app.importFiles([asFile(item)]);
    if (fcs.length) await importFCSItems(fcs);
    for (const item of items.filter((i) => !fcs.includes(i) && !workspaces.includes(i))) await app.importFiles([asFile(item)]);
  };
  if (info?.files?.length) await app.openStartupFiles(info.files);
  if (app.cirro.enabled) app.cirro.resumeSignIn();
  // Programs on this computer (AI agents through "cytoweave mcp") act in this window.
  // A watched folder (cytoweave --watch, or QC → Live): files checked as they are acquired.
  app.refreshStatus = renderStatus;
  app.openLiveQC = async () => {
    if (app.qcState) app.qcState.section = 'live';
    else app.qcStartSection = 'live';
    if (store.ui.mode === 'qc') store.setUI({}, ['selection']);
    else await app.setMode('qc');
  };
  app.openCalibration = async () => {
    if (app.qcState) app.qcState.section = 'calibration';
    else app.qcStartSection = 'calibration';
    if (store.ui.mode === 'qc') store.setUI({}, ['selection']);
    else await app.setMode('qc');
  };
  installLiveQC(app, info);
  installExercises(app);
  if (info?.remoteControl) {
    const { installRemote } = await import('./ui/remote.js');
    app.remote = installRemote(app);
  }
  // A second "cytoweave <files>" launch hands its files to this window.
  if (info) {
    // The second launch also brings this window forward, so checking on focus is enough.
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== 'visible') return;
      checking = true;
      const fresh = await detectBackend();
      if (fresh?.files?.length) await app.openStartupFiles(fresh.files);
      checking = false;
    };
    window.addEventListener('focus', check);
    setInterval(check, 30000);
  }
  window.cytoweave = app;
}

// The Cirro sign-in window returns to this page; there it hands over the sign-in instead.
if (!finishCirroSignIn()) {
  start().catch((error) => {
    console.error(error);
    document.getElementById('workbench').append(h('div.empty', h('h3', 'CytoWeave could not start'), h('p', error.message)));
  });
}
