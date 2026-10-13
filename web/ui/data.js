// Event data management: importing files into the library, decoding samples on demand (in a
// worker), keeping recently used samples in memory within a budget, and keeping each loaded
// sample's compensation in step with the workspace.

import { SampleView, compensationOf } from '../lib/engine.js';
import { sampleFromDataset } from '../lib/workspace.js';
import { WorkerClient } from './workers.js';
import { plainCopy } from '../lib/memory.js';

// Memory for decoded samples: 1.6 GB, or up to 3 GB on machines that report 8 GB or more
// (navigator.deviceMemory, Chromium only, reports at most 8).
const DEFAULT_BUDGET = Math.max(1.6, Math.min(3, 0.375 * (globalThis.navigator?.deviceMemory ?? 0))) * 1024 ** 3;

export class DataStore {
  constructor({ library, getWorkspace, onChange }) {
    this.library = library;
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.views = new Map();
    this.loading = new Map();
    this.status = new Map();
    this.errors = new Map();
    this.lastUsed = new Map();
    this.session = new Map(); // sha256 → bytes or a Blob kept for this session when the library refuses them
    this.localSources = new Map(); // sha256 → URL of a file the desktop program serves
    this.remoteSource = null; // (record) → Blob of a sample's file from where it was opened (Cirro)
    this.derived = new Map(); // sampleId → Map(name → { column, version })
    this.budget = DEFAULT_BUDGET;
    this.parser = new WorkerClient('../workers/fcs-worker.js', { max: Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1)) });
    this.pinned = new Set();
  }

  statusOf(sampleId) {
    return this.status.get(sampleId) ?? 'idle';
  }

  view(sampleId) {
    const view = this.views.get(sampleId);
    if (view) {
      const now = performance.now();
      this.lastUsed.set(sampleId, now);
      this.syncCompensation(view);
      // Caches grow as a sample is used: check the budget now and then.
      if (now - (this.lastEvictCheck ?? 0) > 2000) {
        this.lastEvictCheck = now;
        this.evict();
      }
    }
    return view ?? null;
  }

  // Parses an FCS file in a worker; returns { version, datasets, sha256 }. The file is bytes (whose
  // buffer is handed to the worker), a Blob or File, or a source descriptor ({ kind: 'url', url,
  // size } or { kind: 'blob', blob }); the worker reads the latter in parts. options: hash,
  // parseOptions, onProgress(fraction).
  async parse(file, options = {}) {
    let source;
    let transfer = [];
    if (file instanceof Uint8Array) {
      const own = options.keep || file.byteOffset || file.byteLength !== file.buffer.byteLength ? file.slice() : file;
      source = { kind: 'bytes', buffer: own.buffer };
      transfer = [own.buffer];
    } else if (file instanceof Blob) {
      source = { kind: 'blob', blob: file };
    } else {
      source = file;
    }
    return this.parser.call('parse', { source, hash: options.hash ?? true, options: options.parseOptions }, { transfer, onProgress: options.onProgress });
  }

  // Imports FCS files: stores each in the library and parses it, and returns sample records (one
  // per data set). files: [{ name, size, order, folder, cirro (where in Cirro the file is, kept on
  // its samples), and the content as file (a File or Blob), bytes, or localUrl (a file the desktop
  // program serves) }]. With the desktop program, the program stores the file and computes its
  // SHA-256 while the worker parses it; in the browser,
  // the worker hashes it as it reads it. Neither holds a whole file in memory.
  // onProgress(done, total, name), done counting fractions of files.
  async importFCS(files, onProgress) {
    const records = [];
    const problems = [];
    let done = 0;
    const fractions = new Map();
    const report = (name) => onProgress?.(done + [...fractions.values()].reduce((a, b) => a + b, 0), files.length, name);
    const tasks = files.map(async (file, k) => {
      try {
        const content = file.localUrl ? null : file.file instanceof Blob ? file.file : new Blob([file.bytes]);
        const onProgress = (fraction) => {
          fractions.set(k, fraction);
          report(file.name);
        };
        let sha256 = null;
        let parsed;
        if (this.library.addFile) {
          const stored = (file.localUrl ? this.library.addLocalFile(file.localUrl) : this.library.addFile(content)).catch((error) => ({ error }));
          parsed = await this.parse(file.localUrl ? { kind: 'url', url: new URL(file.localUrl, location.href).href, size: file.size } : content, { hash: false, onProgress });
          const result = await stored;
          sha256 = result.sha256 ?? null;
          if (!sha256) {
            // The program could not store it: hash it here and keep it for this session.
            const blob = content ?? await (await fetch(file.localUrl)).blob();
            sha256 = await this.parser.call('hash', { source: { kind: 'blob', blob } });
            this.session.set(sha256, blob);
            problems.push(`${file.name}: kept for this session only (${result.error?.message ?? 'not stored'})`);
          }
        } else {
          parsed = await this.parse(content, { hash: true, onProgress });
          sha256 = parsed.sha256;
          try {
            if (!(await this.library.hasFile(sha256))) await this.library.putFile(sha256, content);
          } catch (error) {
            this.session.set(sha256, content);
            problems.push(`${file.name}: kept for this session only (${error.message})`);
          }
        }
        parsed.datasets.forEach((dataset, datasetIndex) => {
          const record = sampleFromDataset(dataset, { name: parsed.datasets.length > 1 ? `${file.name.replace(/\.(fcs|lmd)$/i, '')} [${datasetIndex + 1}].fcs` : file.name, sha256, size: file.size ?? content?.size, datasetIndex });
          if (file.cirro) record.cirro = file.cirro;
          records.push({ record, dataset, order: file.order ?? 0, datasetIndex });
        });
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      } finally {
        fractions.delete(k);
        done += 1;
        report(file.name);
      }
    });
    await Promise.all(tasks);
    records.sort((a, b) => a.order - b.order || a.datasetIndex - b.datasetIndex);
    for (const { record, dataset } of records) this.install(record, dataset);
    return { records: records.map((r) => r.record), problems };
  }

  // Where a sample's file can be read: this session's copy, the library, a file the desktop program
  // serves, or the Cirro dataset it was opened from. Null when none has it.
  async sourceFor(record) {
    if (!record.sha256) return null;
    const kept = this.session.get(record.sha256);
    if (kept) return kept;
    if (this.library.kind === 'desktop') {
      if (await this.library.hasFile(record.sha256).catch(() => false)) return this.library.fileSource(record.sha256, record.size);
    } else {
      const source = await this.library.fileSource?.(record.sha256).catch(() => null);
      if (source) return source;
    }
    if (this.localSources.has(record.sha256)) return { kind: 'url', url: new URL(this.localSources.get(record.sha256), location.href).href };
    if (record.cirro && this.remoteSource) return this.fetchRemote(record);
    return null;
  }

  // Reads a sample's file from Cirro, checks it is the file the workspace analyzed, and keeps it in
  // the library so it is read from Cirro only once.
  async fetchRemote(record) {
    const blob = await this.remoteSource(record);
    const sha256 = this.library.addFile ? (await this.library.addFile(blob)).sha256 : await this.parser.call('hash', { source: { kind: 'blob', blob } });
    if (sha256 !== record.sha256) throw new Error(`The file of "${record.name}" in Cirro has changed since this workspace analyzed it.`);
    if (!this.library.addFile) await this.library.putFile(sha256, blob).catch(() => this.session.set(sha256, blob));
    return blob;
  }

  install(record, dataset) {
    const view = new SampleView(record, dataset);
    this.views.set(record.id, view);
    this.status.set(record.id, 'loaded');
    this.lastUsed.set(record.id, performance.now());
    this.attachDerived(view);
    this.syncCompensation(view, record);
    this.evict();
  }

  // Loads a sample's events (from the library, the session or a desktop-served file).
  ensure(sampleId) {
    const existing = this.view(sampleId);
    if (existing) return Promise.resolve(existing);
    if (this.loading.has(sampleId)) return this.loading.get(sampleId);
    const ws = this.getWorkspace();
    const record = ws.samples.find((s) => s.id === sampleId);
    if (!record) return Promise.reject(new Error('Unknown sample.'));
    this.status.set(sampleId, 'loading');
    this.onChange?.(['data']);
    const promise = (async () => {
      const source = await this.sourceFor(record);
      if (!source) {
        this.status.set(sampleId, 'missing');
        throw new Error(`The data of "${record.name}" are not in the library. Add the file ${record.fileName} again to reconnect it.`);
      }
      // Bytes kept for the session stay kept: the worker gets a copy.
      const parsed = await this.parse(source, { hash: false, keep: true });
      const dataset = parsed.datasets[record.datasetIndex ?? 0];
      if (!dataset) throw new Error(`"${record.fileName}" no longer has data set ${record.datasetIndex + 1}.`);
      // Another workspace may have been opened meanwhile: its samples are not this one.
      const current = this.getWorkspace().samples.find((s) => s.id === sampleId);
      if (!current) throw Object.assign(new Error(`"${record.name}" is no longer in the workspace.`), { name: 'AbortError' });
      this.install(current, dataset);
      return this.views.get(sampleId);
    })();
    this.loading.set(sampleId, promise);
    promise.then(() => {
      this.loading.delete(sampleId);
      this.errors.delete(sampleId);
      this.onChange?.(['data']);
    }, (error) => {
      this.loading.delete(sampleId);
      if (this.status.get(sampleId) !== 'missing') this.status.set(sampleId, 'error');
      this.errors.set(sampleId, error.message);
      this.onChange?.(['data']);
    });
    return promise;
  }

  // The compensation a sample should use, as { id, channels, matrix } or null.
  compensationFor(record, view) {
    return compensationOf(this.getWorkspace(), record, view);
  }

  syncCompensation(view, recordOverride) {
    const ws = this.getWorkspace();
    const record = recordOverride ?? ws.samples.find((s) => s.id === view.id);
    if (!record) return;
    view.record = record;
    view.syncWorkspace(ws);
    const comp = this.compensationFor(record, view);
    try {
      view.setCompensation(comp);
      view.compensationError = null;
    } catch (error) {
      view.compensationError = error.message;
      view.setCompensation(null);
    }
  }

  syncAll() {
    for (const view of this.views.values()) this.syncCompensation(view);
  }

  // Derived per-event channels (clusters, embeddings, QC masks) by sample.
  setDerived(sampleId, name, column, version) {
    if (!this.derived.has(sampleId)) this.derived.set(sampleId, new Map());
    this.derived.get(sampleId).set(name, { column, version });
    const view = this.views.get(sampleId);
    if (view) view.setDerived(name, column, version);
  }

  removeDerived(name) {
    for (const [sampleId, map] of this.derived) {
      if (map.delete(name)) this.views.get(sampleId)?.removeDerived(name);
    }
  }

  attachDerived(view) {
    const map = this.derived.get(view.id);
    if (map) {
      for (const [name, { column, version }] of map) {
        if (column.length === view.eventCount) view.setDerived(name, column, version);
      }
    }
    this.restoreDerived(view);
  }

  // Stores a derived column in the library (content-addressed) and returns its reference,
  // { sha256, length }, which the workspace's derived record keeps per sample.
  async persistColumn(column) {
    const bytes = plainCopy(column);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      if (!(await this.library.hasFile(sha256))) await this.library.putFile(sha256, bytes);
    } catch {
      this.session.set(sha256, bytes);
    }
    return { sha256, length: column.length };
  }

  // Loads the derived columns a workspace records for this sample that are not yet attached.
  async restoreDerived(view) {
    const ws = this.getWorkspace();
    const tasks = [];
    for (const record of ws.derived ?? []) {
      const files = record.files?.[view.id];
      if (!files) continue;
      for (const [name, ref] of Object.entries(files)) {
        if (view.derived.has(name) || !ref?.sha256) continue;
        tasks.push((async () => {
          const bytes = this.session.get(ref.sha256) ?? await this.library.getFile(ref.sha256).catch(() => null);
          if (!bytes || bytes.byteLength !== ref.length * 4) return;
          const column = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          if (column.length !== view.eventCount) return;
          this.setDerived(view.id, name, column, ref.sha256.slice(0, 16));
        })());
      }
    }
    if (tasks.length) {
      await Promise.all(tasks);
      this.onChange?.(['data', 'derived']);
    }
  }

  totalBytes() {
    let total = 0;
    for (const view of this.views.values()) total += view.bytes;
    return total;
  }

  // Keeps decoded samples within the budget: first drops other samples' caches (scaled columns,
  // expanded populations), then whole samples, least recently used first. The most recently used
  // sample is never evicted, even when it alone exceeds the budget (a large file must still open).
  evict() {
    let total = this.totalBytes();
    if (total <= this.budget) return;
    const order = [...this.views.keys()].filter((id) => !this.pinned.has(id)).sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    const newest = [...this.views.keys()].reduce((best, id) => ((this.lastUsed.get(id) ?? 0) > (this.lastUsed.get(best) ?? -1) ? id : best), null);
    const others = order.filter((id) => id !== newest);
    for (const id of others) {
      if (total <= this.budget * 0.8) return;
      total -= this.views.get(id).trimCaches();
    }
    for (const id of others) {
      if (total <= this.budget * 0.8) return;
      total -= this.views.get(id).bytes;
      this.views.delete(id);
      this.status.set(id, 'idle');
    }
    if (total > this.budget && newest) this.views.get(newest)?.trimCaches();
  }

  forget(sampleIds) {
    for (const id of sampleIds) {
      this.views.delete(id);
      this.status.delete(id);
      this.derived.delete(id);
    }
  }
}
