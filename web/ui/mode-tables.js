// Tables: batch statistics across samples. A table's columns are population × statistic
// (× channel); its rows are the samples of a group. Values update as gates change.

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { showMenu, showDialog, toast, progressToast, promptDialog } from './overlays.js';
import { STATISTICS, formatStatistic } from '../lib/stats.js';
import { ROOT, channelCatalog, gateById, gatePath, setCollection } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { LIMIT_STATISTICS, LIMIT_STATUS, columnLabel, columnLimits as libColumnLimits, controlSampleOptions, delimitedText, tableControlSamples, tableMatrix, tableSamples, tableValues } from '../lib/tables.js';
import { colormapColor, hexToRgb, luminance, rgbToHex } from '../lib/colormaps.js';

export { columnLabel, controlSampleOptions, LIMIT_STATISTICS, LIMIT_STATUS };

// How a view or tool finds the events of a comparison's control sample.
export function statisticContext(app) {
  return { viewOf: (sampleId) => app.data.view(sampleId) };
}

// A column's detection limits on the loaded samples (lib/tables.js).
export function columnLimits(app, column) {
  return libColumnLimits(app.store.ws, column, (id) => app.data.view(id));
}

// Computes a table's values for the loaded samples: Map(sampleId → values[]).
export function computeTable(app, table, sampleIds) {
  return tableValues(app.store.ws, table, sampleIds, (id) => app.data.view(id));
}

export function tableRows(app, table) {
  return tableSamples(app.store.ws, table);
}

// Loads the samples tables need: their rows, controls, blanks and low-level samples.
export async function ensureTableSamples(app, tables) {
  const { store, data } = app;
  const ids = new Set();
  for (const table of tables) {
    for (const s of [...tableSamples(store.ws, table), ...tableControlSamples(store.ws, table)]) ids.add(s.id);
    for (const c of table.columns) for (const id of [...(c.limits?.blankIds ?? []), ...(c.limits?.lowIds ?? [])]) ids.add(id);
  }
  const missing = [...ids].filter((id) => !data.view(id));
  if (!missing.length) return;
  const progress = progressToast(`Computing ${missing.length} samples…`);
  let done = 0;
  for (const id of missing) {
    await data.ensure(id).catch(() => {});
    done += 1;
    progress.update(done / missing.length);
  }
  progress.done();
}

// Every table in one Excel workbook, with the sheets that say where the numbers come from.
// The workspace's tables as an Excel workbook (a Blob), with their columns, samples and gating.
export async function tablesWorkbookBlob(app) {
  const { store, data } = app;
  const tables = store.ws.tables;
  await ensureTableSamples(app, tables);
  const { tablesWorkbook } = await import('../lib/spreadsheets.js');
  const { writeXLSX } = await import('../lib/xlsx.js');
  const { sheets } = tablesWorkbook(store.ws, tables, (id) => data.view(id), { version: app.version });
  const bytes = await writeXLSX(sheets, { title: `${store.ws.name} tables` });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function exportTablesWorkbook(app) {
  const tables = app.store.ws.tables;
  if (!tables.length) {
    toast('Make a table in Tables first.');
    return;
  }
  downloadBlob(await tablesWorkbookBlob(app), `${(app.store.ws.name || 'tables').replace(/[^\w.-]+/g, '_')}.xlsx`);
  toast(`Wrote ${tables.length} table${tables.length === 1 ? '' : 's'} with their columns, samples and gating.`, { kind: 'ok' });
}

export function mountTablesMode(app, container) {
  const { store, data } = app;
  let tableId = store.ws.tables[0]?.id ?? null;
  let computing = false;

  const list = h('div');
  const builder = h('div');
  const tableHost = h('div', { style: { overflow: 'auto', maxHeight: 'calc(100vh - 230px)' } });
  const tableHead = h('h3');
  const toolbar = h('div.btn-row');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('table'), 'Tables'), h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: () => newTable() }, icon('plus'), 'New table')),
    h('div.view-body', h('div.split',
      h('div', h('div.pane', h('h3', 'Tables'), list), h('div.pane', h('h3', 'Add a column'), builder)),
      h('div.pane', { style: { minWidth: 0 } }, h('div.row', { style: { marginBottom: '10px' } }, tableHead, h('span.grow'), toolbar), tableHost))));
  container.append(root);

  function current() {
    return store.ws.tables.find((t) => t.id === tableId) ?? null;
  }

  function saveTable(table, label = 'Edit table') {
    const tables = store.ws.tables.some((t) => t.id === table.id) ? store.ws.tables.map((t) => (t.id === table.id ? table : t)) : [...store.ws.tables, table];
    store.commit(setCollection(store.ws, 'tables', tables, 'edit-table'), label, ['tables']);
  }

  function newTable(columns) {
    const ws = store.ws;
    const table = {
      id: newId('t'),
      name: `Table ${ws.tables.length + 1}`,
      groupId: store.ui.groupFilter && !store.ui.groupFilter.startsWith('role:') ? store.ui.groupFilter : null,
      columns: columns ?? ws.gates.filter((g) => g.type !== 'category').map((g) => ({ id: newId('col'), gateId: g.id, stat: 'freqParent' })),
      heatmap: true,
    };
    tableId = table.id;
    saveTable(table, 'New table');
  }

  // A one-click column set from the gating tree.
  app.addPopulationToTable = (gateId) => {
    app.setMode('tables');
    const table = current();
    const column = { id: newId('col'), gateId: gateId ?? ROOT, stat: gateId ? 'freqParent' : 'count' };
    if (!table) newTable([column]);
    else saveTable({ ...table, columns: [...table.columns, column] }, 'Add column');
  };

  function renderList() {
    clear(list);
    const ws = store.ws;
    if (!ws.tables.length) {
      list.append(h('p.muted', 'No tables yet.'), h('button.btn.primary.small', { type: 'button', onclick: () => newTable() }, icon('sparkles'), 'Table of every population (% of parent)'));
      return;
    }
    for (const table of ws.tables) {
      list.append(h(`div.tree-row${table.id === tableId ? '.selected' : ''}`, { style: { gridTemplateColumns: '18px 1fr auto' }, onclick: () => { tableId = table.id; renderAll(); } },
        icon('table'), h('span.label', table.name), h('span.count', `${table.columns.length} col`)));
    }
  }

  function renderBuilder() {
    clear(builder);
    const ws = store.ws;
    const table = current();
    if (!table) {
      builder.append(h('p.muted', 'Create a table first.'));
      return;
    }
    const popSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id, selected: g.id === store.ui.gateId }, gatePath(ws, g.id))));
    const statSelect = h('select.input.small', ...STATISTICS.map((s) => h('option', { value: s.id }, s.label)));
    const channels = channelCatalog(ws).filter((c) => c.type !== 'time');
    const channelSelect = h('select.input.small', ...channels.map((c) => h('option', { value: c.name }, c.marker ? `${c.marker} (${c.name})` : c.name)));
    const ancestorSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id }, gatePath(ws, g.id))));
    const valueInput = h('input.input.small', { type: 'number', value: 50, step: 'any' });
    const controlSelect = h('select.input.small', ...controlSampleOptions(ws).map((o) => h('option', { value: o.value }, o.label)));
    const controlPopSelect = h('select.input.small', h('option', { value: '' }, 'The same population'), h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id }, gatePath(ws, g.id))));
    const channelField = h('label.field', h('span', 'Channel'), channelSelect);
    const ancestorField = h('label.field', h('span', 'Relative to'), ancestorSelect);
    const valueField = h('label.field', h('span', 'Value (percentile or threshold)'), valueInput);
    const beadSelect = h('select.input.small', ...ws.gates.map((g) => h('option', { value: g.id, selected: /bead|count/i.test(g.name) }, gatePath(ws, g.id))));
    const beadsInput = h('input.input.small', { type: 'number', min: 0, step: 'any', placeholder: 'e.g. 50000' });
    const volumeInput = h('input.input.small', { type: 'number', min: 0, step: 'any', value: 50 });
    const metaFields = [...new Set(ws.samples.flatMap((x) => Object.keys(x.meta ?? {})))];
    const dilutionSelect = h('select.input.small', h('option', { value: 'number' }, 'The same for every sample'), ...metaFields.map((f) => h('option', { value: `field:${f}`, selected: /dilut/i.test(f) }, `From the annotation "${f}"`)));
    const dilutionInput = h('input.input.small', { type: 'number', min: 0, step: 'any', value: 1, style: { width: '90px' } });
    const countingField = h('div', h('label.field', h('span', 'Counting beads (population)'), beadSelect),
      h('div.row', { style: { gap: '8px' } }, h('label.field', h('span', 'Beads in the tube'), beadsInput), h('label.field', h('span', 'Sample in the tube (µL)'), volumeInput)),
      h('p.muted', { style: { fontSize: '11.5px', marginTop: 0 } }, 'Cells per µL = cell events ÷ bead events × beads in the tube ÷ µL of sample, times the dilution. Beads in the tube: from the lot (TruCount) or the beads per µL times the volume of beads added (CountBright).'));
    const dilutionField = h('div', h('label.field', h('span', 'Dilution factor'), dilutionSelect), dilutionInput);
    dilutionSelect.addEventListener('change', () => { dilutionInput.hidden = dilutionSelect.value !== 'number'; });
    const controlField = h('div', h('label.field', h('span', 'Control sample'), controlSelect), h('label.field', h('span', 'Control population'), controlPopSelect),
      h('p.muted', { style: { fontSize: '11.5px', marginTop: 0 } }, 'Each sample\'s population is compared with the control\'s on the channel: for example a stained sample with its FMO.'));
    const sync = () => {
      const stat = STATISTICS.find((s) => s.id === statSelect.value);
      channelField.hidden = !stat?.needsChannel;
      ancestorField.hidden = !stat?.needsAncestor;
      valueField.hidden = !stat?.needsValue;
      controlField.hidden = !stat?.needsControl;
      countingField.hidden = !stat?.needsCounting;
      dilutionField.hidden = !stat?.needsDilution;
      dilutionInput.hidden = dilutionSelect.value !== 'number';
    };
    statSelect.addEventListener('change', sync);
    sync();
    const add = (columns) => saveTable({ ...table, columns: [...table.columns, ...columns] }, 'Add column');
    builder.append(
      h('label.field', h('span', 'Population'), popSelect),
      h('label.field', h('span', 'Statistic'), statSelect),
      channelField, ancestorField, valueField, controlField, countingField, dilutionField,
      h('div.btn-row',
        h('button.btn.primary.small', {
          type: 'button',
          onclick: () => {
            const stat = STATISTICS.find((s) => s.id === statSelect.value);
            if (stat.needsControl && !controlSelect.value) {
              toast('Add a control sample first.', { kind: 'error' });
              return;
            }
            const control = stat.needsControl ? { sampleId: controlSelect.value, ...(controlPopSelect.value ? { gateId: controlPopSelect.value } : {}) } : undefined;
            let counting;
            if (stat.needsCounting) {
              counting = { beadGateId: beadSelect.value, beads: Number.parseFloat(beadsInput.value), volume: Number.parseFloat(volumeInput.value) };
              if (!counting.beadGateId || !(counting.beads > 0) || !(counting.volume > 0)) {
                toast('Choose the bead population and give the beads in the tube and the sample volume.', { kind: 'error' });
                return;
              }
            }
            const dilution = !stat.needsDilution ? undefined : dilutionSelect.value === 'number' ? (Number.parseFloat(dilutionInput.value) || 1) : { field: dilutionSelect.value.slice(6) };
            add([{ id: newId('col'), gateId: popSelect.value, stat: statSelect.value, channel: stat.needsChannel ? channelSelect.value : undefined, ancestorId: stat.needsAncestor ? ancestorSelect.value : undefined, value: stat.needsValue ? Number.parseFloat(valueInput.value) : undefined, control, counting, ...(dilution !== undefined && dilution !== 1 ? { dilution } : {}) }]);
          },
        }, icon('plus'), 'Add column'),
        h('button.btn.small', {
          type: 'button',
          title: 'Median of every fluorescence channel for this population',
          onclick: () => add(channels.filter((c) => c.type === 'fluorescence').map((c) => ({ id: newId('col'), gateId: popSelect.value, stat: 'median', channel: c.name }))),
        }, 'All medians')),
      h('div.section-title', { style: { marginTop: '14px' } }, 'Rows'),
      h('label.field', h('span', 'Samples'), h('select.input.small', {
        onchange: (event) => saveTable({ ...table, groupId: event.target.value || null }, 'Table rows'),
      }, h('option', { value: '' }, 'All samples'), ...ws.groups.map((g) => h('option', { value: g.id, selected: g.id === table.groupId }, g.name)))),
      h('label.check', h('input', { type: 'checkbox', checked: Boolean(table.includeControls), onchange: (event) => saveTable({ ...table, includeControls: event.target.checked }, 'Table rows') }), 'Include controls'));
  }

  function renderTable() {
    clear(tableHost);
    clear(toolbar);
    clear(tableHead);
    const ws = store.ws;
    const table = current();
    if (!table) {
      tableHost.append(h('div.empty', icon('table'), h('h3', 'Batch statistics'), h('p', 'A table lists statistics of populations for every sample: frequencies, counts, medians and more. Values update as you adjust gates.'), h('button.btn.primary', { type: 'button', onclick: () => newTable() }, 'Create a table of every population')));
      return;
    }
    tableHead.append(h('span', { style: { cursor: 'text' }, title: 'Rename', onclick: async () => { const name = await promptDialog({ title: 'Rename table', label: 'Name', value: table.name }); if (name) saveTable({ ...table, name }, 'Rename table'); } }, table.name));
    const rows = tableRows(app, table);
    const unloaded = [...rows, ...controlSamples(table)].filter((s) => !data.view(s.id));
    toolbar.append(
      unloaded.length ? h('button.btn.small.primary', { type: 'button', disabled: computing, onclick: () => computeAll(rows) }, icon('play'), `Compute all ${rows.length} samples`) : null,
      h('label.check', h('input', { type: 'checkbox', checked: table.heatmap !== false, onchange: (event) => saveTable({ ...table, heatmap: event.target.checked }, 'Table format') }), 'Heat map'),
      h('button.btn.small', { type: 'button', onclick: () => copyTSV(table, rows) }, icon('copy'), 'Copy'),
      h('button.btn.small', { type: 'button', onclick: () => exportCSV(table, rows) }, icon('download'), 'CSV'),
      h('button.btn.small', { type: 'button', title: 'Every table in one Excel workbook, with sheets describing the columns, the samples and their files, and the gating', onclick: () => exportWorkbook() }, icon('download'), 'Excel'),
      h('button.btn.small', { type: 'button', title: 'This table for GraphPad Prism, optionally as column tables by group', onclick: () => prismDialog(table) }, icon('download'), 'Prism…'),
      h('button.icon-button.small', { type: 'button', title: 'Delete table', onclick: () => { store.commit(setCollection(store.ws, 'tables', store.ws.tables.filter((t) => t.id !== table.id)), 'Delete table', ['tables']); tableId = store.ws.tables[0]?.id ?? null; } }, icon('trash')));
    const values = computeTable(app, table, rows.map((s) => s.id));
    // Column ranges for heat-map shading.
    const ranges = table.columns.map((_, j) => {
      let lo = Infinity; let hi = -Infinity;
      for (const row of values.values()) {
        const v = row[j];
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      return [lo, hi];
    });
    const metaFields = [...new Set(rows.flatMap((s) => Object.keys(s.meta ?? {})))].slice(0, 3);
    // Heat-map cells: the shade over the panel, with dark or white text where the theme's text would
    // fall below 4.5:1 on it.
    const dark = document.documentElement.dataset.theme === 'dark';
    const alpha = dark ? 0x88 / 255 : 0x55 / 255;
    const tokens = getComputedStyle(document.documentElement);
    const panel = hexToRgb(tokens.getPropertyValue('--panel').trim() || (dark ? '#111620' : '#ffffff'));
    const textLum = luminance(tokens.getPropertyValue('--text').trim() || (dark ? '#e7eaf1' : '#171b26'));
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const heatText = (color) => {
      const lum = luminance(rgbToHex(hexToRgb(color).map((c, i) => alpha * c + (1 - alpha) * panel[i])));
      if (ratio(textLum, lum) >= 4.5) return null;
      return ratio(0, lum) >= ratio(1, lum) ? '#000000' : '#ffffff';
    };
    // A population's confirmed Cell Ontology term, under its column's name.
    const cellType = (column) => {
      const term = column.gateId && column.gateId !== ROOT ? gateById(ws, column.gateId)?.ontology : null;
      return term?.status === 'confirmed' ? term : null;
    };
    const head = h('tr', h('th', 'Sample'), ...metaFields.map((f) => h('th', f)),
      ...table.columns.map((column) => h('th.r', { title: `${columnLabel(ws, column)}${cellType(column) ? `\nCell type: ${cellType(column).label} (${cellType(column).id})` : ''}`, style: { maxWidth: '180px' } },
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' } }, columnLabel(ws, column)),
          h('button.icon-button.small', { type: 'button', title: 'Column options', onclick: (event) => columnMenu(event.currentTarget, table, column) }, icon('chevronDown'))),
        cellType(column) ? h('div.muted', { style: { fontSize: '11px', fontWeight: 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '170px', marginLeft: 'auto' } }, cellType(column).label) : null)));
    const limitsOf = table.columns.map((column) => (column.limits ? columnLimits(app, column) : null));
    const body = h('tbody');
    for (const sample of rows) {
      const row = values.get(sample.id);
      body.append(h(`tr${sample.id === store.ui.sampleId ? '.selected' : ''}`, { onclick: () => app.selectSample(sample.id), style: { cursor: 'pointer' } },
        h('td', { style: { whiteSpace: 'nowrap' } }, sample.name),
        ...metaFields.map((f) => h('td.muted', sample.meta?.[f] ?? '')),
        ...table.columns.map((column, j) => {
          if (!row) return h('td.r.muted', '…');
          const v = row[j];
          const status = limitsOf[j] && Number.isFinite(v) ? limitsOf[j].status(sample.id, v) : null;
          const cell = h('td.r', formatStatistic(column.stat, v), status && status !== 'quantifiable'
            ? h('span.limit-tag', { title: status === 'not-detected' ? `At or below the limit of blank (${formatStatistic(column.stat, limitsOf[j].limits.lob)})` : `Above the limit of blank, below this sample's lower limit of quantification (${formatStatistic(column.stat, limitsOf[j].loqOf(sample.id))})` }, status === 'not-detected' ? 'ND' : '< LLOQ')
            : null);
          if (table.heatmap !== false && Number.isFinite(v) && ranges[j][1] > ranges[j][0]) {
            const t = (v - ranges[j][0]) / (ranges[j][1] - ranges[j][0]);
            const color = colormapColor('viridis', 0.15 + 0.8 * t);
            cell.style.background = `${color}${dark ? '88' : '55'}`;
            const text = heatText(color);
            if (text) cell.style.color = text;
          }
          return cell;
        })));
    }
    // Summary rows: mean and SD across samples.
    const summary = (label, fn) => h('tr', h('td', h('b', label)), ...metaFields.map(() => h('td')), ...table.columns.map((column, j) => {
      const vs = [...values.values()].map((row) => row[j]).filter(Number.isFinite);
      return h('td.r', h('b', vs.length ? formatStatistic(column.stat, fn(vs)) : '—'));
    }));
    const mean = (vs) => vs.reduce((a, b) => a + b, 0) / vs.length;
    const sd = (vs) => {
      const m = mean(vs);
      return Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vs.length - 1));
    };
    body.append(summary('Mean', mean), summary('SD', sd));
    tableHost.append(h('table.data', h('thead', head), body));
    if (unloaded.length) tableHost.append(h('p.muted', { style: { marginTop: '8px' } }, `${unloaded.length} sample(s) are not loaded yet (…); compute them to fill the table.`));
  }

  function columnMenu(anchor, table, column) {
    showMenu(anchor, [
      { label: 'Rename column…', icon: 'edit', onSelect: async () => { const label = await promptDialog({ title: 'Column name', label: 'Name', value: columnLabel(store.ws, column) }); if (label) saveTable({ ...table, columns: table.columns.map((c) => (c.id === column.id ? { ...c, label } : c)) }); } },
      { label: 'Compare between groups', icon: 'compare', onSelect: () => app.compareColumn?.(table, column) },
      ...(LIMIT_STATISTICS.has(column.stat) ? [{ label: column.limits ? 'Detection limits…' : 'Add detection limits…', icon: 'target', onSelect: () => limitsDialog(table, column) }] : []),
      { label: 'Move left', icon: 'chevronLeft', onSelect: () => move(table, column, -1) },
      { label: 'Move right', icon: 'chevronRight', onSelect: () => move(table, column, 1) },
      '-',
      { label: 'Remove column', icon: 'trash', danger: true, onSelect: () => saveTable({ ...table, columns: table.columns.filter((c) => c.id !== column.id) }, 'Remove column') },
    ]);
  }

  // Blank and low-level samples for a count or frequency column, and the limits they give.
  function limitsDialog(table, column) {
    const ws = store.ws;
    const current = column.limits ?? {};
    const blanks = new Set(current.blankIds ?? []);
    const lows = new Set(current.lowIds ?? []);
    const fields = [...new Set(ws.samples.flatMap((s) => Object.keys(s.meta ?? {})))];
    const method = h('select.input.small', h('option', { value: 'parametric', selected: current.method !== 'nonparametric' }, 'Mean + 1.645 SD of the blanks'), h('option', { value: 'nonparametric', selected: current.method === 'nonparametric' }, '95th percentile of the blanks'));
    const cv = h('input.input.small', { type: 'number', min: 1, max: 100, step: 1, value: current.cvTarget ?? 20, style: { width: '80px' } });
    const groupBy = h('select.input.small', h('option', { value: '' }, 'One group'), ...fields.map((f) => h('option', { value: f, selected: current.lowGroupBy === f }, f)));
    const result = h('div', { style: { marginTop: '10px' } });
    const draft = () => ({ blankIds: [...blanks], lowIds: [...lows], method: method.value, cvTarget: Number.parseFloat(cv.value) || 20, ...(groupBy.value ? { lowGroupBy: groupBy.value } : {}) });
    const list = (set) => h('div', { style: { maxHeight: '180px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '4px 8px' } },
      ...ws.samples.map((sample) => h('label.check', h('input', { type: 'checkbox', checked: set.has(sample.id), onchange: (event) => { if (event.target.checked) set.add(sample.id); else set.delete(sample.id); update(); } }), sample.name)));
    const unit = column.stat === 'count' ? ' events' : '%';
    const fmt = (v) => (Number.isFinite(v) ? `${formatStatistic(column.stat, v)}${unit}` : '—');
    const update = () => {
      clear(result);
      const chosen = [...blanks, ...lows];
      const unloaded = ws.samples.filter((sample) => chosen.includes(sample.id) && !data.view(sample.id));
      if (unloaded.length) {
        result.append(h('div.callout.accent', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('span', { style: { flex: 1 } }, `${unloaded.length} of the chosen samples are not loaded.`),
          h('button.btn.small.primary', { type: 'button', onclick: async () => { for (const sample of unloaded) await data.ensure(sample.id).catch(() => {}); update(); } }, icon('play'), 'Load them')));
      }
      if (!blanks.size) {
        result.append(h('p.muted', 'Choose the blank samples: samples with none of the population, such as healthy donors for a disease marker or FMO controls.'));
        return;
      }
      const found = columnLimits(app, { ...column, limits: draft() });
      if (!found) return;
      const { limits } = found;
      result.append(h('table.data', h('tbody',
        h('tr', h('td', 'Limit of blank (LoB)'), h('td.r', fmt(limits.lob)), h('td.muted', `${limits.blankCount} blank(s), mean ${fmt(limits.blankMean)}, SD ${fmt(limits.blankSD)}`)),
        h('tr', h('td', 'Limit of detection (LoD)'), h('td.r', fmt(limits.lod)), h('td.muted', limits.lowGroups.length ? `LoB + 1.645 × pooled SD of the low-level samples (${fmt(limits.lowSD)})` : 'Add low-level samples')),
        h('tr', h('td', 'Limit of quantification (precision profile)'), h('td.r', fmt(limits.loq)), h('td.muted', limits.lowGroups.length ? limits.lowGroups.map((g) => `${fmt(g.mean)} (CV ${formatStatistic('cv', g.cv)}%, n = ${g.n})`).join('; ') : '')),
        h('tr', h('td', 'Counting limit'), h('td.r', `${found.counted} events`), h('td.muted', `The events that give a ${limits.cvTarget}% CV by Poisson counting; a sample's LLOQ is never below them.`)))),
      limits.notes.length ? h('p.muted', { style: { fontSize: '11.5px' } }, limits.notes.join(' ')) : null);
    };
    for (const input of [method, cv, groupBy]) input.addEventListener('change', update);
    showDialog({
      title: `Detection limits: ${columnLabel(ws, column)}`,
      width: 'wide',
      content: [
        h('p.muted', { style: { marginTop: 0 } }, 'The limit of blank is the highest value expected in samples without the population; the limit of detection, the lowest true value reliably told apart from it; the lower limit of quantification (LLOQ), the lowest value measured with the CV you need (CLSI EP17; Armbruster & Pry 2008). Cells below the LoB are marked ND, cells below their LLOQ < LLOQ.'),
        h('div.split', { style: { gap: '14px' } },
          h('div', h('div.section-title', 'Blank samples'), list(blanks)),
          h('div', h('div.section-title', 'Low-level samples (optional)'), list(lows), h('label.field', h('span', 'Group replicates of a level by'), groupBy))),
        h('div.row', { style: { gap: '14px', marginTop: '8px', flexWrap: 'wrap' } }, h('label.field', h('span', 'Limit of blank'), method), h('label.field', h('span', 'Target CV (%)'), cv)),
        result,
      ],
      buttons: [
        ...(column.limits ? [{ label: 'Remove limits', ghost: true, onClick: () => saveTable({ ...table, columns: table.columns.map((c) => (c.id === column.id ? { ...c, limits: undefined } : c)) }, 'Remove detection limits') }] : []),
        { label: 'Cancel', ghost: true },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            if (!blanks.size) {
              toast('Choose at least one blank sample.', { kind: 'error' });
              return false;
            }
            saveTable({ ...table, columns: table.columns.map((c) => (c.id === column.id ? { ...c, limits: draft() } : c)) }, 'Detection limits');
            return true;
          },
        },
      ],
    });
    update();
  }

  function move(table, column, delta) {
    const columns = table.columns.slice();
    const i = columns.findIndex((c) => c.id === column.id);
    const j = i + delta;
    if (j < 0 || j >= columns.length) return;
    [columns[i], columns[j]] = [columns[j], columns[i]];
    saveTable({ ...table, columns }, 'Reorder columns');
  }

  // The control samples the table's comparison columns need, beyond its rows.
  function controlSamples(table) {
    return tableControlSamples(store.ws, table);
  }

  async function computeAll(rows) {
    rows = [...new Set([...controlSamples(current() ?? { columns: [] }), ...rows])];
    computing = true;
    const progress = progressToast(`Computing ${rows.length} samples…`);
    let done = 0;
    for (const sample of rows) {
      await data.ensure(sample.id).catch(() => {});
      done += 1;
      progress.update(done / rows.length, `Computing ${sample.name} (${done}/${rows.length})`);
      if (done % 4 === 0) renderTable();
    }
    computing = false;
    progress.done(`Computed ${rows.length} samples.`);
    renderTable();
  }

  function matrix(table, rows) {
    return tableMatrix(store.ws, table, rows, (id) => data.view(id));
  }

  function exportCSV(table, rows) {
    downloadBlob(new Blob([delimitedText(matrix(table, rows))], { type: 'text/csv' }), `${table.name.replace(/[^\w.-]+/g, '_')}.csv`);
  }

  const ensureFor = (tables) => ensureTableSamples(app, tables);
  const exportWorkbook = () => exportTablesWorkbook(app);

  function prismDialog(table) {
    const rows = tableRows(app, table);
    const fields = [...new Set(rows.flatMap((s) => Object.entries(s.meta ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k]) => k)))];
    const groupBy = h('select.input.small', h('option', { value: '' }, 'No grouping'), ...fields.map((f) => h('option', { value: f, selected: /condition|treatment|group/i.test(f) }, f)));
    showDialog({
      title: `Prism: ${table.name}`,
      content: [
        h('p.muted', { style: { marginTop: 0 } }, 'A Prism project (.pzfx) with the table as one data table: a row per sample, a column per statistic. With a grouping, each statistic also gets a column table with a column per group, its samples down it, ready for Prism\'s t tests and ANOVA.'),
        h('label.field', h('span', 'Group the samples by'), groupBy),
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Export',
          primary: true,
          onClick: async () => {
            await ensureFor([table]);
            const { prismTables } = await import('../lib/spreadsheets.js');
            const { writePZFX } = await import('../lib/pzfx.js');
            const out = prismTables(store.ws, table, (id) => data.view(id), { groupBy: groupBy.value || null });
            const text = writePZFX(out.tables, { version: app.version, project: store.ws.name, notes: `Exported from CytoWeave ${app.version ?? ''}: ${store.ws.name}, table ${table.name}.` });
            downloadBlob(new Blob([text], { type: 'application/xml' }), `${table.name.replace(/[^\w.-]+/g, '_')}.pzfx`);
            toast(`Wrote ${out.tables.length} Prism table${out.tables.length === 1 ? '' : 's'}.${out.notes.length ? ` ${out.notes.join(' ')}` : ''}`, { kind: 'ok' });
            return true;
          },
        },
      ],
    });
  }

  async function copyTSV(table, rows) {
    const text = matrix(table, rows).map((row) => row.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Table copied; paste it into a spreadsheet.', { kind: 'ok' });
    } catch {
      toast('The browser did not allow copying.', { kind: 'error' });
    }
  }

  function renderAll() {
    renderList();
    renderBuilder();
    renderTable();
  }

  renderAll();
  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('tables') || topics.has('theme') || topics.has('sample')) {
        if (!current() && store.ws.tables.length) tableId = store.ws.tables[0].id;
        renderAll();
      }
    },
    destroy() {
      root.remove();
    },
  };
}
