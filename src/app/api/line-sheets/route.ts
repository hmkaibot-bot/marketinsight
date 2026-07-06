import { NextResponse } from "next/server";
import { createServiceClient, LINE_SHEETS_BUCKET } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** GET /api/line-sheets — list uploaded documents (newest first). */
export async function GET() {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("price_list_document")
      .select(
        "id, supplier, brand, season, version, intake_channel, currency, original_filename, extraction_status, sync_status, received_at",
      )
      .order("received_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return NextResponse.json({ documents: data });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}

/**
 * POST /api/line-sheets — upload a line sheet (multipart form-data).
 * fields: file (required), supplier (required), brand, season, currency, intake_channel
 * Stores the raw file in Supabase Storage and creates a versioned price_list_document.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const supplier = (form.get("supplier") as string | null)?.trim();
    if (!(file instanceof File) || !supplier) {
      return NextResponse.json({ error: "file and supplier are required" }, { status: 400 });
    }
    const brand = (form.get("brand") as string | null)?.trim() || null;
    const season = (form.get("season") as string | null)?.trim() || null;
    const currency = (form.get("currency") as string | null)?.trim() || null;
    const intakeChannel = ((form.get("intake_channel") as string | null)?.trim() || "manual") as
      | "manual"
      | "email"
      | "drive"
      | "portal";

    const db = createServiceClient();

    // Next version for this (supplier, brand, season) — version + diff is the core value.
    const { data: prev, error: prevErr } = await db
      .from("price_list_document")
      .select("version")
      .eq("supplier", supplier)
      .eq("brand", brand)
      .eq("season", season)
      .order("version", { ascending: false })
      .limit(1);
    if (prevErr) throw prevErr;
    const version = (prev?.[0]?.version ?? 0) + 1;

    // Store the raw file (never overwritten — versioned path).
    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${supplier}/${brand ?? "_"}/${season ?? "_"}/v${version}/${safeName}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await db.storage
      .from(LINE_SHEETS_BUCKET)
      .upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
    if (upErr) throw upErr;

    const { data: doc, error: docErr } = await db
      .from("price_list_document")
      .insert({
        supplier,
        brand,
        season,
        version,
        currency,
        intake_channel: intakeChannel,
        original_filename: file.name,
        storage_bucket: LINE_SHEETS_BUCKET,
        storage_path: storagePath,
        extraction_status: "pending",
      })
      .select()
      .single();
    if (docErr) throw docErr;

    return NextResponse.json({ document: doc }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
