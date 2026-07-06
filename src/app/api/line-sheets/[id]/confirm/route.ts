import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { upsertCanonicalFromLine } from "@/lib/canonical";

export const runtime = "nodejs";

interface ConfirmLine {
  id: string; // price_list_line id
  // any overridable fields the human corrected in the review UI
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  size?: string | null;
  color?: string | null;
  cert_version?: string | null;
  barcode?: string | null;
  mpn?: string | null;
  moq?: number | null;
  wholesale_cost?: number | null;
  cost_currency?: string | null;
  rrp?: number | null;
  map_price?: number | null;
  lifecycle_status?: "preorder" | "current" | "run-out" | "eol" | null;
}

/**
 * POST /api/line-sheets/:id/confirm
 * Body: { lines: ConfirmLine[] }  — the human-approved (optionally edited) rows.
 * Commits them: marks lines confirmed, upserts canonical_products, and DIFFs
 * against the previous document version to raise review_queue items for
 * NEW / cost-changed / RRP-changed / MOQ-changed / EOL SKUs.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const db = createServiceClient();
  const documentId = params.id;

  try {
    const body = (await req.json()) as { lines?: ConfirmLine[] };
    const edits = body.lines ?? [];
    if (!edits.length) return NextResponse.json({ error: "no lines to confirm" }, { status: 400 });

    const { data: doc, error: docErr } = await db
      .from("price_list_document")
      .select("id, supplier, brand, season, version")
      .eq("id", documentId)
      .single();
    if (docErr) throw docErr;

    // Previous version's confirmed lines (for the diff), keyed by identity.
    const prevByKey = await loadPreviousVersionLines(db, doc);

    const nowIso = new Date().toISOString();
    let confirmed = 0;
    const reviewItems: Record<string, unknown>[] = [];

    for (const e of edits) {
      // Apply human edits + confirm the line.
      const update: Record<string, unknown> = { confirmed: true, confirmed_at: nowIso };
      for (const k of [
        "brand", "model", "variant", "size", "color", "cert_version", "barcode", "mpn",
        "moq", "wholesale_cost", "cost_currency", "rrp", "map_price", "lifecycle_status",
      ] as const) {
        if (e[k] !== undefined) update[k] = e[k];
      }

      const canonicalId = await upsertCanonicalFromLine(db, e);
      if (canonicalId) update.canonical_id = canonicalId;

      const { data: line, error: lineErr } = await db
        .from("price_list_line")
        .update(update)
        .eq("id", e.id)
        .eq("document_id", documentId)
        .select()
        .single();
      if (lineErr) throw lineErr;
      confirmed += 1;

      // Diff vs previous version.
      const key = identityKey(line);
      const prev = prevByKey.get(key);
      const changes = diffLine(prev, line);
      if (changes && canonicalId) {
        reviewItems.push({
          canonical_id: canonicalId,
          kind: "sourcing",
          status: "new",
          reason: { source: "brand_supply", document_id: documentId, supplier: doc.supplier, changes },
        });
      }
    }

    if (reviewItems.length) {
      const { error: rqErr } = await db.from("review_queue").insert(reviewItems);
      if (rqErr) throw rqErr;
    }

    await db.from("price_list_document").update({ extraction_status: "confirmed" }).eq("id", documentId);

    return NextResponse.json({ confirmed, review_items: reviewItems.length });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}

// --- helpers ---------------------------------------------------------------

type LineRow = {
  brand: string | null; model: string | null; variant: string | null; size: string | null;
  color: string | null; cert_version: string | null; wholesale_cost: number | null;
  rrp: number | null; map_price: number | null; moq: number | null;
  lifecycle_status: string | null;
};

function identityKey(l: Partial<LineRow>): string {
  return [l.brand, l.model, l.variant, l.size, l.color, l.cert_version]
    .map((v) => (v ?? "").toString().trim().toLowerCase())
    .join("|");
}

async function loadPreviousVersionLines(
  db: ReturnType<typeof createServiceClient>,
  doc: { supplier: string; brand: string | null; season: string | null; version: number },
): Promise<Map<string, LineRow>> {
  const map = new Map<string, LineRow>();
  if (doc.version <= 1) return map;

  const { data: prevDoc } = await db
    .from("price_list_document")
    .select("id")
    .eq("supplier", doc.supplier)
    .eq("brand", doc.brand)
    .eq("season", doc.season)
    .eq("version", doc.version - 1)
    .maybeSingle();
  if (!prevDoc) return map;

  const { data: lines } = await db
    .from("price_list_line")
    .select("brand, model, variant, size, color, cert_version, wholesale_cost, rrp, map_price, moq, lifecycle_status")
    .eq("document_id", prevDoc.id)
    .eq("confirmed", true);

  for (const l of lines ?? []) map.set(identityKey(l as LineRow), l as LineRow);
  return map;
}

/** Returns a change summary if the line is new or materially changed, else null. */
function diffLine(prev: LineRow | undefined, cur: Partial<LineRow>): Record<string, unknown> | null {
  if (!prev) return { type: "new" };
  const changes: Record<string, unknown> = {};
  const num = (a: number | null, b: number | null | undefined) =>
    (a ?? null) !== (b ?? null) ? { from: a, to: b ?? null } : null;

  const cost = num(prev.wholesale_cost, cur.wholesale_cost);
  const rrp = num(prev.rrp, cur.rrp);
  const map = num(prev.map_price, cur.map_price);
  const moq = num(prev.moq, cur.moq);
  if (cost) changes.wholesale_cost = cost;
  if (rrp) changes.rrp = rrp;
  if (map) changes.map_price = map;
  if (moq) changes.moq = moq;
  if ((prev.lifecycle_status ?? null) !== (cur.lifecycle_status ?? null)) {
    changes.lifecycle_status = { from: prev.lifecycle_status, to: cur.lifecycle_status ?? null };
  }
  return Object.keys(changes).length ? { type: "changed", ...changes } : null;
}
