import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeUrl,
  codeChallenge,
  codeVerifier,
  datasetFiles,
  fileKind,
  folderListing,
  groupNames,
  jwtClaims,
  loginProviders,
  manifestPath,
  parseS3Uri,
  portalUrl,
  presignS3,
  readSignInState,
  redirectUri,
  s3Host,
  sampleMetaByFile,
  signInForward,
  signInState,
  tenantHost,
  uploadKey,
} from './cirro.js';

test('presigned GET matches the example in the S3 SigV4 query-string documentation', async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = await presignS3({
    host: 'examplebucket.s3.amazonaws.com',
    key: 'test.txt',
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    expires: 86400,
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('presigned URLs keep path separators, encode the rest of the key and carry the session token', async () => {
  const url = new URL(await presignS3({
    method: 'PUT',
    host: s3Host('project-1', 'us-west-2'),
    key: uploadKey('datasets/d1/data/', 'fcs/Specimen 001 (A1).fcs'),
    region: 'us-west-2',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'tok/en+=' },
    date: new Date('2026-10-05T12:00:00Z'),
  }));
  assert.equal(url.host, 'project-1.s3.dualstack.us-west-2.amazonaws.com');
  assert.equal(url.pathname, '/datasets/d1/data/fcs/Specimen%20001%20%28A1%29.fcs');
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'tok/en+=');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('an uploaded file\'s manifest path is its key below the dataset\'s folder', () => {
  assert.equal(manifestPath('datasets/d-1/data/', 'd-1', 'fcs/A1.fcs'), 'data/fcs/A1.fcs');
  assert.equal(manifestPath('datasets/d-1/data', 'd-1', 'run.cwz'), 'data/run.cwz');
  assert.throws(() => manifestPath('uploads/x', 'd-1', 'a.fcs'), /not in the dataset/);
});

test('PKCE S256 challenge of the RFC 7636 appendix B verifier', async () => {
  assert.equal(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.match(codeVerifier(), /^[A-Za-z0-9_-]{43}$/);
});

test('a tenant is named by its host, however its address is written', () => {
  assert.equal(tenantHost(' https://Lab.cirro.bio/project/123 '), 'lab.cirro.bio');
  assert.equal(tenantHost('dev.cirro.bio'), 'dev.cirro.bio');
  assert.throws(() => tenantHost(''), /not a Cirro address/);
  assert.throws(() => tenantHost('not an address'), /not a Cirro address/);
  assert.equal(portalUrl('dev.cirro.bio', 'p1', 'd1'), 'https://dev.cirro.bio/project/p1/dataset/d1');
});

test('sign-in returns to the page\'s own address, as localhost for this computer', () => {
  assert.equal(redirectUri('http://127.0.0.1:8770/'), 'http://localhost:8770');
  assert.equal(redirectUri('http://127.0.0.1:8770/?x=1#y'), 'http://localhost:8770');
  assert.equal(redirectUri('http://[::1]:8771/index.html'), 'http://localhost:8771');
  assert.equal(redirectUri('https://example.org/cytoweave/app/index.html'), 'https://example.org/cytoweave/app/');
});

test('a sign-in that returns to localhost goes on to the loopback address that started it', () => {
  const state = signInState('n0nce', '127.0.0.1');
  assert.deepEqual(readSignInState(state), { nonce: 'n0nce', host: '127.0.0.1' });
  assert.equal(signInForward(`http://localhost:8770/?code=c&state=${encodeURIComponent(state)}`, state), `http://127.0.0.1:8770/?code=c&state=${encodeURIComponent(state)}`);
  assert.equal(signInForward('http://127.0.0.1:8770/?code=c', state), null, 'already there');
  assert.equal(signInForward('http://localhost:8770/?code=c', signInState('n', '[::1]')), 'http://[::1]:8770/?code=c');
  // Never to another computer, and never from a page that is not this computer.
  assert.equal(signInForward('http://localhost:8770/?code=c', signInState('n', 'evil.example')), null);
  assert.equal(signInForward('https://example.org/?code=c', state), null);
  assert.equal(readSignInState('someone-else'), null);
});

test('the sign-in URL asks the tenant\'s user pool for a PKCE code with the openid scope only', () => {
  const url = new URL(authorizeUrl({ domain: 'pool.auth.us-west-2.amazoncognito.com', clientId: 'client', redirectUri: 'http://localhost:8770', challenge: 'c', state: 's' }));
  assert.equal(url.origin + url.pathname, 'https://pool.auth.us-west-2.amazoncognito.com/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8770');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.has('identity_provider'), false);
  const direct = new URL(authorizeUrl({ domain: 'd', clientId: 'c', redirectUri: 'r', challenge: 'c', state: 's', identityProvider: 'ORCID' }));
  assert.equal(direct.searchParams.get('identity_provider'), 'ORCID');
  const system = { tenantInfo: { loginProviders: [{ id: 'Cirro' }, { id: 'COGNITO' }, { id: 'ORCID' }] } };
  assert.deepEqual(loginProviders(system).map((p) => p.id), ['Cirro', 'ORCID']);
});

test('token claims are read, including text outside ASCII', () => {
  const payload = Buffer.from(JSON.stringify({ 'cognito:username': 'u1', exp: 1000, email: 'ü@example.org' })).toString('base64url');
  assert.equal(jwtClaims(`e30.${payload}.sig`).email, 'ü@example.org');
  assert.throws(() => jwtClaims('nope'), /JSON Web Token/);
});

test('a dataset\'s manifest lists its files below data/, with what CytoWeave makes of each', () => {
  const files = datasetFiles({
    domain: 's3://project-1/datasets/d1/',
    files: [
      { path: 'data/plate1/A1.fcs', size: 10 },
      { path: 'data/plate1/A2.FCS', size: 12 },
      { path: 'data/samplesheet.csv', size: 2 },
      { path: 'data/notes.docx', size: 3 },
      { path: 'data/gates.wsp', size: 4 },
    ],
  });
  assert.deepEqual(files.map((f) => [f.relativePath, f.kind, f.uri]), [
    ['plate1/A1.fcs', 'fcs', 's3://project-1/datasets/d1/data/plate1/A1.fcs'],
    ['plate1/A2.FCS', 'fcs', 's3://project-1/datasets/d1/data/plate1/A2.FCS'],
    ['samplesheet.csv', 'table', 's3://project-1/datasets/d1/data/samplesheet.csv'],
    ['notes.docx', '', 's3://project-1/datasets/d1/data/notes.docx'],
    ['gates.wsp', 'flowjo', 's3://project-1/datasets/d1/data/gates.wsp'],
  ]);
  assert.deepEqual(parseS3Uri(files[0].uri), { bucket: 'project-1', key: 'datasets/d1/data/plate1/A1.fcs' });
  assert.throws(() => parseS3Uri('https://example.org/x'));
  // A manifest with files outside data/ keeps their full paths.
  assert.deepEqual(datasetFiles({ domain: 's3://b/datasets/d2', files: [{ path: 'data/a.fcs' }, { path: 'out/b.cwz' }] }).map((f) => f.relativePath), ['data/a.fcs', 'out/b.cwz']);
});

test('a folder of a dataset lists its subfolders, with what is below them, and its own files', () => {
  const files = datasetFiles({
    domain: 's3://b/datasets/d',
    files: [
      { path: 'data/fcs/Tube 10.fcs', size: 5 },
      { path: 'data/fcs/Tube 2.fcs', size: 5 },
      { path: 'data/fcs/day 2/Tube 1.fcs', size: 7 },
      { path: 'data/logs/run.log', size: 1 },
      { path: 'data/annotations.csv', size: 3 },
    ],
  });
  const top = folderListing(files, '');
  assert.deepEqual(top.folders, [
    { name: 'fcs', path: 'fcs', files: 3, openable: 3, size: 17 },
    { name: 'logs', path: 'logs', files: 1, openable: 0, size: 1 },
  ]);
  assert.deepEqual(top.files.map((f) => f.name), ['annotations.csv']);
  const fcs = folderListing(files, 'fcs');
  assert.deepEqual(fcs.folders.map((f) => f.path), ['fcs/day 2']);
  assert.deepEqual(fcs.files.map((f) => f.name), ['Tube 2.fcs', 'Tube 10.fcs'], 'numbers in names sort as numbers');
});

test('opened FCS files join a group named after their dataset, and after their folder when they come from several', () => {
  const files = datasetFiles({ domain: 's3://b/datasets/d', files: [{ path: 'data/fcs/a.fcs' }, { path: 'data/fcs/b.fcs' }, { path: 'data/meta.csv' }] });
  assert.deepEqual([...groupNames(files, 'Run 7').values()], ['Run 7', 'Run 7', 'Run 7']);
  const plates = datasetFiles({ domain: 's3://b/datasets/d', files: [{ path: 'data/plate1/a.fcs' }, { path: 'data/plate2/a.fcs' }, { path: 'data/top.fcs' }] });
  assert.deepEqual([...groupNames(plates, 'Screen').values()], ['Screen/plate1', 'Screen/plate2', 'Screen']);
});

test('Cirro sample metadata annotates samples by file name', () => {
  const meta = sampleMetaByFile([
    { name: 'TU0049', metadata: { Condition: 'stim', Day: 7, extra: null, nested: { a: 1 } }, files: [{ path: 's3://p/datasets/d1/data/Specimen_001_TU0049_001.fcs' }] },
    { name: 'TU0050', metadata: {}, files: null },
  ]);
  assert.deepEqual(meta.get('Specimen_001_TU0049_001.fcs'), { sample: 'TU0049', condition: 'stim', day: '7' });
  assert.equal(meta.size, 1);
});

test('file kinds follow what CytoWeave opens when files are dropped', () => {
  assert.deepEqual(['a.fcs', 'b.LMD', 'w.cwz', 'f.wsp', 'f.flowjo', 'g.xml', 't.tsv', 'x.acs', 'p.pdf', 't.cwt', 'e.Expt', 'r.docx'].map(fileKind),
    ['fcs', 'fcs', 'workspace', 'flowjo', 'flowjo', 'gating-ml', 'table', 'archive', 'figure', 'template', 'spectroflo', '']);
});
