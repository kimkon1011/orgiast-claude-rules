import { isEntry } from './is-entry.mjs';
import { loadCredentials, messageQuery, request, isCloseCandidate, excluded } from './event-shop-inquiry-triage.mjs';

const DAY = 86400000;
const dateKey = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(value));
const time = value => new Date(value).getTime();

/**
 * Build a close-reason string for display, using the same logic as isCloseCandidate.
 */
function closeReason(lead, messages, now) {
  const unique = (() => {
    const seen = new Set();
    return [...messages].sort((a, b) => time(b.received_at) - time(a.received_at)).filter(m => {
      const key = m.rfc822_message_id || `${m.received_at}|${m.direction}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  })();
  const lastIn = unique.find(m => m.direction === 'inbound' && !/自動返信|自動応答|auto-?reply|automatic\s*reply|out\s*of\s*(?:the\s*)?office|不在/i.test(m.subject ?? '') && !/自動返信|自動応答|auto-?reply|automatic\s*reply|out\s*of\s*(?:the\s*)?office|不在/i.test(String(m.body ?? '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).map(line => line.trim()).filter(Boolean).join('\n')));
  const lastOut = unique.find(m => m.direction === 'outbound');
  const past = Boolean(lead.preferred_date && lead.preferred_date < dateKey(now));
  if (past) {
    if (lastIn && (!lastOut || time(lastIn.received_at) > time(lastOut.received_at)) && time(now) - time(lastIn.received_at) < 14 * DAY) {
      return `開催日経過（${lead.preferred_date}）だが直近${Math.floor((time(now) - time(lastIn.received_at)) / DAY)}日以内に未回答の返信あり`;
    }
    return `開催日経過（${lead.preferred_date}）`;
  }
  const bodyLines = msg => String(msg?.body ?? '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).map(line => line.trim()).filter(Boolean);
  const body = bodyLines(lastIn).join('\n');
  if (/見送(?!りをいただきありがとう)/u.test(body)) return '「見送り」の返信あり';
  if (/辞退/u.test(body)) return '「辞退」の返信あり';
  if (/改めてご連絡|必要な際は/u.test(body)) return '「改めてご連絡」の返信あり';
  if (/(?:別社|他社|他業者|別の業者)(?:にて|で|に)(?:問い合わせ|ご連絡|対応|依頼|発注|お願い|決定|手配)/u.test(body)) return '「他社で対応」の返信あり';
  if (/またの機会|次の機会|見合わせ/u.test(body)) return '「またの機会」の返信あり';
  if (/キャンセル(?:させ|いたし|と(?:な|言|申)|させて(?:いただ|頂)|させて(?:もらい|貰))/u.test(body)) return '「キャンセル」の返信あり';
  return '終了候補';
}

export async function main({ env = process.env, args = process.argv.slice(2), now = new Date(), fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const isApply = args.includes('--apply');
  const credentials = await loadCredentials(env);
  if (!credentials.url || !credentials.key) {
    log(`認証情報なし。試したパス: ${credentials.path}`);
    return 1;
  }

  const since = dateKey(new Date(time(now) - 180 * DAY));
  const data = await request(credentials, `/rest/v1/quote_requests?select=id,company_name,contact_name,email,event_name,preferred_date,created_at,status,raw_payload&source=eq.event-shop.jp&created_at=gte.${since}&order=created_at.desc&limit=300`, fetchImpl);

  // Filter out already-completed and test/internal leads
  const candidates = data.filter(lead => !excluded(lead));

  // For each candidate, fetch messages and classify
  const closeTargets = [];
  for (const lead of candidates) {
    const messages = await request(credentials, messageQuery(lead), fetchImpl);
    if (isCloseCandidate(lead, messages, now)) {
      closeTargets.push(lead);
    }
  }

  if (closeTargets.length === 0) {
    log('終了候補の案件はありません。');
    return 0;
  }

  // Build display
  const statusLabel = s => ({ unread: '未読', replied: '返信済', handled: '対応済' })[s] || s;
  const shortDate = v => v ? String(v).slice(5, 10).replace('-', '/') : '未定';

  if (isApply) {
    // --apply: UPDATE each lead and read-back verify
    let okCount = 0;
    let failCount = 0;
    for (const lead of closeTargets) {
      const messages = await request(credentials, messageQuery(lead), fetchImpl);
      const reason = closeReason(lead, messages, now);

      // Prepare updated raw_payload
      const updatedPayload = JSON.parse(JSON.stringify(lead.raw_payload ?? {}));
      if (!updatedPayload.event_shop) updatedPayload.event_shop = {};
      updatedPayload.event_shop.closed_at = now.toISOString();

      // PATCH
      const patchUrl = `${credentials.url.replace(/\/$/, '')}/rest/v1/quote_requests?id=eq.${encodeURIComponent(lead.id)}`;
      const patchRes = await fetchImpl(patchUrl, {
        method: 'PATCH',
        headers: {
          apikey: credentials.key,
          Authorization: `Bearer ${credentials.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ raw_payload: updatedPayload }),
        signal: AbortSignal.timeout(15000),
      });
      if (!patchRes.ok) {
        log(`❌ 更新失敗 ${lead.id} ${lead.company_name}: HTTP ${patchRes.status}`);
        failCount++;
        continue;
      }

      // Read-back: re-fetch and verify closed_at is set
      const readRes = await fetchImpl(patchUrl, {
        headers: { apikey: credentials.key, Authorization: `Bearer ${credentials.key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!readRes.ok) {
        log(`⚠️ read-back失敗 ${lead.id} ${lead.company_name}: HTTP ${readRes.status}（更新は成功した可能性あり）`);
        okCount++;
        continue;
      }
      const readBody = await readRes.json();
      const updated = Array.isArray(readBody) ? readBody[0] : readBody;
      if (updated?.raw_payload?.event_shop?.closed_at === updatedPayload.event_shop.closed_at) {
        log(`✅ ${lead.id} ${lead.company_name}（${reason}）`);
        okCount++;
      } else {
        log(`❌ read-back不一致 ${lead.id} ${lead.company_name}: closed_at が設定されていません`);
        failCount++;
      }
    }
    log(`✅ 更新 ${okCount} 件 / ❌ 失敗 ${failCount} 件`);
    return failCount > 0 ? 1 : 0;
  } else {
    // dry-run: display each candidate
    log('| id | 会社名 | 現在のステータス | 開催日 | 終了候補の理由 |');
    log('| --- | --- | --- | --- | --- |');
    for (const lead of closeTargets) {
      const messages = await request(credentials, messageQuery(lead), fetchImpl);
      const reason = closeReason(lead, messages, now);
      log(`| ${lead.id} | ${lead.company_name} | ${statusLabel(lead.status)} | ${shortDate(lead.preferred_date)} | ${reason} |`);
    }
    log(`---`);
    log(`終了候補: ${closeTargets.length} 件`);
    log('--apply を付けて再実行すると、上記の案件の raw_payload.event_shop.closed_at を設定して完了ステータスにします。');
    return 0;
  }
}

if (isEntry(import.meta.url)) {
  const code = await main();
  process.exit(code);
}