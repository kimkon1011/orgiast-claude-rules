/** 案件フォルダ全資料を Gemini で事前要約し、実施計画書へ保存する。 */
const CASE_DIGEST_SHEET_NAME = 'Claude_案件資料ダイジェスト';
const CASE_DIGEST_MODEL = 'google/gemini-3.7-flash';
const CASE_DIGEST_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const CASE_DIGEST_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CASE_DIGEST_MAX_CHUNK_BYTES = 15 * 1024 * 1024; // base64 で約20MB。UrlFetchApp 50MB 上限に余裕を持たせる
const CASE_DIGEST_RUNTIME_MS = 4.5 * 60 * 1000;
// 1案件(=1チャンク)の処理に最大約2分かかる実測。4.5分経過後に新しい案件を開始すると
// GAS の6分制限を超えて打ち切られるため、新規着手の締切は別に短く取る。
const CASE_DIGEST_CASE_START_CUTOFF_MS = 2.5 * 60 * 1000;
const CASE_DIGEST_RUN_BUDGET_MS = 3.5 * 60 * 1000;
const CASE_DIGEST_MAX_CHUNKS_PER_RUN = 1;
const CASE_DIGEST_CELL_CHARS = 40000; // Sheets の 1セル 50,000 文字上限に対する安全域
const CASE_DIGEST_LEDGER_KEY = 'CASE_DIGEST_LEDGER';
const CASE_DIGEST_RECHECK_MS = 20 * 60 * 60 * 1000;
const CASE_DIGEST_PARTIAL_FINALIZE_MS = 5 * 24 * 60 * 60 * 1000;
const CASE_DIGEST_LEDGER_MAX_CHARS = 8000;
const CASE_DIGEST_FAILURE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function CaseDigest_fingerprint(materials) {
  const source = (materials || []).map(function (m) {
    return String(m.driveFileId || m.fileId || '') + ':' + String(m.lastUpdated || '');
  }).sort().join('\n');
  let bytes;
  if (typeof Utilities !== 'undefined') {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
    return bytes.map(function (b) { return ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2); }).join('');
  }
  // Node の純ロジックテスト用。GAS ではこの分岐を通らない。
  return require('node:crypto').createHash('sha256').update(source, 'utf8').digest('hex');
}

function CaseDigest_chunkFingerprint(chunkMaterials) {
  return CaseDigest_fingerprint(chunkMaterials);
}

/** サイズ情報だけで安定してチャンク化する純関数。 */
function CaseDigest_chunkMaterials(materials, maxChunkBytes) {
  const limit = Number(maxChunkBytes) || CASE_DIGEST_MAX_CHUNK_BYTES;
  const chunks = [], excluded = [];
  let current = [], currentBytes = 0;
  (materials || []).forEach(function (m) {
    const bytes = Number(m.bytes) || 0;
    if (bytes > limit) {
      excluded.push(Object.assign({}, m, { reason: 'over_max_chunk_bytes' }));
      return;
    }
    if (current.length && currentBytes + bytes > limit) {
      chunks.push(current); current = []; currentBytes = 0;
    }
    current.push(m); currentBytes += bytes;
  });
  if (current.length) chunks.push(current);
  return { chunks: chunks, excluded: excluded };
}

function CaseDigest_getKey_() {
  return String(PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY') || '');
}

function CaseDigest_blobForMaterial_(m) {
  const file = DriveApp.getFileById(m.driveFileId);
  if (m.kind === 'pptx') return CaseMaterials_pptxToPdf(m.driveFileId);
  if (m.kind === 'slides' || m.kind === 'docs') return file.getAs('application/pdf');
  return file.getBlob();
}

function CaseDigest_prepareMaterials_(materials) {
  const prepared = [], excluded = [];
  (materials || []).forEach(function (m) {
    try {
      const blob = CaseDigest_blobForMaterial_(m);
      if (!blob) { excluded.push(Object.assign({}, m, { reason: 'conversion_failed' })); return; }
      const bytes = blob.getBytes();
      if (bytes.length > CASE_DIGEST_MAX_FILE_BYTES) {
        excluded.push(Object.assign({}, m, { reason: 'over_max_file_bytes', actualBytes: bytes.length })); return;
      }
      prepared.push(Object.assign({}, m, {
        bytes: bytes.length,
        digestMimeType: m.kind === 'image' ? blob.getContentType() : 'application/pdf',
        digestBase64: Utilities.base64Encode(bytes)
      }));
    } catch (e) {
      excluded.push(Object.assign({}, m, { reason: 'read_failed', detail: String(e.message || e) }));
    }
  });
  return { prepared: prepared, excluded: excluded };
}

function CaseDigest_prompt_() {
  return [
    '添付された案件資料だけを根拠に、展示会ブース制作の案件資料ダイジェストを日本語で作成してください。',
    '見出し付きプレーンテキスト（Markdown見出し可）で、次を必ず含めてください。',
    '1. ブース/装飾の仕様（寸法・素材・色・数量）',
    '2. 現況写真から読み取れる建物・設置環境の条件',
    '3. デザイン/パースで確定していること',
    '4. 測定・実測値',
    '5. 未確定・要確認事項',
    '6. 各項目の出典ファイル名',
    '資料に無い情報は絶対に補わず、「資料に記載なし」と明記してください。'
  ].join('\n');
}

function CaseDigest_callOpenRouter_(key, text, files) {
  const content = [{ type: 'text', text: text }];
  (files || []).forEach(function (f) {
    const dataUrl = 'data:' + f.digestMimeType + ';base64,' + f.digestBase64;
    if (f.kind === 'image') content.push({ type: 'image_url', image_url: { url: dataUrl } });
    else content.push({ type: 'file', file: { filename: f.label, file_data: dataUrl } });
  });
  const response = UrlFetchApp.fetch(CASE_DIGEST_ENDPOINT, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ model: CASE_DIGEST_MODEL, messages: [{ role: 'user', content: content }] }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error('OpenRouter HTTP ' + status + ': ' + body.slice(0, 500));
  const parsed = JSON.parse(body);
  const textOut = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (!textOut) throw new Error('OpenRouter response has no content');
  return { text: String(textOut), usage: parsed.usage || {} };
}

function CaseDigest_addUsage_(total, usage) {
  Object.keys(usage || {}).forEach(function (k) {
    if (typeof usage[k] === 'number') total[k] = (Number(total[k]) || 0) + usage[k];
  });
}

/** Sheets の 1セル文字数上限を超えないよう、改行境界で本文を分割する。 */
function CaseDigest_splitForCells(text, maxChars) {
  const limit = Number(maxChars) || CASE_DIGEST_CELL_CHARS;
  const out = [];
  let buf = '';
  String(text || '').split('\n').forEach(function (line) {
    while (line.length > limit) {            // 1行が上限超なら強制的に切る
      if (buf) { out.push(buf); buf = ''; }
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    if (buf.length + line.length + 1 > limit) { out.push(buf); buf = line; }
    else buf = buf ? buf + '\n' + line : line;
  });
  if (buf) out.push(buf);
  return out.length ? out : [''];
}

/** シート行から再開に必要な状態を取り出す純関数。 */
function CaseDigest_parseProgress(rows, fingerprint, chunkTotal, chunkFingerprints) {
  const values = rows || [];
  const storedFingerprint = values[1] ? String(values[1][1] || '') : '';
  const storedState = values[3] ? String(values[3][1] || '') : '';
  const summaries = [], saved = [], byFingerprint = {};
  for (let i = 0; i < values.length; i++) {
    const match = String(values[i][0] || '').match(/^チャンク(\d+)要約$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const parts = [];
    for (let j = i + 1; j < values.length; j++) {
      if (/^チャンク\d+要約$/.test(String(values[j][0] || ''))) break;
      parts.push(String(values[j][0] || ''));
    }
    const summary = parts.join('\n').trim();
    const chunkFingerprint = String(values[i][1] || '');
    saved[index] = summary;
    if (chunkFingerprint && summary) byFingerprint[chunkFingerprint] = summary;
  }
  if (Array.isArray(chunkFingerprints) && Object.keys(byFingerprint).length) {
    chunkFingerprints.forEach(function (chunkFingerprint, index) {
      if (byFingerprint[String(chunkFingerprint || '')]) summaries[index] = byFingerprint[String(chunkFingerprint || '')];
    });
  } else if (storedFingerprint === String(fingerprint || '') && storedState === '部分') {
    saved.forEach(function (summary, index) { if (summary) summaries[index] = summary; });
  }
  let nextIndex = 0;
  while (nextIndex < chunkTotal && typeof summaries[nextIndex] === 'string' && summaries[nextIndex]) nextIndex++;
  return { state: storedState, fingerprintMatches: storedFingerprint === String(fingerprint || ''),
    summaries: summaries, nextIndex: nextIndex, chunkTotal: chunkTotal };
}

/** チャンク処理の状態遷移。processChunk/savePartial/merge は本番・テストで注入する。 */
function CaseDigest_runChunks(state, opts) {
  const options = opts || {};
  const summaries = (state.summaries || []).slice();
  const total = Number(state.chunkTotal) || 0;
  const maxChunks = options.maxChunksPerRun == null ? CASE_DIGEST_MAX_CHUNKS_PER_RUN : Number(options.maxChunksPerRun);
  const budget = options.runtimeBudgetMs == null ? CASE_DIGEST_RUN_BUDGET_MS : Number(options.runtimeBudgetMs);
  const now = options.now || Date.now;
  const started = now();
  let processed = 0;
  for (let i = 0; i < total; i++) {
    if (summaries[i]) continue;
    if (processed >= maxChunks || now() - started >= budget) break;
    summaries[i] = String(options.processChunk(i) || '');
    if (!summaries[i]) throw new Error('チャンク' + (i + 1) + 'の要約が空です');
    processed++;
    if (options.savePartial) options.savePartial(summaries, summaries.filter(function (s) { return Boolean(s); }).length, total);
  }
  const done = summaries.filter(function (s) { return Boolean(s); }).length;
  if (done < total) return { state: '部分', chunksDone: done, chunkTotal: total, summaries: summaries };
  const digest = total === 1 ? summaries[0] : options.merge(summaries);
  return { state: '完了', chunksDone: done, chunkTotal: total, summaries: summaries, digest: digest };
}

function CaseDigest_readRows_(c) {
  const sh = CaseDigest_sheet_(c);
  if (!sh) return [];
  return sh.getRange(1, 1, sh.getLastRow() || 1, 3).getDisplayValues();
}

function CaseDigest_write_(c, materials, fingerprint, state, chunksDone, chunkTotal, digest, summaries, chunkFingerprints, note) {
  if (!c.zissiId) throw new Error('実施計画書がありません: ' + c.caseId);
  const ss = SpreadsheetApp.openById(c.zissiId);
  const sh = ss.getSheetByName(CASE_DIGEST_SHEET_NAME) || ss.insertSheet(CASE_DIGEST_SHEET_NAME);
  sh.clearContents();
  const rows = [
    ['生成日時', new Date().toISOString(), ''],
    ['フィンガープリント', fingerprint, ''],
    ['対象ファイル', materials.length, ''],
    ['状態', state, ''],
    ['進捗', chunksDone + '/' + chunkTotal, ''],
    ['', '', ''],
    ['ファイル名', 'kind', '更新日時']
  ];
  materials.forEach(function (m) {
    rows.push([m.label || '', m.kind || '', m.lastUpdated ? new Date(m.lastUpdated).toISOString() : '']);
  });
  rows.push(['', '', ''], ['本文', '', '']);
  if (state === '完了') CaseDigest_splitForCells(digest).forEach(function (part) { rows.push([part, '', '']); });
  if (note) rows.push(['注記', note, '']);
  (summaries || []).forEach(function (summary, i) {
    if (!summary) return;
    rows.push(['チャンク' + (i + 1) + '要約', String(chunkFingerprints && chunkFingerprints[i] || ''), '']);
    CaseDigest_splitForCells(summary).forEach(function (part) { rows.push([part, '', '']); });
  });
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  return PanelLinks_sheetUrl(ss, sh);
}

function CaseDigest_buildForCase(caseId, opts) {
  const options = opts || {};
  const key = CaseDigest_getKey_();
  if (!key) return { skipped: 'OPENROUTER_API_KEY 未設定' };
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const materials = options.materials || Case_collectCaseMaterials(c, { unlimited: true });
  const fingerprint = options.fingerprint || CaseDigest_fingerprint(materials);
  // 元サイズでチャンク分割し、変換+base64 は「送る直前にそのチャンクだけ」行う。
  // 先に全件 base64 化すると 30MB 級の案件で GAS のメモリを溢れさせる。
  const split = CaseDigest_chunkMaterials(materials, CASE_DIGEST_MAX_CHUNK_BYTES);
  const chunkFingerprints = split.chunks.map(function (chunk) { return CaseDigest_chunkFingerprint(chunk); });
  const excluded = [].concat(split.excluded);
  if (!split.chunks.length) throw new Error('ダイジェスト対象として送信可能な資料がありません');
  const progress = CaseDigest_parseProgress(CaseDigest_readRows_(c), fingerprint, split.chunks.length, chunkFingerprints);
  const finalizeBeforeProcessing = CaseDigest_shouldFinalizePartial({ partialSinceMs: options.partialSinceMs,
    chunksDone: progress.summaries.filter(function (s) { return Boolean(s); }).length,
    chunkTotal: split.chunks.length, nowMs: Date.now() });
  const usage = {};
  let sheetUrl = '';
  const run = CaseDigest_runChunks(progress, {
    maxChunksPerRun: finalizeBeforeProcessing ? 0 : options.maxChunksPerRun,
    runtimeBudgetMs: options.runtimeBudgetMs,
    processChunk: function (i) {
      const prepared = CaseDigest_prepareMaterials_(split.chunks[i]);
      prepared.excluded.forEach(function (x) { excluded.push(x); });
      if (!prepared.prepared.length) throw new Error('チャンク' + (i + 1) + 'に送信可能な資料がありません');
      const result = CaseDigest_callOpenRouter_(key,
        CaseDigest_prompt_() + '\n\nこれは全' + split.chunks.length + 'チャンク中の' + (i + 1) + '番目です。',
        prepared.prepared);
      CaseDigest_addUsage_(usage, result.usage);
      return result.text;
    },
    savePartial: function (summaries, done, total) {
      sheetUrl = CaseDigest_write_(c, materials, fingerprint, '部分', done, total, '', summaries, chunkFingerprints);
    },
    merge: function (summaries) {
      const merged = CaseDigest_callOpenRouter_(key,
        CaseDigest_prompt_() + '\n\n以下は資料群ごとの要約です。重複を統合して1本のダイジェストにしてください。\n\n' +
        summaries.map(function (s, i) { return '## チャンク' + (i + 1) + '\n' + s; }).join('\n\n'), []);
      CaseDigest_addUsage_(usage, merged.usage);
      return merged.text;
    }
  });
  let finalizedPartial = false;
  if (run.state === '部分' && CaseDigest_shouldFinalizePartial({ partialSinceMs: options.partialSinceMs,
    chunksDone: run.chunksDone, chunkTotal: run.chunkTotal, nowMs: Date.now() })) {
    const available = run.summaries.filter(function (s) { return Boolean(s); });
    if (available.length === 1) run.digest = available[0];
    else {
      const partialMerged = CaseDigest_callOpenRouter_(key,
        CaseDigest_prompt_() + '\n\n以下は取得済み資料群の要約です。重複を統合して1本のダイジェストにしてください。\n\n' +
        available.join('\n\n'), []);
      CaseDigest_addUsage_(usage, partialMerged.usage);
      run.digest = partialMerged.text;
    }
    run.state = '完了';
    finalizedPartial = true;
  }
  if (run.state === '完了') sheetUrl = CaseDigest_write_(c, materials, fingerprint, '完了',
    run.chunksDone, run.chunkTotal, run.digest, run.summaries, chunkFingerprints,
    finalizedPartial ? '資料の一部のみ反映(' + run.chunksDone + '/' + run.chunkTotal + 'チャンク)' : '');
  return { caseId: caseId, files: materials.length, chunks: split.chunks.length,
    state: run.state, chunksDone: run.chunksDone, chunkTotal: run.chunkTotal,
    chunksSent: run.chunksDone - progress.summaries.filter(function (s) { return Boolean(s); }).length,
    chunksDeferred: run.chunkTotal - run.chunksDone, finalizedPartial: finalizedPartial,
    chars: run.digest ? run.digest.length : 0,
    fingerprint: fingerprint, sheetUrl: sheetUrl, usage: usage, excluded: excluded.map(function (x) {
      return { label: x.label || '', reason: x.reason || '' };
    }) };
}

function CaseDigest_sheet_(c) {
  if (!c || !c.zissiId) return null;
  try { return SpreadsheetApp.openById(c.zissiId).getSheetByName(CASE_DIGEST_SHEET_NAME); } catch (e) { return null; }
}

function CaseDigest_load(c) {
  try {
    const values = CaseDigest_readRows_(c);
    if (!values.length) return '';
    const state = values[3] ? String(values[3][1] || '') : '';
    if (state === '部分') {
      const progress = CaseDigest_parseProgress(values, values[1] ? values[1][1] : '', Number(String(values[4] && values[4][1] || '').split('/')[1]) || 0);
      const partial = progress.summaries.filter(function (s) { return Boolean(s); }).join('\n\n');
      return partial ? '（注: このダイジェストは資料の一部のみを反映した途中版です）\n' + partial : '';
    }
    const hasPartialNote = values.some(function (row) { return String(row[0] || '') === '注記'; });
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === '本文') {
        const body = [];
        for (let j = i + 1; j < values.length && !/^チャンク\d+要約$/.test(String(values[j][0] || '')) && String(values[j][0] || '') !== '注記'; j++) body.push(values[j][0]);
        const text = body.join('\n').trim();
        return hasPartialNote && text ? '（注: このダイジェストは資料の一部のみを反映しています）\n' + text : text;
      }
    }
  } catch (e) {}
  return '';
}

function CaseDigest_shouldFinalizePartial(input) {
  const value = input || {};
  const done = Number(value.chunksDone) || 0;
  const total = Number(value.chunkTotal) || 0;
  const since = Number(value.partialSinceMs) || 0;
  const nowMs = Number(value.nowMs) || 0;
  return done >= 1 && total > done && since > 0 && nowMs - since >= CASE_DIGEST_PARTIAL_FINALIZE_MS;
}

/** Unix ms を JST の日付キーへ変換する純関数。 */
const CaseDigest_failureDayKey = function (ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  return new Date(value + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

/** 同日の再試行を数えず、異なる失敗日だけを記録する純関数。 */
const CaseDigest_recordFailure = function (input) {
  const value = input || {};
  const prev = value.prev || {};
  const nowMs = Number(value.nowMs) || 0;
  const days = Array.isArray(prev.days) ? prev.days.map(function (day) { return String(day); })
    .filter(function (day, index, all) { return day && all.indexOf(day) === index; }) : [];
  const previousDay = CaseDigest_failureDayKey(prev.lastMs);
  if (!Array.isArray(prev.days) && previousDay) days.push(previousDay);
  const today = CaseDigest_failureDayKey(nowMs);
  let n = Number(prev.n) || 0;
  if (today && days.indexOf(today) === -1) {
    days.push(today);
    n += 1;
  }
  return { n: n, lastMs: nowMs, days: days.slice(-10) };
};

/** 異なる5日で失敗してから3日未満の間だけ夜間処理を停止する純関数。 */
const CaseDigest_shouldSkipByFailure = function (input) {
  const value = input || {};
  const n = Array.isArray(value.days) ? value.days.filter(function (day, index, all) {
    return day && all.indexOf(day) === index;
  }).length : (Number(value.n) || 0);
  const lastMs = Number(value.lastMs) || 0;
  const nowMs = Number(value.nowMs) || 0;
  return n >= 5 && lastMs > 0 && nowMs - lastMs < CASE_DIGEST_FAILURE_COOLDOWN_MS;
};

function CaseDigest_orderCases(cases, ledger, nowMs) {
  const entries = ledger || {};
  const now = Number(nowMs) || 0;
  return (cases || []).map(function (c, index) { return { c: c, i: index, e: entries[String(c.caseId || '')] }; })
    .filter(function (x) { return !x.e || x.e.s !== '完了' || now - (Number(x.e.c) || 0) >= CASE_DIGEST_RECHECK_MS; })
    .sort(function (a, b) {
      const ap = !a.e ? 0 : a.e.s === '部分' ? 1 : 2;
      const bp = !b.e ? 0 : b.e.s === '部分' ? 1 : 2;
      if (ap !== bp) return ap - bp;
      if (ap === 1) return (Number(a.e.p) || 0) - (Number(b.e.p) || 0) || a.i - b.i;
      if (ap === 2) return (Number(a.e.c) || 0) - (Number(b.e.c) || 0) || a.i - b.i;
      return a.i - b.i;
    }).map(function (x) { return x.c; });
}

function CaseDigest_saveLedger_(props, ledger) {
  let json = JSON.stringify(ledger || {});
  if (json.length > CASE_DIGEST_LEDGER_MAX_CHARS) {
    Object.keys(ledger).filter(function (caseId) { return ledger[caseId] && ledger[caseId].s === '完了'; })
      .sort(function (a, b) { return (Number(ledger[a].c) || 0) - (Number(ledger[b].c) || 0); })
      .some(function (caseId) {
        delete ledger[caseId];
        json = JSON.stringify(ledger);
        return json.length <= CASE_DIGEST_LEDGER_MAX_CHARS;
      });
  }
  props.setProperty(CASE_DIGEST_LEDGER_KEY, json);
}

function CaseDigest_nightlyRun() {
  const key = CaseDigest_getKey_();
  if (!key) {
    const unset = { skipped: 'OPENROUTER_API_KEY 未設定' };
    console.log('CaseDigest nightly: skipped=OPENROUTER_API_KEY 未設定');
    return unset;
  }
  const started = Date.now(), cases = CaseList_listAll() || [];
  const props = PropertiesService.getScriptProperties();
  let ledger = {};
  try { ledger = JSON.parse(props.getProperty(CASE_DIGEST_LEDGER_KEY) || '{}'); } catch (e) {}
  const ordered = CaseDigest_orderCases(cases, ledger, started);
  const result = { done: true, processed: [], partial: [], skipped: [], errors: [], remaining: [],
    order: ordered.slice(0, 5).map(function (c) { return c.caseId; }) };
  for (let i = 0; i < ordered.length; i++) {
    if (Date.now() - started > CASE_DIGEST_CASE_START_CUTOFF_MS) {
      result.done = false; result.remaining = ordered.slice(i).map(function (c) { return c.caseId; }); break;
    }
    const c = ordered[i];
    const failKey = 'DIGEST_FAIL_' + c.caseId;
    let fail = { n: 0, lastMs: 0 };
    try { fail = JSON.parse(props.getProperty(failKey) || '{}'); } catch (e) {}
    fail.n = Number(fail.n) || 0;
    if (CaseDigest_shouldSkipByFailure({ n: fail.n, days: fail.days, lastMs: fail.lastMs, nowMs: Date.now() })) {
      console.error('caseId=' + c.caseId + ' は ' + fail.n + ' 回失敗したため夜間ダイジェストを停止。手動確認が必要');
      result.skipped.push(c.caseId);
      continue;
    }
    const failureDays = Array.isArray(fail.days) ? fail.days.length : fail.n;
    if (failureDays >= 5) {
      props.deleteProperty(failKey);
      console.log('caseId=' + c.caseId + ' カウンタ期限切れのため再開');
      fail = { n: 0, lastMs: 0 };
    }
    fail = CaseDigest_recordFailure({ prev: fail, nowMs: Date.now() });
    props.setProperty(failKey, JSON.stringify(fail));
    try {
      const materials = Case_collectCaseMaterials(c, { unlimited: true });
      const fingerprint = CaseDigest_fingerprint(materials);
      const sh = CaseDigest_sheet_(c);
      const stored = sh ? sh.getRange('B2:B4').getDisplayValues() : [];
      if (stored.length && String(stored[0][0] || '') === fingerprint && String(stored[2][0] || '') === '完了') {
        props.deleteProperty(failKey);
        const old = ledger[c.caseId] || {};
        ledger[c.caseId] = { s: '完了', d: Number(old.d) || 0, t: Number(old.t) || 0, c: Date.now(), p: 0 };
        CaseDigest_saveLedger_(props, ledger);
        result.skipped.push(c.caseId); continue;
      }
      const built = CaseDigest_buildForCase(c.caseId, { materials: materials, fingerprint: fingerprint,
        partialSinceMs: ledger[c.caseId] && ledger[c.caseId].p });
      props.deleteProperty(failKey);
      result.processed.push(built);
      if (built.state === '部分') result.partial.push(c.caseId);
      const previous = ledger[c.caseId] || {};
      ledger[c.caseId] = { s: built.state, d: built.chunksDone, t: built.chunkTotal, c: Date.now(),
        p: built.state === '部分' ? (Number(previous.p) || Date.now()) : 0 };
      CaseDigest_saveLedger_(props, ledger);
    } catch (e) { result.errors.push({ caseId: c.caseId, error: String(e.message || e) }); }
  }
  console.log('CaseDigest nightly: processed=' + result.processed.length + ', skipped=' + result.skipped.length +
    ', failed=' + result.errors.length + ', remaining=' + result.remaining.length);
  return result;
}

function CaseDigest_setupNightlyTrigger() {
  if (!CaseDigest_getKey_()) return { skipped: 'OPENROUTER_API_KEY 未設定' };
  const alreadyInstalled = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getEventType() === ScriptApp.EventType.CLOCK &&
      trigger.getHandlerFunction() === 'CaseDigest_nightlyRun';
  });
  if (alreadyInstalled) return { skipped: 'CaseDigest_nightlyRun trigger already installed' };
  ScriptApp.newTrigger('CaseDigest_nightlyRun').timeBased().everyDays(1)
    .atHour(1).nearMinute(0).create();
  return { removedOld: 0, created: 1, timesJst: ['1:00'] };
}

if (typeof module !== 'undefined') module.exports = { CaseDigest_fingerprint, CaseDigest_chunkMaterials,
  CaseDigest_chunkFingerprint, CaseDigest_splitForCells, CaseDigest_parseProgress, CaseDigest_runChunks,
  CaseDigest_orderCases, CaseDigest_shouldFinalizePartial, CaseDigest_failureDayKey,
  CaseDigest_recordFailure, CaseDigest_shouldSkipByFailure };
