"use client";

import { useCallback, useEffect, useState } from "react";

interface Canonical {
  brand: string; model: string; variant: string; size: string; color: string;
  cert_version: string; category: string | null; image_url: string | null;
}
interface ReviewItem {
  id: string;
  status: string;
  score: number | null;
  reason: Record<string, unknown> | null;
  reason_code: string | null;
  created_at: string;
  canonical_id: string | null;
  canonical_products: Canonical | null;
}

const STATUSES = ["new", "shortlisted", "sample_ordered", "sourced", "rejected", "monitoring"];
const ACTIONS: { label: string; status: string }[] = [
  { label: "Shortlist", status: "shortlisted" },
  { label: "叫樣板", status: "sample_ordered" },
  { label: "Source", status: "sourced" },
  { label: "Monitor", status: "monitoring" },
  { label: "Reject", status: "rejected" },
];

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [filter, setFilter] = useState<string>("new");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = filter ? `?status=${filter}` : "";
      const res = await fetch(`/api/review${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "load failed");
      setItems(json.items ?? []);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, status: string) {
    const res = await fetch("/api/review", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) void load();
  }

  return (
    <main className="container">
      <h1>Review queue</h1>
      <p className="muted">按 HotScore 排序的貨源決策隊列。P0 先以品牌供應的新品/變動填充,P1–P3 加入其他渠道訊號。</p>

      <div className="row" style={{ margin: "12px 0" }}>
        <span className="small muted">狀態:</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button className="ghost" onClick={() => void load()}>重新整理</button>
      </div>

      {error && <p className="err">錯誤:{error}（未設定 Supabase env?見 README）</p>}
      {loading ? (
        <p className="muted">載入中…</p>
      ) : items.length === 0 ? (
        <p className="muted">未有項目。去上載一份品牌 line sheet 就會有新品/變動出現喺度。</p>
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Cert</th>
                <th>Score</th>
                <th>Why surfaced</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const c = it.canonical_products;
                return (
                  <tr key={it.id}>
                    <td>
                      <strong>{c ? `${c.brand} ${c.model}` : "—"}</strong>
                      <div className="small muted">
                        {[c?.variant, c?.size, c?.color].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="small">{c?.cert_version || "—"}</td>
                    <td>{it.score ?? <span className="muted">—</span>}</td>
                    <td className="small muted">{summarizeReason(it.reason)}</td>
                    <td><span className={`badge ${badgeFor(it.status)}`}>{it.status}</span></td>
                    <td>
                      <div className="row">
                        {ACTIONS.map((a) => (
                          <button key={a.status} className="ghost small" onClick={() => decide(it.id, a.status)}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function badgeFor(status: string): string {
  if (status === "new") return "new";
  if (status === "sourced") return "good";
  if (status === "rejected") return "bad";
  if (status === "shortlisted" || status === "sample_ordered") return "warn";
  return "";
}

function summarizeReason(reason: Record<string, unknown> | null): string {
  if (!reason) return "—";
  const changes = (reason as { changes?: Record<string, unknown> }).changes;
  if (!changes) return String((reason as { source?: string }).source ?? "");
  if ((changes as { type?: string }).type === "new") return "新品 (品牌供應)";
  const parts = Object.entries(changes)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => {
      const d = v as { from?: unknown; to?: unknown };
      return `${k}: ${d.from ?? "—"} → ${d.to ?? "—"}`;
    });
  return parts.length ? parts.join("; ") : "變動";
}
