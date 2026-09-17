import { latestAssistantText } from './lib/assistant-text.mjs';
import { hasManualRequest } from './manual-request-fullsteps-gate.mjs';
import { isEntry } from './is-entry.mjs';

const FIRST_BRANCH = /初回(?:は|のみ)|初めて|はじめて|新規に作成|まだ登録されていない|未登録の場合/;
const EXISTING_BRANCH = /既に|すでに|登録済み|作成済み|[2２]回目以降|設定済みの場合|既存の/;

function mainProcedure(text) {
    let inFailureSection = false;
    return text.split(/\r?\n/).filter(line => {
        // 対応表の節は階層を問わず次の見出しで終了する。
        const heading = /^\s{0,3}#{1,6}\s+/.test(line);
        if (heading) inFailureSection = false;
        if ((heading && /失敗|対応表|うまくいかない/.test(line)) ||
            ((line.match(/\|/g) || []).length >= 2 && /症状/.test(line))) {
            inFailureSection = true;
        }
        return !inFailureSection;
    }).join('\n');
}

export function check(text) {
    // コード例の依頼文・分岐語・逃げ道は判定材料にしない。
    const body = text.replace(/```[\s\S]*?```/g, '');
    const bypass = /\[BRANCH-OK:[^\S\r\n]*([^\]\r\n]+)\]/g;
    if ([...body.matchAll(bypass)].some(match => match[1].trim().length > 0)) {
        return { triggered: false, missing: [] };
    }
    if (!hasManualRequest(body)) return { triggered: false, missing: [] };

    const missing = [];
    if (FIRST_BRANCH.test(body) && !EXISTING_BRANCH.test(mainProcedure(body))) {
        missing.push('分岐:既存の場合');
    }
    return { triggered: true, missing };
}

async function main() {
    if (process.argv.includes('--test') || process.argv.includes('--selftest')) {
        const { runTests } = await import('./handoff-branch-coverage-gate.test.mjs');
        process.exitCode = await runTests();
        return;
    }
    try {
        // UTF-8 の多バイト文字がチャンク境界で分割されても壊さない。
        process.stdin.setEncoding('utf8');
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const data = JSON.parse(input.replace(/^\uFEFF/, ''));
        if (data.stop_hook_active) return;
        const result = check(latestAssistantText(data.transcript_path));
        if (!result.triggered || result.missing.length === 0) return;

        const reason = `[BRANCH-COVERAGE] 状態を片方に決め打ちした手順です\n不足: ${result.missing.join('・')}\n本流の手順として両方の分岐を書くこと。失敗時対応表に逃がすのは不可\n既存かどうかを user に確認させるのではなく、user が画面で見分けられる目印（例: 『◯◯が表示されていたら手順Aへ、△△なら手順Bへ』）を先に書くこと\n対象が片側に限られる理由がある場合は [BRANCH-OK: 理由] を記載してください。理由なしの [BRANCH-OK] は通過しません。`;
        console.error(reason);
        // 手本と同じ Stop hook 契約: JSON decision + exit 0。
        console.log(JSON.stringify({ decision: 'block', reason }));
    } catch {
        // 手本と同じく想定外エラーは fail-open。
        process.exitCode = 0;
    }
}

if (isEntry(import.meta.url)) main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
