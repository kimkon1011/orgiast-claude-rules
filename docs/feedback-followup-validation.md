# PR #547: feedback progress regression verification

Validated 2026-09-24 against live GitHub issues and the local Discord directory. No DMs sent; PR not merged.

## Results

- Linux/WSL and Windows native Node: `node tools/feedback-progress-notify.mjs --dry-run --json` returned `ok: true` with six issues.
- Escalations: **6/6 → 5/6**; null states: **1 → 0**; titles containing U+FFFD: **1 → 0**.
- Issue #21 now links to purchasing-management-app PR #22. Its current CI checks are all SUCCESS; failure, pending and queued cases are covered by regressions.
- Issue #13 resolves miho.furukawa0430@gmail.com to 古川未歩 (Discord 1382285704087994413). The existing secretary calendar directory associates the email with 古川 未歩; the live Discord directory resolves that normalized full name exactly. No email-fragment guess or hardcoded person mapping was added.
- Issue #5 already contains replacement characters in GitHub itself (confirmed through REST/gh on Linux). UTF-8 decoding cannot recover lost characters. The notification uses an explicit replacement title and reports `titleFallback: true`; the GitHub original was not edited.
- Backfill and the machine-readable submitter marker are implemented. Actual home ledgers were not written during dry-run; planned backfill is shown below and real write/reuse behavior is tested with temporary fixtures.
- Related test suites: 56 passed, 0 failed (progress notify, issue intake, completion notify, Discord member directory).

## Windows native dry-run excerpt

```json
{
  "ok": true,
  "dryRun": true,
  "items": [
    {
      "key": "kimkon1011/purchasing-management-app#13",
      "title": "[要望] 倉庫アプリとの連動に関して",
      "state": "pr_open",
      "url": "https://github.com/kimkon1011/purchasing-management-app/pull/15",
      "recipient": "古川未歩",
      "recipientId": "1382285704087994413",
      "escalated": false,
      "sent": false,
      "titleFallback": false,
      "checks": [
        {
          "name": "Lint / Typecheck / Test",
          "state": "SUCCESS"
        },
        {
          "name": "E2E (Playwright)",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel Preview Comments",
          "state": "SUCCESS"
        }
      ]
    },
    {
      "key": "kimkon1011/purchasing-management-app#21",
      "title": "[要望] 自分で備品を購入したときにアプリ上で登録すると、備品管理表への登録と経理申請までスムーズに完了する",
      "state": "pr_open",
      "url": "https://github.com/kimkon1011/purchasing-management-app/pull/22",
      "recipient": "kim",
      "recipientId": "715210673642012733",
      "escalated": true,
      "sent": false,
      "titleFallback": false,
      "checks": [
        {
          "name": "Lint / Typecheck / Test",
          "state": "SUCCESS"
        },
        {
          "name": "E2E (Playwright)",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel Preview Comments",
          "state": "SUCCESS"
        }
      ]
    },
    {
      "key": "kimkon1011/purchasing-management-app#7",
      "title": "[不具合] 領収書アップロード失敗",
      "state": "pr_open",
      "url": "https://github.com/kimkon1011/purchasing-management-app/pull/16",
      "recipient": "kim",
      "recipientId": "715210673642012733",
      "escalated": true,
      "sent": false,
      "titleFallback": false,
      "checks": [
        {
          "name": "Lint / Typecheck / Test",
          "state": "SUCCESS"
        },
        {
          "name": "E2E (Playwright)",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel Preview Comments",
          "state": "SUCCESS"
        }
      ]
    },
    {
      "key": "kimkon1011/purchasing-management-app#6",
      "title": "[要望] アリババ、お支払いのみ",
      "state": "pr_open",
      "url": "https://github.com/kimkon1011/purchasing-management-app/pull/17",
      "recipient": "kim",
      "recipientId": "715210673642012733",
      "escalated": true,
      "sent": false,
      "titleFallback": false,
      "checks": [
        {
          "name": "Lint / Typecheck / Test",
          "state": "SUCCESS"
        },
        {
          "name": "E2E (Playwright)",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel",
          "state": "SUCCESS"
        },
        {
          "name": "Vercel Preview Comments",
          "state": "SUCCESS"
        }
      ]
    },
    {
      "key": "kimkon1011/purchasing-management-app#5",
      "title": "フォームからのご報告 #5（原題の文字化けあり）",
      "state": "stalled",
      "url": "https://github.com/kimkon1011/purchasing-management-app/issues/5",
      "recipient": "kim",
      "recipientId": "715210673642012733",
      "escalated": true,
      "sent": false,
      "titleFallback": true,
      "checks": []
    },
    {
      "key": "kimkon1011/purchasing-management-app#4",
      "title": "[不具合] [疎通テスト] 不具合・要望フォーム再導入の確認 2026-08-28 14:35:14",
      "state": "stalled",
      "url": "https://github.com/kimkon1011/purchasing-management-app/issues/4",
      "recipient": "kim",
      "recipientId": "715210673642012733",
      "escalated": true,
      "sent": false,
      "titleFallback": false,
      "checks": []
    }
  ],
  "errors": []
}
```

## Behavior and limitations

Open issues always use one of answered/pr_open/pr_blocked/stalled. With no question or PR, stalled is the fallback; its message now says only that work is ongoing, so recent issues are not falsely called late. Pending checks leave the PR open without claiming that CI passed. PRs are enumerated and checked only within the issue repository.

Submitter resolution tries ledger ID, ledger submitter, JSON marker, then Japanese label lines. Email/name mismatches use the existing local calendar identity directory when present and require an exact unique Discord full-name match. Unresolved identities still escalate; an installation without this optional directory cannot infer this email/name relationship until the ledger contains an ID.

Dry-run preserves notification ledger, submitter ledger and member cache. Normal execution backfills resolved IDs before notification and preserves the readable Discord label for later runs.
