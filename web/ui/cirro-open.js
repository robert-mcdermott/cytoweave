// Open from Cirro: choose a project, then a dataset, then files in the dataset's folders, as in a
// file picker. The files open as dropped files do (FCS files as samples, a dataset's folder as a
// group, workspaces, FlowJo workspaces, annotation tables…); each sample remembers where in Cirro
// its file is, and Cirro's sample metadata annotates the samples.

import { h, icon, clear, formatBytes, relativeTime } from './dom.js';
import { showDialog, confirmDialog, toast, progressToast } from './overlays.js';
import { prefs } from './storage.js';
import { annotateSamples } from '../lib/workspace.js';
import { APP_TAG, FCS_PROCESS, folderListing, groupNames, sampleMetaByFile } from '../lib/cirro.js';

// Reading more than this asks first: every file is copied into the library.
const LARGE_SELECTION = 2 * 1024 ** 3;
const PARALLEL_DOWNLOADS = 4;

const isAnalysis = (dataset) => (dataset.tags ?? []).some((t) => t.key === APP_TAG.key && t.value === APP_TAG.value);

export function openFromCirro(app, session) {
  const crumbs = h('nav.row', { 'aria-label': 'Where in Cirro', style: { flexWrap: 'wrap', gap: '4px', marginBottom: '10px', fontSize: '12.5px' } });
  const tools = h('div.row', { style: { marginBottom: '8px' } });
  const list = h('div', { style: { maxHeight: '55vh', overflow: 'auto', minHeight: '240px' } });
  const foot = h('div.row', { style: { marginTop: '10px' } });
  const dialog = showDialog({
    title: `Open from Cirro · ${session.tenantName}`,
    width: 'wide',
    content: [crumbs, tools, list, foot],
    buttons: [],
  });

  // Where the browser is: { project, dataset, files, folder, selected (Map path → file) }.
  const at = { project: null, dataset: null, files: null, folder: '', selected: new Map() };
  const last = prefs.get('cirroLast', null);

  function renderCrumbs() {
    const parts = [{ label: 'Projects', go: showProjects }];
    if (at.project) parts.push({ label: at.project.name, go: () => showDatasets(at.project) });
    if (at.dataset) {
      parts.push({ label: at.dataset.name, go: () => showFolder('') });
      let path = '';
      for (const name of at.folder ? at.folder.split('/') : []) {
        path = path ? `${path}/${name}` : name;
        const target = path;
        parts.push({ label: name, go: () => showFolder(target) });
      }
    }
    clear(crumbs).append(...parts.flatMap((part, i) => [
      i ? h('span.muted', '›') : null,
      i === parts.length - 1 ? h('b', part.label) : h('button.btn.small.ghost', { type: 'button', onclick: part.go }, part.label),
    ]));
  }

  function loading(text) {
    clear(list).append(h('p.muted', text));
  }

  function failed(error, retry) {
    clear(list).append(h('div.callout.danger', { style: { display: 'block' } }, error.message,
      h('div.btn-row', { style: { marginTop: '8px' } }, h('button.btn.small', { type: 'button', onclick: retry }, 'Try again'))));
  }

  function searchBox(placeholder, onInput) {
    const input = h('input.input', { type: 'search', placeholder, 'aria-label': placeholder, style: { flex: 1 } });
    input.addEventListener('input', () => onInput(input.value.trim().toLowerCase()));
    setTimeout(() => input.focus(), 0);
    return input;
  }

  // --- Projects ---------------------------------------------------------------------------------

  async function showProjects() {
    Object.assign(at, { project: null, dataset: null, files: null, folder: '' });
    at.selected.clear();
    renderCrumbs();
    clear(foot);
    clear(tools);
    loading('Reading your projects…');
    let projects;
    try {
      projects = await session.projects();
    } catch (error) {
      failed(error, showProjects);
      return;
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    const body = h('tbody');
    const rows = projects.map((p) => {
      const row = h('tr', { style: { cursor: 'pointer' }, tabIndex: 0, onclick: () => showDatasets(p), onkeydown: (e) => { if (e.key === 'Enter') showDatasets(p); } },
        h('td', icon('folder'), ' ', h('b', p.name)), h('td.muted', p.description ?? ''));
      return { row, text: `${p.name} ${p.description ?? ''}`.toLowerCase() };
    });
    body.append(...rows.map((r) => r.row));
    tools.append(searchBox('Find a project', (q) => { for (const r of rows) r.row.hidden = Boolean(q) && !r.text.includes(q); }));
    clear(list).append(projects.length ? h('table.data', h('thead', h('tr', h('th', 'Project'), h('th', 'Description'))), body) : h('p.muted', 'Your Cirro account has no projects CytoWeave can see.'));
  }

  // --- Datasets ---------------------------------------------------------------------------------

  async function showDatasets(project) {
    Object.assign(at, { project, dataset: null, files: null, folder: '' });
    at.selected.clear();
    prefs.set('cirroLast', { host: session.host, projectId: project.id });
    renderCrumbs();
    clear(foot);
    clear(tools);
    loading(`Reading the datasets of ${project.name}…`);
    let datasets;
    try {
      datasets = await session.datasets(project.id);
    } catch (error) {
      failed(error, () => showDatasets(project));
      return;
    }
    if (at.project !== project || at.dataset) return;
    datasets.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const body = h('tbody');
    let query = '';
    let onlyFlow = false;
    const filter = () => {
      for (const row of body.children) row.hidden = (Boolean(query) && !row.dataset.text.includes(query)) || (onlyFlow && row.dataset.flow !== 'yes');
    };
    const flowOnly = h('label.check', h('input', { type: 'checkbox', onchange: (e) => { onlyFlow = e.target.checked; filter(); } }), 'FCS datasets and CytoWeave analyses only');
    tools.append(searchBox('Find a dataset', (q) => { query = q; filter(); }), flowOnly);
    for (const d of datasets) {
      const kind = isAnalysis(d) ? h('span.badge.accent', 'CytoWeave analysis') : d.processId === FCS_PROCESS ? h('span.badge.ok', 'FCS') : h('span.badge', { title: d.processId, style: { display: 'inline-block', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' } }, d.processId);
      const ready = d.status === 'COMPLETED';
      body.append(h('tr', {
        style: { cursor: ready ? 'pointer' : 'default' },
        tabIndex: ready ? 0 : -1,
        dataset: { text: `${d.name} ${d.description ?? ''} ${d.processId}`.toLowerCase(), flow: isAnalysis(d) || d.processId === FCS_PROCESS ? 'yes' : 'no' },
        onclick: () => ready && showDataset(d),
        onkeydown: (e) => { if (e.key === 'Enter' && ready) showDataset(d); },
      },
      h('td', icon(isAnalysis(d) ? 'library' : 'folder'), ' ', h('b', d.name), d.description ? h('div.muted', { style: { fontSize: '11.5px' } }, d.description) : null),
      h('td', kind),
      h('td', { style: { whiteSpace: 'nowrap' } }, ready ? h('span.muted', relativeTime(d.createdAt)) : h('span.badge.warn', d.status.toLowerCase()))));
    }
    clear(list).append(datasets.length ? h('table.data', h('thead', h('tr', h('th', 'Dataset'), h('th', 'Type'), h('th', 'Created'))), body) : h('p.muted', `${project.name} has no datasets.`));
  }

  // --- A dataset's folders ----------------------------------------------------------------------

  async function showDataset(dataset) {
    at.dataset = dataset;
    at.folder = '';
    at.selected.clear();
    renderCrumbs();
    clear(tools);
    loading(`Listing the files of ${dataset.name}…`);
    try {
      at.files = await session.files(at.project.id, dataset.id);
    } catch (error) {
      failed(error, () => showDataset(dataset));
      return;
    }
    if (at.dataset !== dataset) return;
    // A dataset whose files all sit in one folder opens in it.
    let folder = '';
    for (let listing = folderListing(at.files, folder); !listing.files.length && listing.folders.length === 1; listing = folderListing(at.files, folder)) folder = listing.folders[0].path;
    showFolder(folder);
  }

  function showFolder(folder) {
    at.folder = folder;
    renderCrumbs();
    const { folders, files } = folderListing(at.files, folder);
    // The files CytoWeave opens anywhere below a folder ('' for the dataset's top).
    const below = (path) => at.files.filter((f) => f.kind && (!path || f.relativePath.startsWith(`${path}/`)));
    const body = h('tbody');
    for (const sub of folders) {
      const inside = below(sub.path);
      const box = h('input', { type: 'checkbox', 'aria-label': `Select the files in ${sub.name}`, disabled: !inside.length, onclick: (e) => e.stopPropagation(), onchange: (e) => { for (const f of inside) select(f, e.target.checked); renderFoot(); } });
      box.checked = inside.length > 0 && inside.every((f) => at.selected.has(f.path));
      box.indeterminate = !box.checked && inside.some((f) => at.selected.has(f.path));
      body.append(h('tr', { style: { cursor: 'pointer' }, tabIndex: 0, onclick: () => showFolder(sub.path), onkeydown: (e) => { if (e.key === 'Enter') showFolder(sub.path); } },
        h('td', box),
        h('td', icon('folder'), ' ', h('b', sub.name)),
        h('td.muted', `${sub.files} file${sub.files === 1 ? '' : 's'}${sub.openable !== sub.files ? `, ${sub.openable} CytoWeave opens` : ''}`),
        h('td.r.muted', formatBytes(sub.size))));
    }
    for (const file of files) {
      const box = h('input', { type: 'checkbox', checked: at.selected.has(file.path), disabled: !file.kind, 'aria-label': `Select ${file.name}`, onchange: (e) => { select(file, e.target.checked); renderFoot(); } });
      body.append(h('tr', {
        style: { opacity: file.kind ? 1 : 0.5, cursor: file.kind ? 'pointer' : 'default' },
        title: file.kind ? '' : 'CytoWeave does not open this kind of file',
        onclick: (e) => { if (e.target !== box && file.kind) box.click(); },
      },
        h('td', box),
        h('td', icon('file'), ' ', file.name),
        h('td.muted', file.kind === 'fcs' ? 'FCS' : file.kind),
        h('td.r.muted', formatBytes(file.size))));
    }
    const fcs = below(folder).filter((f) => f.kind === 'fcs');
    clear(tools).append(
      fcs.length ? h('button.btn.small', { type: 'button', onclick: () => { for (const f of fcs) select(f, true); showFolder(folder); } }, icon('check'), `Select the ${fcs.length} FCS file${fcs.length === 1 ? '' : 's'}${folder ? ' here' : ''}`) : null,
      at.selected.size ? h('button.btn.small.ghost', { type: 'button', onclick: () => { at.selected.clear(); showFolder(folder); } }, 'Clear the selection') : null);
    clear(list).append(folders.length || files.length ? h('table.data', h('thead', h('tr', h('th', { style: { width: '28px' } }), h('th', 'Name'), h('th', 'Kind'), h('th.r', 'Size'))), body) : h('p.muted', 'This folder is empty.'));
    renderFoot();
  }

  function select(file, on) {
    if (on) at.selected.set(file.path, file);
    else at.selected.delete(file.path);
  }

  function renderFoot() {
    const chosen = [...at.selected.values()];
    const bytes = chosen.reduce((sum, f) => sum + (f.size ?? 0), 0);
    clear(foot).append(
      h('span.muted', chosen.length ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} selected (${formatBytes(bytes)})` : 'Select files, or a folder to take every file CytoWeave opens in it.'),
      h('span', { style: { flex: 1 } }),
      h('button.btn.primary', { type: 'button', disabled: !chosen.length, onclick: () => openSelected(chosen, bytes) }, icon('download'), 'Open'));
  }

  async function openSelected(chosen, bytes) {
    if (bytes > LARGE_SELECTION && !(await confirmDialog({ title: 'Open these files?', message: `They hold ${formatBytes(bytes)}. CytoWeave copies each into its library on this computer, so they open again without Cirro.`, confirm: 'Open' }))) return;
    dialog.close();
    await openFiles(app, session, at.project, at.dataset, chosen);
  }

  if (last?.host === session.host && last.projectId) {
    loading('Reading your projects…');
    session.projects().then((projects) => {
      const project = projects.find((p) => p.id === last.projectId);
      if (project && !at.project) showDatasets(project);
      else if (!at.project) showProjects();
    }, () => showProjects());
  } else {
    showProjects();
  }
}

// Reads the chosen files of a dataset and opens them as if they had been dropped, then annotates
// the samples from Cirro's sample metadata.
async function openFiles(app, session, project, dataset, chosen) {
  const { store } = app;
  const sameWorkspace = store.sameWorkspace();
  const groups = groupNames(chosen, dataset.name);
  const total = chosen.reduce((sum, f) => sum + (f.size ?? 0), 0) || 1;
  const received = new Map();
  const progress = progressToast(`Reading ${chosen.length} file${chosen.length === 1 ? '' : 's'} from Cirro…`);
  const files = new Array(chosen.length);
  const problems = [];
  let next = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const k = next++;
      const file = chosen[k];
      try {
        const blob = await session.download(project.id, dataset.id, file, (bytes) => {
          received.set(k, bytes);
          progress.update([...received.values()].reduce((a, b) => a + b, 0) / total, `Reading ${file.name} from Cirro`);
        });
        files[k] = Object.assign(new File([blob], file.name), { folder: groups.get(file.path), cirro: { host: session.host, projectId: project.id, datasetId: dataset.id, path: file.path } });
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_DOWNLOADS, chosen.length) }, worker));
  const read = files.filter(Boolean);
  if (!read.length) {
    progress.fail(problems[0] ?? 'No file could be read from Cirro.');
    return;
  }
  progress.done();
  for (const problem of problems.slice(0, 3)) toast(problem, { kind: 'error' });
  if (!sameWorkspace()) {
    toast('Another workspace was opened while the files were read from Cirro, so they were not added to it. Open them again.', { kind: 'error' });
    return;
  }
  await app.importFiles(read);
  if (read.some((f) => /\.(fcs|lmd)$/i.test(f.name))) await annotateFromCirro(app, session, project, dataset);
}

// Cirro's sample metadata (condition, donor, timepoint…) as annotations of the samples opened from
// this dataset, leaving fields the samples already have as they are.
async function annotateFromCirro(app, session, project, dataset) {
  const { store } = app;
  const sameWorkspace = store.sameWorkspace();
  // Reading sample metadata is an optional permission: without it, samples are simply not annotated.
  const feature = `sample-metadata:${project.id}`;
  if (session.refused.has(feature)) return;
  let byFile;
  try {
    byFile = sampleMetaByFile(await session.samples(project.id, dataset.id));
  } catch (error) {
    if (error.status === 403) session.refused.add(feature);
    else toast(`Cirro's sample metadata was not read, so the samples are not annotated from it. ${error.message}`);
    return;
  }
  if (!byFile.size || !sameWorkspace()) return;
  const changes = {};
  for (const sample of store.ws.samples) {
    if (sample.cirro?.datasetId !== dataset.id) continue;
    // By the file's own name: the samples of a file with several data sets are named "x [2].fcs".
    const fields = Object.entries(byFile.get(sample.cirro.path.split('/').pop()) ?? {}).filter(([field]) => !(field in sample.meta));
    if (fields.length) changes[sample.id] = Object.fromEntries(fields);
  }
  const count = Object.keys(changes).length;
  if (!count) return;
  store.commit(annotateSamples(store.ws, changes, `from Cirro: ${dataset.name}`), 'Annotate samples from Cirro');
  toast(`Annotated ${count} sample${count === 1 ? '' : 's'} from Cirro's sample metadata.`, { kind: 'ok' });
}
