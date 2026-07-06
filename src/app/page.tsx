import Link from "next/link";

export default function HomePage() {
  return (
    <main className="container">
      <h1>Helmet King — Sourcing Platform</h1>
      <p className="muted">
        市場情報 pipeline —— 把品牌供應、Webike、歐美零售、Amazon、Reddit 的訊號,
        整合成同事可恆常 review 的貨源決策隊列。
      </p>

      <div className="card">
        <h2>P0 — 已上線</h2>
        <ul>
          <li>
            <Link href="/line-sheets">品牌 line sheet 上載</Link> — 上載 PDF/CSV
            價格表 → Claude 自動解析 → 人手確認 → 入庫並與上一版 diff。
          </li>
          <li>
            <Link href="/review">Review queue</Link> — 買手審視新品/變動,落決定
            (shortlist / 叫樣板 / source / reject / monitor)。
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>下一步 (roadmap)</h2>
        <ul className="muted">
          <li>P1 — 歐美 affiliate feed + Webike 英文站 scraper → 每日 Slack digest</li>
          <li>P2 — 去重/canonicalization + Finance/Shopify 快照 join + HotScore v1</li>
          <li>P3 — Amazon (Keepa) + Reddit buzz + 評分回饋 loop</li>
        </ul>
        <p className="small muted">完整設計見 <code>docs/sourcing-platform-design.md</code></p>
      </div>
    </main>
  );
}
