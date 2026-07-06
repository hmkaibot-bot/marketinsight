-- ============================================================================
-- marketinsight — 0001 core schema (P0)
-- Sourcing / market-intelligence platform for Helmet King.
--
-- Conventions mirror the existing Supabase modules (shopify-inventory-ops,
-- Finance Module): uuid PKs via gen_random_uuid(), timestamptz now(),
-- text status columns guarded by CHECK, jsonb payloads, created_by -> auth.users,
-- RLS enabled. Cross-module joins (shopify-inventory-ops, Finance Module) are done
-- by BUSINESS KEY + nightly snapshot tables in later migrations, NOT cross-DB FKs.
--
-- Scope of P0: the ingestion core + the brand line-sheet intake path + the deduped
-- master. Scoring, cross-module snapshots, and per-channel signal tables land in
-- later migrations (P1-P3).
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;     -- trigram fuzzy matching (dedup ladder)

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- sources — channel registry (one row per ingest source)
-- ---------------------------------------------------------------------------
create table sources (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,               -- e.g. 'webike_jp', 'revzilla', 'brand:agv'
  name         text not null,
  kind         text not null check (kind in (
                 'brand_supply', 'webike', 'eu_us_retailer', 'amazon', 'reddit',
                 'youtube', 'google_trends', 'shopify_internal', 'other')),
  base_url     text,
  enabled      boolean not null default true,
  robots_ok    boolean not null default true,      -- may we crawl per robots.txt?
  crawl_delay_s integer not null default 10,        -- politeness delay for scraped sources
  config       jsonb not null default '{}'::jsonb,  -- per-source settings (watchlists, node ids, ...)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger sources_set_updated_at before update on sources
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- canonical_products — deduped master item (one row per physical SKU)
--   dedup key = brand|model|variant|size|cert_version|color (cert_version + size
--   MUST be in the key so ECE 22.05 vs 22.06 / shell sizes are never collapsed).
-- ---------------------------------------------------------------------------
create table canonical_products (
  id            uuid primary key default gen_random_uuid(),
  brand         text not null,
  model         text not null,
  variant       text not null default '',           -- graphic / trim
  size          text not null default '',
  color         text not null default '',
  cert_version  text not null default '',            -- 'ECE 22.06', 'DOT', 'SNELL', ...
  category      text,                                -- mapped to a Shopify collection later
  image_url     text,
  -- normalized, immutable dedup key
  dedup_key     text generated always as (
                   lower(btrim(brand)) || '|' ||
                   lower(btrim(model)) || '|' ||
                   lower(btrim(variant)) || '|' ||
                   lower(btrim(size)) || '|' ||
                   lower(btrim(cert_version)) || '|' ||
                   lower(btrim(color))
                 ) stored,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index canonical_products_dedup_key_uidx on canonical_products (dedup_key);
create index canonical_products_brand_model_idx on canonical_products (lower(brand), lower(model));
create index canonical_products_brand_trgm_idx on canonical_products using gin (brand gin_trgm_ops);
create index canonical_products_model_trgm_idx on canonical_products using gin (model gin_trgm_ops);
create trigger canonical_products_set_updated_at before update on canonical_products
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- raw_observations — append-only per-scrape/feed snapshot, source-stamped.
--   (source_id, source_uid, content_hash) unique => every collector is idempotent
--   so retries and overlapping schedules are safe. canonical_id is back-filled by
--   the matcher job; ingestion never blocks on resolution.
-- ---------------------------------------------------------------------------
create table raw_observations (
  id            bigint generated always as identity primary key,
  source_id     uuid not null references sources (id),
  source_uid    text not null,                       -- stable id at the source (product id, ASIN, reddit id, ...)
  content_hash  text not null,                       -- hash of the normalized payload; dedupes unchanged re-scrapes
  observed_at   timestamptz not null default now(),
  url           text,
  -- lightly-normalized common fields (nullable; full payload in raw)
  title         text,
  brand_text    text,
  price         numeric(14,2),
  currency      text,
  rank          integer,
  in_stock      boolean,
  review_count  integer,
  raw           jsonb not null default '{}'::jsonb,   -- original scraped/feed object
  canonical_id  uuid references canonical_products (id),
  created_at    timestamptz not null default now()
);
create unique index raw_observations_idem_uidx
  on raw_observations (source_id, source_uid, content_hash);
create index raw_observations_source_observed_idx on raw_observations (source_id, observed_at desc);
create index raw_observations_canonical_idx on raw_observations (canonical_id);

-- ---------------------------------------------------------------------------
-- product_links — canonical <-> source mapping (M:N) with a confidence ladder.
--   match_tier: gtin_exact / mpn_brand (>=0.95 auto) ; fuzzy_title (<0.95 -> human
--   merge-review queue) ; manual (100%).
-- ---------------------------------------------------------------------------
create table product_links (
  id           uuid primary key default gen_random_uuid(),
  canonical_id uuid not null references canonical_products (id) on delete cascade,
  source_id    uuid not null references sources (id),
  source_uid   text not null,
  url          text,
  match_tier   text not null check (match_tier in ('gtin_exact','mpn_brand','fuzzy_title','manual')),
  confidence   numeric(4,3) not null default 1.000 check (confidence >= 0 and confidence <= 1),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (source_id, source_uid)
);
create index product_links_canonical_idx on product_links (canonical_id);

-- ---------------------------------------------------------------------------
-- price_history — one row per observed price point per source (sparkline source)
-- ---------------------------------------------------------------------------
create table price_history (
  id           bigint generated always as identity primary key,
  canonical_id uuid not null references canonical_products (id) on delete cascade,
  source_id    uuid not null references sources (id),
  captured_at  timestamptz not null default now(),
  price        numeric(14,2) not null,
  currency     text not null,
  in_stock     boolean
);
create index price_history_canonical_time_idx on price_history (canonical_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- signals — generic time-series (demand / trend / buzz), signal_type discriminator
-- ---------------------------------------------------------------------------
create table signals (
  id           bigint generated always as identity primary key,
  canonical_id uuid not null references canonical_products (id) on delete cascade,
  source_id    uuid references sources (id),
  captured_at  timestamptz not null default now(),
  signal_type  text not null,                        -- 'rank' | 'buzz_mentions' | 'sold_out_days' | 'review_velocity' | ...
  value        numeric(18,4) not null,
  metadata     jsonb not null default '{}'::jsonb
);
create index signals_canonical_type_time_idx on signals (canonical_id, signal_type, captured_at desc);

-- ---------------------------------------------------------------------------
-- Brand supply intake: versioned documents + extracted, human-confirmed lines
-- ---------------------------------------------------------------------------
create table price_list_document (
  id              uuid primary key default gen_random_uuid(),
  source_id       uuid references sources (id),
  supplier        text not null,                     -- distributor / brand entity
  brand           text,
  season          text,                              -- e.g. 'SS26', 'FW25', model-year
  version         integer not null default 1,        -- monotonically increasing per (supplier, brand, season)
  intake_channel  text not null default 'manual' check (intake_channel in ('manual','email','drive','portal')),
  currency        text,
  original_filename text,
  drive_file_id   text,                              -- Google Drive dual-storage convention
  storage_bucket  text,                              -- Supabase Storage
  storage_path    text,
  received_at     timestamptz not null default now(),
  -- extraction bookkeeping
  extraction_model   text,
  extraction_status  text not null default 'pending'
                     check (extraction_status in ('pending','extracting','extracted','confirmed','failed')),
  sync_status     text not null default 'new'
                     check (sync_status in ('new','synced','error')),
  notes           text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (supplier, brand, season, version)
);
create index price_list_document_supplier_idx on price_list_document (supplier, brand, season, version desc);
create trigger price_list_document_set_updated_at before update on price_list_document
  for each row execute function set_updated_at();

create table price_list_line (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references price_list_document (id) on delete cascade,
  canonical_id       uuid references canonical_products (id),   -- linked on confirm
  -- buyer field set (per SKU)
  brand              text,
  model              text,
  variant            text,
  size               text,
  color              text,
  cert_version       text,
  supplier_sku       text,
  barcode            text,                                       -- EAN/UPC/GTIN (top dedup key)
  mpn                text,
  model_year         text,
  moq                integer,
  case_pack          integer,
  wholesale_cost     numeric(14,2),
  cost_currency      text,
  rrp                numeric(14,2),
  map_price          numeric(14,2),
  lead_time_days     integer,
  lifecycle_status   text check (lifecycle_status in ('preorder','current','run-out','eol')),
  exclusivity_terms  text,
  -- extraction / review
  per_field_confidence jsonb not null default '{}'::jsonb,       -- {field: 0..1} from the LLM extractor
  confirmed          boolean not null default false,             -- human-in-the-loop gate
  confirmed_by       uuid references auth.users (id),
  confirmed_at       timestamptz,
  raw_extracted      jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index price_list_line_document_idx on price_list_line (document_id);
create index price_list_line_barcode_idx on price_list_line (barcode);
create index price_list_line_canonical_idx on price_list_line (canonical_id);
create trigger price_list_line_set_updated_at before update on price_list_line
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- review_queue — buyer decision state machine (minimal in P0; scoring joins later)
-- ---------------------------------------------------------------------------
create table review_queue (
  id            uuid primary key default gen_random_uuid(),
  canonical_id  uuid references canonical_products (id) on delete cascade,
  kind          text not null default 'sourcing' check (kind in ('sourcing','merge')),
  status        text not null default 'new'
                check (status in ('new','shortlisted','sample_ordered','sourced','rejected','monitoring','merged')),
  score         numeric(6,2),
  reason        jsonb not null default '{}'::jsonb,   -- "why surfaced" / score components
  reason_code   text,                                 -- reject reason taxonomy
  assignee      uuid references auth.users (id),
  snooze_until  timestamptz,
  slack_channel_id text,
  slack_message_ts text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users (id)
);
create index review_queue_status_score_idx on review_queue (status, score desc nulls last);
create index review_queue_canonical_idx on review_queue (canonical_id);
create trigger review_queue_set_updated_at before update on review_queue
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- decisions_audit — append-only log of every state transition / buyer action
-- ---------------------------------------------------------------------------
create table decisions_audit (
  id            bigint generated always as identity primary key,
  review_id     uuid references review_queue (id) on delete set null,
  canonical_id  uuid references canonical_products (id) on delete set null,
  actor         uuid references auth.users (id),
  actor_email   text,                                 -- denormalized (mirrors Finance Module)
  action        text not null,                        -- 'shortlist' | 'reject' | 'sample_order' | 'source' | 'merge' | ...
  reason_code   text,
  before_state  text,
  after_state   text,
  feedback      smallint,                             -- +1 / -1 thumbs for scoring feedback loop
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index decisions_audit_review_idx on decisions_audit (review_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — enable on all tables. Access is via the service-role key
-- from server-side route handlers / n8n for now; add granular staff policies
-- (buyer / admin / viewer) alongside auth wiring in a later migration.
-- ---------------------------------------------------------------------------
alter table sources                enable row level security;
alter table canonical_products     enable row level security;
alter table raw_observations       enable row level security;
alter table product_links          enable row level security;
alter table price_history          enable row level security;
alter table signals                enable row level security;
alter table price_list_document    enable row level security;
alter table price_list_line        enable row level security;
alter table review_queue           enable row level security;
alter table decisions_audit        enable row level security;

-- ---------------------------------------------------------------------------
-- Seed the source registry with the channels from the design blueprint.
-- ---------------------------------------------------------------------------
insert into sources (key, name, kind, base_url, robots_ok, crawl_delay_s, config) values
  ('webike_jp',      'Webike Japan (English)',       'webike',          'https://japan.webike.net', true, 15,
     '{"tracks":["new_arrivals_daily","ranking_weekly_moto_news","brand_watchlist","product_detail"],"avoid":["/api","/gfront"]}'),
  ('webike_tw',      'Webike Taiwan',                'webike',          'https://exp.webike.tw',    true, 10, '{}'),
  ('revzilla',       'RevZilla (Comoto / Impact)',   'eu_us_retailer',  'https://www.revzilla.com', true, 1,
     '{"feed":"impact.com","curated_pages":["/best-sellers","/new-motorcycle-helmet-releases","/trending-helmet-deals"]}'),
  ('cyclegear',      'Cycle Gear (Comoto / Impact)', 'eu_us_retailer',  'https://www.cyclegear.com', true, 1, '{"feed":"impact.com"}'),
  ('fcmoto',         'FC-Moto',                      'eu_us_retailer',  'https://www.fc-moto.de',   true, 5, '{"feed":"webgains|flexoffers"}'),
  ('champion_helmets','Champion Helmets',            'eu_us_retailer',  'https://www.championhelmets.com', true, 5, '{}'),
  ('amazon_keepa',   'Amazon via Keepa',             'amazon',          'https://www.amazon.com',   true, 0,
     '{"engine":"keepa","browse_nodes":["404836011"],"note":"do NOT use PA-API; brand-filter hard"}'),
  ('reddit',         'Reddit communities',           'reddit',          'https://www.reddit.com',   true, 0,
     '{"subs":["motorcyclegear","helmets","motorcycles","SuggestAMotorcycle"],"posture":"internal_low_volume_no_training"}'),
  ('shopify_internal','Helmet King Shopify sell-through','shopify_internal','https://helmetking.com', true, 0,
     '{"purpose":"calibration_baseline","join_key":"barcode|sku|mpn"}')
on conflict (key) do nothing;
