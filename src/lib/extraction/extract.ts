import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL, ExtractionResultSchema, type ExtractionResult } from "./schema";

const SYSTEM_PROMPT = `You are a meticulous purchasing analyst for Helmet King, a Hong Kong motorcycle helmet & riding-gear retailer.
You are given a brand/distributor LINE SHEET or PRICE LIST (PDF or tabular text) and must extract EVERY sellable SKU row into structured data.

Rules:
- One output line per orderable SKU (a model x size x color combination is a distinct SKU).
- Preserve the source currency; do not convert. Put the dominant currency at the top level and per-line cost_currency if it differs.
- cert_version matters: capture ECE 22.06 vs 22.05, DOT, SNELL when stated. Never invent it.
- For every field you populate, record a 0..1 confidence in per_field_confidence. Be conservative: values you inferred, OCR'd from a scan, or that were ambiguous should get LOW confidence so a human double-checks them.
- Do not fabricate barcodes, MOQ, or costs. Leave a field null if it is not present.
- Return the result ONLY by calling the record_line_sheet tool.`;

export interface ExtractInput {
  /** File bytes (PDF) or already-extracted tabular text (CSV/plain). */
  data: Buffer | string;
  mediaType: "application/pdf" | "text/plain" | "text/csv";
  /** Optional hints from the upload form. */
  supplier?: string;
  brand?: string;
  season?: string;
}

/**
 * Run Claude over a line sheet and return validated structured rows with
 * per-field confidence. Throws on missing config or an unparseable response.
 */
export async function extractLineSheet(input: ExtractInput): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY.");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const client = new Anthropic({ apiKey });

  const hint = [
    input.supplier ? `Supplier hint: ${input.supplier}` : null,
    input.brand ? `Brand hint: ${input.brand}` : null,
    input.season ? `Season hint: ${input.season}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const content: Anthropic.ContentBlockParam[] = [];
  if (input.mediaType === "application/pdf") {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: (input.data as Buffer).toString("base64"),
      },
    });
  } else {
    content.push({
      type: "text",
      text: `Line sheet (tabular text):\n\n${input.data as string}`,
    });
  }
  content.push({
    type: "text",
    text: `${hint}\n\nExtract every SKU row. Call record_line_sheet with the full result.`,
  });

  const resp = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
    messages: [{ role: "user", content }],
  });

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("Model did not return a record_line_sheet tool call.");

  const parsed = ExtractionResultSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(`Extraction failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
