import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ブース来場者受付",
  description: "展示会ブース向け来場者登録プロトタイプ",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
