# marketinsight — Helmet King Sourcing Platform

市場情報 / 貨源 pipeline:把品牌供應、Webike、歐美零售、Amazon、Reddit 的訊號,整合成同事可**恆常 review** 的決策隊列。完整設計見 [`docs/sourcing-platform-design.md`](docs/sourcing-platform-design.md)。

## 這個 repo 的狀態(P0)

已實作的 thin vertical slice:

- **品牌 line sheet intake** — 上載 PDF/CSV → Claude 結構化解析(逐欄 confidence)→ 人手確認 → 入庫,並與上一版本 diff 出「新品 / 成本變動 / RRP 變動 / MOQ 變動 / EOL」→ 自動入 review queue。
- **Review queue** — 買手審視並落決定(shortlist / 叫樣板 / source / reject / monitor),每次轉態寫入 `decisions_audit`。
- **核心 Supabase schema** — `supabase/migrations/0001_core_schema.sql`(採集核心 + 去重主檔 + 品牌供應 + review 工作流)。

> P1–P3(其他渠道採集、canonicalization 去重階梯、HotScore 評分、Slack digest、Finance/Shopify 快照 join)見設計文件路線圖。

## 技術棧

Next.js 14 (App Router, TypeScript) · Supabase (Postgres + Storage) · Anthropic (line-sheet 抽取) · 部署於 Vercel。

## 本機啟動

```bash
npm install
cp .env.example .env.local   # 填入下面的值
npm run dev                  # http://localhost:3000
```

## 需要 provision 的 infra(動到 live 系統 / 涉成本,交你拍板)

1. **新 Supabase project `marketinsight`**(建議獨立 project,沿用你 per-module 慣例,與 `shopify-inventory-ops` / `Finance Module` 同 org 以便日後跨模組 join)。
2. 套用 migration:`supabase/migrations/0001_core_schema.sql`(可用 Supabase CLI `supabase db push`,或喺 SQL editor 執行)。
3. 建一個 Storage bucket(預設名 `line-sheets`)。
4. 填 `.env.local`:`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ANTHROPIC_API_KEY`(`ANTHROPIC_MODEL` 預設 `claude-sonnet-5`)。
5. **Vercel** 部署:把上述 env 加入 Vercel project。

## 專案結構

```
supabase/migrations/0001_core_schema.sql   核心 schema + source 登記 seed
src/lib/supabase/                          server(service-role) / browser client
src/lib/extraction/                        Claude 抽取:schema.ts(工具+zod) / extract.ts
src/lib/canonical.ts                       去重 upsert(composite-key tier;GTIN/MPN tier 為後續)
src/app/api/line-sheets/                   上載 / 列表 / :id/extract / :id/confirm / :id/lines
src/app/api/review/                        review queue GET + PATCH(決策 + audit)
src/app/line-sheets/                       上載 + 人手確認 UI
src/app/review/                            review queue UI
```

## 安全 / 權限備註

- `SUPABASE_SERVICE_ROLE_KEY` 只喺 server route handlers 用,永不落 client。
- 所有表已 `enable row level security`;P0 經 service-role 存取,細粒度 staff policy(buyer/admin/viewer)連同 auth 於後續 migration 加入。
- 官方品牌 B2B portal **不爬**(關係風險)—— 只做人手/自動檔案上載 intake。
