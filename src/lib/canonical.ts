import type { SupabaseClient } from "@supabase/supabase-js";

export interface CanonicalFields {
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  size?: string | null;
  color?: string | null;
  cert_version?: string | null;
}

const s = (v?: string | null) => (v ?? "").trim();

/**
 * Upsert a canonical_products row from a confirmed line's identity fields,
 * deduping on the composite key (brand|model|variant|size|cert_version|color).
 * Requires brand + model; returns the canonical id, or null if not enough
 * identity to canonicalize (caller should flag for manual handling).
 *
 * NOTE (P0): dedup here is the composite-key tier only. GTIN/barcode-first and
 * MPN-first matching (the higher tiers of the confidence ladder) are a follow-up.
 */
export async function upsertCanonicalFromLine(
  db: SupabaseClient,
  fields: CanonicalFields,
): Promise<string | null> {
  const brand = s(fields.brand);
  const model = s(fields.model);
  if (!brand || !model) return null;

  const row = {
    brand,
    model,
    variant: s(fields.variant),
    size: s(fields.size),
    color: s(fields.color),
    cert_version: s(fields.cert_version),
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("canonical_products")
    .upsert(row, { onConflict: "dedup_key" })
    .select("id")
    .single();
  if (error) throw error;
  return data?.id ?? null;
}
