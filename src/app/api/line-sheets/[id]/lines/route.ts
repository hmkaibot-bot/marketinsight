import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** GET /api/line-sheets/:id/lines — extracted rows for the human-in-the-loop review. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("price_list_line")
      .select("*")
      .eq("document_id", params.id)
      .order("brand", { ascending: true })
      .order("model", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ lines: data });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
