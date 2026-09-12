// 正式なチェック項目を取り込むまでの最小構成。
export const CHECKLIST = {
  open: {
    label: '出勤時（開店準備）',
    items: [
      {
        id: 'open-preparation-check',
        label: '開店準備の確認（正式項目反映待ち）',
        photoRequired: false,
        source: 'seed',
      },
    ],
  },
  close: {
    label: '退勤時（閉店作業）',
    items: [
      {
        id: 'roomba-back-clean',
        label: 'ルンバの裏側清掃（ブラシ・車輪・センサーのホコリを取る）',
        photoRequired: true,
        source: 'seed',
      },
    ],
  },
};
