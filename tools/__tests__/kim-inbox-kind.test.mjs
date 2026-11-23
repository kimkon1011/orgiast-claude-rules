import { describe, it } from 'node:test';
import assert from 'node:assert';
import { looksLikeApprovalRequest } from '../lib/kim-inbox-kind.mjs';
import { sweepInfoCandidates as originalSweepInfoCandidates } from '../kim-inbox.mjs';

// Mock data for testing
const mockItems = [
  { id: 'ki-20230101000000-0001', kind: 'info', status: 'open', text: '通常の情報', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0002', kind: 'info', status: 'open', text: '承認をお願いします', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0003', kind: 'info', status: 'open', text: '判断が必要です', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0004', kind: 'info', status: 'open', text: 'どちらの選択肢が良いでしょうか？', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0005', kind: 'info', status: 'open', text: 'YES で進めますか？', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0006', kind: 'info', status: 'open', text: '決めてください', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'ki-20230101000000-0007', kind: 'info', status: 'open', text: '未配信かつ30日未満', createdAt: '2023-01-01T00:00:00.000Z' },
];

describe('kim-inbox-kind', () => {
  describe('looksLikeApprovalRequest', () => {
    it('should return true for text containing 承認', () => {
      assert.strictEqual(looksLikeApprovalRequest('承認をお願いします'), true);
    });

    it('should return true for text containing 判断', () => {
      assert.strictEqual(looksLikeApprovalRequest('判断が必要です'), true);
    });

    it('should return true for text containing どちら', () => {
      assert.strictEqual(looksLikeApprovalRequest('どちらの選択肢が良いでしょうか？'), true);
    });

    it('should return true for text containing YES', () => {
      assert.strictEqual(looksLikeApprovalRequest('YES で進めますか？'), true);
    });

    it('should return true for text containing 決めて', () => {
      assert.strictEqual(looksLikeApprovalRequest('決めてください'), true);
    });

    it('should return false for normal info text', () => {
      assert.strictEqual(looksLikeApprovalRequest('通常の情報'), false);
    });
  });

  describe('sweepInfoCandidates compatibility', () => {
    it('should produce same results as original sweepInfoCandidates', () => {
      // 新しい looksLikeApprovalRequest を使用したバージョン
      function sweepInfoCandidates(items, { now = Date.now() } = {}) {
        const openInfos = items.filter(i => i.kind === 'info' && i.status === 'open');
        const targetIds = new Set();
        const excludedReasons = [];
        const dedupeGroups = new Map(); // dedupeKey -> [{item, index}]
        for (const item of openInfos) {
          // Exclude: 承認キーワードを含むもの
          if (looksLikeApprovalRequest(item.text)) {
            excludedReasons.push({ id: item.id, reason: '承認キーワードを含む' });
            continue;
          }
          // Exclude: 未配信かつ 30 日未満
          const days = (now - Date.parse(item.createdAt)) / 86_400_000;
          if (!item.deliveredToKim && days < 30) {
            excludedReasons.push({ id: item.id, reason: '未配信かつ30日未満' });
            continue;
          }
          // 対象候補
          targetIds.add(item.id);
          // dedupeKey でグループ化
          if (item.dedupeKey) {
            if (!dedupeGroups.has(item.dedupeKey)) dedupeGroups.set(item.dedupeKey, []);
            dedupeGroups.get(item.dedupeKey).push(item);
          }
        }
        // dedupeKey 重複: 最新1件だけ残し、残りを対象に追加
        for (const [, group] of dedupeGroups) {
          if (group.length < 2) continue;
          group.sort((a, b) => (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt));
          const keep = group[0];
          targetIds.delete(keep.id); // 最新1件は対象外
          for (const dup of group.slice(1)) {
            targetIds.add(dup.id); // 重複行は対象
          }
        }
        return { targetIds, excludedReasons };
      }

      // 元の実装と新しい実装の結果を比較
      const now = Date.parse('2023-02-01T00:00:00.000Z');
      const originalResult = originalSweepInfoCandidates(mockItems, { now });
      const newResult = sweepInfoCandidates(mockItems, { now });

      // targetIds の比較
      assert.deepStrictEqual(
        [...originalResult.targetIds].sort(),
        [...newResult.targetIds].sort()
      );

      // excludedReasons の比較
      assert.deepStrictEqual(
        originalResult.excludedReasons.sort((a, b) => a.id.localeCompare(b.id)),
        newResult.excludedReasons.sort((a, b) => a.id.localeCompare(b.id))
      );
    });
  });
});
