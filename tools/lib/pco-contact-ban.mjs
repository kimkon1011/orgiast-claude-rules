// 学会運営会社（PCO）への新規連絡禁止（kim 2026-11-17）。
// ドメインは plan3oku-gakkai-011.md 2章と提案Docで確認した公式窓口。

export const PCO_SEND_LIFT_PHRASE = '学会運営会社の送信を許可';

export const PCO_CONTACT_BAN_REASON = '学会運営会社（PCO）への新規連絡は禁止です（ストック・送信禁止）。下書きは保管してよいが、送信候補に上げないでください。既存の進行中やり取りも、送る前に金さんの確認が必要です。金さんが明示的に解除するまで有効。send-context-check では --kim-approved のメモに「学会運営会社の送信を許可」と書いたときだけ通れます。詳細: rules/pco-contact-ban.md';

// 親ドメインだけ書く。サブドメイン（例: or.knt.co.jp）も後ろ一致で対象。
export const PCO_BLOCKED_DOMAINS = [
  'congre.co.jp',
  'congre.com',
  'convention.co.jp',
  'c-linkage.co.jp',
  'med-group.co.jp',
  'med-gakkai.com',
  'med-gakkai.jp',
  'sunplanet.co.jp',
  'knt.co.jp',
  'nta.co.jp',
  'macc.jp',
  'consect.jp',
  'ksconvention.com',
  'jtbcom.co.jp',
  'kohmura.co.jp',
];

export const PCO_TARGET_NAME_PATTERNS = [
  'コングレ',
  '日本コンベンションサービス',
  'コンベンションリンケージ',
  '株式会社メッド',
  'サンプラネット',
  '近畿日本ツーリスト',
  '日本旅行',
  'MAコンベンション',
  'コンベンションセクレタリアット',
  'ケーズ・クルー',
  'ケーズクルー',
  'JTBコミュニケーションデザイン',
  'コームラ',
];

const EMAIL_RE = /[^\s<>,;]+@[^\s<>,;]+/g;

export function normalizeDomain(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

export function isPcoBlockedDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return false;
  return PCO_BLOCKED_DOMAINS.some(blocked => d === blocked || d.endsWith(`.${blocked}`));
}

export function isPcoSendLifted(kimApproved) {
  return String(kimApproved ?? '').includes(PCO_SEND_LIFT_PHRASE);
}

export function extractEmails(value) {
  return String(value ?? '').match(EMAIL_RE) || [];
}

export function findPcoContactBan({ target = '', text = '' } = {}) {
  const fields = [
    { source: 'target', value: target },
    { source: 'text', value: text },
  ];
  for (const { source, value } of fields) {
    for (const email of extractEmails(value)) {
      const address = email.replace(/^<|>$/g, '').toLowerCase();
      const domain = normalizeDomain(address.split('@')[1] || '');
      if (isPcoBlockedDomain(domain)) {
        return { domain, address, source };
      }
    }
  }
  const targetNorm = String(target ?? '').normalize('NFKC');
  for (const name of PCO_TARGET_NAME_PATTERNS) {
    if (targetNorm.includes(name)) return { domain: null, address: null, source: 'target-name', name };
  }
  const targetDomain = normalizeDomain(String(target ?? '').replace(/^@/, ''));
  if (targetDomain && !targetDomain.includes(' ') && isPcoBlockedDomain(targetDomain)) {
    return { domain: targetDomain, address: null, source: 'target' };
  }
  return null;
}
