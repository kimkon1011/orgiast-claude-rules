// CI-only transport fixture. The normal receiver CLI still authenticates, decodes,
// validates all seven hashes, and installs the files. No production data or keys.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { FILES, HUB_ID, FOLDER_NAME } from '../../tools/knowledge-pack.mjs';

assert.ok(process.env.ORGIAST_HOME, 'fixture requires an explicit target home');
assert.ok(process.argv.includes('--knowledge-only') && process.argv.includes('--knowledge-receiver'));
const secret = 'ci-only-synthetic-enrollment';
process.env.ORGIAST_KEYSERVE_SECRET = secret;
process.env.ORGIAST_KEYSERVE_PC = 'clean-install-fixture';
process.env.ORGIAST_CHANNEL_BASE_URL = 'https://knowledge-ci.invalid';
process.env.GOOGLE_SA_KEY = path.join(process.env.ORGIAST_HOME, 'ci-missing-google-key.json');
const contents = new Map(FILES.map((name, i) => [`ci-file-${i}`, Buffer.from(`# CI fixture: ${name}\n制作・営業ナレッジの受信検証用。\n`)]));
const manifest = { version: 1, files: FILES.map((name, i) => {
  const id = `ci-file-${i}`, bytes = contents.get(id);
  return { name, id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}) };
contents.set('ci-manifest', Buffer.from(JSON.stringify(manifest)));
const json = value => Buffer.from(JSON.stringify(value));

// Never fall through to real fetch: unexpected requests fail the installation.
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input), headers = new Headers(options.headers);
  assert.equal(url.origin, process.env.ORGIAST_CHANNEL_BASE_URL);
  assert.equal(url.pathname, '/api/gws');
  assert.equal(options.method, 'GET');
  assert.equal(url.searchParams.get('service'), 'drive');
  assert.equal(headers.get('x-orgiast-pc'), 'clean-install-fixture');
  assert.equal(headers.get('x-orgiast-auth'), createHmac('sha256', secret).update(headers.get('x-orgiast-ts')).digest('hex'));
  const drive = new URL(url.searchParams.get('path'), 'https://www.googleapis.com');
  let body;
  if (drive.pathname === '/drive/v3/files') {
    const q = drive.searchParams.get('q');
    if (q === `name='${FOLDER_NAME}' and '${HUB_ID}' in parents and trashed=false`) {
      body = json({ files: [{ id: 'ci-folder', name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }] });
    } else {
      assert.equal(q, "name='manifest.json' and 'ci-folder' in parents and trashed=false");
      body = json({ files: [{ id: 'ci-manifest', name: 'manifest.json' }] });
    }
  } else {
    assert.equal(drive.searchParams.get('alt'), 'media');
    body = contents.get(drive.pathname.replace('/drive/v3/files/', ''));
    assert.ok(body, `unexpected download: ${drive.pathname}`);
  }
  return new Response(JSON.stringify({ status: 200, contentType: 'application/octet-stream', body: body.toString('base64') }));
};
