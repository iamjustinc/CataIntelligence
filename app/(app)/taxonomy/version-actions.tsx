"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { buttonClass } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function DraftActions({ versionId, sequence, lockVersion, conceptCount }: { versionId: string; sequence: number; lockVersion: number; conceptCount: number }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"publish" | "discard" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  const open = (kind: "publish" | "discard") => {
    key.current = crypto.randomUUID();
    setError(null);
    setDialog(kind);
  };

  async function run(kind: "publish" | "discard") {
    setPending(true);
    setError(null);
    try {
      await api(`/api/taxonomy/versions/${versionId}/${kind}`, { method: "POST", idempotencyKey: key.current, body: { expectedVersion: lockVersion } });
      setDialog(null);
      router.replace(kind === "publish" ? `/taxonomy?version=${versionId}` : "/taxonomy");
      router.refresh();
    } catch (err) {
      const e = err instanceof ApiClientError ? err : null;
      const details = e?.fieldErrors.length ? ` ${e.fieldErrors.slice(0, 3).map((f) => f.message).join(" ")}` : "";
      setError(e ? `${e.message}${details}${e.status === 409 ? " Reload the page to see the latest state." : ""}` : "The request failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => open("discard")} className={buttonClass.secondary}>
        Discard draft
      </button>
      <button type="button" onClick={() => open("publish")} className={buttonClass.primary}>
        Publish version {sequence}
      </button>
      <ConfirmDialog
        open={dialog === "publish"}
        title={`Publish taxonomy version ${sequence}?`}
        confirmLabel="Publish"
        pending={pending}
        error={error}
        onConfirm={() => run("publish")}
        onClose={() => setDialog(null)}
      >
        <p>
          Version {sequence} ({conceptCount} concepts) becomes the active taxonomy for this workspace and can no longer be edited. Later changes require a new draft version.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "discard"}
        title={`Discard draft version ${sequence}?`}
        confirmLabel="Discard draft"
        pending={pending}
        error={error}
        onConfirm={() => run("discard")}
        onClose={() => setDialog(null)}
      >
        <p>The draft is retired and its number is not reused. Published versions are not affected.</p>
      </ConfirmDialog>
    </>
  );
}
