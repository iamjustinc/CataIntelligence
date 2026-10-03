import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/actor";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getSessionUser(await headers())) redirect("/overview");
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-rail p-12 text-rail-text lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "repeating-linear-gradient(to bottom, #fff 0 1px, transparent 1px 32px)" }} />
        <p className="eyebrow relative !text-rail-text/60">Catalog Intelligence</p>
        <div className="relative">
          <h1 className="rise font-display text-5xl leading-[1.05] font-medium tracking-tight text-white">
            The model proposes.
            <br />
            The server validates.
            <br />
            <span className="text-stamp">The human decides.</span>
          </h1>
          <p className="rise rise-2 mt-6 max-w-md text-[0.95rem] leading-relaxed">
            Import a merchant catalog, review proposed classifications against a canonical taxonomy, publish a reproducible mapping release and measure what remains.
          </p>
        </div>
        <dl className="relative grid grid-cols-3 gap-6 border-t border-rail-soft pt-6 font-mono text-[0.7rem] tracking-wider uppercase">
          <div>
            <dt className="text-rail-text/50">Decisions</dt>
            <dd className="mt-1 text-white">Human approved</dd>
          </div>
          <div>
            <dt className="text-rail-text/50">Releases</dt>
            <dd className="mt-1 text-white">Immutable</dd>
          </div>
          <div>
            <dt className="text-rail-text/50">Numbers</dt>
            <dd className="mt-1 text-white">Database derived</dd>
          </div>
        </dl>
      </section>
      <section className="paper-rules flex items-center justify-center px-6 py-12">
        <div className="rise w-full max-w-sm rounded-md border border-rule bg-surface p-8 shadow-[0_1px_0_var(--color-rule),0_18px_40px_-28px_rgba(28,26,22,0.45)]">
          <p className="eyebrow lg:hidden">Catalog Intelligence</p>
          <h2 className="font-display text-2xl font-medium">Sign in</h2>
          <p className="mt-1 text-sm text-ink-soft">Accounts are provisioned by a workspace administrator.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
