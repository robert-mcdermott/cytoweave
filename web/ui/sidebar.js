// The left sidebar: samples (with groups) and the population tree of the current sample.

import { h, icon, clear, iconButton, formatCount, formatPercent } from './dom.js';
import { showMenu, promptDialog, confirmDialog, showDialog, toast } from './overlays.js';
import { acceptProposal, dependentsOfProposal, describeProposal, heldChanges, openProposals, proposalOfGate, proposedChannels, rejectProposal } from '../lib/proposals.js';
import { countOf, populationSet } from '../lib/engine.js';
import {
  ROOT,
  SAMPLE_ROLES,
  addGroup,
  copyGateSubtree,
  gateById,
  gateChildren,
  removeGroup,
  removeSamples,
  setSampleCompensation,
  updateGroup,
  updateSample,
} from '../lib/workspace.js';
import { categoricalColor, shownColor } from '../lib/colormaps.js';
import { prefs } from './storage.js';

// The sample list's status dots, in words (for screen readers and on hover).
const SAMPLE_STATUS = { loaded: 'Loaded', loading: 'Loading', error: 'Could not be read', missing: 'File not in the library' };

// Drag handles: the sidebar's width, and the split between samples and populations.
function installSplitters(sidebar, samplesPanel) {
  const appEl = document.getElementById('app');
  const applyWidth = (width) => {
    const clamped = Math.max(220, Math.min(560, width));
    appEl.style.setProperty('--sidebar', `${clamped}px`);
    sidebar.classList.toggle('narrow', clamped < 270);
    return clamped;
  };
  applyWidth(prefs.get('sidebarWidth', 300));
  const resizer = h('div.side-resizer', { role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  sidebar.append(resizer);
  resizer.addEventListener('pointerdown', (event) => {
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    const move = (e) => applyWidth(e.clientX);
    const up = (e) => {
      resizer.classList.remove('dragging');
      prefs.set('sidebarWidth', applyWidth(e.clientX));
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      window.dispatchEvent(new Event('resize'));
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  const splitter = document.getElementById('sidebar-splitter');
  const applySplit = (fraction) => {
    const clamped = Math.max(0.15, Math.min(0.85, fraction));
    samplesPanel.style.flexBasis = `${(clamped * 100).toFixed(1)}%`;
    return clamped;
  };
  applySplit(prefs.get('sidebarSplit', 0.46));
  splitter.addEventListener('pointerdown', (event) => {
    splitter.setPointerCapture(event.pointerId);
    const rect = sidebar.getBoundingClientRect();
    const move = (e) => applySplit((e.clientY - rect.top) / rect.height);
    const up = (e) => {
      prefs.set('sidebarSplit', applySplit((e.clientY - rect.top) / rect.height));
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

const ROLE_LABELS = {
  sample: 'Sample',
  unstained: 'Unstained',
  'single-stain': 'Single stain',
  fmo: 'FMO',
  isotype: 'Isotype',
  bead: 'Beads',
  reference: 'Reference',
};

export function mountSidebar(app) {
  const { store, data } = app;
  const samplesPanel = document.getElementById('samples-panel');
  const populationsPanel = document.getElementById('populations-panel');
  installSplitters(document.getElementById('sidebar'), samplesPanel);
  let lastClicked = null;

  // --- Samples ---------------------------------------------------------------------------------

  const sampleCount = h('span.badge');
  const samplesHead = h('div.panel-head',
    h('h2', 'Samples', sampleCount),
    iconButton('plus', 'Add FCS files…', (e) => addMenu(e.currentTarget), { class: 'small' }),
    iconButton('more', 'Sample actions', (e) => sampleActions(e.currentTarget), { class: 'small' }));
  const chips = h('div.group-chips');
  const sampleBody = h('div.panel-body');
  samplesPanel.append(samplesHead, chips, sampleBody);

  function addMenu(anchor) {
    showMenu(anchor, [
      { label: 'Add FCS files…', icon: 'file', hint: `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}O`, onSelect: () => app.pickFiles() },
      { label: 'Add a folder of FCS files…', icon: 'folder', onSelect: () => app.pickFolder() },
      ...(app.cirro.enabled ? [{ label: 'Open from Cirro…', icon: 'globe', onSelect: () => app.cirro.open() }] : []),
      '-',
      { label: 'Open an example experiment…', icon: 'flask', onSelect: () => app.showExamples() },
      { label: 'Import a FlowJo workspace or Gating-ML…', icon: 'upload', onSelect: () => app.pickFiles('.wsp,.wspt,.flowjo,.xml') },
    ]);
  }

  function selectedIds() {
    const set = store.ui.selectedSamples;
    if (set.size) return [...set];
    return store.ui.sampleId ? [store.ui.sampleId] : [];
  }

  function sampleActions(anchor) {
    const ids = selectedIds();
    const ws = store.ws;
    const items = [
      { section: `${ids.length} selected` },
      { label: 'New group from selection…', icon: 'layers', disabled: !ids.length, onSelect: () => newGroup(ids) },
      { label: 'Add selection to group', icon: 'plus', disabled: !ids.length || !ws.groups.length, onSelect: () => addToGroupMenu(anchor, ids) },
      { label: 'Annotate selection…', icon: 'tag', disabled: !ids.length, onSelect: () => app.annotateSamples(ids) },
      { label: 'Set role', icon: 'flask', disabled: !ids.length, onSelect: () => roleMenu(anchor, ids) },
      { label: 'Compensation', icon: 'compensate', disabled: !ids.length, onSelect: () => compensationMenu(anchor, ids) },
      '-',
      { label: 'Select all in view', icon: 'check', onSelect: () => store.setUI({ selectedSamples: new Set(visibleSamples().map((s) => s.id)) }, ['selection']) },
      { label: 'Clear selection', icon: 'close', disabled: !store.ui.selectedSamples.size, onSelect: () => store.setUI({ selectedSamples: new Set() }, ['selection']) },
      { label: 'Load every sample', icon: 'download', onSelect: () => app.loadAll() },
      '-',
      { label: 'Remove selection from workspace', icon: 'trash', danger: true, disabled: !ids.length, onSelect: () => removeSelected(ids) },
    ];
    showMenu(anchor, items);
  }

  async function newGroup(ids) {
    const name = await promptDialog({ title: 'New group', label: 'Group name', value: `Group ${store.ws.groups.length + 1}`, confirm: 'Create' });
    if (!name) return;
    const result = addGroup(store.ws, name, ids);
    store.commit(result.ws, `Create group ${name}`);
    store.setUI({ groupFilter: result.group.id }, ['selection']);
  }

  function addToGroupMenu(anchor, ids) {
    showMenu(anchor, store.ws.groups.map((group) => ({
      label: group.name,
      swatch: shownColor(store.ws, group, 'groups'),
      onSelect: () => store.commit(updateGroup(store.ws, group.id, { sampleIds: [...new Set([...group.sampleIds, ...ids])] }), `Add to ${group.name}`),
    })));
  }

  function roleMenu(anchor, ids) {
    showMenu(anchor, SAMPLE_ROLES.map((role) => ({
      label: ROLE_LABELS[role],
      onSelect: () => {
        let next = store.ws;
        for (const id of ids) next = updateSample(next, id, { role });
        store.commit(next, `Set role ${ROLE_LABELS[role]}`);
      },
    })));
  }

  function compensationMenu(anchor, ids) {
    const ws = store.ws;
    const items = [
      { label: 'From the file ($SPILLOVER)', onSelect: () => store.commit(setSampleCompensation(ws, ids, 'file'), 'Use file compensation') },
      { label: 'None (uncompensated)', onSelect: () => store.commit(setSampleCompensation(ws, ids, 'none'), 'Remove compensation') },
      ...(ws.compensations.length ? ['-'] : []),
      ...ws.compensations.map((comp) => ({ label: comp.name, hint: comp.source, onSelect: () => store.commit(setSampleCompensation(ws, ids, comp.id), `Apply ${comp.name}`) })),
    ];
    showMenu(anchor, items);
  }

  async function removeSelected(ids) {
    const ok = await confirmDialog({ title: 'Remove samples', message: `Remove ${ids.length} sample(s) from this workspace? The FCS files stay in the library, and you can undo this.`, confirm: 'Remove', danger: true });
    if (!ok) return;
    store.commit(removeSamples(store.ws, ids), `Remove ${ids.length} sample(s)`);
    if (ids.includes(store.ui.sampleId)) app.selectSample(store.ws.samples[0]?.id ?? null);
    store.setUI({ selectedSamples: new Set() }, ['selection']);
  }

  function visibleSamples() {
    const ws = store.ws;
    const filter = store.ui.groupFilter;
    if (!filter) return ws.samples;
    if (filter.startsWith('role:')) return ws.samples.filter((s) => s.role === filter.slice(5));
    const group = ws.groups.find((g) => g.id === filter);
    return group ? ws.samples.filter((s) => group.sampleIds.includes(s.id)) : ws.samples;
  }

  function renderChips() {
    const ws = store.ws;
    clear(chips);
    const chip = (label, count, id, color) => h(`button.chip${store.ui.groupFilter === id ? '.active' : ''}`, {
      type: 'button',
      onclick: () => store.setUI({ groupFilter: store.ui.groupFilter === id ? null : id }, ['selection']),
      oncontextmenu: (event) => {
        if (!id || id.startsWith('role:')) return;
        event.preventDefault();
        groupMenu({ x: event.clientX, y: event.clientY }, id);
      },
    }, color ? h('span.swatch', { style: { background: color } }) : null, label, h('span.count', String(count)));
    chips.append(chip('All', ws.samples.length, null));
    for (const group of ws.groups) chips.append(chip(group.name, group.sampleIds.length, group.id, shownColor(ws, group, 'groups')));
    const controls = ws.samples.filter((s) => s.role !== 'sample').length;
    if (controls) chips.append(chip('Controls', controls, 'role:single-stain'));
  }

  function groupMenu(point, id) {
    const group = store.ws.groups.find((g) => g.id === id);
    if (!group) return;
    showMenu(point, [
      { label: 'Rename…', icon: 'edit', onSelect: async () => {
        const name = await promptDialog({ title: 'Rename group', label: 'Name', value: group.name });
        if (name) store.commit(updateGroup(store.ws, id, { name }), `Rename group ${name}`);
      } },
      { label: 'Recolor', icon: 'tag', onSelect: () => store.commit(updateGroup(store.ws, id, { color: categoricalColor(Math.floor(Math.random() * 20)) }), 'Recolor group') },
      { label: 'Remove selected samples from group', icon: 'minus', disabled: !store.ui.selectedSamples.size, onSelect: () => store.commit(updateGroup(store.ws, id, { sampleIds: group.sampleIds.filter((s) => !store.ui.selectedSamples.has(s)) }), 'Remove from group') },
      '-',
      { label: 'Delete group', icon: 'trash', danger: true, onSelect: () => store.commit(removeGroup(store.ws, id), `Delete group ${group.name}`) },
    ]);
  }

  function renderSamples() {
    const ws = store.ws;
    sampleCount.textContent = String(ws.samples.length);
    renderChips();
    const hadFocus = sampleBody.contains(document.activeElement);
    clear(sampleBody);
    if (!ws.samples.length) {
      sampleBody.append(h('div.drop-hint', { onclick: () => app.pickFiles() }, icon('upload'), h('div', 'Drop FCS files here or click to add them'), h('div.muted', 'or open an example from the welcome page')));
      return;
    }
    // One stop for the keyboard: ↑ ↓ move between samples (the app's shortcut), the selected one
    // announced as the active option.
    const list = h('ul.sample-list', { role: 'listbox', 'aria-label': 'Samples', tabIndex: 0 });
    const gateId = store.ui.gateId;
    const gate = gateId ? gateById(ws, gateId) : null;
    for (const sample of visibleSamples()) {
      const status = data.statusOf(sample.id);
      let freq = '';
      if (gate) {
        const view = data.view(sample.id);
        if (view) {
          try {
            const indices = populationSet(view, ws, gate.id);
            const parent = populationSet(view, ws, gate.parentId ?? ROOT);
            if (indices !== undefined && parent !== undefined) freq = formatPercent((100 * countOf(indices, view)) / (countOf(parent, view) || 1));
          } catch { /* channel missing */ }
        }
      }
      const groups = ws.groups.filter((g) => g.sampleIds.includes(sample.id));
      const meta = [sample.meta?.condition, sample.meta?.subject, sample.meta?.batch && `batch ${sample.meta.batch}`].filter(Boolean).join(' · ');
      const item = h(`li.sample-item${sample.id === store.ui.sampleId ? '.selected' : ''}${store.ui.selectedSamples.has(sample.id) ? '.multi' : ''}`, {
        id: `sample-option-${sample.id}`,
        'aria-selected': String(sample.id === store.ui.sampleId),
        role: 'option',
        title: `${sample.fileName}\n${formatCount(sample.eventCount)} events · ${sample.fcsVersion}${data.errors.get(sample.id) ? `\n${data.errors.get(sample.id)}` : ''}`,
        dataset: { id: sample.id },
        onclick: (event) => clickSample(event, sample.id),
        oncontextmenu: (event) => {
          event.preventDefault();
          if (!store.ui.selectedSamples.has(sample.id)) store.setUI({ selectedSamples: new Set([sample.id]) }, ['selection']);
          sampleActions({ getBoundingClientRect: () => ({ left: event.clientX, bottom: event.clientY, top: event.clientY, right: event.clientX }) });
        },
      },
      h(`span.status.${status}`, { role: 'img', 'aria-label': SAMPLE_STATUS[status] ?? 'Not loaded', title: SAMPLE_STATUS[status] ?? 'Not loaded' }),
      h('div', { style: { minWidth: 0 } },
        h('div.name', sample.name),
        h('div.sub',
          h('span', formatCount(sample.eventCount)),
          sample.role !== 'sample' ? h('span.badge', ROLE_LABELS[sample.role] ?? sample.role) : null,
          meta ? h('span', meta) : null,
          ...groups.slice(0, 2).map((g) => h('span.swatch', { style: { background: shownColor(store.ws, g, 'groups') }, title: g.name })))),
      h('div.right.num', freq));
      list.append(item);
    }
    sampleBody.append(list);
    sampleBody.querySelector('.sample-item.selected')?.scrollIntoView({ block: 'nearest' });
    if (store.ui.sampleId) list.setAttribute('aria-activedescendant', `sample-option-${store.ui.sampleId}`);
    if (hadFocus) list.focus({ preventScroll: true });
  }

  function clickSample(event, id) {
    const ids = visibleSamples().map((s) => s.id);
    if (event.metaKey || event.ctrlKey) {
      const set = new Set(store.ui.selectedSamples);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      lastClicked = id;
      store.setUI({ selectedSamples: set }, ['selection']);
      return;
    }
    if (event.shiftKey && lastClicked) {
      const a = ids.indexOf(lastClicked);
      const b = ids.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      store.setUI({ selectedSamples: new Set(ids.slice(lo, hi + 1)) }, ['selection']);
      return;
    }
    lastClicked = id;
    store.setUI({ selectedSamples: new Set() }, ['selection']);
    app.selectSample(id);
  }

  // --- Populations -----------------------------------------------------------------------------

  const popBody = h('div.panel-body');
  const popHead = h('div.panel-head',
    h('h2', 'Populations'),
    iconButton('backgate', 'Backgate the selected population on its ancestors (B)', () => store.setUI({ backgate: !store.ui.backgate }, ['backgate']), { class: 'small' }),
    iconButton('more', 'Population actions', (e) => app.gateMenu(store.ui.gateId, e.currentTarget, store.ui.sampleId), { class: 'small' }));
  populationsPanel.append(popHead, popBody);

  function renderPopulations() {
    const ws = store.ws;
    popHead.querySelector('[title^="Backgate"]').classList.toggle('active', store.ui.backgate);
    const hadFocus = popBody.contains(document.activeElement);
    clear(popBody);
    const sampleId = store.ui.sampleId;
    const view = sampleId ? data.view(sampleId) : null;
    for (const proposal of openProposals(ws)) popBody.append(proposalStrip(ws, proposal, view));
    // A tree with one focusable row (the selected one): ↑ ↓ move, → expands or goes to the first
    // child, ← collapses or goes to the parent, Home and End go to the ends (WAI-ARIA tree pattern).
    const tree = h('ul.tree', { role: 'tree', 'aria-label': 'Populations', onkeydown: (event) => treeKeys(event, tree) });
    const rootRow = row({ id: null, name: 'All events', color: '#94a3b8' }, view, 0, ws);
    tree.append(rootRow);
    popBody.append(tree);
    if (hadFocus) tree.querySelector('[role="treeitem"][tabindex="0"]')?.focus();
    if (!ws.gates.length) {
      popBody.append(h('div.empty', { style: { padding: '16px 8px' } },
        h('p', 'No gates yet. Pick a drawing tool above a plot (R rectangle, P polygon, E ellipse, Q quadrant, W magic wand) and draw on the plot.')));
    }
  }

  function treeKeys(event, tree) {
    const rows = [...tree.querySelectorAll('[role="treeitem"]')];
    const current = event.target.closest?.('[role="treeitem"]');
    const at = rows.indexOf(current);
    if (at < 0) return;
    const select = (el) => {
      if (!el) return;
      const id = el.dataset.gate || null;
      app.selectGate(id);
    };
    const id = current.dataset.gate || null;
    const expanded = current.getAttribute('aria-expanded');
    const toggle = (open) => {
      const collapsed = new Set(store.ui.collapsed ?? []);
      if (open) collapsed.delete(id);
      else collapsed.add(id);
      store.setUI({ collapsed }, ['tree']);
    };
    switch (event.key) {
      case 'ArrowDown': select(rows[at + 1]); break;
      case 'ArrowUp': select(rows[at - 1]); break;
      case 'Home': select(rows[0]); break;
      case 'End': select(rows[rows.length - 1]); break;
      case 'ArrowRight':
        if (expanded === 'false') toggle(true);
        else if (expanded === 'true') select(rows[at + 1]);
        break;
      case 'ArrowLeft':
        if (expanded === 'true') toggle(false);
        else select(current.parentElement?.parentElement?.closest('li')?.querySelector(':scope > [role="treeitem"]'));
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  // --- Proposals from agents ---------------------------------------------------------------------

  function proposalStrip(ws, proposal, view) {
    const items = describeProposal(ws, proposal);
    const count = items.length;
    return h('div.proposal-strip', { role: 'region', 'aria-label': `Proposal from ${proposal.author}` },
      h('div.proposal-title', icon('sparkles'), h('span', h('strong', proposal.author), count ? ` proposes ${count} change${count === 1 ? '' : 's'}` : ' has nothing left to review')),
      h('div.btn-row',
        h('button.btn.small', { type: 'button', onclick: () => reviewProposal(proposal.id) }, 'Review'),
        h('button.btn.small.primary', { type: 'button', onclick: () => accept(proposal.id) }, 'Accept all'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => reject(proposal.id) }, 'Reject all')));
  }

  function accept(id) {
    const proposal = openProposals(store.ws).find((p) => p.id === id);
    if (!proposal) return;
    store.commit(acceptProposal(store.ws, id), `Accept the proposal from ${proposal.author}`);
    toast(`Accepted the proposal from ${proposal.author}.`, { kind: 'ok' });
  }

  async function reject(id) {
    const proposal = openProposals(store.ws).find((p) => p.id === id);
    if (!proposal) return;
    const drawn = dependentsOfProposal(store.ws, id);
    if (drawn.length && !(await confirmDialog({ title: 'Reject the proposal?', message: `Rejecting removes the proposed gates and results, and with them ${drawn.length} population${drawn.length === 1 ? '' : 's'} drawn on them since: ${drawn.slice(0, 6).map((g) => g.name).join(', ')}${drawn.length > 6 ? '…' : ''}.`, confirm: 'Reject', danger: true }))) return;
    const channels = proposedChannels(store.ws, id);
    store.commit(rejectProposal(store.ws, id), `Reject the proposal from ${proposal.author}`);
    // Detach the rejected results' channels that no remaining result provides.
    const kept = new Set(store.ws.derived.flatMap((d) => d.outputs ?? []));
    for (const channel of channels) if (!kept.has(channel)) data.removeDerived(channel);
    toast(`Rejected the proposal from ${proposal.author}.`);
  }

  function reviewProposal(id) {
    const ws = store.ws;
    const proposal = openProposals(ws).find((p) => p.id === id);
    if (!proposal) return;
    const view = store.ui.sampleId ? data.view(store.ui.sampleId) : null;
    const sample = ws.samples.find((s) => s.id === store.ui.sampleId);
    const frequency = (gateId) => {
      if (!view) return '';
      try {
        const gate = gateById(ws, gateId);
        const members = populationSet(view, ws, gateId);
        if (!gate || members === undefined) return '';
        return `${formatPercent((100 * countOf(members, view)) / (countOf(populationSet(view, ws, gate.parentId ?? ROOT), view) || 1))} of parent`;
      } catch {
        return '';
      }
    };
    const list = h('ul.proposal-items', ...describeProposal(ws, proposal).map((item) => h(`li.${item.kind}`,
      h('span', item.text),
      item.kind === 'add' ? h('span.muted', frequency(item.gateId)) : null,
      item.gateId && gateById(ws, item.gateId) ? h('button.btn.small.ghost', { type: 'button', onclick: () => { app.selectGate(item.gateId); dialog.close(); } }, 'Show') : null)));
    const content = h('div',
      h('p.muted', `Proposed by ${proposal.author}, ${new Date(proposal.opened).toLocaleString()}. New gates, results and figures are already in the workspace, marked as proposed; the other changes apply only if you accept. The change log records your decision.${sample ? ` Frequencies are for ${sample.name}.` : ''}`),
      list);
    const dialog = showDialog({
      title: 'Review the proposal',
      content,
      buttons: [
        { label: 'Reject all', danger: true, onClick: () => { reject(id); } },
        { label: 'Close', ghost: true },
        { label: 'Accept all', primary: true, onClick: () => accept(id) },
      ],
    });
  }

  function row(gate, view, depth, ws) {
    const id = gate.id;
    // Helper gates (the shapes behind imported "outside" populations) are not shown.
    const children = gateChildren(ws, id).filter((g) => !g.meta?.helper);
    const expanded = id === null || store.ui.expanded.has(id) || !store.ui.collapsed?.has(id);
    let count = Number.NaN;
    let freq = Number.NaN;
    let applies = true;
    if (view) {
      try {
        const indices = populationSet(view, ws, id ?? ROOT);
        if (indices === undefined) applies = false;
        else {
          count = countOf(indices, view);
          const parent = id ? populationSet(view, ws, gate.parentId ?? ROOT) : null;
          freq = id ? (100 * count) / (countOf(parent, view) || 1) : 100;
        }
      } catch {
        applies = false;
      }
    }
    const selected = (store.ui.gateId ?? null) === id;
    const overridden = id && gate.overrides?.[store.ui.sampleId];
    const twisty = h(`button.twisty${expanded ? '.open' : ''}`, {
      type: 'button',
      tabIndex: -1,
      'aria-label': expanded ? `Collapse ${gate.name}` : `Expand ${gate.name}`,
      style: { visibility: children.length ? 'visible' : 'hidden' },
      onclick: (event) => {
        event.stopPropagation();
        const collapsed = new Set(store.ui.collapsed ?? []);
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        store.setUI({ collapsed }, ['tree']);
      },
    }, icon('chevronRight'));
    // Markers sit outside the name so a long name truncates before they do.
    const label = h('span.label', { title: gate.name }, gate.name);
    const proposed = id ? proposalOfGate(ws, gate) : null;
    const held = id ? heldChanges(ws, id) : [];
    const removal = held.find((x) => x.change.kind === 'remove-gate');
    const rename = held.find((x) => x.change.kind === 'edit-gate' && x.change.patch.name && x.change.patch.name !== gate.name);
    const origin = gate.meta?.proposedBy ? `Proposed by ${gate.meta.proposedBy}${gate.meta.acceptedBy ? `, accepted by ${gate.meta.acceptedBy}` : ''}` : 'Added by an AI agent';
    const marks = h('span.marks',
      overridden ? h('span.flag', { title: 'Adjusted for this sample' }) : null,
      proposed ? h('span.badge.accent.proposal-mark', { title: `${origin}; waiting for your review` }, 'proposed') : null,
      rename ? h('span.badge.proposal-mark', { title: `${rename.proposal.author} proposes renaming it to ${rename.change.patch.name}` }, `→ ${rename.change.patch.name}`) : null,
      removal ? h('span.badge.danger.proposal-mark', { title: `${removal.proposal.author} proposes deleting it` }, 'delete?') : null,
      gate.meta?.origin === 'auto' ? h('span.auto-mark', { title: `Proposed automatically${gate.meta.note ? `: ${gate.meta.note}` : ''}` }, icon('sparkles')) : null,
      gate.meta?.origin === 'agent' && !proposed ? h('span.auto-mark', { title: origin }, icon('sparkles')) : null);
    const rowEl = h(`div.tree-row${selected ? '.selected' : ''}${applies ? '' : '.inapplicable'}${proposed ? '.proposed' : ''}${removal ? '.pending-removal' : ''}`, {
      role: 'treeitem',
      tabIndex: selected ? 0 : -1,
      'aria-selected': String(selected),
      'aria-level': String(depth + 1),
      ...(children.length ? { 'aria-expanded': String(Boolean(expanded)) } : {}),
      'aria-label': `${gate.name}${Number.isFinite(freq) && id ? `, ${formatPercent(freq)} of parent` : ''}${Number.isFinite(count) ? `, ${formatCount(count)} events` : ''}${proposed ? ', proposed' : ''}`,
      dataset: { gate: id ?? '' },
      draggable: Boolean(id),
      title: applies ? '' : 'This gate does not apply to the current sample (its group scope excludes it).',
      onclick: () => app.selectGate(id),
      ondblclick: () => id && app.renameGateInline(id, rowEl),
      oncontextmenu: (event) => {
        event.preventDefault();
        app.gateMenu(id, { x: event.clientX, y: event.clientY }, store.ui.sampleId);
      },
      ondragstart: (event) => {
        event.dataTransfer.setData('application/x-cytoweave-gate', id);
        event.dataTransfer.effectAllowed = 'copy';
      },
      ondragover: (event) => {
        if (event.dataTransfer.types.includes('application/x-cytoweave-gate')) {
          event.preventDefault();
          rowEl.classList.add('drop-target');
        }
      },
      ondragleave: () => rowEl.classList.remove('drop-target'),
      ondrop: (event) => {
        rowEl.classList.remove('drop-target');
        const source = event.dataTransfer.getData('application/x-cytoweave-gate');
        if (!source || source === id) return;
        event.preventDefault();
        const sourceGate = gateById(store.ws, source);
        const result = copyGateSubtree(store.ws, source, id ?? ROOT);
        store.commit(result.ws, `Copy ${sourceGate?.name ?? 'gates'} to ${gate.name}`);
        toast(`Copied ${sourceGate?.name} (and its subpopulations) under ${gate.name}.`, { kind: 'ok' });
      },
    },
    twisty,
    h('span.swatch', { style: { background: shownColor(store.ws, gate) ?? '#94a3b8' } }),
    label,
    marks,
    h('span.freq', Number.isFinite(freq) && id ? formatPercent(freq) : ''),
    h('span.count', Number.isFinite(count) ? formatCount(count) : ''));
    const li = h('li', { role: 'none' }, rowEl);
    if (children.length && expanded) {
      const sub = h('ul.tree', { role: 'group' });
      for (const child of children) sub.append(row(child, view, depth + 1, ws));
      li.append(sub);
    }
    return li;
  }

  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('selection') || topics.has('sample') || topics.has('gate') || topics.has('colors')) renderSamples();
      if (topics.has('ws') || topics.has('data') || topics.has('sample') || topics.has('gate') || topics.has('tree') || topics.has('backgate') || topics.has('colors')) renderPopulations();
    },
    visibleSamples,
    render() {
      renderSamples();
      renderPopulations();
    },
  };
}
