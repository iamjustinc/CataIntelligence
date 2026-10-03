@AGENTS.md

# Catalog Intelligence

- Source of truth: `PRD.md`. Keep `BUILD_STATUS.md` (status + evidence per requirement ID), `DECISIONS.md` and `README.md` current after each phase.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (needs `pnpm db:up`), `pnpm build`.
- Tenant data access goes through `withContext()` in `db/client.ts`; API routes use `route()` in `lib/api/handler.ts`; services in `lib/domain` re-check capabilities.
- Schema changes: edit `db/schema.ts`, run `pnpm db:generate`. New tenant tables need a custom migration calling `apply_workspace_rls()`.
