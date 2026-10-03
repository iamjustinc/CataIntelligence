"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

interface Result {
  sequence: number;
  revalidated: number;
  needsReview: number;
  needsAnalysis: number;
  reopened: number;
}

export function RevalidateButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        disabled={pending}
        className={buttonClass.primary}
        onClick={async () => {
          setPending(true);
          setMessage(null);
          try {
            const r = await api<Result>("/api/taxonomy/revalidate", { method: "POST", idempotencyKey: key.current, body: {} });
            key.current = crypto.randomUUID();
            setMessage({ ok: true, text: `Version ${r.sequence}: ${r.revalidated} decisions retained, ${r.needsReview} returned to review, ${r.needsAnalysis} need analysis again, ${r.reopened} reopened for the new concepts.` });
            router.refresh();
          } catch (err) {
            setMessage({ ok: false, text: err instanceof ApiClientError ? err.message : "Revalidation failed." });
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Revalidating…" : "Revalidate dependencies"}
      </button>
      <p role="status" aria-live="polite" className={`text-sm ${message?.ok === false ? "text-danger" : "text-ok"}`}>
        {message?.text}
      </p>
    </div>
  );
}
