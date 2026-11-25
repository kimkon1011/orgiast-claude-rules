import { googleClient } from '../deadline-ledger.mjs';
import { extractSearchTerms } from './autoreply-related.mjs';

const DRIVE_FACT_QUESTION = /(?:プロジェクト|PJ|案件)?コード|実施計画書|見積書/i;
const PROJECT_CODE = /(?<![A-Z0-9])\d{6,7}[A-Z]{3,5}(?![A-Z0-9])/g;

export function needsDriveFactSearch(message) {
  return DRIVE_FACT_QUESTION.test(String(message || '')) || PROJECT_CODE.test(String(message || '').toUpperCase());
}

export async function searchDriveFacts({ message, documents = [], terms, llm, request } = {}) {
  if (!needsDriveFactSearch(message)) return { files: [], uniqueCode: null, searched: false };
  try {
    const extracted = terms?.length ? terms : await extractSearchTerms(message, documents, llm);
    const quoted = [...String(message || '').matchAll(/[「『“\"]([^」』”\"]{2,30})[」』”\"]/g)].map(match => match[1]);
    const searchTerms = [...quoted, ...extracted];
    const usefulTerms = [...new Set(searchTerms.map(x => String(x).trim()).filter(x => x.length >= 2 && !/^(?:プロジェクト|PJ|案件)?コード$/i.test(x)))].slice(0, 6);
    if (!usefulTerms.length) return { files: [], uniqueCode: null, searched: true };
    const req = request || googleClient();
    const found = new Map();
    for (const term of usefulTerms) {
      const escaped = term.replace(/'/g, "\\'");
      const params = new URLSearchParams({ q: `name contains '${escaped}' and trashed=false`, pageSize: '10', fields: 'files(id,name,mimeType,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      const data = await req(`https://www.googleapis.com/drive/v3/files?${params}`, { user: 'kim@orgiast.jp' });
      for (const file of data.files || []) found.set(file.id, file);
    }
    const files = [...found.values()].slice(0, 10).map(file => ({ name: file.name, id: file.id, codes: [...new Set(String(file.name || '').toUpperCase().match(PROJECT_CODE) || [])] }));
    const codes = [...new Set(files.flatMap(file => file.codes))];
    return { files, uniqueCode: codes.length === 1 ? codes[0] : null, searched: true, terms: usefulTerms };
  } catch (e) {
    return { error: String(e?.message || e), files: [], uniqueCode: null, searched: true };
  }
}
