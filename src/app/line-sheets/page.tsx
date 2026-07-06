"use client";

import { useCallback, useEffect, useState } from "react";

interface Doc {
  id: string; supplier: string; brand: string | null; season: string | null;
  version: number; intake_channel: string; currency: string | null;
  original_filename: string | null; extraction_status: string; sync_status: string;
  received_at: string;
}
interface Line {
  id: string; brand: string | null; model: string | null; variant: string | null;
  size: string | null; color: string | null; cert_version: string | null;
  barcode: string | null; moq: number | null; wholesale_cost: number | null;
  cost_currency: string | null; rrp: number | null; lifecycle_status: string | null;
  per_field_confidence: Record<string, number>; confirmed: boolean;
}

export default function LineSheetsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/line-sheets");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "load failed");
      setDocs(json.documents ?? []);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  async function upload(form: FormData) {
    setBusy("upload");
    setError(null);
    try {
      const res = await fetch("/api/line-sheets", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "upload failed");
      await loadDocs();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function extract(doc: Doc) {
    setBusy(`extract:${doc.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/line-sheets/${doc.id}/extract`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "extract failed");
      await loadDocs();
      await openLines(doc);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function openLines(doc: Doc) {
    setSelected(doc);
    const res = await fetch(`/api/line-sheets/${doc.id}/lines`);
    const json = await res.json();
    setLines(json.lines ?? []);
  }

  function edit(id: string, field: keyof Line, value: string) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  }

  async function confirmAll() {
    if (!selected) return;
    setBusy(`confirm:${selected.id}`);
    setError(null);
    try {
      const payload = {
        lines: lines.map((l) => ({
          id: l.id, brand: l.brand, model: l.model, variant: l.variant, size: l.size,
          color: l.color, cert_version: l.cert_version, barcode: l.barcode,
          moq: numOrNull(l.moq), wholesale_cost: numOrNull(l.wholesale_cost),
          cost_currency: l.cost_currency, rrp: numOrNull(l.rrp), lifecycle_status: l.lifecycle_status,
        })),
      };
      const res = await fetch(`/api/line-sheets/${selected.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "confirm failed");
      await loadDocs();
      await openLines(selected);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="container">
      <h1>Brand line sheets</h1>
      <p className="muted">上載品牌/經銷商價格表 → Claude 自動解析成結構化行 → 人手確認 → 入庫並與上一版 diff 出新品/變動。</p>

      {error && <p className="err">錯誤:{error}</p>}

      <div className="card">
        <h2>上載新價格表</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void upload(new FormData(e.currentTarget));
          }}
          className="row"
        >
          <input name="supplier" placeholder="Supplier / distributor *" required />
          <input name="brand" placeholder="Brand (e.g. AGV)" />
          <input name="season" placeholder="Season (e.g. SS26)" />
          <input name="currency" placeholder="Currency (JPY/EUR/USD)" style={{ width: 130 }} />
          <input name="file" type="file" accept=".pdf,.csv,.tsv,.txt" required />
          <button className="primary" type="submit" disabled={busy === "upload"}>
            {busy === "upload" ? "上載中…" : "上載"}
          </button>
        </form>
        <p className="small muted">P0 支援 PDF / CSV / TSV / TXT。(xlsx 解析為後續項目。)</p>
      </div>

      <div className="card table-scroll">
        <h2>已上載文件</h2>
        {docs.length === 0 ? (
          <p className="muted">未有文件。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Supplier / Brand / Season</th><th>Ver</th><th>File</th>
                <th>Extraction</th><th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{[d.supplier, d.brand, d.season].filter(Boolean).join(" / ")}</td>
                  <td>v{d.version}</td>
                  <td className="small muted">{d.original_filename}</td>
                  <td><span className={`badge ${statusBadge(d.extraction_status)}`}>{d.extraction_status}</span></td>
                  <td>
                    <div className="row">
                      <button className="ghost small" disabled={busy === `extract:${d.id}`} onClick={() => void extract(d)}>
                        {busy === `extract:${d.id}` ? "解析中…" : "Extract"}
                      </button>
                      <button className="ghost small" onClick={() => void openLines(d)}>Review</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card table-scroll">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>確認:{[selected.supplier, selected.brand, selected.season].filter(Boolean).join(" / ")} v{selected.version}</h2>
            <button className="primary" disabled={busy === `confirm:${selected.id}` || lines.length === 0} onClick={() => void confirmAll()}>
              {busy === `confirm:${selected.id}` ? "確認中…" : `確認 ${lines.length} 行入庫`}
            </button>
          </div>
          <p className="small muted">低信心欄位以 <span className="conf-low">黃色</span> 標示 —— 請人手核對再確認。</p>
          {lines.length === 0 ? (
            <p className="muted">未有解析結果。按上面 “Extract” 先。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Brand</th><th>Model</th><th>Variant</th><th>Size</th><th>Color</th>
                  <th>Cert</th><th>Cost</th><th>Cur</th><th>RRP</th><th>MOQ</th><th>Barcode</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <Cell l={l} field="brand" onEdit={edit} />
                    <Cell l={l} field="model" onEdit={edit} />
                    <Cell l={l} field="variant" onEdit={edit} />
                    <Cell l={l} field="size" onEdit={edit} width={60} />
                    <Cell l={l} field="color" onEdit={edit} />
                    <Cell l={l} field="cert_version" onEdit={edit} width={90} />
                    <Cell l={l} field="wholesale_cost" onEdit={edit} width={80} />
                    <Cell l={l} field="cost_currency" onEdit={edit} width={55} />
                    <Cell l={l} field="rrp" onEdit={edit} width={70} />
                    <Cell l={l} field="moq" onEdit={edit} width={55} />
                    <Cell l={l} field="barcode" onEdit={edit} width={120} />
                    <td>{l.confirmed ? <span className="badge good">✓</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}

function Cell({
  l, field, onEdit, width = 100,
}: {
  l: Line; field: keyof Line; onEdit: (id: string, f: keyof Line, v: string) => void; width?: number;
}) {
  const conf = l.per_field_confidence?.[field as string];
  const low = typeof conf === "number" && conf < 0.6;
  const val = l[field];
  return (
    <td>
      <input
        className={low ? "conf-low" : ""}
        style={{ width, borderColor: low ? "var(--warn)" : undefined }}
        value={(val ?? "") as string}
        onChange={(e) => onEdit(l.id, field, e.target.value)}
        title={typeof conf === "number" ? `confidence ${conf}` : undefined}
      />
    </td>
  );
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function statusBadge(s: string): string {
  if (s === "confirmed") return "good";
  if (s === "extracted") return "new";
  if (s === "failed") return "bad";
  if (s === "extracting") return "warn";
  return "";
}
