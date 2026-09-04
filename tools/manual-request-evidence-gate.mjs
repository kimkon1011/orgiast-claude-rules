import { latestAssistantText } from './lib/assistant-text.mjs';

export function judge(text) {
    // コードフェンスを除去
    const textWithoutCodeFences = text.replace(/```[\s\S]*?```/g, '');
    
    // 逃がし弁: [SCREEN-UNSEEN-OK] があれば無条件で通過
    if (textWithoutCodeFences.includes('[SCREEN-UNSEEN-OK]')) {
        return { triggered: false, missing: [] };
    }
    
    // トリガー判定
    // トリガーは「依頼の言い回し」だけに絞る。話題として単語が出ただけでは止めない。
    // 実際に踏んだ誤爆(2026-08-30): 「次から私が"手作業"を頼もうとすると…」という説明文で block した。
    // 部分一致は『言及』と『実行』を区別できない（worklock hook で2回踏んだのと同じ罠）。
    const triggerPatterns = [
        // ①相手への命令形。実際の依頼はほぼ必ずこの形を含む（「終わったら返信してください」等）
        /(実行|起動|クリック|押|入力|貼り付け|貼っ|打っ|ログイン|承認|認証|発行|設定|開い|やっ|試し|返信|教え|選ん|進ん|変更|変え|直し)(し)?て\s*(ください|下さい|ほしい|欲しい|もらえ)/,
        // ②「〜をお願いします」。挨拶の「よろしくお願いします」を拾わないよう動作語に限定する
        /(実行|操作|作業|対応|確認|ログイン|承認|マージ|クリック|登録|設定)(を)?\s*お願いします/,
        // ③依頼専用の見出し
        /(^|\n)\s{0,3}#{1,4}[^\n]*(お願いしたいこと|やってほしいこと|手作業のお願い)/,
    ];
    
    const triggered = triggerPatterns.some(pattern => pattern.test(textWithoutCodeFences));
    if (!triggered) {
        return { triggered: false, missing: [] };
    }

    // 根拠の宣言の検査
    const missing = [];
    
    // 行頭が「確認済み:」または「未確認:」で始まる行を集める（全角コロン「：」も可、行頭の空白は許す）
    const evidenceLines = [];
    const lines = textWithoutCodeFences.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('確認済み:') || trimmed.startsWith('確認済み：') ||
            trimmed.startsWith('未確認:') || trimmed.startsWith('未確認：')) {
            evidenceLines.push(trimmed);
        }
    }
    
    // 1行も無い -> missing に '根拠の宣言'
    if (evidenceLines.length === 0) {
        missing.push('根拠の宣言');
        return { triggered: true, missing };
    }
    
    // 「未確認:」の行がある -> 合格（正直に未確認と書いているので通す）
    const hasUnconfirmed = evidenceLines.some(line => line.startsWith('未確認:') || line.startsWith('未確認：'));
    if (hasUnconfirmed) {
        return { triggered: true, missing: [] };
    }
    
    // 「確認済み:」の行だけ -> そのうち少なくとも1行が次のどれかを含むこと
    const evidenceTokens = [
        /http:\/\//, /https:\/\//, /\.png/, /\.jpg/, /\.txt/, /\.json/, /\.md/, /tools\//,
        /exit\s*\d+/, /スクショ/, /スクリーンショット/, /実測/, /読み戻/
    ];
    const hasEvidence = evidenceLines.some(line => {
        return evidenceTokens.some(token => token.test(line));
    });
    
    if (!hasEvidence) {
        missing.push('根拠の中身');
    }
    
    return { triggered: true, missing };
}

function main() {
    try {
        if (process.argv.includes('--selftest')) {
            // 自己テスト実行
            const testCases = [
                {
                    text: '処理が完了しました。結果は正常です。',
                    expected: { triggered: false, missing: [] }
                },
                {
                    text: '管理画面で「事前予告」を「3日前まで」から変更してください。',
                    expected: { triggered: true, missing: ['根拠の宣言'] }
                },
                {
                    text: '管理画面で「事前予告」を「3日前まで」から変更してください。\n未確認: Airbnb ホスト画面のラベルは見ていません',
                    expected: { triggered: true, missing: [] }
                },
                {
                    text: '管理画面で「事前予告」を「3日前まで」から変更してください。\n確認済み: analysis/verify-airbnb.png を目視（exit 1）',
                    expected: { triggered: true, missing: [] }
                },
                {
                    text: '管理画面で「事前予告」を「3日前まで」から変更してください。\n確認済み: 社長に聞きました',
                    expected: { triggered: true, missing: ['根拠の中身'] }
                },
                {
                    text: '管理画面で「事前予告」を「3日前まで」から変更してください。\n[SCREEN-UNSEEN-OK]',
                    expected: { triggered: false, missing: [] }
                },
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
                
                const assistantText = latestAssistantText(data.transcript_path);

                // 空チェック
                if (!assistantText) {
                    process.exit(0);
                }
                
                // 判定実行
                const result = judge(assistantText);
                
                if (!result.triggered || result.missing.length === 0) {
                    process.exit(0);
                }
                
                // block出力
                const reason = `[SCREEN-EVIDENCE] 人に手作業を頼んでいますが、その画面を自分で見た根拠が書かれていません。実在しないラベル名や現在値を創作すると、ユーザーに余計な手戻りをさせてしまいます。\n\n依頼と同じメッセージに、次のどちらかを1行入れてください:\n  確認済み: <どうやって見たか。スクショのパス・URL・実行したコマンドと exit code>\n  未確認: <何を見ていないか。ラベル名や現在値が違う可能性がある旨>\n\n画面を自分で見られないときは、多段の操作手順を書く前に「その画面のスクショを1枚ください」の1手から始めるのが正しいです。間違った手順はユーザーの手戻りを増やします。\n\nどうしても不要なときだけ本文に [SCREEN-UNSEEN-OK] と書けば通過します。`;
                
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

if (process.argv[1] && process.argv[1].endsWith('manual-request-evidence-gate.mjs')) {
    main();
}
