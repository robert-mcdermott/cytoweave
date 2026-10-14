// Cirro (https://cirro.bio): the parts of working with a Cirro tenant that need no page. CytoWeave
// signs in as a registered Cirro app (a Public App, Cirro-app-kit docs/app-types-and-registration.md)
// with the OAuth 2.0 authorization code flow and PKCE (RFC 7636) against the tenant's Cognito user
// pool, calls the tenant's API as the signed-in user, and reads and writes dataset files in S3 with
// the short-lived credentials the API hands out, by URLs presigned with AWS Signature Version 4
// (https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html).

// Public App registrations allow only the openid scope (Cirro-app-kit docs/authentication.md), and
// Cognito refuses a sign-in that asks for any scope the registration lacks.
export const SIGN_IN_SCOPE = 'openid';

// The user pool's own provider sends emailed sign-in links, which cannot return to an app other
// than the Cirro portal; CytoWeave offers the tenant's other providers.
export const EMAIL_LINK_PROVIDER = 'COGNITO';

// Ingest types every tenant has: flow cytometry files, and any files (what an analysis saves as).
export const FCS_PROCESS = 'fcs';
export const FILES_PROCESS = 'custom_dataset';

// Every dataset CytoWeave creates carries this tag, so its analyses can be found in any tenant.
export const APP_TAG = { key: 'cirro-app', value: 'cytoweave' };

// Cirro keeps a dataset's uploaded files under this folder.
const DATA_ROOT = 'data/';

const STATE_PREFIX = 'cytoweave-cirro';
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const encoder = new TextEncoder();

// --- Tenants and addresses ----------------------------------------------------------------------

// A tenant's address as its host name: "https://Lab.cirro.bio/project/x" → "lab.cirro.bio".
export function tenantHost(address) {
  const host = String(address ?? '').trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(host)) throw new Error(`"${String(address ?? '').trim()}" is not a Cirro address; it looks like lab.cirro.bio.`);
  return host;
}

export const apiBase = (host) => `https://${host}/api`;

// A dataset (or a project, without datasetId) in the Cirro web interface.
export const portalUrl = (host, projectId, datasetId) => `https://${host}/project/${projectId}${datasetId ? `/dataset/${datasetId}` : ''}`;

// Where Cirro's sign-in returns: this page's own address, with "localhost" for a loopback address
// (Cognito accepts plain http only for localhost). As the kit registers apps, a page at the root of
// its origin returns to the bare origin: http://localhost:8770.
export function redirectUri(pageUrl) {
  const url = new URL('.', pageUrl);
  if (LOOPBACK_NAMES.has(url.hostname)) url.hostname = 'localhost';
  return url.pathname === '/' ? url.origin : url.origin + url.pathname;
}

// The OAuth state of a sign-in: a nonce, and the host name of the page that started it, so a sign-in
// that returns to localhost can go on to the page at 127.0.0.1 (the same program) that waits for it.
export function signInState(nonce, hostname) {
  return `${STATE_PREFIX}.${nonce}.${encodeURIComponent(hostname)}`;
}

// { nonce, host } of a state signInState made, or null for any other.
export function readSignInState(state) {
  const match = new RegExp(`^${STATE_PREFIX}\\.([\\w-]+)\\.(.+)$`).exec(state ?? '');
  if (!match) return null;
  return { nonce: match[1], host: decodeURIComponent(match[2]) };
}

// Where a sign-in that returned to `pageUrl` must go on to: the same address with the host name of
// the page that started it, when that differs and both are this computer; otherwise null.
export function signInForward(pageUrl, state) {
  const url = new URL(pageUrl);
  const host = readSignInState(state)?.host;
  if (!host || host === url.hostname || !LOOPBACK_NAMES.has(host) || !LOOPBACK_NAMES.has(url.hostname)) return null;
  url.hostname = host;
  return url.href;
}

// --- OAuth --------------------------------------------------------------------------------------

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A PKCE code verifier: 32 random bytes, base64url (43 characters).
export function codeVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// The PKCE S256 code challenge of a verifier.
export async function codeChallenge(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

// The claims of a JWT. Not verified: the API verifies the token; this only reads it.
export function jwtClaims(token) {
  const part = token?.split('.')[1];
  if (!part) throw new Error('Not a JSON Web Token.');
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

// The sign-in page of the tenant's user pool (domain: /info/system's auth.endpoint); with
// identityProvider (one of the tenant's login providers), straight to that provider.
export function authorizeUrl({ domain, clientId, redirectUri: redirect, challenge, state, identityProvider }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: SIGN_IN_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (identityProvider) params.set('identity_provider', identityProvider);
  return `https://${domain}/oauth2/authorize?${params}`;
}

// The tenant's sign-in providers CytoWeave can use (from /info/system).
export function loginProviders(system) {
  return (system?.tenantInfo?.loginProviders ?? []).filter((p) => p.id !== EMAIL_LINK_PROVIDER);
}

// --- S3 -----------------------------------------------------------------------------------------

// Encodes as SigV4 requires: every byte but A–Z a–z 0–9 - . _ ~.
function awsEncode(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, text) {
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text));
}

// "s3://bucket/a/b" → { bucket, key: 'a/b' }.
export function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri ?? '');
  if (!match) throw new Error(`Not an S3 location: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

// The virtual-hosted, dual-stack endpoint of a bucket, as Cirro's own clients use.
export const s3Host = (bucket, region) => `${bucket}.s3.dualstack.${region}.amazonaws.com`;

// A presigned URL for one S3 request. credentials: { accessKeyId, secretAccessKey, sessionToken? };
// expires in seconds (at most 7 days); date: when it is signed.
export async function presignS3({ method = 'GET', host, key, region, credentials, expires = 900, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  if (credentials.sessionToken) query['X-Amz-Security-Token'] = credentials.sessionToken;
  const canonicalQuery = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`).join('&');
  const path = `/${key.split('/').map(awsEncode).join('/')}`;
  const canonical = [method, path, canonicalQuery, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))].join('\n');
  let signingKey = await hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// The S3 key a file uploaded as `name` gets in a new dataset (uploadPath from the upload request).
export const uploadKey = (uploadPath, name) => `${uploadPath.replace(/\/+$/, '')}/${name}`;

// The path in the dataset's manifest of a file uploaded as `name`: its key below the dataset's own
// folder (datasets/<id>/data/x.fcs → data/x.fcs).
export function manifestPath(uploadPath, datasetId, name) {
  const key = uploadKey(uploadPath, name);
  const folder = `${datasetId}/`;
  const at = key.indexOf(folder);
  if (at < 0) throw new Error(`Cirro's upload location (${uploadPath}) is not in the dataset's folder.`);
  return key.slice(at + folder.length);
}

// --- Datasets -----------------------------------------------------------------------------------

// What CytoWeave opens, by extension (as app.importFiles sorts dropped files); '' for the rest.
export function fileKind(name) {
  const lower = name.toLowerCase();
  if (/\.(fcs|lmd)$/.test(lower)) return 'fcs';
  if (/\.(cwz|json)$/.test(lower)) return 'workspace';
  if (/\.(wspt?|flowjo)$/.test(lower)) return 'flowjo';
  if (/\.xml$/.test(lower)) return 'gating-ml';
  if (/\.(csv|tsv|txt)$/.test(lower)) return 'table';
  if (/\.(acs|zip)$/.test(lower)) return 'archive';
  if (/\.(svg|png|pdf)$/.test(lower)) return 'figure';
  if (/\.cwt$/.test(lower)) return 'template';
  if (/\.expt$/.test(lower)) return 'spectroflo';
  return '';
}

// The files of a dataset's manifest (GET /projects/{id}/datasets/{id}/files): [{ path (in the
// manifest, which identifies the file), relativePath (below data/, as the user sees the dataset),
// name, size, uri (s3://…), kind }].
export function datasetFiles(manifest) {
  const domain = (manifest?.domain ?? '').replace(/\/+$/, '');
  const files = manifest?.files ?? [];
  const underData = files.length > 0 && files.every((f) => f.path.startsWith(DATA_ROOT));
  return files.map((f) => {
    const relativePath = underData ? f.path.slice(DATA_ROOT.length) : f.path;
    const name = relativePath.split('/').pop();
    return { path: f.path, relativePath, name, size: f.size ?? null, uri: `${domain}/${f.path}`, kind: fileKind(name) };
  });
}

// One folder of a dataset (folder: a relativePath prefix without its slash, '' for the top):
// { folders: [{ name, path, files, openable, size }], files } sorted by name, each subfolder
// counting every file below it.
export function folderListing(files, folder) {
  const prefix = folder ? `${folder}/` : '';
  const folders = new Map();
  const direct = [];
  for (const file of files) {
    if (!file.relativePath.startsWith(prefix)) continue;
    const rest = file.relativePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      direct.push(file);
      continue;
    }
    const name = rest.slice(0, slash);
    const entry = folders.get(name) ?? { name, path: prefix + name, files: 0, openable: 0, size: 0 };
    entry.files += 1;
    if (file.kind) entry.openable += 1;
    entry.size += file.size ?? 0;
    folders.set(name, entry);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  return { folders: [...folders.values()].sort(byName), files: direct.sort(byName) };
}

// The sample group each opened file joins: the dataset's name when the FCS files come from one
// folder, and "<dataset>/<folder>" when they come from several, as a dropped folder's files join a
// group named after it. Map(path → group name).
export function groupNames(files, datasetName) {
  const parent = (f) => f.relativePath.split('/').slice(0, -1).join('/');
  const parents = new Set(files.filter((f) => f.kind === 'fcs').map(parent));
  return new Map(files.map((f) => [f.path, parents.size > 1 && parent(f) ? `${datasetName}/${parent(f)}` : datasetName]));
}

// Cirro's sample metadata (GET /projects/{id}/datasets/{id}/samples) as CytoWeave annotations, by
// file name: Map(file name → { sample, ...fields }). Text and number values only, under lower-case
// names as CytoWeave's annotation tables keep them.
export function sampleMetaByFile(samples) {
  const out = new Map();
  for (const sample of samples ?? []) {
    const meta = { sample: sample.name };
    for (const [key, value] of Object.entries(sample.metadata ?? {})) {
      if (value === null || value === undefined || value === '' || typeof value === 'object') continue;
      meta[key.toLowerCase()] = String(value);
    }
    for (const file of sample.files ?? []) out.set(file.path.split('/').pop(), meta);
  }
  return out;
}
