import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const STATUSES = ["new", "shortlisted", "sample_ordered", "sourced", "rejected", "monitoring", "merged"];

/** GET /api/review?status=new — review queue joined to canonical product identity. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const db = createServiceClient();
    let q = db
      .from("review_queue")
      .select(
        "id, status, score, reason, reason_code, created_at, updated_at, canonical_id, canonical_products(brand, model, variant, size, color, cert_version, category, image_url)",
      )
      .order("score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (status && STATUSES.includes(status)) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ items: data });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}

/**
 * PATCH /api/review — update a review item's status (buyer decision).
 * Body: { id, status, reason_code? }. Logs the transition to decisions_audit.
 */
export async function PATCH(req: Request) {
  try {
    const { id, status, reason_code } = (await req.json()) as {
      id?: string;
      status?: string;
      reason_code?: string;
    };
    if (!id || !status || !STATUSES.includes(status)) {
      return NextResponse.json({ error: "id and a valid status are required" }, { status: 400 });
    }
    const db = createServiceClient();

    const { data: before } = await db.from("review_queue").select("status").eq("id", id).single();

    const decided = ["sourced", "rejected"].includes(status);
    const { data, error } = await db
      .from("review_queue")
      .update({
        status,
        reason_code: reason_code ?? null,
        decided_at: decided ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    await db.from("decisions_audit").insert({
      review_id: id,
      canonical_id: data.canonical_id,
      action: status,
      reason_code: reason_code ?? null,
      before_state: before?.status ?? null,
      after_state: status,
    });

    return NextResponse.json({ item: data });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
