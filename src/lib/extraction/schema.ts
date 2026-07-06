import { z } from "zod";

/**
 * Buyer field set extracted from a brand/distributor line sheet.
 * Every field is optional because real line sheets are inconsistent; the
 * extractor reports a per-field confidence so low-confidence values are flagged
 * for human confirmation before anything commits.
 */
export const LineItemSchema = z.object({
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  cert_version: z.string().nullable().optional(),
  supplier_sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  mpn: z.string().nullable().optional(),
  model_year: z.string().nullable().optional(),
  moq: z.number().int().nullable().optional(),
  case_pack: z.number().int().nullable().optional(),
  wholesale_cost: z.number().nullable().optional(),
  cost_currency: z.string().nullable().optional(),
  rrp: z.number().nullable().optional(),
  map_price: z.number().nullable().optional(),
  lead_time_days: z.number().int().nullable().optional(),
  lifecycle_status: z
    .enum(["preorder", "current", "run-out", "eol"])
    .nullable()
    .optional(),
  exclusivity_terms: z.string().nullable().optional(),
  /** {fieldName: 0..1} — extractor's confidence per field it filled. */
  per_field_confidence: z.record(z.number().min(0).max(1)).default({}),
});

export type LineItem = z.infer<typeof LineItemSchema>;

export const ExtractionResultSchema = z.object({
  currency: z.string().nullable().optional(),
  supplier: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  season: z.string().nullable().optional(),
  lines: z.array(LineItemSchema),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * JSON Schema handed to Claude as a forced tool call. Keep in sync with
 * ExtractionResultSchema above.
 */
export const EXTRACTION_TOOL = {
  name: "record_line_sheet",
  description:
    "Return the fully structured contents of a motorcycle helmet/gear distributor line sheet.",
  input_schema: {
    type: "object" as const,
    properties: {
      currency: { type: ["string", "null"], description: "Dominant cost currency, ISO 4217 (JPY/EUR/USD/HKD)." },
      supplier: { type: ["string", "null"] },
      brand: { type: ["string", "null"] },
      season: { type: ["string", "null"], description: "Season / model-year, e.g. SS26, FW25, 2026." },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            brand: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            variant: { type: ["string", "null"], description: "Graphic / trim." },
            size: { type: ["string", "null"] },
            color: { type: ["string", "null"] },
            cert_version: { type: ["string", "null"], description: "ECE 22.06, DOT, SNELL, etc." },
            supplier_sku: { type: ["string", "null"] },
            barcode: { type: ["string", "null"], description: "EAN/UPC/GTIN." },
            mpn: { type: ["string", "null"] },
            model_year: { type: ["string", "null"] },
            moq: { type: ["integer", "null"] },
            case_pack: { type: ["integer", "null"] },
            wholesale_cost: { type: ["number", "null"] },
            cost_currency: { type: ["string", "null"] },
            rrp: { type: ["number", "null"], description: "RRP / MSRP." },
            map_price: { type: ["number", "null"] },
            lead_time_days: { type: ["integer", "null"] },
            lifecycle_status: { type: ["string", "null"], enum: ["preorder", "current", "run-out", "eol", null] },
            exclusivity_terms: { type: ["string", "null"] },
            per_field_confidence: {
              type: "object",
              additionalProperties: { type: "number", minimum: 0, maximum: 1 },
              description: "For each field you filled, your 0..1 confidence. Be honest: low for guessed/ambiguous values.",
            },
          },
          required: ["per_field_confidence"],
        },
      },
    },
    required: ["lines"],
  },
} as const;
