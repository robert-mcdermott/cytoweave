// A methods paragraph, references and a MIFlowCyt checklist, written from what the workspace
// actually contains: the instruments in the files' keywords, the compensation and scales used,
// the gating hierarchy, and every recorded analysis with its parameters.

export const REFERENCES = {
  cytoweave: { text: 'CytoWeave: open-source flow cytometry analysis. https://github.com/robert-mcdermott/cytoweave', doi: null },
  fcs31: { text: 'Spidlen J, Moore W, Parks D, et al. Data File Standard for Flow Cytometry, version FCS 3.1. Cytometry A. 2010;77(1):97–100.', doi: '10.1002/cyto.a.20825' },
  logicle: { text: 'Parks DR, Roederer M, Moore WA. A new "Logicle" display method avoids deceptive effects of logarithmic scaling for low signals and compensated data. Cytometry A. 2006;69(6):541–551.', doi: '10.1002/cyto.a.20258' },
  logicleAlgorithm: { text: 'Moore WA, Parks DR. Update for the logicle data scale including operational code implementations. Cytometry A. 2012;81(4):273–277.', doi: '10.1002/cyto.a.22030' },
  cellOntology: { text: 'Diehl AD, Meehan TF, Bradford YM, et al. The Cell Ontology 2016: enhanced content, modularization, and ontology interoperability. J Biomed Semantics. 2016;7:44.', doi: '10.1186/s13326-016-0088-7' },
  gatingml: { text: 'Spidlen J, Moore W, Brinkman RR, et al. ISAC\'s Gating-ML 2.0 data exchange standard for gating description. Cytometry A. 2015;87(7):683–687.', doi: '10.1002/cyto.a.22690' },
  ssm: { text: 'Nguyen R, Perfetto S, Mahnke YD, Chattopadhyay P, Roederer M. Quantifying spillover spreading for comparing instrument performance and aiding in multicolor panel design. Cytometry A. 2013;83(3):306–315.', doi: '10.1002/cyto.a.22251' },
  autospill: { text: 'Roca CP, Burton OT, Gergelits V, et al. AutoSpill is a principled framework that simplifies the analysis of multichromatic flow cytometry data. Nat Commun. 2021;12:2890.', doi: '10.1038/s41467-021-23126-8' },
  peacoqc: { text: 'Emmaneel A, Quintelier K, Sichien D, et al. PeacoQC: Peak-based selection of high quality cytometry data. Cytometry A. 2022;101(4):325–338.', doi: '10.1002/cyto.a.24501' },
  flowai: { text: 'Monaco G, Chen H, Poidinger M, Chen J, de Magalhães JP, Larbi A. flowAI: automatic and interactive anomaly discerning tools for flow cytometry data. Bioinformatics. 2016;32(16):2473–2480.', doi: '10.1093/bioinformatics/btw191' },
  flowsom: { text: 'Van Gassen S, Callebaut B, Van Helden MJ, et al. FlowSOM: Using self-organizing maps for visualization and interpretation of cytometry data. Cytometry A. 2015;87(7):636–645.', doi: '10.1002/cyto.a.22625' },
  consensus: { text: 'Wilkerson MD, Hayes DN. ConsensusClusterPlus: a class discovery tool with confidence assessments and item tracking. Bioinformatics. 2010;26(12):1572–1573.', doi: '10.1093/bioinformatics/btq170' },
  umap: { text: 'McInnes L, Healy J, Melville J. UMAP: Uniform Manifold Approximation and Projection for dimension reduction. arXiv:1802.03426. 2018.', doi: null },
  tsne: { text: 'van der Maaten L. Accelerating t-SNE using tree-based algorithms. J Mach Learn Res. 2014;15:3221–3245.', doi: null },
  optsne: { text: 'Belkina AC, Ciccolella CO, Anno R, et al. Automated optimized parameters for T-distributed stochastic neighbor embedding improve visualization and analysis of large datasets. Nat Commun. 2019;10:5415.', doi: '10.1038/s41467-019-13055-y' },
  leiden: { text: 'Traag VA, Waltman L, van Eck NJ. From Louvain to Leiden: guaranteeing well-connected communities. Sci Rep. 2019;9:5233.', doi: '10.1038/s41598-019-41695-z' },
  louvain: { text: 'Blondel VD, Guillaume J-L, Lambiotte R, Lefebvre E. Fast unfolding of communities in large networks. J Stat Mech. 2008;2008:P10008.', doi: '10.1088/1742-5468/2008/10/P10008' },
  kmeans: { text: 'Lloyd S. Least squares quantization in PCM. IEEE Trans Inf Theory. 1982;28(2):129–137.', doi: '10.1109/TIT.1982.1056489' },
  kmeansPlusPlus: { text: 'Arthur D, Vassilvitskii S. k-means++: the advantages of careful seeding. Proceedings of the 18th ACM-SIAM Symposium on Discrete Algorithms. 2007:1027–1035.', doi: null },
  hamerly: { text: 'Hamerly G. Making k-means even faster. Proceedings of the 2010 SIAM International Conference on Data Mining. 2010:130–140.', doi: '10.1137/1.9781611972801.12' },
  phenograph: { text: 'Levine JH, Simonds EF, Bendall SC, et al. Data-driven phenotypic dissection of AML reveals progenitor-like cells that correlate with prognosis. Cell. 2015;162(1):184–197.', doi: '10.1016/j.cell.2015.05.047' },
  cytonorm: { text: 'Van Gassen S, Gaudilliere B, Angst MS, Saeys Y, Aghaeepour N. CytoNorm: A normalization algorithm for cytometry data. Cytometry A. 2020;97(3):268–278.', doi: '10.1002/cyto.a.23904' },
  beads: { text: 'Finck R, Simonds EF, Jager A, et al. Normalization of mass cytometry data with bead standards. Cytometry A. 2013;83(5):483–494.', doi: '10.1002/cyto.a.22271' },
  debarcode: { text: 'Zunder ER, Finck R, Behbehani GK, et al. Palladium-based mass tag cell barcoding with a doublet-filtering scheme and single-cell deconvolution algorithm. Nat Protoc. 2015;10(2):316–333.', doi: '10.1038/nprot.2015.020' },
  deanJettFox: { text: 'Fox MH. A model for the computer analysis of synchronous DNA distributions obtained by flow cytometry. Cytometry. 1980;1(1):71–77.', doi: '10.1002/cyto.990010114' },
  watson: { text: 'Watson JV, Chambers SH, Smith PJ. A pragmatic approach to the analysis of DNA histograms with a definable G1 peak. Cytometry. 1987;8(1):1–8.', doi: '10.1002/cyto.990080101' },
  proliferation: { text: 'Roederer M. Interpretation of cellular proliferation data: avoid the panglossian. Cytometry A. 2011;79(2):95–101.', doi: '10.1002/cyto.a.21010' },
  bh: { text: 'Benjamini Y, Hochberg Y. Controlling the false discovery rate: a practical and powerful approach to multiple testing. J R Stat Soc B. 1995;57(1):289–300.', doi: null },
  miflowcyt: { text: 'Lee JA, Spidlen J, Boyce K, et al. MIFlowCyt: the minimum information about a flow cytometry experiment. Cytometry A. 2008;73(10):926–930.', doi: '10.1002/cyto.a.20623' },
  unmixing: { text: 'Novo D, Grégori G, Rajwa B. Generalized unmixing model for multispectral flow cytometry utilizing nonsquare compensation matrices. Cytometry A. 2013;83(5):508–520.', doi: '10.1002/cyto.a.22272' },
  autofluorescence: { text: 'Roet JEG, Mikula AM, de Kok M, et al. Unbiased method for spectral analysis of cells with great diversity of autofluorescence spectra. Cytometry A. 2024;105(8):595–606.', doi: '10.1002/cyto.a.24856' },
  parksQB: { text: 'Parks DR, El Khettabi F, Chase E, et al. Evaluating flow cytometer performance with weighted quadratic least squares analysis of LED and multi-level bead data. Cytometry A. 2017;91(3):232–249.', doi: '10.1002/cyto.a.23052' },
  westgard: { text: 'Westgard JO, Barry PL, Hunt MR, Groth T. A multi-rule Shewhart chart for quality control in clinical chemistry. Clin Chem. 1981;27(3):493–501.', doi: '10.1093/clinchem/27.3.493' },
  gaussNorm: { text: 'Hahne F, Khodabakhshi AH, Bashashati A, et al. Per-channel basis normalization methods for flow cytometry data. Cytometry A. 2010;77(2):121–131.', doi: '10.1002/cyto.a.20823' },
  stainIndex: { text: 'Maecker HT, Frey T, Nomura LE, Trotter J. Selecting fluorochrome conjugates for maximum sensitivity. Cytometry A. 2004;62(2):169–173.', doi: '10.1002/cyto.a.20092' },
  separationIndex: { text: 'Bigos M. Separation index: an easy-to-use metric for evaluation of different configurations on the same flow cytometer. Curr Protoc Cytom. 2007;Chapter 1:Unit 1.21.', doi: '10.1002/0471142956.cy0121s40' },
  titration: { text: 'Bonilla DL, Paul A, Gil-Pulido J, Park LM, Jaimes MC. The power of reagent titration in flow cytometry. Cells. 2024;13(20):1677.', doi: '10.3390/cells13201677' },
  drc: { text: 'Ritz C, Baty F, Streibig JC, Gerhard D. Dose-response analysis using R. PLoS One. 2015;10(12):e0146021.', doi: '10.1371/journal.pone.0146021' },
  zPrime: { text: 'Zhang JH, Chung TDY, Oldenburg KR. A simple statistical parameter for use in evaluation and validation of high throughput screening assays. J Biomol Screen. 1999;4(2):67–73.', doi: '10.1177/108705719900400206' },
  fivePL: { text: 'Gottschalk PG, Dunn JR. The five-parameter logistic: a characterization and comparison with the four-parameter logistic. Anal Biochem. 2005;343(1):54–65.', doi: '10.1016/j.ab.2005.04.035' },
  bmv: { text: 'U.S. Food and Drug Administration. Bioanalytical Method Validation: Guidance for Industry. 2018.', doi: null },
  voltageSetup: { text: 'Meinelt E, Reunanen M, Edinger M, et al. Standardizing application setup across multiple flow cytometers using BD FACSDiva version 6 software. BD Biosciences technical bulletin; 2012.', doi: null },
  overton: { text: 'Overton WR. Modified histogram subtraction technique for analysis of flow cytometry data. Cytometry. 1988;9(6):619–626.', doi: '10.1002/cyto.990090617' },
  bagwell: { text: 'Bagwell CB. A journey through flow cytometric immunofluorescence analyses: finding accurate and robust algorithms that estimate positive fraction distributions. Clin Immunol Newsl. 1996;16(3).', doi: null },
  probabilityBinning: { text: 'Roederer M, Treister A, Moore W, Herzenberg LA. Probability binning comparison: a metric for quantitating univariate distribution differences. Cytometry. 2001;45(1):37–46.', doi: '10.1002/1097-0320(20010901)45:1<37::AID-CYTO1142>3.0.CO;2-E' },
  ksTest: { text: 'Young IT. Proof without prejudice: use of the Kolmogorov-Smirnov test for the analysis of histograms from flow systems and other sources. J Histochem Cytochem. 1977;25(7):935–941.', doi: '10.1177/25.7.894009' },
  garwood: { text: 'Garwood F. Fiducial limits for the Poisson distribution. Biometrika. 1936;28(3/4):437–442.', doi: '10.2307/2333958' },
  clopperPearson: { text: 'Clopper CJ, Pearson ES. The use of confidence or fiducial limits illustrated in the case of the binomial. Biometrika. 1934;26(4):404–413.', doi: '10.1093/biomet/26.4.404' },
  eventsNeeded: { text: 'Roederer M. How many events is enough? Are you positive? Cytometry A. 2008;73(5):384–385.', doi: '10.1002/cyto.a.20549' },
  detectionLimits: { text: 'Armbruster DA, Pry T. Limit of blank, limit of detection and limit of quantitation. Clin Biochem Rev. 2008;29(Suppl 1):S49–S52.', doi: null },
  flowcal: { text: 'Castillo-Hair SM, Sexton JT, Landry BP, Olson EJ, Igoshin OA, Tabor JJ. FlowCal: a user-friendly, open source software tool for automatically converting flow cytometry data from arbitrary to calibrated units. ACS Synth Biol. 2016;5(7):774–780.', doi: '10.1021/acssynbio.5b00284' },
  absoluteCounts: { text: 'Brando B, Barnett D, Janossy G, et al. Cytofluorometric methods for assessing absolute numbers of cell subsets in blood. Cytometry. 2000;42(6):327–346.', doi: '10.1002/1097-0320(20001215)42:6<327::AID-CYTO1000>3.0.CO;2-F' },
  diffcyt: { text: 'Weber LM, Nowicka M, Soneson C, Robinson MD. diffcyt: Differential discovery in high-dimensional cytometry via high-resolution clustering. Commun Biol. 2019;2:183.', doi: '10.1038/s42003-019-0415-5' },
  limma: { text: 'Ritchie ME, Phipson B, Wu D, Hu Y, Law CW, Shi W, Smyth GK. limma powers differential expression analyses for RNA-sequencing and microarray studies. Nucleic Acids Res. 2015;43(7):e47.', doi: '10.1093/nar/gkv007' },
  moderatedT: { text: 'Smyth GK. Linear models and empirical Bayes methods for assessing differential expression in microarray experiments. Stat Appl Genet Mol Biol. 2004;3:Article 3.', doi: '10.2202/1544-6115.1027' },
  unequalDf: { text: 'Chen Y, Chen L, Lun ATL, Baldoni PL, Smyth GK. edgeR v4: powerful differential analysis of sequencing data with expanded functionality and improved support for small counts and larger datasets. Nucleic Acids Res. 2025;53(2):gkaf018.', doi: '10.1093/nar/gkaf018' },
};

const ORDER = Object.keys(REFERENCES);

function list(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeTransform(spec) {
  if (!spec) return 'linear';
  switch (spec.type) {
    case 'logicle': return `logicle (T = ${spec.T}, W = ${spec.W}, M = ${spec.M}, A = ${spec.A ?? 0})`;
    case 'biex': return `biexponential (width basis ${spec.widthBasis}, ${spec.positiveDecades} positive decades)`;
    case 'arcsinh': return `arcsinh (cofactor ${spec.cofactor})`;
    case 'log': return 'logarithmic';
    default: return spec.type;
  }
}

// Writes the methods: { paragraphs: [string], references: [{ key, text, doi }] }. Citations
// appear in the text as [n] in the order first used.
export function writeMethods(ws, options = {}) {
  const used = [];
  const cite = (key) => {
    if (!REFERENCES[key]) return '';
    if (!used.includes(key)) used.push(key);
    return `[${used.indexOf(key) + 1}]`;
  };
  const paragraphs = [];
  const samples = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
  const controls = ws.samples.filter((s) => s.role !== 'sample' && s.role !== 'reference');
  const cytometers = [...new Set(ws.samples.map((s) => s.acquisition?.cytometer).filter(Boolean))];
  const versions = [...new Set(ws.samples.map((s) => s.fcsVersion).filter(Boolean))];
  const technology = [...new Set(ws.samples.map((s) => s.technology))];
  paragraphs.push(`Flow cytometry data (${samples.length} sample${samples.length === 1 ? '' : 's'}${controls.length ? ` and ${controls.length} control${controls.length === 1 ? '' : 's'}` : ''}${cytometers.length ? `, acquired on ${list(cytometers)}` : ''}; ${list(versions)} files ${cite('fcs31')}) were analyzed with CytoWeave ${options.version ?? ''} ${cite('cytoweave')}.`.replace(/\s+/g, ' ').replace(' .', '.'));

  // Compensation and unmixing.
  const compSentences = [];
  const fileComp = ws.samples.filter((s) => s.compensationId === 'file').length;
  if (fileComp) compSentences.push(`${fileComp} file(s) were compensated with the spillover matrix recorded at acquisition ($SPILLOVER)`);
  for (const comp of ws.compensations) {
    const users = ws.samples.filter((s) => s.compensationId === comp.id).length;
    if (!users) continue;
    if (comp.source === 'computed') compSentences.push(`${users} file(s) were compensated with a ${comp.channels.length}-color spillover matrix computed from single-stain controls by ${comp.method === 'regression' ? `robust regression ${cite('autospill')}` : 'the difference of positive and negative medians'}`);
    else if (comp.source === 'imported') compSentences.push(`${users} file(s) used the imported matrix "${comp.name}"`);
    else compSentences.push(`${users} file(s) used the matrix "${comp.name}", adjusted manually`);
  }
  // Files with several fluorochromes that were left uncompensated are worth stating; a single-dye
  // assay (DNA content, one marker) needs no compensation.
  const dyes = (s) => new Set(s.channels.filter((c) => c.type === 'fluorescence').map((c) => c.marker || c.name.replace(/-[AHW]$/, ''))).size;
  const uncompensated = ws.samples.filter((s) => s.compensationId === 'none' && s.technology === 'conventional' && dyes(s) > 1).length;
  if (uncompensated) compSentences.push(`${uncompensated} file(s) were not compensated`);
  if (compSentences.length) paragraphs.push(`${compSentences.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
  const unmixing = ws.derived.filter((d) => d.kind === 'unmixing');
  for (const d of unmixing) {
    // Spectra taken from the instrument's spectral library rather than this experiment's controls.
    const fromLibrary = (d.params?.references ?? []).filter((r) => r.library);
    const library = fromLibrary.length ? ` The reference spectra of ${list(fromLibrary.map((r) => `${r.fluorochrome}${r.library.date ? ` (acquired ${String(r.library.date).slice(0, 10)})` : ''}`))} came from the instrument's spectral library, measured on single-stain controls of an earlier experiment.` : '';
    paragraphs.push(`Spectral data were unmixed by ${d.method ?? 'least squares'} ${cite('unmixing')}${d.params?.autofluorescence ? `, with ${d.params.autofluorescence === 'multiple' ? 'per-cell selection among multiple autofluorescence signatures' : 'an autofluorescence signature'} ${cite('autofluorescence')}` : ''}.${library}`);
  }

  // Scales: channels sharing a transform family and its fixed parameters are described together,
  // with the range of their per-channel linear widths.
  const families = new Map();
  for (const [channel, setting] of Object.entries(ws.channelSettings ?? {})) {
    const spec = setting.transform;
    if (!spec?.type || spec.type === 'linear') continue;
    const key = spec.type === 'logicle' ? `logicle|${spec.T}|${spec.M}|${spec.A ?? 0}` : spec.type === 'arcsinh' ? `arcsinh|${spec.cofactor}` : describeTransform(spec);
    if (!families.has(key)) families.set(key, { spec, channels: [], widths: [] });
    const family = families.get(key);
    family.channels.push(channel);
    if (spec.type === 'logicle') family.widths.push(spec.W);
  }
  if (families.size) {
    const parts = [...families.values()].map(({ spec, channels, widths }) => {
      const n = `${channels.length} channel${channels.length === 1 ? '' : 's'}`;
      if (spec.type === 'logicle') {
        const lo = Math.min(...widths);
        const hi = Math.max(...widths);
        const width = lo === hi ? `W = ${lo}` : `W from ${+lo.toFixed(2)} to ${+hi.toFixed(2)}, estimated per channel from the negative data`;
        return `logicle (T = ${spec.T}, M = ${spec.M}, A = ${spec.A ?? 0}, ${width}) for ${n}`;
      }
      return `${describeTransform(spec)} for ${n}`;
    });
    const logicle = [...families.values()].some((f) => f.spec.type === 'logicle' || f.spec.type === 'biex');
    paragraphs.push(`Fluorescence was displayed and gated on ${list(parts)}${logicle ? ` ${cite('logicle')}${cite('logicleAlgorithm')}` : ''}.`);
  }

  // Quality control and normalization.
  for (const d of ws.derived.filter((r) => r.kind === 'qc')) {
    const removed = d.summary?.percentRemoved ?? d.summary?.meanRemoved;
    paragraphs.push(`Acquisition anomalies were flagged with a PeacoQC-style algorithm ${cite('peacoqc')} and a flow-rate check ${cite('flowai')}${d.params ? ` (${Object.entries(d.params).slice(0, 4).map(([k, v]) => `${k} = ${v}`).join(', ')})` : ''}${Number.isFinite(removed) ? `, removing ${removed.toFixed(1)}% of events on average` : ''}.`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'normalization')) paragraphs.push(`Batch effects were corrected with ${d.method?.toLowerCase().includes('bead') ? `bead normalization ${cite('beads')}` : `CytoNorm ${cite('cytonorm')}`}${d.params?.channels ? ` on ${d.params.channels.length} channels` : ''}.`);

  // Instrument characterization.
  for (const d of ws.derived.filter((r) => r.kind === 'instrument-qc')) {
    const runs = d.runs ?? [];
    if (!runs.length) continue;
    const beads = runs.filter((r) => r.method === 'beads');
    const series = runs.filter((r) => r.method === 'series');
    const what = [beads.length ? `${beads.length} run${beads.length === 1 ? '' : 's'} of ${beads[0].product ? `${beads[0].product} beads` : `${beads[0].peaks}-level beads`}` : '', series.length ? `${series.length} series of single-level files (an LED pulser or single-level beads)` : ''].filter(Boolean).join(' and ');
    const dates = runs.map((r) => r.date).filter(Boolean).sort();
    paragraphs.push(`The detection efficiency (Q) and optical background (B) of each fluorescence detector of ${d.instrument?.name ?? 'the cytometer'} were measured from ${what}${dates.length > 1 ? ` between ${dates[0].slice(0, 10)} and ${dates.at(-1).slice(0, 10)}` : ''} by weighted quadratic least squares on the peaks' means and variances, as in flowQB ${cite('parksQB')}: each peak's mean and SD from a normal fitted to its central 80%, peaks outside the detector's linear range left out, and weights re-estimated from the fit.${runs.length >= 3 ? ` Runs were followed on Levey–Jennings charts with Westgard rules ${cite('westgard')} against the mean and SD of the first ${Math.min(20, runs.length)} runs.` : ''}`);
  }

  // Reagent titration and detector voltages.
  for (const d of ws.derived.filter((r) => r.kind === 'titration')) {
    const steps = d.steps ?? [];
    if (!steps.length) continue;
    const among = d.population ? ` among ${d.population}` : '';
    if (d.mode === 'voltage') {
      const v = d.summary ?? {};
      const noise = v.rsdEN ? ` (${+v.rsdEN.toPrecision(3)}, ${v.noiseSource === 'given' ? 'from the cytometer\'s baseline report' : 'estimated from the walk'})` : '';
      paragraphs.push(`The ${d.channel} detector was set from a voltage walk of ${steps.length} steps from ${steps[0].label} to ${steps.at(-1).label}${among}: the minimum voltage is where the negative cells' robust SD reaches 2.5 times the detector's electronic noise${noise} ${cite('voltageSetup')}${Number.isFinite(v.minimum) ? `, ${Math.round(v.minimum)} V` : ''}, and the maximum keeps the positive cells' 99th percentile within the linear range${Number.isFinite(v.maximum) ? `, ${Math.round(v.maximum)} V` : ''}${Number.isFinite(v.recommended) ? `; ${v.recommended} V was chosen` : ''}.`);
    } else {
      const t = d.summary ?? {};
      paragraphs.push(`${d.marker ? `The ${d.marker} reagent` : 'The reagent'} (${d.channel}) was titrated in ${steps.length} steps from ${steps[0].label} to ${steps.at(-1).label}${among}; at each step the stain index ${cite('stainIndex')} and separation index ${cite('separationIndex')} of the positive against the negative cells were computed, a saturation curve was fitted to the stain index, and ${t.recommended ? `${t.recommended} was chosen as` : 'the amount to use is'} at least twice the amount giving 90% of saturating staining${t.c90 ? ` (${t.c90})` : ''} ${cite('titration')}.`);
    }
  }

  // Gating.
  const roots = ws.gates.filter((g) => !g.parentId);
  if (ws.gates.length) {
    const paths = [];
    const walk = (gate, trail) => {
      const children = ws.gates.filter((g) => g.parentId === gate.id);
      const next = [...trail, gate.name];
      if (!children.length) paths.push(next.join(' → '));
      for (const child of children) walk(child, next);
    };
    for (const root of roots) walk(root, []);
    const adjusted = ws.gates.filter((g) => Object.keys(g.overrides ?? {}).length).length;
    const auto = ws.gates.filter((g) => g.meta?.origin === 'auto' && !g.meta?.proposedBy).length;
    const byAgents = [...new Set(ws.gates.filter((g) => g.meta?.proposedBy && g.meta?.acceptedBy).map((g) => g.meta.proposedBy))];
    const agentGates = ws.gates.filter((g) => g.meta?.proposedBy && g.meta?.acceptedBy).length;
    const pending = ws.gates.filter((g) => g.meta?.proposal).length;
    paragraphs.push(`Populations were identified by sequential gating (${ws.gates.length} gates): ${paths.slice(0, 8).join('; ')}${paths.length > 8 ? `; and ${paths.length - 8} further branches` : ''}. ${auto ? `${auto} gate(s) were proposed automatically from the data's density and accepted by the analyst. ` : ''}${agentGates ? `${agentGates} gate(s) were proposed by an AI agent (${byAgents.join(', ')}) and reviewed and accepted by the analyst. ` : ''}${pending ? `${pending} gate(s) proposed by an AI agent have not yet been reviewed. ` : ''}${adjusted ? `${adjusted} gate(s) were adjusted for individual samples; all other gates were applied identically to every sample. ` : 'Gates were applied identically to every sample. '}The gating strategy is available in Gating-ML 2.0 format ${cite('gatingml')}.`);
  }
  // Cell Ontology terms the analyst confirmed.
  const annotated = ws.gates.filter((g) => g.ontology?.status === 'confirmed');
  if (annotated.length) paragraphs.push(`Populations were annotated with Cell Ontology terms ${cite('cellOntology')}: ${annotated.slice(0, 12).map((g) => `${g.name} as ${g.ontology.label} (${g.ontology.id})`).join('; ')}${annotated.length > 12 ? `; and ${annotated.length - 12} more` : ''}.`);

  // Autogating: the latest adaptation of each gate.
  const adaptations = new Map();
  for (const d of ws.derived.filter((r) => r.kind === 'autogating')) adaptations.set(d.gateId, d);
  if (adaptations.size) {
    const records = [...adaptations.values()];
    const results = records.flatMap((d) => Object.values(d.results ?? {}));
    const applied = results.filter((r) => r.applied).length;
    const review = results.filter((r) => r.status === 'review').length;
    const reviewedByHand = results.filter((r) => r.status === 'review' && r.applied).length;
    const threshold = records[0].params?.confident ?? 0.8;
    const names = records.map((d) => ws.gates.find((g) => g.id === d.gateId)?.name ?? d.name.replace(/^Autogating of /, ''));
    const agents = [...new Set(records.map((d) => d.proposedBy).filter(Boolean))];
    paragraphs.push(`${list(names)} ${records.length === 1 ? 'was' : 'were'} adapted to each sample by landmark registration of the parent population's density along each gate axis ${cite('gaussNorm')}, from the samples the analyst had drawn, adjusted or confirmed the gate on, with an ensemble over exemplar samples, smoothing bandwidths and halves of the events giving each sample a confidence. Adaptations with confidence of at least ${threshold} were ${agents.length ? `proposed by an AI agent (${agents.join(', ')}) and ` : ''}applied after review by the analyst (${applied} sample-gate adjustment${applied === 1 ? '' : 's'}${reviewedByHand ? `, ${reviewedByHand} of them below that confidence and applied by the analyst` : ''}); ${review ? `${review} sample-gate pair${review === 1 ? ' was' : 's were'} flagged as uncertain for manual review` : 'no sample was flagged as uncertain'}.`);
  }

  // High-dimensional analysis.
  for (const d of ws.derived.filter((r) => ['flowsom', 'clustering', 'umap', 'tsne', 'pca', 'embedding', 'phenograph', 'leiden', 'louvain', 'kmeans'].includes(r.kind))) {
    const params = d.params ?? {};
    const seed = d.seed !== undefined ? `, seed ${d.seed}` : '';
    const markers = `${params.markers?.length ?? 'the selected'} markers`;
    const text = `${d.kind} ${d.method ?? ''}`;
    // A result may hold a clustering, an embedding or both (Explore records both in params).
    const clustering = params.clustering ?? (/flowsom/i.test(text) ? 'flowsom' : /k-?means/i.test(text) ? 'kmeans' : /louvain/i.test(text) ? 'louvain' : /leiden|phenograph/i.test(text) ? 'phenograph' : 'none');
    const embedding = params.embedding ?? (/umap/i.test(text) ? 'umap' : /t-?sne/i.test(text) ? 'tsne' : /\bpca\b/i.test(text) ? 'pca' : 'none');
    if (clustering === 'flowsom') paragraphs.push(`Cells were clustered with FlowSOM ${cite('flowsom')} (${params.xdim ?? 10}×${params.ydim ?? 10} grid, ${params.k ?? 'k'} metaclusters by consensus clustering ${cite('consensus')}${seed}) on ${markers}.`);
    else if (clustering === 'kmeans') paragraphs.push(`Cells were clustered by k-means ${cite('kmeans')} into ${params.k ?? 'k'} clusters (k-means++ initialization ${cite('kmeansPlusPlus')}, Hamerly's algorithm ${cite('hamerly')}${seed}) on ${markers} of the embedded subsample; every other event was assigned to the nearest cluster center.`);
    else if (clustering === 'louvain') paragraphs.push(`Cells were clustered by Louvain community detection ${cite('louvain')} (resolution ${params.resolution ?? 1}) on a ${params.leidenK ?? 30}-nearest-neighbor graph with Jaccard weights as in PhenoGraph ${cite('phenograph')}${seed}; every other event was assigned to the nearest cluster centroid.`);
    else if (clustering === 'phenograph') paragraphs.push(`Cells were clustered by Leiden community detection ${cite('leiden')} on a k-nearest-neighbor graph with Jaccard weights as in PhenoGraph ${cite('phenograph')}${seed}.`);
    if (embedding === 'umap') paragraphs.push(`Data were embedded with UMAP ${cite('umap')} (${params.nNeighbors ?? 15} neighbors, minimum distance ${params.minDist ?? 0.1}${seed}) on ${markers} of ${params.events ? `${params.events.toLocaleString('en-US')} events` : 'a subsample of events'}.${params.placed?.length ? ` ${params.placed.length} further sample(s) (${params.placed.join(', ')}) were placed on the finished map with UMAP's transform, which positions new events among their nearest neighbors in the reference without changing the map.` : ''}`);
    else if (embedding === 'tsne') paragraphs.push(`Data were embedded with Barnes–Hut t-SNE ${cite('tsne')} (perplexity ${params.perplexity ?? 30}, learning rate set as in opt-SNE ${cite('optsne')}${seed}).`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'cellcycle')) paragraphs.push(`DNA content histograms were modeled with the ${/watson/i.test(d.method ?? '') ? `Watson pragmatic model ${cite('watson')}` : `Dean–Jett–Fox model ${cite('deanJettFox')}`}.`);
  for (const d of ws.derived.filter((r) => r.kind === 'proliferation')) paragraphs.push(`Proliferation was modeled by fitting generation peaks of dye dilution; division, proliferation and expansion indices follow Roederer ${cite('proliferation')}.`);
  for (const d of ws.derived.filter((r) => r.kind === 'dose-response')) {
    const p = d.params ?? {};
    const weights = p.weighting && p.weighting !== 'none' ? `, weighted ${p.weighting === '1/y2' ? '1/Y²' : '1/Y'}` : '';
    const response = p.normalize === 'inhibition' ? ' expressed as % inhibition relative to the plate\'s positive and negative control wells' : p.normalize === 'controls' ? ' expressed as % of the plate\'s controls (negative 0%, positive 100%)' : '';
    const fixed = p.fixed && Object.keys(p.fixed).length ? ', with the asymptotes fixed at 0% and 100%' : '';
    const z = Number.isFinite(d.summary?.zPrime) ? ` The plate's Z′ ${cite('zPrime')} from its control wells was ${d.summary.zPrime.toFixed(2)}.` : '';
    paragraphs.push(`Dose-response curves (${d.name.replace(/^Dose-response · /, '')}) were fitted per ${p.groupField ?? 'group'} by least squares to a ${p.model === 'LL.5' ? 'five' : 'four'}-parameter log-logistic model in the parameterization of the R package drc ${cite('drc')}${weights}${fixed}, the response${response}; EC50 values are reported with 95% confidence intervals from the delta method on the log scale, and curves no better than a flat line (F test, p ≥ 0.05) as showing no dose-response.${z}`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'bead-assay')) {
    const p = d.params ?? {};
    const n = d.summary?.analytes?.length ?? 0;
    paragraphs.push(`A bead-based immunoassay of ${n} analyte${n === 1 ? '' : 's'} was analyzed per well: capture beads were identified by bead group and level of their classification dye (${p.classification}), found once from all wells, and each analyte's reporter (${p.reporter}) ${p.statistic === 'geometric' ? 'geometric mean' : p.statistic ?? 'median'} fluorescence intensity was read off ${p.model === 'LL.4' ? 'a four' : `a five ${cite('fivePL')}`}-parameter log-logistic standard curve${p.weighting && p.weighting !== 'none' ? ` (weighted ${p.weighting === '1/y2' ? '1/Y²' : '1/Y'})` : ''} fitted to the standards (top standard ${p.top} ${p.unit ?? ''}, ${p.factor}-fold steps) and multiplied by each sample's dilution. The quantifiable range was set by the standards that back-calculated within 20% of their concentration with a CV of at most 20% (25% at its ends) ${cite('bmv')}, and the limit of detection at the blanks' mean + 3 SD.`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'kinetics')) {
    const p = d.params ?? {};
    const measure = p.mode === 'ratio' ? `the ratio of ${p.numerator} to ${p.denominator} (events where either was not positive excluded)` : p.channel ?? 'the signal';
    paragraphs.push(`Kinetics of ${measure} were measured against acquisition time: the ${p.statistic === 'mean' ? 'mean' : 'median'} per ${p.binWidth ? `${p.binWidth}-s` : 'time'} bin, smoothed by a centered moving average of ${p.smoothing ?? 3} bins, with the baseline taken before the stimulus ${Number.isFinite(p.stimulus) ? `(at ${p.stimulus} s)` : '(where acquisition paused to add it)'}; responding cells were those above ${Number.isFinite(p.threshold) ? `a ratio of ${p.threshold}` : 'the 99th percentile of the baseline events'}, net of the baseline's share above it.`);
  }

  // Computed channels: formulas and bead calibrations.
  const formulas = ws.derived.filter((d) => d.kind === 'formula');
  if (formulas.length) paragraphs.push(`${formulas.length === 1 ? 'A channel was' : `${formulas.length} channels were`} computed for every event from the compensated values: ${formulas.slice(0, 8).map((d) => `${d.outputs[0]} = ${d.params.expression}`).join('; ')}${formulas.length > 8 ? `; and ${formulas.length - 8} more` : ''}.`);
  const calibrations = ws.derived.filter((d) => d.kind === 'calibration');
  for (const d of calibrations) {
    const used = d.params.levels?.filter((l) => l.used).length;
    paragraphs.push(`${d.inputs[0]} was converted to ${d.params.unit} with ${d.params.beads ? `the multi-level calibration beads of ${d.params.beads}` : 'multi-level calibration beads'} as in FlowCal ${cite('flowcal')}: the beads' levels were found by clustering, each level's median matched to the manufacturer's value${used ? ` (${used} of ${d.params.levels.length} levels, leaving out those near the ends of the detector's range)` : ''}, and the model m·ln(x) + b = ln(${d.params.unit} + ${d.params.unit}_beads) fitted in log space (m = ${d.params.m.toFixed(4)}); values were converted with ${d.params.unit} = e^b·x^m, applied to ${d.samples ? `${d.samples.length} sample${d.samples.length === 1 ? '' : 's'} acquired with the beads' settings` : 'every sample'}.`);
  }

  // Tables: comparisons with control samples, rare-event statistics and detection limits.
  const columns = (ws.tables ?? []).flatMap((t) => t.columns);
  const stats = new Set(columns.map((c) => c.stat));
  const comparisons = [
    stats.has('sed') ? `enhanced normalized subtraction (SED in FlowJo) ${cite('bagwell')}` : '',
    stats.has('overton') ? `Overton's cumulative subtraction ${cite('overton')}` : '',
    stats.has('pbT') || stats.has('pbPositive') ? `probability binning (${stats.has('pbT') ? 'the T(χ) metric' : ''}${stats.has('pbT') && stats.has('pbPositive') ? ' and ' : ''}${stats.has('pbPositive') ? 'the share of events in excess of the control' : ''}) ${cite('probabilityBinning')}` : '',
    stats.has('ksD') ? `the Kolmogorov–Smirnov statistic D ${cite('ksTest')}` : '',
  ].filter(Boolean);
  if (comparisons.length) {
    const controls = [...new Set(columns.filter((c) => c.control?.sampleId).map((c) => ws.samples.find((x) => x.id === c.control.sampleId)?.name).filter(Boolean))];
    paragraphs.push(`Each sample's population was compared with that of a control sample (${list(controls)}) on the channel, using ${list(comparisons)}.`);
  }
  const intervals = [
    stats.has('countLow') || stats.has('countHigh') ? `counts with exact Poisson ${cite('garwood')}` : '',
    stats.has('freqLow') || stats.has('freqHigh') ? `frequencies with exact binomial (Clopper–Pearson) ${cite('clopperPearson')}` : '',
  ].filter(Boolean);
  if (intervals.length) paragraphs.push(`Rare populations are reported as ${list(intervals)} 95% confidence intervals${stats.has('countCV') ? `, and with the counting CV of 100/√n for n events ${cite('eventsNeeded')}` : ''}.`);
  const counted = columns.filter((c) => c.stat === 'absoluteCount' && c.counting?.beadGateId);
  if (counted.length) {
    const c = counted[0].counting;
    const beads = ws.gates.find((g) => g.id === c.beadGateId)?.name ?? 'counting beads';
    const dilution = counted.some((x) => x.dilution) ? ', times each sample\'s dilution' : '';
    paragraphs.push(`Absolute counts were obtained with counting beads ${cite('absoluteCounts')}: cells per µL = (cell events / bead events, gated as ${beads}) × (${Number(c.beads).toLocaleString('en-US')} beads / ${c.volume} µL of sample)${dilution}.`);
  }
  for (const column of columns.filter((c) => c.limits?.blankIds?.length)) {
    const name = column.gateId && column.gateId !== 'root' ? ws.gates.find((g) => g.id === column.gateId)?.name ?? 'the population' : 'all events';
    const what = column.stat === 'count' ? 'count' : 'frequency';
    const l = column.limits;
    const cv = l.cvTarget ?? 20;
    paragraphs.push(`Limits for the ${what} of ${name} were set as in CLSI EP17 ${cite('detectionLimits')} from ${l.blankIds.length} blank sample(s)${l.lowIds?.length ? ` and ${l.lowIds.length} low-level sample(s)` : ''}: the limit of blank as ${l.method === 'nonparametric' ? 'the blanks\' 95th percentile' : 'the blanks\' mean plus 1.645 SD'}${l.lowIds?.length ? ', the limit of detection as the limit of blank plus 1.645 times the low-level samples\' pooled SD' : ''}, and each sample's lower limit of quantification as the lowest value measured with a CV of ${cv}%, never below the ${Math.ceil((100 / cv) ** 2 - 1e-9)} events that give that CV by Poisson counting ${cite('eventsNeeded')}.`);
  }

  // Statistics.
  for (const comparison of (ws.comparisons ?? []).slice(-5)) {
    // Differential state (diffcyt-DS-limma) and abundance (approximating diffcyt) cite their sources.
    if (comparison.kind === 'screen-states') ['diffcyt', 'limma', 'moderatedT', 'unequalDf'].forEach(cite);
    if (comparison.kind === 'screen-clusters') cite('diffcyt');
    const adjusted = comparison.adjustment ? `, with ${comparison.adjustment === 'BH' ? `Benjamini–Hochberg correction ${cite('bh')}` : `${comparison.adjustment} correction`}` : '';
    paragraphs.push(`${comparison.methods ?? `${comparison.measure ?? 'Values'} were compared between groups with ${comparison.test ?? 'a two-sided test'}`}${adjusted}; each sample was one observation.`.replace(/\.\./g, '.'));
  }
  // Claim MIFlowCyt only when every checklist item is documented; otherwise say how far it goes.
  const checklist = miflowcytChecklist(ws);
  const documented = checklist.filter((item) => item.ok).length;
  paragraphs.push(documented === checklist.length
    ? `Reporting follows MIFlowCyt ${cite('miflowcyt')}.`
    : `This description documents ${documented} of the ${checklist.length} MIFlowCyt items ${cite('miflowcyt')}; the remaining items should be reported with it.`);
  return { paragraphs, references: used.map((key) => ({ key, ...REFERENCES[key] })) };
}

// The methods as plain text: the paragraphs, then the numbered references.
export function methodsText(ws, options = {}) {
  const { paragraphs, references } = writeMethods(ws, options);
  return `${paragraphs.join('\n\n')}\n\nReferences\n${references.map((r, i) => `${i + 1}. ${r.text}${r.doi ? ` doi:${r.doi}` : ''}`).join('\n')}`;
}

export function toBibTeX(references) {
  return references.map((ref, i) => {
    const authors = ref.text.split('.')[0];
    const year = (ref.text.match(/(19|20)\d{2}/) ?? [''])[0];
    return `@misc{ref${i + 1},\n  note = {${ref.text.replace(/[{}]/g, '')}},\n  author = {${authors}},\n  year = {${year}}${ref.doi ? `,\n  doi = {${ref.doi}}` : ''}\n}`;
  }).join('\n\n');
}

// MIFlowCyt items and whether the workspace documents them.
export function miflowcytChecklist(ws) {
  const keywords = ws.samples.map((s) => s.keywords ?? {});
  const any = (fn) => keywords.some(fn);
  const meta = (field) => ws.samples.some((s) => s.meta?.[field]);
  return [
    { section: 'Experiment overview', item: 'Purpose, keywords and experiment variables', ok: Boolean(ws.notes?.trim()) || meta('condition'), hint: 'Describe the experiment in the workspace notes and annotate conditions.' },
    { section: 'Experiment overview', item: 'Organization, primary contact, date', ok: any((k) => k.$DATE) && Boolean(ws.notes?.match(/contact|lab|@/i)), hint: 'Add the lab and a contact to the notes; acquisition dates come from $DATE.' },
    { section: 'Sample', item: 'Specimen description (source, organism, treatment)', ok: meta('tissue') || meta('treatment') || meta('condition'), hint: 'Annotate samples with tissue, organism and treatment.' },
    { section: 'Sample', item: 'Reagents: analytes, fluorochromes, clones', ok: ws.samples.some((s) => s.channels.some((c) => c.marker)), hint: 'Marker names come from $PnS; clones and lots belong in the notes.' },
    { section: 'Sample', item: 'Controls (unstained, single-stain, FMO, isotype)', ok: ws.samples.some((s) => s.role !== 'sample'), hint: 'Mark control samples with their role.' },
    { section: 'Instrument', item: 'Cytometer, configuration and settings', ok: any((k) => k.$CYT), hint: '$CYT, detector voltages ($PnV) and filters ($PnF) come from the files.' },
    { section: 'Data analysis', item: 'List-mode data files', ok: ws.samples.length > 0, hint: '' },
    { section: 'Data analysis', item: 'Compensation description', ok: ws.samples.every((s) => s.technology !== 'conventional' || s.compensationId !== 'none') || ws.compensations.length > 0, hint: 'Apply or compute a compensation, or state why none was used.' },
    { section: 'Data analysis', item: 'Data transformation', ok: Object.keys(ws.channelSettings ?? {}).length > 0, hint: 'Channel scales are recorded automatically.' },
    { section: 'Data analysis', item: 'Gating description', ok: ws.gates.length > 0, hint: 'Export the gates as Gating-ML and include a gating strategy figure.' },
  ];
}
