# Release notes

## 0.1.0: demonstration candidate (2026-10-05)

The first build that contains both halves of the product: the taxonomy workflow and governed analytics over the same data. It is a **demonstration candidate in demo mode**. It is not a production release: live AI has never been run, the evaluation gates are unmet, and it has never been deployed.

### What you can do

- **Set up a workspace.** Load a canonical taxonomy from CSV, validate it, publish it as an immutable version.
- **Import merchant catalogs.** Map columns, see row-level validation, choose snapshot or delta, commit an immutable revision. Unchanged listings keep their decisions.
- **Get suggestions.** Analysis runs as a background job in a separate worker with progress, cancellation, retry and budget caps. In demo mode, suggestions are curated fixtures for the seeded products only and are labeled as demo output everywhere.
- **Review.** Approve, change, reject, defer or mark "no suitable category", with evidence and alternatives beside the listing, keyboard shortcuts, and conflict detection when two people decide the same listing.
- **Change the taxonomy.** Propose a new leaf or synonym, have an administrator decide, publish a new version, and revalidate what depends on it. Stale work cannot be published.
- **Publish.** Preview, then publish a full or acknowledged partial release. Roll back to a compatible earlier release. Export a release as CSV, JSON or ZIP, byte-for-byte reproducible.
- **Measure.** A dashboard with coverage, backlog, ambiguity, failures, merchant comparison, review activity and publication history; every figure links to the listings behind it.
- **Ask.** Type a question, read and edit the interpretation, run it, follow up, save it as a report, share it, refresh it, export it.
- **Audit.** Every change is in an append-only log with actor, role, reason and request ID.

### Added since the Phase 3 build

- Publication history: releases and mappings published by day, week or merchant, taken from the release records.
- A root-level error page, and error pages that re-fetch on "Try again".
- Navigation contrast on the dark rail raised to meet WCAG AA; the current section stays in view on a phone.
- Focus moves to a new interpretation in Analytics.
- Browser tests for accessibility rules on every screen and state, keyboard-only operation, phone layout, the full role matrix on every API route, cross-workspace access by ID, rollback, a failed server render, and failed or lost saves.
- `pnpm backup:check`: dump, restore and compare a database without writing to the source.
- An independent evaluation protocol (`evals/PROTOCOL.md`) with a frozen test split the code refuses to tune against.
- Live-only checks for the analytics planner (`pnpm smoke:live`, `pnpm eval:analytics:live`), which make no call and say so when credentials are missing.

### Fixed

- A database transaction is no longer replayed after it has started or when its commit outcome is unknown.
- A failed `BEGIN` no longer leaks a pooled connection.
- Two overlapping test runs can no longer corrupt each other; the second one stops.
- Scrolling the phone navigation no longer made the first Tab skip "Skip to content".

### Not verified

| Item | Why |
| --- | --- |
| Any live AI call: recommendations, analytics planner, smoke test, live evaluation | No provider credentials were available. Both adapters are tested against a stand-in client only |
| Suggestion accuracy (KPI01 to KPI03) | Labels are provisional and written by the application's author. No frozen, expert-labeled test set exists |
| High signal band | Disabled, and it stays disabled until the protocol's gate is met |
| Review-time saving (KPI04) and usability (KPI08) | Need studies with people |
| Deployment | Never deployed. The deployment guide is unexercised |
| Performance targets (PRD section 16) | Not measured at 5,000 listings and three concurrent reviewers |
| Accessibility conformance | Automated rules pass and keyboard paths are tested. No manual screen-reader pass, so no WCAG conformance claim |

### Known limitations

See "Known gaps and limitations" in `BUILD_STATUS.md`. The ones most likely to matter in a demonstration:

- The demo planner refuses phrasings outside its rules and lists the words it did not match. Use the controls, or the example questions.
- Demo suggestions exist only for the seeded products. A catalog of your own gets no suggestions in demo mode and can be mapped by hand.
- Coverage and backlog have no history; only review activity and publications are recorded by date.
- No screens for member management, merchant deactivation or workspace deletion.
- Bulk approval is built but has nothing to select, because it applies to High signal rows only.

### Upgrade

Migrations 0000 to 0004 are additive. `pnpm db:migrate` applies them without touching existing rows. This release adds no migration beyond 0004.
