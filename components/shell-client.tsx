"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { api, ApiClientError } from "@/lib/client/api";

export interface NavItem {
  href: string;
  label: string;
  index: string;
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex gap-1 overflow-x-auto px-3 pb-2 lg:block lg:space-y-0.5 lg:overflow-visible lg:px-3 lg:pb-0">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`group flex items-baseline gap-3 rounded-sm px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                active ? "bg-rail-soft text-white" : "text-rail-text hover:bg-rail-soft/60 hover:text-white"
              }`}
            >
              <span className={`font-mono text-[0.65rem] tracking-widest ${active ? "text-stamp" : "text-rail-text/50"}`}>{item.index}</span>
              <span className={active ? "font-semibold" : ""}>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function WorkspaceSwitcher({ current, options }: { current: string; options: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (options.length <= 1) {
    return <span className="truncate text-sm font-medium text-ink">{options[0]?.name}</span>;
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor="workspace-switcher" className="sr-only">
        Workspace
      </label>
      <select
        id="workspace-switcher"
        value={current}
        disabled={pending}
        onChange={(e) => {
          const workspaceId = e.target.value;
          setError(null);
          startTransition(async () => {
            try {
              await api("/api/workspaces/active", { method: "POST", body: { workspaceId } });
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiClientError ? err.message : "Could not switch workspace.");
            }
          });
        }}
        className="max-w-[16rem] truncate rounded-sm border border-rule-strong bg-surface py-1 pr-7 pl-2 text-sm font-medium text-ink"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <span role="status" aria-live="polite" className="text-xs text-danger">
        {error}
      </span>
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
        router.replace("/login");
        router.refresh();
      }}
      className="rounded-sm px-2 py-1 text-xs font-medium text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-60"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
