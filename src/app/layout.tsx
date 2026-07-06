import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Helmet King — marketinsight",
  description: "Sourcing / market-intelligence review platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>
        <nav className="nav">
          <span className="brand">🪖 marketinsight</span>
          <Link href="/">Overview</Link>
          <Link href="/review">Review queue</Link>
          <Link href="/line-sheets">Brand line sheets</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
