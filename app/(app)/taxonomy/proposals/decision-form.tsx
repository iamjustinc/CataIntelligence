"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function ProposalDecisionForm({ id, lockVersion, type, name, definition }: { id: string; lockVersion: number; type: "new_leaf" | "synonym"; name: string; definition: string }) {
  const router = useRouter();
  const [editedName, setEditedName] = useState(name);
  const [editedDefinition, setEditedDefinition] = useState(definition);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const modified = editedName.trim() !== name || (type === "new_leaf" && editedDefinition.trim() !== definition);

  async function decide(decision: "approve" | "reject") {
    if (pending) return;
    const actual = decision === "approve" && modified ? "modify" : decision;
    if ((actual === "reject" || actual === "modify") && !reason.trim()) return setError(actual === "reject" ? "Explain why the proposal is rejected." : "Explain the change you made.");
    setPending(decision);
    setError(null);
    try {
      const modifications = actual === "modify" ? (type === "new_leaf" ? { name: editedName.trim(), definition: editedDefinition.trim() } : { synonym: editedName.trim() }) : undefined;
      await api(`/api/taxonomy/proposals/${id}/decision`, { method: "POST", idempotencyKey: key.current, body: { decision: actual, reason: reason.trim() || null, expectedVersion: lockVersion, modifications } });
      router.refresh();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(err instanceof ApiClientError ? `${err.message}${err.status === 409 ? " Reload the page." : ""}` : "The decision could not be saved.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-rule pt-3 text-sm">
      <h3 className="eyebrow">Administrator decision</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`name-${id}`} className="mb-1 block font-medium">
            {type === "new_leaf" ? "Name" : "Synonym"}
          </label>
          <input id={`name-${id}`} value={editedName} onChange={(e) => setEditedName(e.target.value)} maxLength={120} className={inputClass} />
        </div>
        {type === "new_leaf" ? (
          <div>
            <label htmlFor={`definition-${id}`} className="mb-1 block font-medium">
              Definition
            </label>
            <input id={`definition-${id}`} value={editedDefinition} onChange={(e) => setEditedDefinition(e.target.value)} maxLength={800} className={inputClass} />
          </div>
        ) : null}
      </div>
      <div>
        <label htmlFor={`reason-${id}`} className="mb-1 block font-medium">
          Explanation <span className="font-normal text-muted">(required to reject or to approve with changes)</span>
        </label>
        <input id={`reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending !== null || !editedName.trim()} onClick={() => decide("approve")} className={buttonClass.primary}>
          {pending === "approve" ? "Saving…" : modified ? "Approve with changes" : "Approve into draft"}
        </button>
        <button type="button" disabled={pending !== null} onClick={() => decide("reject")} className={buttonClass.secondary}>
          {pending === "reject" ? "Saving…" : "Reject"}
        </button>
        <span className="text-xs text-muted">Approval edits the draft taxonomy. The live tree changes only when the draft is published.</span>
      </div>
      <p role="alert" className="min-h-5 text-danger">
        {error}
      </p>
    </div>
  );
}
