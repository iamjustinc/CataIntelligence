import Link from "next/link";
import { NavLinks, SignOutButton, WorkspaceSwitcher, type NavItem } from "@/components/shell-client";
import { Badge, type Tone } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { requirePageSession } from "@/lib/auth/session";
import { getProviderStatus } from "@/lib/domain/workspace";

const NAV: NavItem[] = [
  { href: "/overview", label: "Overview", index: "01" },
  { href: "/catalogs", label: "Merchants & Catalogs", index: "02" },
  { href: "/review", label: "Review Queue", index: "03" },
  { href: "/taxonomy", label: "Taxonomy", index: "04" },
  { href: "/analytics", label: "Analytics", index: "05" },
  { href: "/releases", label: "Releases", index: "06" },
  { href: "/audit", label: "Audit", index: "07" },
  { href: "/settings", label: "Settings", index: "08" },
];

const PROVIDER_TONE: Record<string, Tone> = { demo: "warn", live: "ok", unavailable: "danger", off: "neutral" };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, workspaces } = await requirePageSession();
  const provider = await getProviderStatus(actor);
  const environment = process.env.NODE_ENV === "production" ? "Production" : "Development";

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:text-sm">
        Skip to content
      </a>

      <aside className="bg-rail text-rail-text lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <Link href="/overview" className="flex items-center gap-3 px-6 pt-6 pb-5">
          <svg aria-hidden viewBox="0 0 32 32" className="size-8 shrink-0">
            <rect x="1" y="1" width="30" height="30" rx="3" fill="none" stroke="#cfc8b6" strokeWidth="1.5" />
            <path d="M8 10h16M8 16h10M8 22h13" stroke="#cfc8b6" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="23" cy="16" r="2.4" fill="#b93a16" />
          </svg>
          <span className="font-display text-[1.15rem] leading-[1.1] font-medium text-white">
            Catalog
            <br />
            Intelligence
          </span>
        </Link>
        <nav aria-label="Primary" className="lg:flex-1 lg:overflow-y-auto lg:pt-2">
          <NavLinks items={NAV} />
        </nav>
        <div className="hidden border-t border-rail-soft px-6 py-4 lg:block">
          <p className="truncate text-sm font-medium text-white">{actor.name}</p>
          <p className="truncate text-xs text-rail-text/70">{actor.email}</p>
          <p className="mt-2 font-mono text-[0.65rem] tracking-widest text-rail-text/60 uppercase">{ROLE_LABELS[actor.role]}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-surface/80 px-5 py-2.5 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="eyebrow hidden sm:inline">Workspace</span>
            <WorkspaceSwitcher current={actor.workspaceId} options={workspaces.map((w) => ({ id: w.id, name: w.name }))} />
            {actor.workspace.isDemo ? (
              <Badge tone="warn" title="This workspace contains synthetic, fictional data.">
                Demo data
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={PROVIDER_TONE[provider.state]} title={provider.detail}>
              {provider.label}
            </Badge>
            <Badge title="Deployment environment">{environment}</Badge>
            <span className="text-xs text-muted lg:hidden">{ROLE_LABELS[actor.role]}</span>
            <SignOutButton />
          </div>
        </div>
        <main id="main" tabIndex={-1} className="paper-rules flex-1 px-5 py-8 outline-none sm:px-8 lg:px-12">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
