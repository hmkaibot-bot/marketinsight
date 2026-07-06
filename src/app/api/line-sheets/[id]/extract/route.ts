import { NextResponse } from "next/server";
import { createServiceClient, LINE_SHEETS_BUCKET } from "@/lib/supabase/server";
import { extractLineSheet } from "@/lib/extraction/extract";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/line-sheets/:id/extract
 * Pulls the stored file, runs Claude extraction, and inserts UNCONFIRMED
 * price_list_line rows (human confirms them next). Idempotent-ish: it clears
 * prior unconfirmed lines for this document before re-inserting.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const db = createServiceClient();
  const documentId = params.id;

  try {
    const { data: doc, error: docErr } = await db
      .from("price_list_document")
      .select("*")
      .eq("id", documentId)
      .single();
    if (docErr) throw docErr;
    if (!doc?.storage_path) throw new Error("Document has no stored file.");

    await db.from("price_list_document").update({ extraction_status: "extracting" }).eq("id", documentId);

    const { data: blob, error: dlErr } = await db.storage
      .from(doc.storage_bucket || LINE_SHEETS_BUCKET)
      .download(doc.storage_path);
    if (dlErr) throw dlErr;

    const buf = Buffer.from(await blob.arrayBuffer());
    const name: string = doc.original_filename || "";
    const isPdf = name.toLowerCase().endsWith(".pdf");
    const isCsvOrText = /\.(csv|txt|tsv)$/i.test(name);

    if (!isPdf && !isCsvOrText) {
      // Excel/other binary formats need a pre-parse step (follow-up: add xlsx -> CSV).
      await db.from("price_list_document").update({ extraction_status: "failed" }).eq("id", documentId);
      return NextResponse.json(
        { error: `Unsupported format for auto-extraction in P0: ${name}. Supported: PDF, CSV/TSV/TXT. (xlsx parsing is a follow-up.)` },
        { status: 415 },
      );
    }

    const result = await extractLineSheet({
      data: isPdf ? buf : buf.toString("utf8"),
      mediaType: isPdf ? "application/pdf" : name.toLowerCase().endsWith(".csv") ? "text/csv" : "text/plain",
      supplier: doc.supplier,
      brand: doc.brand ?? undefined,
      season: doc.season ?? undefined,
    });

    // Replace prior unconfirmed lines, keep confirmed ones.
    await db.from("price_list_line").delete().eq("document_id", documentId).eq("confirmed", false);

    const rows = result.lines.map((l) => ({
      document_id: documentId,
      brand: l.brand ?? doc.brand ?? null,
      model: l.model ?? null,
      variant: l.variant ?? null,
      size: l.size ?? null,
      color: l.color ?? null,
      cert_version: l.cert_version ?? null,
      supplier_sku: l.supplier_sku ?? null,
      barcode: l.barcode ?? null,
      mpn: l.mpn ?? null,
      model_year: l.model_year ?? null,
      moq: l.moq ?? null,
      case_pack: l.case_pack ?? null,
      wholesale_cost: l.wholesale_cost ?? null,
      cost_currency: l.cost_currency ?? result.currency ?? doc.currency ?? null,
      rrp: l.rrp ?? null,
      map_price: l.map_price ?? null,
      lead_time_days: l.lead_time_days ?? null,
      lifecycle_status: l.lifecycle_status ?? null,
      exclusivity_terms: l.exclusivity_terms ?? null,
      per_field_confidence: l.per_field_confidence ?? {},
      confirmed: false,
      raw_extracted: l,
    }));

    if (rows.length) {
      const { error: insErr } = await db.from("price_list_line").insert(rows);
      if (insErr) throw insErr;
    }

    await db
      .from("price_list_document")
      .update({
        extraction_status: "extracted",
        extraction_model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        currency: doc.currency ?? result.currency ?? null,
      })
      .eq("id", documentId);

    return NextResponse.json({ extracted: rows.length });
  } catch (err) {
    await db.from("price_list_document").update({ extraction_status: "failed" }).eq("id", documentId);
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
