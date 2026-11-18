# フォーム実測

確認日: 2026-11-18。公開HTMLと配信JavaScriptをGET。送信テスト・WP変更・GAS変更は行っていない。

## Re:Booth

- 元ページ: https://rebooth.co.jp/contact/
- 実際の action: `/contact/#wpcf7-f4-o1`（下書きにあった23番ではなく4番）。
- ページ内 `wpcf7.api.root` は `https://rebooth.co.jp/wp-json/`、namespace は `contact-form-7/v1`。
- 配信JS `https://rebooth.co.jp/wp-content/plugins/contact-form-7/includes/js/index.js?ver=6.1.6` は `contact-forms/${e.wpcf7.id}/feedback` へPOST。したがって送信先は `https://rebooth.co.jp/wp-json/contact-form-7/v1/contact-forms/4/feedback`。
- 今回の `/wp-json/` GET は200。前提の401は再現しなかった。REST indexの200だけで、reCAPTCHA等を含む送信成功は保証できない。静的英語ページでは既存CF7フォームを使用しない。
- 証拠: `evidence/forms-rebooth.html`, `evidence/cf7-submit.js`, `evidence/preflight-rest.json`。

## Orgiast

- 元ページ: https://www.orgiast.jp/contactus
- CF7ではない。`<form id="js-form" class="contactForm-form">` のactionと `xhr.open('POST', ...)` はともに https://docs.google.com/forms/u/0/d/e/1FAIpQLSfMRXsDEo_lNS2pGWyDwZdCnZ2yqL-9B7IjcQIpxRtpNEoykw/formResponse 。
- JSはFormDataをXHRで送信し、HTTP 200 **または status 0** で `/contactform-complete` に遷移する。status 0は受理の証明にならないため、静的版で成功と表示する処理を流用しない。
- 証拠: `evidence/forms-orgiast.html`。外部送信は実行していない。

## 英語版の結論

`apps/expo-apply/config.js` を**読み取りのみ**で確認し、`FORM_ENDPOINT = ''` を実測。両サイトとも英語フォームは **未接続**。指定どおり `mailto:seisaku-team@orgiast.jp` と電話 `0120-487-121` の案内に置き換える。置換したフォーム専用の古い送信JSも除き、存在しないフォームへのアクセスを防ぐ。

将来FORM_ENDPOINTが設定された場合に備え、`gas/expo-apply/Code.gs` の必須項目（companyName, country, contactPerson, email, exhibitionName）に対応した英語フォーム生成も実装。JSONをtext/plainでPOSTし、`ok: true` のJSON応答でのみ成功を表示する。今回は設定が空なのでこの経路は非稼働・送信未検証。
