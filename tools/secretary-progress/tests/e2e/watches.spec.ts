import { test, expect } from '@playwright/test';

test('dashboard displays a completed HP watch and unresolved asks without hiding auth errors', async ({ page }) => {
  const response = {
    watches: [{ id: 'open', label: '受付の見張り', status: 'open', verdict: 'unmet', deadline: '2026-11-15T05:56:06Z', lastCheck: '2026-11-13T04:30:01Z', detail: '返信待ち' }],
    recentCompleted: [{ id: '4ee33e10', label: '東邦2階HP 使用量把握', status: 'done', verdict: 'done', deadline: '2026-11-15T05:56:06Z', lastCheck: '2026-11-13T04:30:01Z', detail: '達成: 新しい席の報告が台帳に入った' }],
    inboxAsks: [{ id: 'ask', text: '内容をご確認ください', createdAt: '2026-11-13T04:30:01Z', from: 'kim-PC' }], warnings: [], updatedAt: '2026-11-13T04:30:01Z',
  };
  await page.route('**/secretary/api/**', route => route.fulfill({ status: 401, body: '{}' }));
  await page.route('**/secretary/api/watches', route => route.fulfill({ json: response }));
  await page.goto('/secretary');
  const section = page.getByRole('region', { name: 'kim-PC の見張り・確認' });
  await expect(section.getByText('東邦2階HP 使用量把握', { exact: true })).toBeVisible();
  await expect(section.getByText('内容をご確認ください')).toBeVisible();
  await page.getByRole('textbox', { name: '見張り・確認を検索' }).fill('東邦');
  await expect(section.getByText('受付の見張り')).toHaveCount(0);
  await expect(section.getByText('東邦2階HP 使用量把握', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.cache/watches-staged.png', fullPage: true });
  await page.route('**/secretary/api/watches', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.reload();
  await expect(section.getByRole('alert')).toContainText('ログインして');
});
