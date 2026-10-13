// The welcome page: start from files, an example experiment or a saved workspace.

import { h, icon, clear, relativeTime, formatBytes } from './dom.js';
import { prefs } from './storage.js';

const FEATURES = [
  ['gate', 'Fast, precise gating', 'Rectangle, polygon, ellipse, quadrant, range, split, freehand and magic-wand gates with live statistics while you drag.'],
  ['target', 'Gate robustness and cohort review', 'See how much a frequency depends on where a boundary was drawn, and review a gate across every sample, outliers first.'],
  ['compensate', 'Compensation you can trust', 'Spillover from controls by median or robust regression, the spillover spreading matrix, and detection of leaning populations.'],
  ['spectral', 'Open spectral unmixing', 'Reference spectra, similarity and complexity, OLS, weighted and non-negative unmixing, and multiple autofluorescence signatures.'],
  ['explore', 'High-dimensional analysis', 'UMAP, t-SNE, FlowSOM and Leiden clustering with an honesty report on every embedding.'],
  ['qc', 'Quality control', 'PeacoQC-style acquisition cleaning, flow-rate checks and saturation, as reversible masks with explanations.'],
  ['compare', 'Statistics that respect the design', 'Per-sample comparisons with paired and nonparametric tests, effect sizes, multiple-testing correction and differential abundance.'],
  ['history', 'Reproducible by construction', 'Every edit is recorded; undo anything, keep provenance, export Gating-ML and a methods paragraph.'],
  ['lock', 'Private and local', 'Files are read on this computer, and uploaded only when you save them to Cirro. Free and open source (Apache-2.0).'],
];

export function mountWelcome(app, container) {
  const { library } = app;
  const recent = h('div.welcome-grid');
  const examples = h('div.welcome-grid');
  const root = h('div.workbench-scroll', h('div.welcome',
    h('div.welcome-hero',
      h('div', { style: { flex: 1 } },
        h('h1', 'Flow cytometry analysis, ', h('span.weave-text', 'woven together.')),
        h('p', 'CytoWeave brings gating, compensation, spectral unmixing, quality control, high-dimensional analysis, statistics and publication figures into one fast, open workbench that keeps every step reproducible.'),
        h('div.btn-row',
          h('button.btn.primary', { type: 'button', onclick: () => app.pickFiles() }, icon('file'), 'Add FCS files'),
          h('button.btn', { type: 'button', onclick: () => app.pickFolder() }, icon('folder'), 'Open a folder'),
          app.cirro.enabled ? h('button.btn', { type: 'button', onclick: () => app.cirro.open() }, icon('globe'), 'Open from Cirro') : null,
          h('button.btn', { type: 'button', onclick: () => app.pickFiles('.cwz,.json,.wsp,.wspt,.flowjo,.xml,.acs,.zip') }, icon('upload'), 'Import a workspace'),
          h('span.muted', { style: { marginLeft: '6px' } }, 'or drop files anywhere'))),
      h('img', { src: 'favicon.svg', width: 132, height: 132, alt: '', style: { filter: 'drop-shadow(0 18px 40px rgba(91,76,230,0.35))' } })),
    h('div.section-title', 'Recent workspaces'),
    recent,
    h('div.section-title', { style: { marginTop: '22px' } }, 'Example experiments'),
    examples,
    h('div.welcome-learn',
      h('span.glyph', icon('school')),
      h('div', h('b', 'Learning flow cytometry analysis?'), h('span', ' Exercises on the examples ask a question, let you answer it with CytoWeave\'s views, then check your answer against the simulator\'s truth.')),
      h('button.btn', { type: 'button', onclick: () => app.showExercises?.() }, 'Exercises')),
    h('div.section-title', { style: { marginTop: '22px' } }, 'What CytoWeave does'),
    h('div.feature-list', ...FEATURES.map(([glyph, title, text]) => h('div.feature', h('span.glyph', icon(glyph)), h('div', h('b', title), h('span', text)))))));
  container.append(root);

  async function loadRecent() {
    clear(recent);
    let list = [];
    try {
      list = await library.listWorkspaces();
    } catch { /* none */ }
    if (!list.length) {
      recent.append(h('div.card', h('p.muted', `No saved workspaces yet. Workspaces save automatically to ${library.kind === 'desktop' ? `the library folder (${library.location})` : 'this browser'}.`)));
      return;
    }
    const last = prefs.get('lastWorkspace', null);
    for (const item of list.slice(0, 8)) {
      recent.append(h('div.card.clickable', { onclick: () => app.openWorkspace(item.id) },
        h('h4', icon('library'), item.name || 'Untitled workspace', item.id === last ? h('span.badge.accent', { style: { marginLeft: '6px' } }, 'Last opened') : null),
        h('p', `${item.samples ?? 0} samples · ${relativeTime(item.modified)}${item.size ? ` · ${formatBytes(item.size)}` : ''}`)));
    }
  }

  async function loadExamples() {
    clear(examples);
    try {
      const { EXAMPLES } = await import('../lib/examples.js');
      for (const example of EXAMPLES) {
        examples.append(h('div.card.clickable', { onclick: () => app.openExample(example.id) },
          h('h4', icon(example.technology === 'spectral' ? 'spectral' : example.technology === 'mass' ? 'explore' : example.id.includes('cycle') ? 'dna' : example.id.includes('qc') ? 'qc' : 'flask'), example.title),
          h('p', example.description),
          h('div.tags', ...(example.tags ?? []).slice(0, 4).map((tag) => h('span.badge', tag)))));
      }
    } catch {
      examples.append(h('div.card', h('p.muted', 'Example experiments are not available in this build.')));
    }
  }

  loadRecent();
  loadExamples();
  return {
    update(topics) {
      if (topics.has('library')) loadRecent();
    },
    destroy() {
      root.remove();
    },
  };
}
