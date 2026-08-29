import { readFileSync } from 'node:fs';

export function judge(text) {
    // コードフェンスを除去
    const textWithoutCodeFences = text.replace(/```[\s\S]*?```/g, '');
    
    // トリガー判定
    const triggerPatterns = [
        // 「実行してください」は 実行→し→て の順。語幹の直後に'て'を要求すると1件も当たらない（selftest で実測）
        /(実行|起動|クリック|押|入力|貼り付け|貼っ|打っ|ログイン|承認|認証|発行|設定|開い|やっ|試し)(し)?て\s*(ください|下さい|ほしい|欲しい|もらえ)/,
        /(お願いしたいこと|手作業|やってもらう|人が1回|人間が)/,
        /(user|ユーザー|kim|社長)(に|へ)(お願い|依頼|実行)/
    ];
    
    const triggered = triggerPatterns.some(pattern => pattern.test(textWithoutCodeFences));
    if (!triggered) {
        return { triggered: false, missing: [] };
    }

    // 必須要素の検査
    const missing = [];
    
    // 場所のチェック
    const locationPattern = /(PowerShell|パワーシェル|コマンドプロンプト|ターミナル|端末|ブラウザ|管理画面|スプレッドシート|エクスプローラ|アプリ|画面|スタートメニュー|Windows ?キー)/;
    if (!locationPattern.test(text)) {
        missing.push('場所');
    }
    
    // 手順のチェック（3行以上の数字付きステップ）
    const stepLines = text.match(/^\s*\d+[.)]\s/gm) || [];
    if (stepLines.length < 3) {
        missing.push('手順');
    }
    
    // 成功のチェック
    const successPattern = /(成功|完了|と表示|と出|表示されたら|出たら|出れば|消えます|閉じて)/;
    if (!successPattern.test(text)) {
        missing.push('成功');
    }
    
    // 失敗のチェック
    const failurePattern = /(出ない|表示されない|失敗|エラー|うまくいかな|ダメ|見つからな|貼ってください|教えてください)/;
    if (!failurePattern.test(text)) {
        missing.push('失敗');
    }
    
    return { triggered: true, missing };
}

function main() {
    try {
        if (process.argv.includes('--selftest')) {
            // 自己テスト実行
            const testCases = [
                {
                    text: '実行してください。設定してください。承認してください。',
                    expected: { triggered: true, missing: ['場所', '手順', '成功', '失敗'] }
                },
                {
                    text: 'PowerShellを開いてください。\n1. スタートメニューを開く\n2. PowerShellと入力\n3. Enterを押す\n成功したら完了と表示されます。失敗したら教えてください。',
                    expected: { triggered: true, missing: [] }
                },
                {
                    text: '処理が完了しました。結果は正常です。',
                    expected: { triggered: false, missing: [] }
                },
                {
                    text: 'コード例:\n```\n実行してください\n```\n通常のテキスト',
                    expected: { triggered: false, missing: [] }
                }
            ];
            
            let allPassed = true;
            for (const testCase of testCases) {
                const result = judge(testCase.text);
                if (JSON.stringify(result) !== JSON.stringify(testCase.expected)) {
                    console.error(`テスト失敗: ${JSON.stringify(testCase)}\n結果: ${JSON.stringify(result)}`);
                    allPassed = false;
                }
            }
            
            process.exit(allPassed ? 0 : 1);
            return;
        }
        
        // 標準入力からJSONを読み取り
        let input = '';
        process.stdin.on('data', chunk => {
            input += chunk;
        });
        
        process.stdin.on('end', () => {
            try {
                const data = JSON.parse(input);
                
                // ループ防止
                if (data.stop_hook_active) {
                    process.exit(0);
                }
                
                // トランスクリプトパスのチェック
                if (!data.transcript_path) {
                    process.exit(0);
                }
                
                // トランスクリプト読み込み
                let transcriptLines;
                try {
                    const content = readFileSync(data.transcript_path, 'utf8');
                    transcriptLines = content.split('\n').slice(-80);
                } catch {
                    process.exit(0);
                }
                
                // アシスタントテキストの抽出
                const NL = String.fromCharCode(10);   // ヒアドキュメント越しの改行エスケープ事故を避けるため定数にする
                const entries = [];
                for (const raw of transcriptLines) {
                    try { entries.push(JSON.parse(raw)); } catch { /* パース失敗行は無視 */ }
                }
                // 「最後の user 発言より後ろ」が今回のターン。末尾から遡って集めると
                // 1つ前のターンの発言を読んでしまう（委譲コードの実際の不具合）。
                let lastUser = -1;
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (entries[i] && entries[i].type === 'user') { lastUser = i; break; }
                }
                let assistantText = '';
                for (let i = lastUser + 1; i < entries.length; i++) {
                    const e = entries[i];
                    if (!e || e.type !== 'assistant' || !e.message) continue;
                    const content = e.message.content;
                    if (typeof content === 'string') { assistantText += content + NL; continue; }
                    if (!Array.isArray(content)) continue;
                    for (const b of content) if (b && b.type === 'text' && b.text) assistantText += b.text + NL;
                }

                // 空チェックとMANUAL-OKチェック
                if (!assistantText || assistantText.includes('[MANUAL-OK]')) {
                    process.exit(0);
                }
                
                // 判定実行
                const result = judge(assistantText);
                
                if (!result.triggered || result.missing.length === 0) {
                    process.exit(0);
                }
                
                // block出力
                const reason = `[FULL-STEPS] 人に手作業を頼んでいますが、次が足りません: ${result.missing.join('・')}（§1.5.1 絶対ルール）\n\n書き直しテンプレート:\n- この作業の目的と省略可否\n- 具体的な操作場所（例: Windowsキー → 「powershell」入力 → Enter）\n- コピーする1行コード（コードブロックで）\n- 貼り付け方法（青い画面で右クリック）とEnter押下\n- 成功時の画面表示内容\n- 失敗時の対応表（症状 → 対策）\n\nどうしても手順化できない場合だけ、応答に [MANUAL-OK] と書けばこの検査を通過します。`;
                
                console.log(JSON.stringify({
                    decision: 'block',
                    reason: reason
                }));
                
            } catch {
                // 想定外エラーはfail-open
                process.exit(0);
            }
        });
        
    } catch {
        process.exit(0);
    }
}

if (process.argv[1] && process.argv[1].endsWith('manual-request-fullsteps-gate.mjs')) {
    main();
}
