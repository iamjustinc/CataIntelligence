"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge, buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { BAND_LABELS, BAND_TONES, STATE_LABELS, STATE_TONES, type ReviewState, type SignalBand } from "@/lib/review-labels";

export interface QueueItem {
  id: string;
  sku: string;
  title: string;
  merchantCategoryPath: string | null;
  merchantName: string;
  state: ReviewState;
  lockVersion: number;
  band: SignalBand | null;
  isDemo: boolean | null;
  warningCount: number;
  proposedPath: string | null;
  decided: boolean;
  recommendationStale: boolean;
}

const eligible = (i: QueueItem) => i.state === "suggested" && i.band === "high" && !i.recommendationStale && i.warningCount === 0;

export function QueueTable({ items, linkQuery, canDecide }: { items: QueueItem[]; linkQuery: string; canDecide: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const key = useRef(crypto.randomUUID());
  const selectable = items.filter(eligible);
  const showBulk = canDecide && selectable.length > 0;

  async function approve() {
    setPending(true);
    setError(null);
    try {
      const body = { items: items.filter((i) => selected.has(i.id)).map((i) => ({ listingRevisionId: i.id, expectedVersion: i.lockVersion })) };
      const result = await api<{ approved: number }>("/api/review/bulk-approve", { method: "POST", idempotencyKey: key.current, body });
      setOpen(false);
      setSelected(new Set());
      setMessage(`Approved ${result.approved} listing${result.approved === 1 ? "" : "s"}.`);
      router.refresh();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(err instanceof ApiClientError ? `${err.message}${err.status === 409 ? " Reload the queue and select again." : ""}` : "Bulk approval failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {showBulk ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-sunken/40 px-5 py-2.5 text-sm">
          <span>
            <span className="font-mono">{selected.size}</span> of {selectable.length} High signal suggestion{selectable.length === 1 ? "" : "s"} on this page selected
          </span>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => {
              key.current = crypto.randomUUID();
              setError(null);
              setOpen(true);
            }}
            className={buttonClass.secondary}
          >
            Approve selected
          </button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className={message ? "border-b border-rule bg-ok-bg px-5 py-2 text-sm text-ok" : "sr-only"}>
        {message}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Review queue</caption>
          <thead className="border-b border-rule-strong bg-sunken/60">
            <tr className="eyebrow [&>th]:px-4 [&>th]:py-2.5 [&>th]:font-normal">
              {showBulk ? (
                <th scope="col" className="w-10">
                  <span className="sr-only">Select for bulk approval</span>
                </th>
              ) : null}
              <th scope="col">Listing</th>
              <th scope="col">Merchant path</th>
              <th scope="col">Proposed canonical path</th>
              <th scope="col">Status</th>
              <th scope="col">Signal</th>
              <th scope="col">Warnings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {items.map((item) => (
              <tr key={item.id} className="align-top [&>td]:px-4 [&>td]:py-3">
                {showBulk ? (
                  <td>
                    {eligible(item) ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.title} for bulk approval`}
                        checked={selected.has(item.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                        className="size-4 accent-[var(--color-stamp)]"
                      />
                    ) : null}
                  </td>
                ) : null}
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <Link href={`/review/${item.id}${linkQuery ? `?${linkQuery}` : ""}`} className="font-medium text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                    {item.title}
                  </Link>
                  <span className="mt-0.5 block text-xs text-muted">
                    <span className="font-mono">{item.sku}</span> · {item.merchantName}
                  </span>
                </th>
                <td className="text-ink-soft">{item.merchantCategoryPath ?? "—"}</td>
                <td>
                  {item.proposedPath ? (
                    <>
                      <span className="text-ink">{item.proposedPath.replace(/^All Products > /, "")}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1.5">
                        <span className="text-xs text-muted">{item.decided ? "Reviewer decision" : "Suggestion"}</span>
                        {!item.decided && item.isDemo ? <Badge tone="warn">Demo</Badge> : null}
                        {item.recommendationStale && !item.decided ? <Badge tone="warn">Stale</Badge> : null}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">None</span>
                  )}
                </td>
                <td>
                  <Badge tone={STATE_TONES[item.state]}>{STATE_LABELS[item.state]}</Badge>
                </td>
                <td>{item.band ? <Badge tone={BAND_TONES[item.band]}>{BAND_LABELS[item.band]}</Badge> : <span className="text-muted">—</span>}</td>
                <td className="font-mono text-xs">{item.warningCount > 0 ? item.warningCount : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog open={open} title={`Approve ${selected.size} selected listing${selected.size === 1 ? "" : "s"}?`} confirmLabel={`Approve ${selected.size}`} pending={pending} error={error} onConfirm={approve} onClose={() => setOpen(false)}>
        <p>
          Each selected listing is mapped to its suggested concept. The server rechecks every row; if any changed or is no longer eligible, nothing is saved and you will see which rows conflicted.
        </p>
        <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto text-xs">
          {items
            .filter((i) => selected.has(i.id))
            .map((i) => (
              <li key={i.id}>
                {i.title} → {i.proposedPath?.replace(/^All Products > /, "")}
              </li>
            ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}
