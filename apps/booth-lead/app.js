/* ============================================================
   ブースAIリードアプリ - メインロジック
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 定数
  // ============================================================
  const LEAD_STORE_KEY = 'booth-leads';
  const EXHIBITION_KEY = 'booth-exhibition';

  const KEYWORDS_SCORE = {
    decision: { words: ['決裁', '稟議', '上長', '役員', '承認'], points: 15 },
    high: { words: ['見積', '導入', '予算', 'デモ', 'PO', '発注'], points: 20 },
    medium: { words: ['興味', '検討', '比較', '評価', 'パイロット'], points: 10 },
    low: { words: ['いいですね', '魅力的', '素晴らしい', '使いたい'], points: 5 }
  };

  // ============================================================
  // 状態
  // ============================================================
  let leads = [];
  let selectedLeadId = null;
  let html5QrCode = null;
  let isScanning = false;

  // 録音関連
  let mediaRecorder = null;
  let audioChunks = [];
  let audioStream = null;
  let recognition = null;
  let isRecording = false;
  let isPaused = false;
  let recordingTimer = null;
  let recordingSeconds = 0;
  let fullTranscript = '';
  let interimText = '';
  let audioContext = null;
  let analyserNode = null;
  let animationId = null;

  // ============================================================
  // DOM 参照
  // ============================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Tab
  const tabBtns = $$('.tab-btn');
  const tabPanels = $$('.tab-panel');

  // Scan
  const qrReaderEl = $('#qr-reader');
  const qrStatus = $('#qr-reader-results');
  const btnStartScan = $('#btn-start-scan');
  const btnStopScan = $('#btn-stop-scan');
  const cameraSelect = $('#camera-select');
  const leadForm = $('#lead-form');
  const formError = $('#form-error');
  const scanInputs = {
    name: $('#input-name'),
    company: $('#input-company'),
    position: $('#input-position'),
    email: $('#input-email'),
    phone: $('#input-phone'),
    interests: $('#input-interests'),
    notes: $('#input-notes')
  };

  // Dashboard
  const statTotal = $('#stat-total');
  const statHot = $('#stat-hot');
  const statWarm = $('#stat-warm');
  const statCold = $('#stat-cold');
  const statAvg = $('#stat-avg');
  const searchInput = $('#search-leads');
  const leadsTbody = $('#leads-tbody');
  const detailPanel = $('#detail-panel');
  const detailName = $('#detail-name');
  const detailBody = $('#detail-body');
  const detailClose = $('#detail-close');

  // Conversation
  const convLeadSelect = $('#conv-lead-select');
  const convEmpty = $('#conv-empty');
  const recordingControls = $('#recording-controls');
  const recordingsList = $('#recordings-list');
  const recordingsContainer = $('#recordings-container');
  const transcriptionSection = $('#transcription-section');
  const transcriptDisplay = $('#transcript-display');
  const interimDisplay = $('#interim-display');
  const transcriptionFallback = $('#transcription-fallback');
  const manualTranscript = $('#manual-transcript');
  const btnSaveManualTranscript = $('#btn-save-manual-transcript');
  const scoringSection = $('#ai-scoring-section');
  const scoreGauge = $('#score-gauge');
  const scoreValue = $('#score-value');
  const scoreCategory = $('#score-category');
  const scoreDetail = $('#score-detail');
  const aiSummary = $('#ai-summary');
  const summaryContent = $('#summary-content');
  const leadNotes = $('#lead-notes');
  const btnSaveNotes = $('#btn-save-notes');
  const convError = $('#conv-error');
  const btnRecStart = $('#btn-rec-start');
  const btnRecPause = $('#btn-rec-pause');
  const btnRecStop = $('#btn-rec-stop');
  const recDot = $('#rec-dot');
  const recTimer = $('#rec-timer');
  const audioVisualizer = $('#audio-visualizer');
  const visCtx = audioVisualizer ? audioVisualizer.getContext('2d') : null;

  // Campaign
  const btnExportCsv = $('#btn-export-csv');
  const btnExportJson = $('#btn-export-json');
  const importFile = $('#import-file');
  const importResult = $('#import-result');
  const templateSelect = $('#template-select');
  const templateLeadSelect = $('#template-lead-select');
  const emailPreviewSection = $('#email-preview-section');
  const emailPreview = $('#email-preview');
  const btnCopyEmail = $('#btn-copy-email');
  const btnExportEmailCsv = $('#btn-export-email-csv');
  const btnExportEmailTxt = $('#btn-export-email-txt');
  const btnPreviewEmail = $('#btn-preview-email');
  const emailPreviewDialog = $('#email-preview-dialog');
  const btnCloseEmail = $('#btn-close-email');

  const toastContainer = $('#toast-container');

  // ============================================================
  // ユーティリティ
  // ============================================================
  function generateId () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatDate (date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatTime (sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function showToast (message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' toast-' + type : '');
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3000);
  }

  // ============================================================
  // データ保存・読込
  // ============================================================
  function loadLeads () {
    try {
      const data = localStorage.getItem(LEAD_STORE_KEY);
      leads = data ? JSON.parse(data) : [];
    } catch (e) {
      leads = [];
    }
  }

  function saveLeads () {
    try {
      localStorage.setItem(LEAD_STORE_KEY, JSON.stringify(leads));
      showToast('保存しました', 'success');
      return true;
    } catch (e) {
      showToast('保存に失敗しました', 'error');
      return false;
    }
  }

  // ============================================================
  // スコア計算
  // ============================================================
  function computeScore (transcription, durationSeconds = 0) {
    if (!transcription || !transcription.trim()) return { score: 10, details: ['初期スコア: 10点'] };

    let score = 0;
    const details = [];
    const text = transcription;

    // 録音時間スコア（0-60pt）: 1秒につき1点
    const safeDuration = Math.max(0, Number(durationSeconds) || 0);
    const durationScore = Math.min(60, Math.floor(safeDuration));
    score += durationScore;
    details.push(`会話時間: ${durationScore}点（${Math.floor(safeDuration)}秒）`);

    // キーワード検出（0-40pt + bonus）
    let keywordTotal = 0;
    for (const [, group] of Object.entries(KEYWORDS_SCORE)) {
      for (const word of group.words) {
        const regex = new RegExp(word, 'g');
        const matches = text.match(regex);
        if (matches) {
          keywordTotal += group.points;
          details.push(`キーワード「${word}」: +${group.points}点（${matches.length}回）`);
        }
      }
    }
    keywordTotal = Math.min(40, keywordTotal);
    score += keywordTotal;

    // 最終調整
    score = Math.max(0, Math.min(100, score));
    if (score === 0) score = 10;
    details.unshift(`合計スコア: ${score}点`);

    return { score, details };
  }

  function getCategory (score) {
    if (score >= 70) return 'HOT';
    if (score >= 40) return 'WARM';
    return 'COLD';
  }

  function getLeadRecordingDuration (lead) {
    return (lead.conversationRecordings || []).reduce((total, recording) => {
      return total + Math.max(0, Number(recording.duration) || 0);
    }, 0);
  }

  // ============================================================
  // AIサマリー（モック）
  // ============================================================
  function generateAiSummary (transcription) {
    if (!transcription || !transcription.trim()) return null;

    const sentences = transcription.match(/[^。！？]*[。！？]/g) || [transcription];
    const meaningful = sentences.filter(s => s.trim().length > 5).slice(0, 3);

    const overview = meaningful.length > 0
      ? meaningful[0].trim()
      : transcription.slice(0, 50) + '...';

    const interestKeywords = ['興味', '欲しい', 'ほしい', '導入', '比較', '見積', 'デモ', '予算', '検討', '評価'];
    const nextKeywords = ['連絡', '送付', '送る', '見学', '訪問', '打ち合わせ', 'ミーティング', '会議', '決裁', '稟議'];

    const interests = interestKeywords.filter(kw => transcription.includes(kw));
    const nextActions = nextKeywords.filter(kw => transcription.includes(kw));

    return {
      overview,
      interests: interests.length > 0 ? interests : ['（具体的な関心ワードは検出されませんでした）'],
      nextActions: nextActions.length > 0 ? nextActions : ['フォローアップ連絡']
    };
  }

  // ============================================================
  // リード作成
  // ============================================================
  function createLead (data) {
    const { score, details } = computeScore(data.transcription || '');
    const lead = {
      id: generateId(),
      name: data.name || '',
      company: data.company || '',
      position: data.position || '',
      email: data.email || '',
      phone: data.phone || '',
      badgeScanMethod: data.badgeScanMethod || 'manual',
      badgeScanTime: data.badgeScanTime || new Date().toISOString(),
      conversationRecordings: data.conversationRecordings || [],
      transcription: data.transcription || '',
      aiSummary: data.aiSummary || null,
      leadScore: score,
      leadCategory: getCategory(score),
      interests: data.interests || '',
      notes: data.notes || '',
      followUpEmailBody: '',
      crmPushed: false,
      crmPushTime: null,
      createdAt: new Date().toISOString()
    };
    return lead;
  }

  function registerLead (leadData) {
    const lead = createLead(leadData);
    leads.push(lead);
    saveLeads();
    renderDashboard();
    renderConversationSelect();
    renderTemplateLeadSelect();
    return lead;
  }

  function updateLead (id, updates) {
    const idx = leads.findIndex(l => l.id === id);
    if (idx === -1) return null;
    leads[idx] = { ...leads[idx], ...updates };
    saveLeads();
    renderDashboard();
    renderConversationSelect();
    renderTemplateLeadSelect();
    return leads[idx];
  }

  // ============================================================
  // タブ切り替え
  // ============================================================
  function switchTab (tabName) {
    tabBtns.forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive);
    });
    tabPanels.forEach(panel => {
      const isActive = panel.id === 'panel-' + tabName;
      panel.classList.toggle('active', isActive);
    });
    if (tabName === 'dashboard') renderDashboard();
    if (tabName === 'conversation') renderConversationSelect();
    if (tabName === 'campaign') renderTemplateLeadSelect();
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
      // スキャンタブから離れる時はカメラ停止
      if (btn.dataset.tab !== 'scan') stopScanner();
    });
  });

  // ============================================================
  // QRスキャナー
  // ============================================================
  async function startScanner () {
    if (isScanning) return;

    if (typeof Html5Qrcode === 'undefined') {
      qrStatus.textContent = 'ライブラリ読み込み中...もう一度お試しください';
      return;
    }

    try {
      html5QrCode = new Html5Qrcode('qr-reader');
      const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0
      };

      const cameraId = cameraSelect.value;
      await html5QrCode.start(
        cameraId || { facingMode: 'environment' },
        config,
        onQrScanSuccess,
        onQrScanFailure
      );

      isScanning = true;
      btnStartScan.disabled = true;
      btnStopScan.disabled = false;
      qrStatus.textContent = 'QRコードをスキャンしてください';
      showToast('カメラを起動しました', 'success');
    } catch (err) {
      console.error('Camera start failed:', err);
      qrStatus.textContent = 'カメラ起動に失敗しました。手動入力フォームをご利用ください。';
      showToast('カメラの起動に失敗しました', 'error');
    }
  }

  async function loadCameras () {
    if (typeof Html5Qrcode === 'undefined') return;
    try {
      const cameras = await Html5Qrcode.getCameras();
      cameraSelect.innerHTML = '';
      if (!cameras.length) throw new Error('利用可能なカメラがありません');
      cameras.forEach((camera, index) => {
        const option = document.createElement('option');
        option.value = camera.id;
        option.textContent = camera.label || `カメラ ${index + 1}`;
        cameraSelect.appendChild(option);
      });
    } catch (error) {
      cameraSelect.innerHTML = '<option value="">背面カメラ（自動選択）</option>';
    }
  }

  cameraSelect.addEventListener('change', async function () {
    if (!isScanning) return;
    await stopScanner();
    await startScanner();
  });

  async function stopScanner () {
    if (!isScanning || !html5QrCode) return;
    try {
      await html5QrCode.stop();
      html5QrCode = null;
    } catch (e) { /* ignore */ }
    isScanning = false;
    btnStartScan.disabled = false;
    btnStopScan.disabled = true;
    qrStatus.textContent = 'スキャナー停止中';
  }

  function onQrScanSuccess (decodedText) {
    // スキャン結果をフォームに反映
    const data = parseQrData(decodedText);
    if (data) {
      if (data.name) scanInputs.name.value = data.name;
      if (data.company) scanInputs.company.value = data.company;
      if (data.position) scanInputs.position.value = data.position;
      if (data.email) scanInputs.email.value = data.email;
      if (data.phone) scanInputs.phone.value = data.phone;
    }
    qrStatus.textContent = '読み取り成功! 内容を確認して登録してください';
    showToast('QRコードを読み取りました', 'success');

    // 単発スキャン
    stopScanner();
  }

  function onQrScanFailure () {
    // 無視（継続スキャン）
  }

  function parseQrData (text) {
    // vCard パース対応
    const result = { name: '', company: '', position: '', email: '', phone: '' };

    if (text.startsWith('BEGIN:VCARD')) {
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('FN:')) result.name = line.slice(3).trim();
        if (line.startsWith('ORG:')) result.company = line.slice(4).trim();
        if (line.startsWith('TITLE:')) result.position = line.slice(6).trim();
        if (line.startsWith('EMAIL')) {
          const parts = line.split(':');
          if (parts.length > 1) result.email = parts[1].trim();
        }
        if (line.startsWith('TEL')) {
          const parts = line.split(':');
          if (parts.length > 1) result.phone = parts[1].trim();
        }
      }
      return result;
    }

    // 単純な文字列→名前として扱う
    if (text.trim()) {
      result.name = text.trim();
      return result;
    }

    return null;
  }

  btnStartScan.addEventListener('click', startScanner);
  btnStopScan.addEventListener('click', stopScanner);

  // ============================================================
  // 手動入力フォーム
  // ============================================================
  leadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    formError.hidden = true;

    const name = scanInputs.name.value.trim();
    const company = scanInputs.company.value.trim();

    if (!name || !company) {
      formError.textContent = '名前と会社名は必須です';
      formError.hidden = false;
      return;
    }

    const leadData = {
      name,
      company,
      position: scanInputs.position.value.trim(),
      email: scanInputs.email.value.trim(),
      phone: scanInputs.phone.value.trim(),
      interests: scanInputs.interests.value.trim(),
      notes: scanInputs.notes.value.trim(),
      badgeScanMethod: 'manual',
      badgeScanTime: new Date().toISOString()
    };

    const lead = registerLead(leadData); // eslint-disable-line no-unused-vars
    leadForm.reset();
    showToast('リードを登録しました', 'success');
  });

  // ============================================================
  // ダッシュボード
  // ============================================================
  function renderDashboard () {
    renderStats();
    renderLeadsTable(leads);
  }

  function renderStats () {
    const total = leads.length;
    const hot = leads.filter(l => l.leadCategory === 'HOT').length;
    const warm = leads.filter(l => l.leadCategory === 'WARM').length;
    const cold = leads.filter(l => l.leadCategory === 'COLD').length;
    const avg = total > 0 ? Math.round(leads.reduce((sum, l) => sum + l.leadScore, 0) / total) : 0;

    statTotal.textContent = total;
    statHot.textContent = hot;
    statWarm.textContent = warm;
    statCold.textContent = cold;
    statAvg.textContent = avg;
  }

  function renderLeadsTable (data) {
    const list = data || leads;
    if (list.length === 0) {
      leadsTbody.innerHTML = '<tr class="empty-row"><td colspan="6">リードがありません。スキャンタブから登録してください。</td></tr>';
      return;
    }

    leadsTbody.innerHTML = '';
    list.forEach(lead => {
      const template = document.getElementById('lead-row-template');
      const clone = template.content.cloneNode(true);
      const row = clone.querySelector('.lead-row');
      row.dataset.leadId = lead.id;
      row.classList.add('score-' + lead.leadCategory.toLowerCase());
      if (lead.id === selectedLeadId) row.classList.add('selected');

      row.querySelector('.td-score').textContent = lead.leadScore;
      const catSpan = document.createElement('span');
      catSpan.className = 'score-badge score-' + lead.leadCategory.toLowerCase();
      catSpan.textContent = lead.leadCategory;
      row.querySelector('.td-category').appendChild(catSpan);
      row.querySelector('.td-name').textContent = lead.name;
      row.querySelector('.td-company').textContent = lead.company;
      row.querySelector('.td-position').textContent = lead.position || '-';
      row.querySelector('.td-created').textContent = formatDate(lead.createdAt);

      row.addEventListener('click', () => showLeadDetail(lead.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showLeadDetail(lead.id); }
      });

      leadsTbody.appendChild(clone);
    });
  }

  function showLeadDetail (id) {
    selectedLeadId = id;
    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    detailPanel.hidden = false;
    detailName.textContent = lead.name;

    detailBody.innerHTML = '';
    const fields = [
      { label: '会社名', value: lead.company },
      { label: '役職', value: lead.position || '-' },
      { label: 'メール', value: lead.email || '-' },
      { label: '電話', value: lead.phone || '-' },
      { label: 'スコア', value: lead.leadScore + '点' },
      { label: 'カテゴリ', value: lead.leadCategory },
      { label: '関心事項', value: lead.interests || '-' },
      { label: 'メモ', value: lead.notes || '-' },
      { label: '登録日時', value: formatDate(lead.createdAt) },
      { label: 'CRM連携', value: lead.crmPushed ? '済 (' + formatDate(lead.crmPushTime) + ')' : '未' }
    ];

    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = f.label;
      const value = document.createElement('span');
      value.className = 'detail-value';
      value.textContent = f.value;
      row.append(label, value);
      detailBody.appendChild(row);
    });

    // 選択状態を更新
    leadsTbody.querySelectorAll('.lead-row').forEach(r => r.classList.remove('selected'));
    const selRow = leadsTbody.querySelector(`tr[data-lead-id="${id}"]`);
    if (selRow) selRow.classList.add('selected');
  }

  detailClose.addEventListener('click', () => {
    detailPanel.hidden = true;
    selectedLeadId = null;
    leadsTbody.querySelectorAll('.lead-row').forEach(r => r.classList.remove('selected'));
  });

  // 検索
  searchInput.addEventListener('input', function () {
    const q = this.value.trim().toLowerCase();
    if (!q) {
      renderLeadsTable(leads);
      return;
    }
    const filtered = leads.filter(l =>
      l.name.toLowerCase().includes(q) ||
      l.company.toLowerCase().includes(q)
    );
    renderLeadsTable(filtered);
  });

  // ============================================================
  // 会話タブ - リード選択
  // ============================================================
  function renderConversationSelect () {
    convLeadSelect.innerHTML = '<option value="">-- リードを選択 --</option>';
    leads.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.name}（${l.company}）`;
      convLeadSelect.appendChild(opt);
    });
    // テンプレートのセレクトも更新
    renderTemplateLeadSelect();
  }

  convLeadSelect.addEventListener('change', function () {
    const id = this.value;
    if (!id) {
      convEmpty.hidden = false;
      recordingControls.hidden = true;
      recordingsList.hidden = true;
      transcriptionSection.hidden = true;
      scoringSection.hidden = true;
      aiSummary.hidden = true;
      return;
    }

    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    convEmpty.hidden = true;
    recordingControls.hidden = false;
    recordingsList.hidden = false;
    loadRecordings(lead);
    loadTranscription(lead);
    loadScoring(lead);
  });

  // ============================================================
  // 録音機能
  // ============================================================
  async function initAudioVisualizer () {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
    }
    if (audioStream) {
      const source = audioContext.createMediaStreamSource(audioStream);
      source.connect(analyserNode);
      drawVisualizer();
    }
  }

  function drawVisualizer () {
    if (!analyserNode || !visCtx || !isRecording) return;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserNode.getByteFrequencyData(dataArray);

    visCtx.clearRect(0, 0, audioVisualizer.width, audioVisualizer.height);
    const barWidth = (audioVisualizer.width / bufferLength) * 2.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * audioVisualizer.height;
      const gradient = visCtx.createLinearGradient(0, audioVisualizer.height, 0, audioVisualizer.height - barHeight);
      gradient.addColorStop(0, isPaused ? '#9aa0a6' : '#34a853');
      gradient.addColorStop(1, isPaused ? '#dadce0' : '#1a73e8');
      visCtx.fillStyle = gradient;
      visCtx.fillRect(x, audioVisualizer.height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }

    animationId = requestAnimationFrame(drawVisualizer);
  }

  function startRecordingTimer () {
    recordingSeconds = 0;
    recTimer.textContent = '00:00';
    clearInterval(recordingTimer);
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      recTimer.textContent = formatTime(recordingSeconds);
    }, 1000);
  }

  function stopRecordingTimer () {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }

  function resumeRecordingTimer () {
    clearInterval(recordingTimer);
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      recTimer.textContent = formatTime(recordingSeconds);
    }, 1000);
  }

  btnRecStart.addEventListener('click', async function () {
    const leadId = convLeadSelect.value;
    if (!leadId) {
      convError.hidden = false;
      convError.textContent = 'リードを選択してください';
      return;
    }
    convError.hidden = true;

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // SpeechRecognition
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRec) {
        recognition = new SpeechRec();
        recognition.lang = 'ja-JP';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = function (event) {
          interimText = '';
          fullTranscript = '';
          let finalText = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
              finalText += result[0].transcript;
            } else {
              interimText += result[0].transcript;
            }
          }
          if (finalText) {
            const prevText = transcriptDisplay.textContent || '';
            transcriptDisplay.textContent = prevText + finalText;
          }
          interimDisplay.textContent = interimText || '（認識中...）';
          fullTranscript = transcriptDisplay.textContent || '';
        };
        recognition.onerror = function () {
          // SpeechRecognitionエラーは無視（継続）
        };
        try {
          recognition.start();
        } catch (e) {
          // 既に開始済みの場合は無視
        }
        transcriptionFallback.hidden = true;
      } else {
        // SpeechRecognition非対応→手動入力モード
        transcriptionFallback.hidden = false;
        interimDisplay.textContent = '';
      }

      // MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      mediaRecorder = new MediaRecorder(audioStream, { mimeType });
      audioChunks = [];

      mediaRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = function () {
        const blob = new Blob(audioChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const recording = {
          id: generateId(),
          duration: recordingSeconds,
          createdAt: new Date().toISOString(),
          blobUrl: url
        };
        const lead = leads.find(l => l.id === leadId);
        if (lead) {
          if (!lead.conversationRecordings) lead.conversationRecordings = [];
          lead.conversationRecordings.push(recording);
          lead.transcription = fullTranscript || manualTranscript.value || '';
          const { score } = computeScore(lead.transcription, getLeadRecordingDuration(lead));
          lead.leadScore = score;
          lead.leadCategory = getCategory(score);
          lead.aiSummary = generateAiSummary(lead.transcription);
          updateLead(leadId, {
            conversationRecordings: lead.conversationRecordings,
            transcription: lead.transcription,
            leadScore: lead.leadScore,
            leadCategory: lead.leadCategory,
            aiSummary: lead.aiSummary
          });
        }
        loadRecordings(lead);
        loadTranscription(lead);
        loadScoring(lead);
        cleanupRecording();
      };

      mediaRecorder.start(1000);
      isRecording = true;
      isPaused = false;
      btnRecStart.disabled = true;
      btnRecPause.disabled = false;
      btnRecStop.disabled = false;
      recDot.className = 'rec-dot active';
      transcriptionSection.hidden = false;
      transcriptDisplay.textContent = '';
      interimDisplay.textContent = '（認識中...）';
      manualTranscript.value = '';
      fullTranscript = '';
      interimText = '';

      startRecordingTimer();
      initAudioVisualizer();
      showToast('録音を開始しました', 'success');
    } catch (err) {
      console.error('Recording start failed:', err);
      convError.hidden = false;
      convError.textContent = 'マイクの起動に失敗しました。ブラウザの設定をご確認ください。';
      // テキストのみモードにフォールバック
      transcriptionSection.hidden = false;
      transcriptionFallback.hidden = false;
      interimDisplay.textContent = '';
      showToast('マイクが使用できません。テキストモードで操作してください。', 'error');
    }
  });

  btnRecPause.addEventListener('click', function () {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      if (recognition) try { recognition.stop(); } catch (e) { /* ignore */ }
      isPaused = true;
      stopRecordingTimer();
      recDot.className = 'rec-dot paused';
      btnRecPause.textContent = '再開';
      cancelAnimationFrame(animationId);
    } else {
      mediaRecorder.resume();
      if (recognition) try { recognition.start(); } catch (e) { /* ignore */ }
      isPaused = false;
      resumeRecordingTimer();
      recDot.className = 'rec-dot active';
      btnRecPause.textContent = '一時停止';
      drawVisualizer();
    }
  });

  btnRecStop.addEventListener('click', function () {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.stop();
    if (recognition) {
      try { recognition.stop(); } catch (e) { /* ignore */ }
      recognition = null;
    }
    isRecording = false;
    stopRecordingTimer();
    cancelAnimationFrame(animationId);
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
    btnRecStart.disabled = false;
    btnRecPause.disabled = true;
    btnRecStop.disabled = true;
    recDot.className = 'rec-dot';
    btnRecPause.textContent = '一時停止';
    if (visCtx) visCtx.clearRect(0, 0, audioVisualizer.width, audioVisualizer.height);
    showToast('録音を停止しました', 'success');
  });

  function cleanupRecording () {
    mediaRecorder = null;
    audioChunks = [];
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
      analyserNode = null;
    }
  }

  btnSaveManualTranscript.addEventListener('click', function () {
    const leadId = convLeadSelect.value;
    if (!leadId) return;
    const text = manualTranscript.value.trim();
    if (!text) {
      showToast('文字起こしを入力してください', 'error');
      return;
    }
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    fullTranscript = text;
    lead.transcription = text;
    const { score } = computeScore(text, getLeadRecordingDuration(lead));
    lead.leadScore = score;
    lead.leadCategory = getCategory(score);
    lead.aiSummary = generateAiSummary(text);
    updateLead(leadId, {
      transcription: lead.transcription,
      leadScore: lead.leadScore,
      leadCategory: lead.leadCategory,
      aiSummary: lead.aiSummary
    });
    loadTranscription(lead);
    loadScoring(lead);
    showToast('文字起こしを保存しました', 'success');
  });

  function loadRecordings (lead) {
    recordingsContainer.innerHTML = '';
    if (!lead.conversationRecordings || lead.conversationRecordings.length === 0) {
      recordingsContainer.innerHTML = '<div class="empty-state">録音データがありません</div>';
      return;
    }
    lead.conversationRecordings.forEach(rec => {
      const template = document.getElementById('recording-item-template');
      const clone = template.content.cloneNode(true);
      clone.querySelector('.recording-duration').textContent = '録音時間: ' + formatTime(rec.duration);
      clone.querySelector('.recording-time').textContent = formatDate(rec.createdAt);
      const audio = clone.querySelector('.recording-audio');
      if (rec.blobUrl) {
        audio.src = rec.blobUrl;
      }
      recordingsContainer.appendChild(clone);
    });
  }

  function loadTranscription (lead) {
    if (lead.transcription) {
      transcriptionSection.hidden = false;
      transcriptDisplay.textContent = lead.transcription;
      interimDisplay.textContent = '';
    } else {
      // 表示をクリアするが section は非表示にしない（録音開始まで待つ）
    }
  }

  function loadScoring (lead) {
    if (!lead.transcription) {
      scoringSection.hidden = true;
      return;
    }
    scoringSection.hidden = false;
    const { score, details } = computeScore(lead.transcription, getLeadRecordingDuration(lead));
    const category = getCategory(score);

    // ゲージ
    const deg = (score / 100) * 360;
    const color = category === 'HOT' ? '#ea4335' : category === 'WARM' ? '#fbbc04' : '#9aa0a6';
    const nextColor = category === 'HOT' ? '#ea4335' : category === 'WARM' ? '#fbbc04' : '#dadce0';
    scoreGauge.style.background = `conic-gradient(${color} 0deg, ${color} ${deg}deg, ${nextColor} ${deg}deg, #dadce0 360deg)`;
    scoreValue.textContent = score;

    scoreCategory.textContent = category;
    scoreCategory.style.background = category === 'HOT' ? '#fce8e6' : category === 'WARM' ? '#fef7e0' : '#f1f3f4';
    scoreCategory.style.color = category === 'HOT' ? '#ea4335' : category === 'WARM' ? '#e37400' : '#5f6368';

    // 詳細
    scoreDetail.replaceChildren();
    const detailList = document.createElement('ul');
    details.slice(1).forEach(detail => {
      const item = document.createElement('li');
      item.textContent = detail;
      detailList.appendChild(item);
    });
    scoreDetail.appendChild(detailList);

    // AIサマリー
    if (lead.aiSummary) {
      aiSummary.hidden = false;
      summaryContent.replaceChildren();
      const addParagraph = (label, value) => {
        const paragraph = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = label;
        paragraph.append(strong, document.createTextNode(value ? ` ${value}` : ''));
        summaryContent.appendChild(paragraph);
      };
      const addList = values => {
        const list = document.createElement('ul');
        values.forEach(value => {
          const item = document.createElement('li');
          item.textContent = value;
          list.appendChild(item);
        });
        summaryContent.appendChild(list);
      };
      addParagraph('概要:', lead.aiSummary.overview);
      addParagraph('関心事項:');
      addList(lead.aiSummary.interests);
      addParagraph('次のアクション:');
      addList(lead.aiSummary.nextActions);
    } else {
      aiSummary.hidden = true;
    }

    // メモ
    leadNotes.value = lead.notes || '';
  }

  // メモ保存
  btnSaveNotes.addEventListener('click', function () {
    const leadId = convLeadSelect.value;
    if (!leadId) return;
    const text = leadNotes.value.trim();
    updateLead(leadId, { notes: text });
    showToast('メモを保存しました', 'success');
  });

  // ============================================================
  // キャンペーン - CRMエクスポート
  // ============================================================
  btnExportCsv.addEventListener('click', function () {
    if (leads.length === 0) {
      showToast('エクスポートするリードがありません', 'error');
      return;
    }
    const headers = ['id', 'name', 'company', 'position', 'email', 'phone', 'score', 'category', 'interests', 'notes', 'transcription', 'created_at'];
    const csvRows = [headers.join(',')];
    leads.forEach(l => {
      const row = headers.map(h => {
        let val = '';
        switch (h) {
          case 'id': val = l.id; break;
          case 'name': val = l.name; break;
          case 'company': val = l.company; break;
          case 'position': val = l.position || ''; break;
          case 'email': val = l.email || ''; break;
          case 'phone': val = l.phone || ''; break;
          case 'score': val = l.leadScore; break;
          case 'category': val = l.leadCategory; break;
          case 'interests': val = (l.interests || '').replace(/,/g, '、'); break;
          case 'notes': val = (l.notes || '').replace(/,/g, '、'); break;
          case 'transcription': val = (l.transcription || '').replace(/,/g, '、').replace(/\n/g, ' '); break;
          case 'created_at': val = l.createdAt; break;
        }
        return '"' + String(val).replace(/"/g, '""') + '"';
      });
      csvRows.push(row.join(','));
    });
    downloadFile(csvRows.join('\n'), 'booth-leads.csv', 'text/csv;charset=utf-8;');
  });

  btnExportJson.addEventListener('click', function () {
    if (leads.length === 0) {
      showToast('エクスポートするリードがありません', 'error');
      return;
    }
    const data = JSON.stringify(leads, null, 2);
    downloadFile(data, 'booth-leads.json', 'application/json');
  });

  function downloadFile (content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(filename + 'をダウンロードしました', 'success');
  }

  // ============================================================
  // インポート
  // ============================================================
  importFile.addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (evt) {
      try {
        const imported = JSON.parse(evt.target.result);
        if (!Array.isArray(imported)) {
          importResult.textContent = 'エラー: 有効なJSON配列ではありません';
          importResult.style.color = 'var(--warning)';
          return;
        }
        const existingIds = new Set(leads.map(l => l.id));
        let added = 0;
        imported.forEach(item => {
          if (item.id && !existingIds.has(item.id)) {
            // 必須フィールドの補完
            if (!item.name || !item.company) return;
            leads.push({
              id: item.id,
              name: item.name,
              company: item.company,
              position: item.position || '',
              email: item.email || '',
              phone: item.phone || '',
              badgeScanMethod: item.badgeScanMethod || 'import',
              badgeScanTime: item.badgeScanTime || new Date().toISOString(),
              conversationRecordings: item.conversationRecordings || [],
              transcription: item.transcription || '',
              aiSummary: item.aiSummary || null,
              leadScore: item.leadScore || 10,
              leadCategory: item.leadCategory || 'COLD',
              interests: item.interests || '',
              notes: item.notes || '',
              followUpEmailBody: item.followUpEmailBody || '',
              crmPushed: item.crmPushed || false,
              crmPushTime: item.crmPushTime || null,
              createdAt: item.createdAt || new Date().toISOString()
            });
            added++;
          }
        });
        saveLeads();
        renderDashboard();
        renderConversationSelect();
        renderTemplateLeadSelect();
        importResult.textContent = added + '件のリードをインポートしました';
        importResult.style.color = 'var(--accent)';
      } catch (parseErr) {
        importResult.textContent = 'エラー: JSONの解析に失敗しました';
        importResult.style.color = 'var(--warning)';
      }
    };
    reader.readAsText(file);
    // リセット（同じファイルを再選択可能に）
    e.target.value = '';
  });

  // ============================================================
  // メールテンプレート
  // ============================================================
  const EMAIL_TEMPLATES = {
    thankyou: {
      subject: '【{{company}}】{{name}}様 お忙しい中ありがとうございました',
      body: `{{name}} 様

{{company}}
{{position}} {{name}}

この度は、展示会ブースにお越しいただき、誠にありがとうございました。

お話しいただいた内容を元に、{{interests}}について
社内で検討させていただきます。

ご質問等がございましたら、どうぞお気軽にご連絡ください。

引き続きよろしくお願いいたします。`
    },
    materials: {
      subject: '【{{company}}】{{name}}様 ご依頼の資料をお送りいたします',
      body: `{{name}} 様

{{company}}
{{position}} {{name}}

先日はお世話になりました。
ご依頼いただきました資料をお送りいたします。

{{interests}}

ご不明な点がございましたら、どうぞお気軽にご連絡ください。
ご検討のほど、よろしくお願いいたします。`
    },
    demo: {
      subject: '【{{company}}】{{name}}様 デモンストレーションのご案内',
      body: `{{name}} 様

{{company}}
{{position}} {{name}}

先日は展示会ブースにお越しいただきありがとうございました。

ご要望を踏まえ、デモンストレーションをご案内させていただきます。
オンラインでも対面でも対応可能ですので、ご都合の良い日時をお知らせください。

お忙しいところ恐れ入りますが、どうぞよろしくお願いいたします。`
    },
    quote: {
      subject: '【{{company}}】{{name}}様 お見積りのご連絡',
      body: `{{name}} 様

{{company}}
{{position}} {{name}}

先日はお世話になりました。

お見積りについてご連絡いたします。
ご要望いただいた内容を基に、見積書を作成いたしました。

ご確認の上、ご不明な点がございましたらお知らせください。
ご検討のほど、よろしくお願いいたします。`
    }
  };

  function interpolateTemplate (template, lead) {
    return template
      .replace(/\{\{name\}\}/g, lead.name)
      .replace(/\{\{company\}\}/g, lead.company)
      .replace(/\{\{position\}\}/g, lead.position || '')
      .replace(/\{\{interests\}\}/g, lead.interests || 'ご関心いただいた内容');
  }

  function renderTemplateLeadSelect () {
    templateLeadSelect.innerHTML = '<option value="">-- リードを選択（全リードにも適用可） --</option>';
    leads.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.name}（${l.company}）`;
      templateLeadSelect.appendChild(opt);
    });
  }

  function generateEmailPreview () {
    const templateKey = templateSelect.value;
    const leadId = templateLeadSelect.value;
    if (!templateKey) {
      btnPreviewEmail.disabled = true;
      return;
    }
    const template = EMAIL_TEMPLATES[templateKey];
    if (!template) return;

    if (leadId) {
      const lead = leads.find(l => l.id === leadId);
      if (!lead) {
        btnPreviewEmail.disabled = true;
        return;
      }
      const subject = interpolateTemplate(template.subject, lead);
      const body = interpolateTemplate(template.body, lead);
      emailPreview.textContent = '件名: ' + subject + '\n\n' + body;
      btnPreviewEmail.disabled = false;
    } else {
      // 全リード向けプレースホルダ
      emailPreview.textContent = '件名: ' + template.subject + '\n\n' + template.body;
      btnPreviewEmail.disabled = false;
    }
  }

  templateSelect.addEventListener('change', generateEmailPreview);
  templateLeadSelect.addEventListener('change', generateEmailPreview);

  btnPreviewEmail.addEventListener('click', function () {
    generateEmailPreview();
    if (!btnPreviewEmail.disabled) emailPreviewDialog.showModal();
  });

  btnCloseEmail.addEventListener('click', () => emailPreviewDialog.close());
  emailPreviewDialog.addEventListener('click', function (event) {
    if (event.target === emailPreviewDialog) emailPreviewDialog.close();
  });

  btnCopyEmail.addEventListener('click', function () {
    const text = emailPreview.textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      showToast('クリップボードにコピーしました', 'success');
    }).catch(() => {
      // clipboard API 非対応向け
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('クリップボードにコピーしました', 'success');
    });
  });

  btnExportEmailCsv.addEventListener('click', function () {
    const templateKey = templateSelect.value;
    if (!templateKey) {
      showToast('テンプレートを選択してください', 'error');
      return;
    }
    const template = EMAIL_TEMPLATES[templateKey];
    if (!template) return;

    const rows = [['name', 'company', 'email', 'subject', 'body']];
    leads.forEach(l => {
      if (!l.email) return;
      rows.push([
        l.name,
        l.company,
        l.email,
        interpolateTemplate(template.subject, l),
        interpolateTemplate(template.body, l).replace(/\n/g, ' ')
      ]);
    });
    const csv = rows.map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
    downloadFile(csv, 'email-campaign.csv', 'text/csv;charset=utf-8;');
  });

  btnExportEmailTxt.addEventListener('click', function () {
    const templateKey = templateSelect.value;
    if (!templateKey) {
      showToast('テンプレートを選択してください', 'error');
      return;
    }
    const template = EMAIL_TEMPLATES[templateKey];
    if (!template) return;

    let content = '';
    const leadId = templateLeadSelect.value;
    if (leadId) {
      const lead = leads.find(l => l.id === leadId);
      if (lead) {
        content += 'To: ' + (lead.email || '(メール未設定)') + '\n';
        content += interpolateTemplate(template.subject, lead) + '\n';
        content += '---\n';
        content += interpolateTemplate(template.body, lead) + '\n\n';
      }
    } else {
      leads.forEach(l => {
        content += '========================================\n';
        content += 'To: ' + (l.email || '(メール未設定)') + '\n';
        content += '件名: ' + interpolateTemplate(template.subject, l) + '\n';
        content += '---\n';
        content += interpolateTemplate(template.body, l) + '\n\n';
      });
    }
    downloadFile(content, 'email-messages.txt', 'text/plain;charset=utf-8;');
  });

  // ============================================================
  // クリーンアップ（タブクローズ・ページ離脱）
  // ============================================================
  window.addEventListener('beforeunload', function () {
    stopScanner();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (recognition) {
      try { recognition.stop(); } catch (e) { /* ignore */ }
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
    }
    stopRecordingTimer();
    cancelAnimationFrame(animationId);
    if (audioContext) {
      audioContext.close().catch(() => {});
    }
  });

  // ============================================================
  // 初期化
  // ============================================================
  loadLeads();
  renderDashboard();
  renderConversationSelect();
  renderTemplateLeadSelect();
  switchTab('scan');
  loadCameras();

  // スタイルのフォールバック変数
    const varBorderLight = '#dadce0';

  // グローバル公開（デバッグ用）
  window.__leads = leads;

})();
