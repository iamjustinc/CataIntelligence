"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { buttonClass } from "@/components/ui";

/** Modal confirmation built on <dialog>: focus is trapped natively and Escape closes it. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending,
  error,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pending: boolean;
  error?: string | null;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="confirm-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border border-rule-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-ink/50"
    >
      <div className="p-6">
        <h2 id="confirm-title" className="font-display text-xl font-medium">
          {title}
        </h2>
        <div className="mt-2 text-sm leading-relaxed text-ink-soft">{children}</div>
        <p role="alert" className="mt-3 min-h-5 text-sm text-danger">
          {error}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={pending || confirmDisabled} className={buttonClass.primary}>
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
