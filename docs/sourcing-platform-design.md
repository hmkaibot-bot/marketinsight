# Helmet King — Sourcing / Market-Intelligence Platform (`marketinsight`)

> 完整設計藍圖:把頭盔王現時人手 sourcing(官方品牌供應、Webike、歐美零售、Amazon、Reddit)整合成一條同事可以**恆常 review** 的 pipeline。
>
> 核心原則:**整合,唔好做孤島。** 這個平台插進你現有的 Supabase 生態(`shopify-inventory-ops`、`Finance Module`、`Retail Dashboard`、`CONTENT HUB`),用 n8n 採集、Slack 觸發 review、Vercel 出 dashboard、Shopify 做落地。

---

## 0. 一句總結

外部市場訊號(邊啲頭盔/裝備而家熱、新出、缺貨、減價)**×** 你內部數據(我哋有冇賣、賣得點、毛利幾多)的交叉,就是護城河。純爬蟲人人做得到;**「外部 buzz × 內部 sell-through × 落地毛利」的交叉**先係買手真正需要的決策依據。

---

## 1. 四層架構

```
採集層 Ingestion      n8n 排程/webhook + 輕量 scraper + 品牌 line sheet 上載(LLM 解析)
        │                每個渠道獨立排程,一個爛唔會拖死其他
        ▼  append-only
標準化層 Canonicalize  Supabase + Edge Functions:GTIN→MPN→fuzzy 去重階梯
        │                接 shopify-inventory-ops(我哋有冇賣)、Finance(落地成本/毛利)
        ▼
評分層 Scoring         每晚計一個可拆解的 0–100 HotScore(硬閘先行,再加權)
        │
        ▼
審視層 Review          Vercel dashboard + 每日 09:00 Slack top-N digest
                         同事按掣:shortlist / 叫樣板 / source / reject / monitor
```

---

## 2. 各渠道可行性結論(已用 live web 研究,2025–2026)

| 渠道 | 建議主路徑 | 可行性 / 風險 | 關鍵發現 |
|---|---|---|---|
| **官方品牌供應** | **AI 解析 emailed PDF/Excel line sheet + 人手確認 + 版本 diff**。**唔好爬 B2B portal**(會危及 dealer 關係) | 高 / 低 | 香港現實主要係 email 嘅 PDF/Excel(不定期、多幣種、有時掃描檔)。Alpinestars 有 `b2bstore.alpinestars.com`;鴻興(Hung Hing)係區域 Arai/Alpinestars 進口商。Shoei/Arai/AGV 在亞洲多數**冇** self-serve portal → pipeline 要以 email 檔為基線。 |
| **Webike** | **(1) 申請 wholesale 取得權威價格/庫存**;**(2) 爬英文站做訊號** | 中 / 中 | **冇公開 API**。⚠️ 搜尋到的 `developer.webikeo.com` 係**另一間法國公司**(Webikeo 網路研討會),唔好用。Webike 有批發計劃:`japan.webike.net/wholesale_applyform/`(`jp_info@webike.net`)。英文站 `japan.webike.net` 係 server-rendered、robots 容許 catalog/新品/排行/評論(只擋 `/api`、`/gfront`、購物車)。排行用**每週英文 `moto_news` 帖**(易 parse)而非 JS 驅動的 `/ranking/`。`exp.webike.tw` robots 全開,做 TWD 對照。 |
| **歐美零售商** | **Tier 1:affiliate 產品 feed**(Impact.com 一個帳號覆蓋 RevZilla+Cycle Gear+J&P;FC-Moto 用 Webgains/FlexOffers)。**Tier 2:sitemap-diff 偵測新品 + 輕量抓 best-seller/clearance 頁** | 高 / 低 | Affiliate feed 完全合規、直接畀 price + 庫存,仲**賺返佣金**。RevZilla robots 容許 `/best-sellers`、`/new-motorcycle-helmet-releases`、`/trending-helmet-deals`(crawl-delay 1s)。**Sportbike Track Gear 完全排除自動化**(明確封 AI bots、10s crawl-delay、冇 sitemap)。 |
| **Amazon** | **Keepa API**(~EUR 49–459/月)做趨勢引擎 | 高 / 中 | **唔好用 PA-API**:資格門檻(180 日內 3 單、之後每 30 日 ~10 單合資格才保留 access),而且**API 唔會回傳 Best Sellers/Movers & Shakers/New Releases 清單**,且 **2026-05-15 退役**(轉 Creators API 限制相同)。Keepa 畀 BSR 歷史 + 類別 bestseller(node `404836011` = Motorcycle & Powersports Helmets),自己算 7/30 日 BSR 變化即可複製 Movers & Shakers。**硬性 brand filter** 隔走 no-name 雜訊。 |
| **Reddit + 社群** | **官方 Data API 免費 tier(內部、低量)+ LLM 抽取** | 中 / 中 | 免費 tier 100 QPM,但 **2025-11-11 起所有 app 強制 Responsible Builder 預先批准**,且免費 tier **非商業用** + 禁止用其數據訓練/餵 AI 模型 → 立場:內部買手研究、低量、不轉售、不訓練,LLM 只做抽取分類。Watchlist:**r/motorcyclegear(最高訊號)**、r/helmets、r/motorcycles、r/SuggestAMotorcycle、品牌 sub。補充:**YouTube Data API**(評測影片速度)+ **Google Trends**(確認真實搜尋需求)。 |
| **(基線)你自己的 Shopify sell-through** | Shopify Admin GraphQL/ShopifyQL → 每晚入 Supabase | 高 / 低 | **最被低估、最有預測力的訊號**:用「同你過往 winner/dog 的相似度」評分候選品。冇任何外部數據比你自己已證實的 sell-through 更準。 |

---

## 3. 資料模型(Supabase / Postgres)

新開一個 Supabase project `marketinsight`(沿用你既有模組慣例:`uuid` PK、`timestamptz now()`、`text + CHECK` 狀態、`jsonb` payload、`created_by → auth.users`、RLS on)。**跨模組用 business key(barcode/EAN 優先,再 sku/MPN)+ 每晚同步快照,唔用跨 DB FK**(因為係獨立 project)。

**採集核心(append-only)**
- `sources` — 渠道登記(kind、base_url、`crawl_delay_s`、`robots_ok`、enabled)
- `raw_observations` — 每次抓取的快照,source-stamped,`(source, source_uid, content_hash)` 唯一索引 → 每個 collector idempotent,重試/排程重疊都安全
- `price_history` / `signals` — 單表 + `signal_type` 判別欄(demand/trend/buzz…)+ `bigserial` PK,新訊號類型免改 DDL

**標準化主檔**
- `canonical_products` — 去重主檔。**去重 key = STORED generated column `brand|model|variant|size|cert_version|color`** + 唯一索引。⚠️ **cert_version(ECE 22.05 vs 22.06)同 size 一定要入 key**,否則會錯誤合併不同 SKU
- `product_links` — canonical ↔ 各來源 M:N,`match_tier`(`gtin_exact` / `mpn_brand` / `fuzzy_title` / `manual`);**≥0.95 自動連結,以下入人手 merge queue,永不自動合併**

**品牌供應**
- `price_list_document`(原始檔 + supplier + season + version + source)/ `price_list_line`(逐 SKU 成本/RRP/MOQ + `per_field_confidence`)。原始檔留 Google Drive + Supabase Storage,**版本化、永不覆蓋 → 可 diff**

**跨模組快照(每晚同步)**
- `shopify_link` → cache `shopify-inventory-ops`(project `rywfenzskxtcegyudqwl`)的 `public.items`:do-we-carry-it + sell-through + `is_winner/is_dog`
- `finance_link` → 用 `Finance Module`(project `bmsagxmsclkekwgmjkis`)的 `fx_rate` / landed-cost 慣例計 `landed_cost_hkd` + `gross_margin_pct`,加 `cost_freshness_days` flag

**買手工作流**
- `review_queue` — 顯式狀態機 `new → shortlisted → sample_ordered → sourced`,另 `rejected / monitoring / merged`;`hot_scores`(拆解後子分數 + 硬閘 jsonb);`decisions_audit`(每次轉態 append-only:actor、reason_code、👍/👎);`scoring_config`、`buyer_feedback`、`brand_roster`

---

## 4. 採集 pipeline(n8n + 程式碼)

**兩段式分工**:n8n 負責 orchestration / glue(觸發、HTTP、Gmail/Drive watch、Slack、retry、secrets);**brittle/重活(HTML+sitemap parse、fuzzy 去重、Claude 抽取、FX/landed-cost)放 versioned code(Supabase Edge Functions / Vercel functions),由 n8n 經 HTTP 呼叫** —— 唔好塞落巨型 n8n Code node。

- **品牌 line sheet**:Vercel 上載表單(之後加 n8n Gmail/Drive 自動 ingest)→ Claude JSON-schema 抽取(逐欄 confidence,掃描檔用 vision)→ **強制人手確認** → 版本化 + diff 出 NEW/EOL/成本/MAP/MOQ 變動訊號
- **Webike**:Track 1 申請 wholesale(問佢有冇 data feed);Track 2 排程爬英文站 robots 容許頁(`/NewArrivals/` 每日 diff、每週 `moto_news` 排行、品牌頁 watchlist、`/products/<id>.html` 取價/庫存/評論數)。誠實 UA、單線程、≥1 req/s、crawl-delay 10–20s,永不掂 `/api`、`/gfront`
- **歐美**:Impact.com / Webgains 等 affiliate **catalog feed**(CSV/XML/FTP)每日/每週拉 → 正規化成單一表;sitemap-diff 偵測新品;少量抓 best-seller/clearance 頁
- **Amazon**:Keepa 每晚拉 moto node bestseller + BSR/價/評論數快照 → 算 7/30 日 delta;硬 brand filter
- **Reddit**:官方 API 免費 tier(PRAW)每 1–6h 拉 watchlist `/new` `/top` → `raw_reddit_posts`(dedupe on Reddit id)→ Claude 只做抽取分類 {products[], brand, model, sentiment, aspect_tags[], intent, region}
- **韌性**:每個 collector source-isolated;每個 HTTP node 指數退避重試 3 次,最終失敗 → `ingestion_errors` + Slack `#marketinsight-alerts`

---

## 5. 評分排序(每晚,可拆解,先閘後評)

**硬閘(評分前)**:可採購(有 distributor、合理 MOQ)、現行 cert(ECE 22.06)、brand-fit、最低毛利(≥25% floor)。閘失敗**存 reason,唔靜靜 drop**。

**加權 0–100**(預設,放 `scoring_config` 可逐類別 retune):

```
trend_velocity 30 + demand_level 25 + sellthrough_fit 20 + margin_headroom 15 + saturation_health 10
+ gap_bonus 10(高 buzz 但我哋未賣)
± sentiment_modifier 5(Reddit)
× cross_source_corroboration(1 源 0.8 → 4+ 源 1.1)   ← 多渠道印證先係真熱,單源 confidence=low,不能自動升到叫樣板
```

- **價格地板陷阱偵測**:`price_floor_slope_12m` 持續下跌 → 強制 saturation 低,病毒式訊號都唔可以蓋過毛利崩潰警告
- **每行存 `score_components`**:買手永遠見到可拆解的分數,唔淨係一個數字
- **防 alert 疲勞**(借 SOC 做法):只 top-of-distribution 才推、每日 roll-up 唔逐件 ping、已決定的 suppress、sticky reject + reason taxonomy、指數 novelty decay、需 ≥10 分實質上升才 re-alert
- **回饋學習**:買手 accept/reject + 實際 sell-through → 每月 logistic 重新擬合權重;單一來源 reject 率 >50% → 降低 `source_trust`;以 score-vs-實際 sell-through 校準為治理 KPI

---

## 6. 同事 review 流程與介面(恆常使用的部分)

**節奏(配合人的注意力,唔係機器能力)**
- **每日 09:00 HKT**:Slack `#marketinsight` top-N digest(只推淨新增高分 + gap),每張卡有 `Shortlist` / `叫樣板` / `Reject(+原因)` / `Monitor` 掣 → 寫回 `buyer_feedback` / `review_queue`
- **每週 30–60 分鐘**:買手 sourcing 會,喺 Vercel dashboard 處理 shortlist + 樣板決定
- **每月**:模型調權重 + KPI review(剪走 false-positive 高的來源)

**Dashboard(`marketinsight` repo,Next.js + Vercel,讀 Supabase 單一 project 快照表,免 request-time 跨 3 個 DB fan-out)**
- 主畫面:按 HotScore 排序的 review queue,可按品牌/類別/來源/狀態 filter
- Product card:圖、品牌型號、**score 拆解**、「點解上榜(why surfaced)」、各來源連結、價格歷史 sparkline、`we_stock` badge、估算落地毛利、cross-source 印證旗標、cert 版本
- **決策狀態板**(new→shortlisted→sample→sourced + rejected/monitoring)+ **merge-review queue**(處理 Tier3 fuzzy 配對)
- 角色權限:buyer / admin / viewer;「source it」決定把 canonical record 交畀 `shopify-inventory-ops` 上架

---

## 7. 分階段路線圖(crawl → walk → run)

| 階段 | 目標 | 交付 | 粗略工時 |
|---|---|---|---|
| **P0(第 1 週)** | 一條 thin pipeline 跑得通 + 校準基線 | `marketinsight` Supabase project + 核心表;**品牌 line sheet 上載 + Claude 解析 + diff**;極簡 review 清單;**Shopify sell-through 每晚 ingest 作基線** | 3–5 日 |
| **P1(2–3 週)** | 加自動渠道 + Slack digest | 歐美 affiliate feed(Impact)+ Webike 英文站 scraper(訊號)→ `raw_observations`;每日 09:00 Slack top-N | 1–2 週 |
| **P2(4–6 週)** | 去重 + dashboard + 評分 v1 | canonicalization/dedup 階梯 + Vercel dashboard + Finance/Shopify 快照 join + HotScore v1 | 2 週 |
| **P3(2 個月+)** | 智能化 + 回饋 | Amazon(Keepa)+ Reddit buzz + YouTube/Trends;評分回饋 loop + 每月調權重 | 持續 |

### P0 第一個 PR(可即刻動手,零 ToS 風險)
1. `marketinsight` repo scaffold Next.js + Supabase;
2. 新 Supabase project 起 §3 核心表(`sources` / `raw_observations` / `canonical_products` / `product_links` / `price_list_document` / `price_list_line`);
3. 「品牌 line sheet 上載 → Claude JSON-schema 抽取 → 人手確認 → 入庫 + 版本 diff」一條流;
4. 極簡 review 清單頁(table + 狀態掣)+ Shopify sell-through 每晚 ingest;部署上 Vercel。

> 為何由 P0 起步:同事終於有**一個地方睇晒所有品牌新季 line sheet + 變動**,即刻有用、零爬蟲風險,同時把架構骨架立起,之後 Webike/歐美/Amazon/Reddit 逐個插落去。

---

## 8. 需要你/買手拍板的決定

1. **平台首要目標 + 評分權重**:發掘新品 / 品牌新季管理 / 競品價格監察 / 市場情報報告(影響權重同先做邊個渠道)
2. **最先做模板的 3–4 個品牌**(spend 最高、price list 最頻密)
3. **Webike wholesale**:申唔申請(`jp_info@webike.net`)→ 決定 Webike 係 feed-of-record 定 scrape-only
4. **Reddit**:Responsible Builder app 註冊/批准(有 lead time)+ 內部低量用途的法務立場(定追商業授權)
5. **Affiliate publisher property**:用頭盔王官網/blog 做 Impact/Webgains 審批資格?接受放少量 affiliate link?
6. **落地成本假設**:JP/EU/US → HK 的關稅 + 運費假設(邊個維護)→ 毛利數字才可信
7. **Keepa budget/tier**(EUR 49 vs 459/月)+ 確切 moto browse node 清單(US + JP)
8. **確認新 Supabase project**(名/region,同 org 以便跨模組 join)、reject reason taxonomy、初始權重

---

*此文件由跨渠道研究 + 架構設計綜合而成。各渠道的可行性結論已用 2025–2026 即時資料核實;資料模型已對照 live `shopify-inventory-ops` 與 `Finance Module` schema 驗證。*
