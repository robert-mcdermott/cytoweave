// Cirro (https://cirro.bio): signing in to a Cirro tenant as a registered app, and the session that
// lists projects, datasets and files, reads and writes files in S3, and leaves notes. Opening files
// is in cirro-open.js, saving an analysis in cirro-save.js. Tokens are kept in memory only: a sign-in
// lasts until the window closes (Cirro-app-kit docs/authentication.md).

import { h, icon, clear } from './dom.js';
import { showDialog, toast } from './overlays.js';
import { prefs } from './storage.js';
import {
  APP_TAG,
  apiBase,
  authorizeUrl,
  base64url,
  codeChallenge,
  codeVerifier,
  datasetFiles,
  jwtClaims,
  loginProviders,
  parseS3Uri,
  presignS3,
  readSignInState,
  redirectUri,
  s3Host,
  signInForward,
  signInState,
  tenantHost,
  uploadKey,
} from '../lib/cirro.js';

const SIGN_IN_CHANNEL = 'cytoweave-cirro-sign-in';
const SIGN_IN_WINDOW = 'cytoweave-cirro-sign-in';
// A sign-in in this window (when pop-ups are blocked), kept while the window is at the sign-in page.
const PENDING_SIGN_IN = 'cytoweave:cirro-sign-in';
// Tokens and file credentials are renewed this long before they expire.
const RENEW_MARGIN_MS = 2 * 60 * 1000;
const DATASET_PAGE = 1000;
const MANIFEST_PAGE = 5000;

// The sign-in window comes back to CytoWeave's own address with ?code=…&state=… (or ?error=…). On
// that page this hands them to the window that started the sign-in, and CytoWeave does not start.
// Returns whether the page was such a return.
export function finishCirroSignIn() {
  const params = new URLSearchParams(location.search);
  const state = params.get('state');
  if (!readSignInState(state) || !(params.has('code') || params.has('error'))) return false;
  const forward = signInForward(location.href, state);
  if (forward) {
    location.replace(forward);
    return true;
  }
  // A sign-in this window started itself is finished by CytoWeave as it starts (resumeSignIn).
  if (pendingSignIn()?.state === state) return false;
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
  channel.postMessage({ state, code: params.get('code'), error: params.get('error'), description: params.get('error_description') });
  channel.close();
  history.replaceState(null, '', location.pathname);
  document.title = 'Cirro sign-in · CytoWeave';
  document.body.replaceChildren(h('div.empty', { style: { marginTop: '20vh' } }, icon('check'),
    h('h3', params.has('code') ? 'Signed in to Cirro' : 'Cirro did not sign you in'),
    h('p', 'You can close this window and go back to CytoWeave.')));
  window.close();
  return true;
}

function pendingSignIn() {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING_SIGN_IN));
  } catch {
    return null;
  }
}

class CirroError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Reads a tenant's public configuration (/info/system): its Cognito user pool, sign-in providers,
// name and region.
async function tenantSystem(host) {
  let response;
  try {
    response = await fetch(`${apiBase(host)}/info/system`, { cache: 'no-store' });
  } catch {
    throw new Error(`Could not reach ${host}. Check the address and your connection.`);
  }
  if (!response.ok) throw new Error(`${host} did not answer as a Cirro tenant (HTTP ${response.status}).`);
  const system = await response.json().catch(() => null);
  if (!system?.auth?.endpoint) throw new Error(`${host} did not answer as a Cirro tenant.`);
  if (system.maintenanceModeEnabled) throw new Error(`${system.tenantInfo?.name ?? host} is down for maintenance. Try again later.`);
  return system;
}

class CirroSession {
  constructor(host, clientId, system, onChange) {
    this.host = host;
    this.clientId = clientId;
    this.system = system;
    this.onChange = onChange;
    this.tokens = null;
    this.renewing = null;
    this.credentials = new Map();
    this.manifests = new Map();
    this.details = new Map();
    // Optional features Cirro refused (403) in this session, by feature and project: not asked again.
    this.refused = new Set();
  }

  get signedIn() {
    return Boolean(this.tokens);
  }

  get tenantName() {
    return this.system.tenantInfo?.name ?? this.host;
  }

  get userName() {
    const claims = this.tokens ? jwtClaims(this.tokens.idToken) : {};
    return claims.email ?? claims.name ?? claims['cognito:username'] ?? '';
  }

  // A sign-in request: { url of the tenant's sign-in page, state, verifier, redirect }.
  async signInRequest(identityProvider) {
    const verifier = codeVerifier();
    const state = signInState(base64url(crypto.getRandomValues(new Uint8Array(16))), location.hostname);
    const redirect = redirectUri(location.href);
    const url = authorizeUrl({ domain: this.system.auth.endpoint, clientId: this.clientId, redirectUri: redirect, challenge: await codeChallenge(verifier), state, identityProvider });
    return { url, state, verifier, redirect };
  }

  // Signs in through a window of the tenant's sign-in page. The window is opened before anything is
  // awaited, while the click that asked for it still allows a window to open. Abort with signal.
  async signIn(identityProvider, signal) {
    const popup = window.open('', SIGN_IN_WINDOW, 'popup,width=520,height=720');
    if (!popup) throw Object.assign(new Error('The browser blocked the sign-in window.'), { popupBlocked: true });
    const request = await this.signInRequest(identityProvider);
    const reply = waitForSignIn(request.state, signal);
    popup.location.href = request.url;
    await this.finishSignIn(await reply, request);
  }

  // Signs in by taking this window to the tenant's sign-in page; CytoWeave starts again when it
  // returns, finishes the sign-in and reopens the workspace (resumeSignIn).
  async signInHere(identityProvider, workspaceId) {
    const { url, state, verifier, redirect } = await this.signInRequest(identityProvider);
    sessionStorage.setItem(PENDING_SIGN_IN, JSON.stringify({ host: this.host, clientId: this.clientId, state, verifier, redirect, workspaceId }));
    location.assign(url);
  }

  async finishSignIn({ code, error, description }, { verifier, redirect }) {
    if (error) throw new Error(`Cirro did not sign you in: ${description || error}.`);
    this.keepTokens(await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }));
  }

  signOut() {
    this.tokens = null;
    this.credentials.clear();
    this.onChange();
  }

  async tokenRequest(params) {
    const response = await fetch(`https://${this.system.auth.endpoint}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...params }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Cirro sign-in failed: ${body.error_description || body.error || `HTTP ${response.status}`}.`);
    return body;
  }

  keepTokens(body) {
    this.tokens = {
      accessToken: body.access_token,
      idToken: body.id_token,
      // A renewal does not return a new refresh token.
      refreshToken: body.refresh_token ?? this.tokens?.refreshToken,
      expires: Date.now() + body.expires_in * 1000,
    };
    this.onChange();
  }

  // A current access token, renewed with the refresh token when it is about to expire.
  async accessToken() {
    if (!this.tokens) throw new CirroError(401, 'Sign in to Cirro first.');
    if (Date.now() < this.tokens.expires - RENEW_MARGIN_MS) return this.tokens.accessToken;
    this.renewing ??= this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken })
      .then((body) => this.keepTokens(body), (error) => {
        this.signOut();
        throw new CirroError(401, `Your Cirro sign-in has expired; sign in again. (${error.message})`);
      })
      .finally(() => { this.renewing = null; });
    await this.renewing;
    return this.tokens.accessToken;
  }

  async api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${apiBase(this.host)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Some calls (posting a message) succeed with an empty body.
    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    const message = (await response.json().catch(() => ({}))).message || `HTTP ${response.status}`;
    if (response.status === 401) {
      this.signOut();
      throw new CirroError(401, `Cirro ended the sign-in; sign in again. (${message})`);
    }
    // A refusal comes from the user's role in the project or from what the tenant granted CytoWeave,
    // and the response may not say which (Cirro-app-kit docs/permissions.md).
    if (response.status === 403) throw new CirroError(403, `Cirro refused: ${message}. A project owner can change your role, or your Cirro admins can grant CytoWeave this permission.`);
    throw new CirroError(response.status, `Cirro: ${message}`);
  }

  projects() {
    return this.api('/projects');
  }

  // Every dataset of a project, a page of DATASET_PAGE at a time.
  async datasets(projectId) {
    const all = [];
    let nextToken = null;
    do {
      const page = await this.api(`/projects/${projectId}/datasets?limit=${DATASET_PAGE}${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`);
      all.push(...(page.data ?? []));
      nextToken = page.nextToken || null;
    } while (nextToken);
    return all;
  }

  async dataset(projectId, datasetId) {
    const key = `${projectId}/${datasetId}`;
    if (!this.details.has(key)) this.details.set(key, this.api(`/projects/${projectId}/datasets/${datasetId}`).catch((error) => { this.details.delete(key); throw error; }));
    return this.details.get(key);
  }

  // A dataset's files (datasetFiles), every page of its manifest.
  async files(projectId, datasetId) {
    const key = `${projectId}/${datasetId}`;
    if (!this.manifests.has(key)) {
      this.manifests.set(key, (async () => {
        const all = [];
        let domain = '';
        for (;;) {
          const page = await this.api(`/projects/${projectId}/datasets/${datasetId}/files?fileOffset=${all.length}&fileLimit=${MANIFEST_PAGE}`);
          domain = page.domain ?? domain;
          all.push(...(page.files ?? []));
          if (!page.files?.length || all.length >= (page.totalFiles ?? all.length)) break;
        }
        return datasetFiles({ domain, files: all });
      })().catch((error) => { this.manifests.delete(key); throw error; }));
    }
    return this.manifests.get(key);
  }

  samples(projectId, datasetId) {
    return this.api(`/projects/${projectId}/datasets/${datasetId}/samples`);
  }

  // Short-lived AWS credentials for a project's files, kept until shortly before they expire.
  // Concurrent requests share one: the API answers 429 to several at once.
  credentialsFor(projectId, accessType, datasetId = null) {
    const key = `${projectId}:${accessType}:${datasetId ?? ''}`;
    const kept = this.credentials.get(key);
    if (kept && (kept.pending || Date.now() < kept.expires - RENEW_MARGIN_MS)) return kept.value;
    const value = this.api(`/projects/${projectId}/s3-token`, { method: 'POST', body: { accessType, datasetId } });
    const entry = { value, pending: true, expires: 0 };
    this.credentials.set(key, entry);
    value.then((c) => Object.assign(entry, { pending: false, expires: new Date(c.expiration).getTime() }), () => this.credentials.delete(key));
    return value;
  }

  // Downloads a file of a dataset (a datasetFiles entry) as a Blob. onProgress(bytes so far).
  async download(projectId, datasetId, file, onProgress) {
    // A dataset shared from another project is read with credentials for that dataset alone.
    const detail = await this.dataset(projectId, datasetId);
    const credentials = await (detail.share
      ? this.credentialsFor(projectId, 'SHARED_DATASET_DOWNLOAD', datasetId)
      : this.credentialsFor(projectId, 'PROJECT_DOWNLOAD'));
    const { bucket, key } = parseS3Uri(file.uri);
    const region = credentials.region ?? this.system.region;
    const url = await presignS3({ host: s3Host(bucket, region), key, region, credentials });
    const response = await fetch(url);
    if (!response.ok) throw new CirroError(response.status, `${file.name} could not be read from Cirro (HTTP ${response.status}).`);
    if (!onProgress || !response.body) return response.blob();
    const parts = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      onProgress(received);
    }
    return new Blob(parts);
  }

  // Creates a dataset tagged as CytoWeave's that expects these files (names are paths within the
  // dataset); Cirro completes it when all have been uploaded. Returns { id, uploadPath, bucket }.
  createDataset(projectId, { name, description, processId, fileNames }) {
    return this.api(`/projects/${projectId}/datasets/upload`, {
      method: 'POST',
      body: { name, description, processId, expectedFiles: fileNames, tags: [APP_TAG] },
    });
  }

  // Uploads the files ({ name, blob }) of a dataset createDataset made. onProgress(fraction, name).
  async uploadFiles(projectId, created, files, onProgress) {
    const credentials = await this.api(`/projects/${projectId}/s3-token`, { method: 'POST', body: { accessType: 'DATASET_UPLOAD', datasetId: created.id } });
    const region = credentials.region ?? this.system.region;
    const total = files.reduce((sum, f) => sum + f.blob.size, 0) || 1;
    let sent = 0;
    for (const file of files) {
      onProgress?.(sent / total, file.name);
      const url = await presignS3({ method: 'PUT', host: s3Host(created.bucket, region), key: uploadKey(created.uploadPath, file.name), region, credentials });
      const response = await fetch(url, { method: 'PUT', body: file.blob });
      if (!response.ok) throw new CirroError(response.status, `${file.name} could not be uploaded to Cirro (HTTP ${response.status}).`);
      sent += file.blob.size;
    }
  }

  // A note on a dataset, saying what made it (Cirro-app-kit docs/building-on-cirro.md, provenance).
  async addNote(projectId, datasetId, { title, subtitle, text }) {
    const discussion = await this.api('/discussions', {
      method: 'POST',
      body: { name: title, description: subtitle, entity: { type: 'DATASET', id: datasetId }, type: 'NOTES', projectId },
    });
    await this.api(`/discussions/${discussion.id}/messages`, { method: 'POST', body: { message: text } });
  }
}

// Resolves with the reply to the sign-in with this state (finishCirroSignIn posts it).
function waitForSignIn(state, signal) {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    const stop = () => {
      channel.close();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop();
      reject(Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' }));
    };
    channel.onmessage = (event) => {
      if (event.data?.state !== state) return;
      stop();
      resolve(event.data);
    };
    signal?.addEventListener('abort', abort);
  });
}

export function installCirro(app) {
  const { store, data } = app;
  // The program started with --no-cirro allows pages to reach only itself; Cirro is not offered.
  if (app.info?.cirro === false) {
    data.remoteSource = async (record) => {
      throw new Error(`The file of "${record.name}" is in Cirro (${record.cirro.host}), and this CytoWeave was started with --no-cirro.`);
    };
    app.cirro = { enabled: false, session: null };
    return;
  }
  let session = null;
  const notify = () => store.notify(['cirro']);

  async function connectTo(host, clientId) {
    const system = await tenantSystem(host);
    session = new CirroSession(host, clientId, system, notify);
    prefs.set('cirro', { host, clientId });
    notify();
    return session;
  }

  // The connection dialog: the tenant and CytoWeave's client ID there, then sign-in. Resolves with
  // the signed-in session, or null when closed first.
  function connectionDialog() {
    return new Promise((resolve) => {
      const saved = prefs.get('cirro', null);
      const body = h('div');
      let pending = null;
      const dialog = showDialog({
        title: 'Cirro',
        content: body,
        buttons: [{ label: 'Close' }],
        onClose: () => {
          pending?.abort();
          resolve(session?.signedIn ? session : null);
        },
      });

      const redirect = redirectUri(location.href);
      function setupForm(problem) {
        const address = h('input.input', { value: session?.host ?? saved?.host ?? '', placeholder: 'lab.cirro.bio', 'aria-label': 'Cirro address', spellcheck: false });
        const clientId = h('input.input.mono', { value: session?.clientId ?? saved?.clientId ?? '', placeholder: 'from your Cirro admins', 'aria-label': 'Client ID', spellcheck: false });
        const status = h('div', problem ? h('div.callout.danger', problem) : null);
        const submit = async () => {
          let host;
          try {
            host = tenantHost(address.value);
            if (!clientId.value.trim()) throw new Error('Enter the client ID your Cirro admins gave CytoWeave.');
          } catch (error) {
            replaceStatus(status, error.message);
            return;
          }
          replaceStatus(status, null, `Connecting to ${host}…`);
          try {
            await connectTo(host, clientId.value.trim());
            render();
          } catch (error) {
            replaceStatus(status, error.message);
          }
        };
        for (const input of [address, clientId]) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
        clear(body).append(
          h('p', 'Open FCS files, workspaces and sample annotations from your Cirro projects, and save analyses to them. CytoWeave signs in as you and reaches only what your Cirro account can; files are still analyzed on this computer.'),
          h('label.field', h('span', 'Cirro address'), address),
          h('label.field', h('span', 'CytoWeave\'s client ID on that Cirro'), clientId),
          h('div.callout', { style: { display: 'block' } },
            h('div', 'Your Cirro admins register CytoWeave as an app (a Public App) and give you its client ID. They need its sign-in address:'),
            h('div.row', { style: { marginTop: '6px' } },
              h('code.mono', redirect),
              h('button.btn.small', { type: 'button', onclick: () => navigator.clipboard.writeText(redirect).then(() => toast('Copied.', { timeout: 1200 })) }, icon('copy'), 'Copy')),
            h('div.muted', { style: { marginTop: '6px', fontSize: '11.5px' } }, 'and the permissions in CytoWeave\'s cirro-permissions.json.')),
          status,
          h('div.btn-row', h('button.btn.primary', { type: 'button', onclick: submit }, 'Continue')));
      }

      function signInView() {
        const providers = loginProviders(session.system);
        const status = h('div');
        const start = (provider) => {
          pending = new AbortController();
          const signal = pending.signal;
          const signing = session.signIn(provider.id, signal);
          replaceStatus(status, null, h('span', 'Finish signing in in the window that opened. ', h('button.btn.small', { type: 'button', onclick: () => pending?.abort() }, 'Cancel')));
          signing.then(() => {
            pending = null;
            toast(`Signed in to ${session.tenantName}.`, { kind: 'ok' });
            dialog.close();
          }, (error) => {
            pending = null;
            if (error.name === 'AbortError') replaceStatus(status, null);
            else if (error.popupBlocked) {
              clear(status).append(h('div.callout.warn', { style: { display: 'block' } }, 'The browser blocked the sign-in window. Allow pop-ups for CytoWeave, or sign in in this window: CytoWeave saves the workspace and reopens it after you sign in.',
                h('div.btn-row', { style: { marginTop: '8px' } }, h('button.btn.small', { type: 'button', onclick: () => signInHere(provider) }, 'Sign in in this window'))));
            } else replaceStatus(status, error.message);
          });
        };
        const signInHere = async (provider) => {
          await app.saveNow();
          const ws = store.ws;
          session.signInHere(provider.id, ws.samples.length || ws.gates.length ? ws.id : null).catch((error) => replaceStatus(status, error.message));
        };
        clear(body).append(
          h('p', h('b', session.tenantName), ` (${session.host})`),
          h('div.btn-row', ...providers.map((p) => h('button.btn.primary', { type: 'button', onclick: () => start(p) }, /^sign in/i.test(p.name) ? p.name : `Sign in with ${p.name}`)),
            providers.length ? null : h('span.muted', 'This Cirro offers no sign-in CytoWeave can use.')),
          status,
          h('p.muted', { style: { marginTop: '12px', fontSize: '11.5px' } }, 'If the sign-in window reports redirect_mismatch, CytoWeave\'s registration on this Cirro lacks the sign-in address ', h('code.mono', redirect), '; invalid_client means the client ID is not for this Cirro.'),
          h('div.btn-row', h('button.btn.small', { type: 'button', onclick: () => setupForm() }, 'Use another Cirro or client ID')));
      }

      function signedInView() {
        clear(body).append(
          h('div.callout.ok', { style: { display: 'block' } }, 'Signed in to ', h('b', session.tenantName), ` (${session.host})`, session.userName ? ` as ${session.userName}` : '', '.'),
          h('div.btn-row', { style: { marginTop: '10px' } },
            h('button.btn', { type: 'button', onclick: () => { session.signOut(); render(); } }, 'Sign out'),
            h('button.btn', { type: 'button', onclick: () => { session.signOut(); setupForm(); } }, 'Use another Cirro')));
      }

      async function render() {
        if (session?.signedIn) return signedInView();
        if (session) return signInView();
        if (!saved?.host || !saved?.clientId) return setupForm();
        clear(body).append(h('p.muted', `Connecting to ${saved.host}…`));
        try {
          await connectTo(saved.host, saved.clientId);
          signInView();
        } catch (error) {
          setupForm(error.message);
        }
      }
      render();
    });
  }

  function replaceStatus(status, problem, note) {
    clear(status).append(problem ? h('div.callout.danger', problem) : note ? h('p.muted', note) : null);
  }

  // The signed-in session, asking to connect or sign in first when needed; null when the user
  // closed the dialog instead.
  async function signedIn() {
    return session?.signedIn ? session : connectionDialog();
  }

  // A sample opened from Cirro whose file is not in the library (a workspace saved to Cirro, opened
  // on another computer) is read from Cirro again.
  data.remoteSource = async (record) => {
    const origin = record.cirro;
    if (!session?.signedIn || session.host !== origin.host) throw new Error(`The file of "${record.name}" is in Cirro (${origin.host}). Sign in to Cirro (Workspace → Cirro) to read it.`);
    const file = (await session.files(origin.projectId, origin.datasetId)).find((f) => f.path === origin.path);
    if (!file) throw new Error(`The file of "${record.name}" is no longer in its Cirro dataset (${origin.path}).`);
    return session.download(origin.projectId, origin.datasetId, file);
  };

  // Finishes a sign-in this window went to the sign-in page for (signInHere), and reopens the
  // workspace that was open.
  async function resumeSignIn() {
    const pending = pendingSignIn();
    const params = new URLSearchParams(location.search);
    if (!pending || params.get('state') !== pending.state) return;
    sessionStorage.removeItem(PENDING_SIGN_IN);
    history.replaceState(null, '', location.pathname);
    try {
      await connectTo(pending.host, pending.clientId);
      await session.finishSignIn({ code: params.get('code'), error: params.get('error'), description: params.get('error_description') }, pending);
      if (pending.workspaceId) await app.openWorkspace(pending.workspaceId);
      toast(`Signed in to ${session.tenantName}.`, { kind: 'ok', action: { label: 'Open from Cirro', onClick: () => app.cirro.open() } });
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  }

  app.cirro = {
    enabled: true,
    get session() {
      return session;
    },
    resumeSignIn,
    connect: connectionDialog,
    open: async () => {
      const signed = await signedIn();
      if (signed) (await import('./cirro-open.js')).openFromCirro(app, signed);
    },
    save: async () => {
      if (!store.ws.samples.length && !store.ws.gates.length) {
        toast('There is nothing to save yet: open FCS files first.');
        return;
      }
      const signed = await signedIn();
      if (signed) (await import('./cirro-save.js')).saveToCirro(app, signed);
    },
  };
}
