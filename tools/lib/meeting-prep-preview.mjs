// Copy-on-write Google Sheets adapter. Only GET requests reach the real client.
// The same applier runs against this overlay, including simulated read-backs.
export function createApplyPreview(source) {
  const sheets = new Map(), cells = new Map(), documents = new Map(), mutations = [];
  const clone = value => structuredClone(value);
  const col = text => [...text].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const column = n => { let s = ''; for (; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const trim = rows => {
    rows = clone(rows);
    for (const row of rows) while (row.length && (row.at(-1) === '' || row.at(-1) == null)) row.pop();
    while (rows.length && !rows.at(-1).length) rows.pop();
    return rows;
  };
  async function metadata(id) {
    if (!sheets.has(id)) sheets.set(id, clone(await source.request('spreadsheets.readonly', `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`)));
    return sheets.get(id);
  }
  async function values(id, tab) {
    const key = `${id}/${tab}`;
    if (!cells.has(key)) cells.set(key, clone((await source.request('spreadsheets.readonly', `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMULA`)).values || []));
    return cells.get(key);
  }
  return {
    simulated: true, mutations,
    pages: (...args) => source.pages(...args),
    async request(scope, url, method = 'GET', body) {
      const u = new URL(url), match = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
      if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files' && method === 'POST' && body?.mimeType === 'application/vnd.google-apps.document') {
        const id = `preview-document-${documents.size + 1}`;
        documents.set(id, { revisionId: 'preview', body: { content: [] } });
        mutations.push({ url, method, body: clone(body) }); return { id };
      }
      const driveFile = /^\/drive\/v3\/files\/([^/]+)(\/permissions)?$/.exec(u.pathname);
      if (u.hostname === 'www.googleapis.com' && driveFile && documents.has(driveFile[1])) {
        const doc = documents.get(driveFile[1]);
        if (!driveFile[2] && method === 'PATCH' && body?.properties?.orgiastAutomation === 'true') {
          mutations.push({ url, method, body: clone(body) }); return { id: driveFile[1] };
        }
        if (driveFile[2] && method === 'GET') return { permissions: clone(doc.permissions || []) };
        if (driveFile[2] && method === 'POST' && body?.emailAddress === 'kim@orgiast.jp' && body.role === 'writer') {
          doc.permissions = [clone(body)]; mutations.push({ url, method, body: clone(body) }); return { id: 'preview-permission' };
        }
        throw new Error('apply-dry: unsupported document permission mutation');
      }
      if (u.hostname === 'docs.googleapis.com') {
        const id = u.pathname.split('/')[3].replace(/:batchUpdate$/, '');
        if (!documents.has(id)) documents.set(id, clone(await source.request('documents', `https://docs.googleapis.com/v1/documents/${id}`)));
        if (method === 'GET') return clone(documents.get(id));
        if (method === 'POST' && u.pathname.endsWith(':batchUpdate')) {
          const doc = documents.get(id);
          if (doc.body?.content?.length || body.requests.length !== 1 || body.requests[0].insertText?.location?.index !== 1) throw new Error('apply-dry: 既存Docの置換は禁止');
          doc.body = { content: [{ paragraph: { elements: [{ textRun: { content: body.requests[0].insertText.text + '\n' } }] } }] };
          mutations.push({ url, method, body: clone(body) }); return {};
        }
        throw new Error('apply-dryで未対応のDoc操作');
      }
      if (u.hostname !== 'sheets.googleapis.com' || !match) {
        if (method !== 'GET') throw new Error(`apply-dryでは未対応の書込: ${scope} ${method}`);
        return source.request(scope, url);
      }
      const [, id, rest] = match, meta = await metadata(id);
      if (!rest && method === 'GET') return clone(meta);
      if (rest === ':batchUpdate' && method === 'POST') {
        for (const req of body.requests) {
          if (!req.addSheet) throw new Error('apply-dry: addSheet以外の構造変更は禁止');
          const title = req.addSheet.properties.title;
          if (meta.sheets.some(s => s.properties.title === title)) throw new Error('タブ重複');
          const sheetId = Math.max(0, ...meta.sheets.map(s => s.properties.sheetId)) + 1;
          meta.sheets.push({ properties: { title, sheetId } }); cells.set(`${id}/${title}`, []);
        }
        mutations.push({ url, method, body: clone(body) }); return {};
      }
      if (rest.startsWith('/values/')) {
        const append = rest.endsWith(':append'), a1 = decodeURIComponent(rest.slice(8).replace(/:append$/, ''));
        const m = /^'([^']+)'(?:!([A-Z]+)(\d*)?(?::([A-Z]+)(\d*)?)?)?$/.exec(a1);
        if (!m) throw new Error(`apply-dryの範囲不正: ${a1}`);
        const [, tab, c1, r1, c2, r2] = m, rows = await values(id, tab);
        let y = Number(r1 || 1) - 1, x = c1 ? col(c1) - 1 : 0;
        if (method === 'GET') {
          const end = r2 ? Number(r2) : rows.length, width = c2 ? col(c2) : c1 ? col(c1) : Infinity;
          return { values: trim(rows.slice(y, end).map(row => row.slice(x, width))) };
        }
        if (method !== 'PUT' && !(method === 'POST' && append)) throw new Error('apply-dryで未対応のシート書込');
        if (append) { y = trim(rows).length; x = 0; }
        for (let i = 0; i < body.values.length; i++) {
          rows[y + i] ||= [];
          for (let j = 0; j < body.values[i].length; j++) rows[y + i][x + j] = body.values[i][j];
        }
        mutations.push({ url, method, body: clone(body) });
        return append ? { updates: { updatedRange: `'${tab}'!A${y + 1}:${column(body.values[0].length)}${y + body.values.length}` } } : {};
      }
      throw new Error(`apply-dryで未対応の操作: ${method} ${url}`);
    }
  };
}
