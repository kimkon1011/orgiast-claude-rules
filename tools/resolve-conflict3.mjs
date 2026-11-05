import fs from 'node:fs';

let src = fs.readFileSync('tools/auto-progress-digest.mjs', 'utf8');

// Find conflict 3 start marker line
const lines = src.split('\n');
let ci3start = -1, ci3end = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('<<<<<<< HEAD') && lines[i+1] && lines[i+1].includes('const deliveries = [')) ci3start = i;
  if (ci3start >= 0 && lines[i].startsWith('>>>>>>> origin/main') && i > ci3start) { ci3end = i; break; }
}

const before = lines.slice(0, ci3start).join('\n');
const after = lines.slice(ci3end + 1).join('\n');

const merged = `      // 案件ID・更新席・生のハブ本文は外に出さず件数だけをまとめる。
      const caseCount = Object.keys(ownerCases.checkpoints).length;
      const caseUnchanged = caseCount && Object.entries(ownerCases.checkpoints).every(([id, cp]) => state.caseProgress?.[id]?.fingerprint === cp.fingerprint);
      const deadlinePrefix = owner === 'kim@orgiast.jp' && deadlineText ? deadlineText + '\\n\\n' : '';
      const longChecks = items.rows.filter(row => row.check && Date.parse(row.deadlineAt) - now >= 12 * 3600000 && !['done', 'overdue_reported'].includes(row.status));
      const dailyChecks = currentSlot === '朝' && state.checkSummaryDays?.[owner] !== key.split('|')[0] ? longChecks : [];
      const progressText = dailyChecks.length ? '日次進捗\\n' + dailyChecks.map(row => \`\${row.label || row.promise}\\n\${checkProgressSummary(row.checkText || 'まだ確認結果がありません')}\`).join('\\n') + '\\n' : '';
      // Multi-delivery: main digest + case-progress-digest entries
      const deliveries = [
        ...(items.rows.length || items.pending.length || deadlineText || progressText ? [{ text: redactSecrets(deadlinePrefix + \`【進捗まとめ】\\n\${progressText}\${digest.text}\${caseCount ? \`（案件 \${caseCount}件\${caseUnchanged ? '・変化なし' : ''}）\` : ''}\`), kind: 'digest', source: 'auto-progress-digest' }] : []),
        ...(ownerCases.entries || []).map(entry => ({ ...entry, source: 'case-progress-digest' })),
      ];
      let failed = false;
      for (const delivery of deliveries) {
        const { text } = delivery;
        messages.push(text);
        if (dryRun) continue;
        const options = { home, now, owner, kind: delivery.kind, source: delivery.source, deliveryKey: delivery.source === 'case-progress-digest' ? \`\${key}:\${hash(delivery.kind + text)}\` : undefined, ...(delivery.source === 'case-progress-digest' ? { plainJa: false } : {}), webhookFallback: false };
        let result;
        try {
          result = io.notify ? await io.notify(text, options) : io.notifyOwner ? await io.notifyOwner(owner, text, options)
            : delivery.source === 'case-progress-digest' ? await notifyKim(text, options) : await notifyOwner(owner, text, options);
        } catch (e) { result = { delivered: 'none', reason: String(e?.message || e) }; }
        const ok = delivery.source === 'case-progress-digest' ? result?.delivered === 'session-inbox'
          : ['dm', 'session-inbox', 'toast', 'inbox'].includes(result?.delivered);
        receipts.push({ owner, ...result, channel: result?.channel || result?.delivered, recipientId: result?.recipientId ?? result?.userId ?? null, messageId: result?.messageId ?? null, httpStatus: result?.httpStatus ?? result?.status ?? null });
        if (!ok) { error ||= result?.reason || 'inbox not delivered'; failed = true; break; }
      }
      // Send deadline digest to inbox separately
      if (deadlinePrefix && !dryRun && !failed) {
        try { await addDeadlineDigest(home, { kind: 'info', source: 'deadline-digest', text: deadlineText, dedupeKey: \`deadline-digest:\${key}\` }); }
        catch (e) { /* best-effort */ }
      }
      if (dryRun || failed) continue;`;

fs.writeFileSync('tools/auto-progress-digest.mjs', before + '\n' + merged + '\n' + after, 'utf8');
console.log('Conflict 3 resolved');