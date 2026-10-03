"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass, Card, inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

interface Option {
  id: string;
  path: string;
}

export function ProposalForm({ parents, concepts, initial, listing }: { parents: Option[]; concepts: Option[]; initial: { type: "new_leaf" | "synonym"; name: string; parent: string; concept: string }; listing: { id: string; title: string; sku: string } | null }) {
  const router = useRouter();
  const [type, setType] = useState(initial.type);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const key = useRef(crypto.randomUUID());
  const short = (p: string) => p.replace(/^All Products > /, "");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const v = (k: string) => String(form.get(k) ?? "").trim();
    const common = { rationale: v("rationale"), evidenceListingIds: listing ? [listing.id] : [] };
    const body = type === "new_leaf" ? { type, name: v("name"), definition: v("definition"), parentConceptId: v("parent"), ...common } : { type, conceptId: v("concept"), synonym: v("synonym"), ...common };
    setPending(true);
    setError(null);
    setFields({});
    try {
      await api("/api/taxonomy/proposals", { method: "POST", idempotencyKey: key.current, body });
      router.push("/taxonomy/proposals");
      router.refresh();
    } catch (err) {
      key.current = crypto.randomUUID();
      if (err instanceof ApiClientError) {
        setFields(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
        setError(err.message);
      } else setError("The proposal could not be submitted.");
      setPending(false);
    }
  }
  const invalid = (k: string) => (fields[k] ? true : undefined);

  return (
    <Card className="rise rise-1 max-w-3xl p-5">
      <form onSubmit={onSubmit} className="space-y-4 text-sm">
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 font-medium">Proposal type</legend>
          {(
            [
              ["new_leaf", "New leaf concept"],
              ["synonym", "Synonym for an existing concept"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="type" value={value} checked={type === value} onChange={() => setType(value)} className="accent-[var(--color-stamp)]" />
              {label}
            </label>
          ))}
        </fieldset>
        {listing ? (
          <p className="rounded-sm border border-rule bg-sunken/50 px-3 py-2">
            <span className="eyebrow mr-2">Related listing</span>
            {listing.title} <span className="font-mono text-xs text-muted">{listing.sku}</span>
          </p>
        ) : null}
        {type === "new_leaf" ? (
          <>
            <div>
              <label htmlFor="p-name" className="mb-1 block font-medium">
                Name
              </label>
              <input id="p-name" name="name" required maxLength={120} defaultValue={initial.name} aria-invalid={invalid("name")} className={inputClass} />
            </div>
            <div>
              <label htmlFor="p-parent" className="mb-1 block font-medium">
                Parent concept
              </label>
              <select id="p-parent" name="parent" required defaultValue={initial.parent} aria-invalid={invalid("parentConceptId")} className={inputClass}>
                <option value="">Choose an organizing concept</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {short(p.path) || "All Products"}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">Only organizing concepts are listed. A concept that already accepts product mappings cannot have children.</p>
            </div>
            <div>
              <label htmlFor="p-definition" className="mb-1 block font-medium">
                Definition
              </label>
              <textarea id="p-definition" name="definition" required rows={2} maxLength={800} className={inputClass} />
              <p className="mt-1 text-xs text-muted">Say what belongs here and how it differs from neighbouring concepts.</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <label htmlFor="p-concept" className="mb-1 block font-medium">
                Concept
              </label>
              <select id="p-concept" name="concept" required defaultValue={initial.concept} aria-invalid={invalid("conceptId")} className={inputClass}>
                <option value="">Choose a concept</option>
                {concepts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {short(c.path) || "All Products"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="p-synonym" className="mb-1 block font-medium">
                Synonym
              </label>
              <input id="p-synonym" name="synonym" required maxLength={120} defaultValue={initial.name} aria-invalid={invalid("synonym")} className={inputClass} />
              <p className="mt-1 text-xs text-muted">Stored exactly as typed. A synonym helps retrieval; it is not proof that a product belongs to the concept.</p>
            </div>
          </>
        )}
        <div>
          <label htmlFor="p-rationale" className="mb-1 block font-medium">
            Rationale
          </label>
          <textarea id="p-rationale" name="rationale" required rows={2} maxLength={1000} className={inputClass} />
        </div>
        <p role="alert" className="min-h-5 text-danger">
          {error}
        </p>
        <button type="submit" disabled={pending} className={buttonClass.primary}>
          {pending ? "Submitting…" : "Submit for administrator review"}
        </button>
      </form>
    </Card>
  );
}
