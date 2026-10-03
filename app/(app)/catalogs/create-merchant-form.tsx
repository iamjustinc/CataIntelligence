"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function CreateMerchantForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  // One key per logical submission: a retry of the same attempt is deduplicated by the server.
  const keyRef = useRef<string>(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const value = (k: string) => String(form.get(k) ?? "").trim();
    setPending(true);
    setMessage(null);
    setFields({});
    try {
      const created = await api<{ name: string }>("/api/merchants", {
        method: "POST",
        idempotencyKey: keyRef.current,
        body: { name: value("name"), externalKey: value("externalKey") || null, region: value("region") || null },
      });
      keyRef.current = crypto.randomUUID();
      formRef.current?.reset();
      setMessage({ kind: "ok", text: `Added ${created.name}.` });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setFields(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
        setMessage({ kind: "error", text: err.message });
        if (!err.retryable) keyRef.current = crypto.randomUUID();
      } else {
        setMessage({ kind: "error", text: "Could not add the merchant." });
      }
    } finally {
      setPending(false);
    }
  }

  const field = (name: string, label: string, required = false, hint?: string) => (
    <div>
      <label htmlFor={`m-${name}`} className="mb-1 block text-sm font-medium">
        {label} {required ? null : <span className="font-normal text-muted">(optional)</span>}
      </label>
      <input id={`m-${name}`} name={name} required={required} maxLength={120} className={inputClass} aria-invalid={fields[name] ? true : undefined} aria-describedby={`m-${name}-help`} />
      <p id={`m-${name}-help`} className={`mt-1 text-xs ${fields[name] ? "text-danger" : "text-muted"}`}>
        {fields[name] ?? hint}
      </p>
    </div>
  );

  return (
    <form ref={formRef} onSubmit={onSubmit} className="mt-4 space-y-3">
      {field("name", "Name", true, "Unique within the workspace.")}
      {field("externalKey", "External key", false, "Your identifier for this merchant.")}
      {field("region", "Region")}
      <button type="submit" disabled={pending} className={`${buttonClass.primary} w-full`}>
        {pending ? "Adding…" : "Add merchant"}
      </button>
      <p role="status" aria-live="polite" className={`min-h-5 text-sm ${message?.kind === "error" ? "text-danger" : "text-ok"}`}>
        {message?.text}
      </p>
    </form>
  );
}
