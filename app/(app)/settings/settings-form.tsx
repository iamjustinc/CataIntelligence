"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, buttonClass, inputClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export interface SettingsView {
  lockVersion: number;
  providerMode: "off" | "demo" | "live";
  liveAiOptIn: boolean;
  aiModelId: string | null;
  serverDefaultModelId: string | null;
  providerKeyConfigured: boolean;
  liveProvider: { label: string; keyVariable: string };
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  jobTokenCap: number;
  jobSpendCapUsd: number;
  dailySpendCapUsd: number;
  jobItemCap: number;
  committedTodayUsd: number;
  highSignalEnabled: boolean;
  fieldsSentToProvider: readonly string[];
  status: { state: string; label: string; detail: string };
}

const MODES = [
  ["off", "Off", "No suggestions. Reviewers map every listing manually."],
  ["demo", "Demo", "Deterministic fixture suggestions for seeded fixture listings only, always labeled Demo. No provider calls."],
  ["live", "Live", "Sends bounded listing fields to the configured model. Requires a server API key, a model ID and the opt-in below."],
] as const;

export function SettingsForm({ settings }: { settings: SettingsView }) {
  const router = useRouter();
  const [mode, setMode] = useState(settings.providerMode);
  const [optIn, setOptIn] = useState(settings.liveAiOptIn);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const text = (k: string) => String(form.get(k) ?? "").trim();
    const number = (k: string) => (text(k) === "" ? null : Number(text(k)));
    setPending(true);
    setMessage(null);
    setFields({});
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          providerMode: mode,
          liveAiOptIn: optIn,
          aiModelId: text("aiModelId") || null,
          inputPricePerMtok: number("inputPricePerMtok"),
          outputPricePerMtok: number("outputPricePerMtok"),
          jobTokenCap: Number(text("jobTokenCap")),
          jobSpendCapUsd: Number(text("jobSpendCapUsd")),
          dailySpendCapUsd: Number(text("dailySpendCapUsd")),
          jobItemCap: Number(text("jobItemCap")),
          expectedVersion: settings.lockVersion,
        },
      });
      setMessage({ ok: true, text: "Settings saved. They apply to jobs started from now on; existing suggestions are unchanged." });
      router.refresh();
    } catch (err) {
      const e2 = err instanceof ApiClientError ? err : null;
      setFields(Object.fromEntries((e2?.fieldErrors ?? []).map((f) => [f.path, f.message])));
      setMessage({ ok: false, text: e2 ? `${e2.message}${e2.status === 409 ? " Reload the page." : ""}` : "Settings could not be saved." });
    } finally {
      setPending(false);
    }
  }

  const field = (name: string, label: string, value: string | number | null, hint: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label htmlFor={`s-${name}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input id={`s-${name}`} name={name} defaultValue={value ?? ""} aria-invalid={fields[name] ? true : undefined} aria-describedby={`s-${name}-hint`} className={inputClass} {...props} />
      <p id={`s-${name}-hint`} className={`mt-1 text-xs ${fields[name] ? "text-danger" : "text-muted"}`}>
        {fields[name] ?? hint}
      </p>
    </div>
  );

  return (
    <form key={settings.lockVersion} onSubmit={onSubmit} className="space-y-6 text-sm">
      <fieldset>
        <legend className="font-display text-lg font-medium">AI provider mode</legend>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-ink-soft">
          Current status:
          <Badge tone={settings.status.state === "demo" ? "warn" : settings.status.state === "live" ? "ok" : settings.status.state === "unavailable" ? "danger" : "neutral"}>{settings.status.label}</Badge>
          <span>{settings.status.detail}</span>
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {MODES.map(([value, label, help]) => (
            <label key={value} className={`flex cursor-pointer gap-3 rounded-sm border p-3 ${mode === value ? "border-ink bg-sunken/50" : "border-rule-strong"}`}>
              <input type="radio" name="providerMode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 accent-[var(--color-stamp)]" />
              <span>
                <span className="font-medium">{label}</span>
                <span className="mt-0.5 block text-ink-soft">{help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg font-medium">Live provider</legend>
        <p className="flex flex-wrap items-center gap-2 text-ink-soft">
          Server API key:
          {settings.providerKeyConfigured ? <Badge tone="ok">Configured</Badge> : <Badge tone="danger">Not configured</Badge>}
          <span>
            Provider: <strong className="text-ink">{settings.liveProvider.label}</strong>. The key is read from the server environment ({settings.liveProvider.keyVariable}). It is never stored in the database, shown here or written to logs.
          </span>
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {field("aiModelId", "Model ID", settings.aiModelId, settings.serverDefaultModelId ? `Leave empty to use the server default (${settings.serverDefaultModelId}).` : "The provider's model ID, for example claude-opus-5-5. No model is assumed when this is empty.", { maxLength: 100, autoComplete: "off", spellCheck: false })}
          {field("inputPricePerMtok", "Input price, USD per million tokens", settings.inputPricePerMtok, "From the provider's current price list. Leave empty if unknown: cost is then reported as unknown, never as zero.", { type: "number", min: 0, step: "0.0001" })}
          {field("outputPricePerMtok", "Output price, USD per million tokens", settings.outputPricePerMtok, "Spending caps can only be enforced when both prices are set. The token cap always applies.", { type: "number", min: 0, step: "0.0001" })}
        </div>
        <label className={`flex items-start gap-2 rounded-sm border p-3 ${optIn ? "border-warn/40 bg-warn-bg text-warn" : "border-rule-strong"}`}>
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-stamp)]" />
          <span>
            Allow this workspace to send catalog data to the live provider. For each listing analyzed, these fields are sent: {settings.fieldsSentToProvider.join(", ")}. Workspace names, user identities, prices and review decisions are not sent. Check the provider&apos;s retention and training terms before using real company data.
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg font-medium">Job limits and budgets</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {field("jobItemCap", "Listings per job", settings.jobItemCap, "A job that would analyze more is refused.", { type: "number", min: 1, max: 5000, required: true })}
          {field("jobTokenCap", "Tokens per job", settings.jobTokenCap, "Hard cap, checked before starting and between batches.", { type: "number", min: 1000, required: true })}
          {field("jobSpendCapUsd", "Spend per job, USD", settings.jobSpendCapUsd, "Needs provider prices to be enforced.", { type: "number", min: 0, step: "0.01", required: true })}
          {field("dailySpendCapUsd", "Spend per day, USD", settings.dailySpendCapUsd, `Workspace total per UTC day. Committed today: USD ${settings.committedTodayUsd.toFixed(2)}.`, { type: "number", min: 0, step: "0.01", required: true })}
        </div>
        <p className="text-ink-soft">
          High signal band: <Badge>{settings.highSignalEnabled ? "Enabled" : "Disabled"}</Badge> It stays disabled until an evaluation on independently labeled, held-out data shows at least 95% precision. It cannot be switched on from this page.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass.primary}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        <p role="status" aria-live="polite" className={message?.ok === false ? "text-danger" : "text-ok"}>
          {message?.text}
        </p>
      </div>
    </form>
  );
}
