# Presentation package

Hosted site: https://catatelligence-rho.vercel.app

Status of this document: the script below is the journey the browser test suite runs on every build against a production build locally (24 of 24 passing). **It has not yet been walked through on the hosted site with a signed-in session.** Do one rehearsal in the Rehearsal workspace before presenting; the expected numbers assume the demo workspace is still as seeded.

## The story in three sentences

Retail catalog teams spend expert hours matching each merchant's products to one canonical category tree, and the hard part is not the first guess but keeping decisions consistent, versioned and traceable as catalogs and categories change. Catalog Intelligence proposes a category for each listing with its evidence, lets a person approve or correct it, publishes the approved set as an immutable release, and answers questions about coverage and backlog from those same records. **The model proposes, the server validates, the human decides, the database calculates.**

## Human-review safeguards worth saying out loud

- A suggestion is never a mapping. Nothing is published until a person approves it, and a later suggestion can never overwrite a human decision.
- The model can only choose from candidates the server retrieved for that listing; the server rejects any other answer and checks that quoted evidence really appears in the listing.
- Releases are immutable and exports are reproducible byte for byte; every change is in an append-only audit log.
- Analytics never runs model-written SQL. A question becomes a small, validated request for registered metrics, shown to you before anything runs.
- The "High" signal band is disabled. It stays off until an independent, expert-labeled evaluation shows 95% precision.
- Demo suggestions are labeled as demo everywhere. Nothing synthetic is presented as live AI.

## Before you present

- [ ] Open `/api/health`. Expect `"status":"ok"`, `"jobs":"inline"`, `"storage":"database"`, and the commit you expect.
- [ ] Sign in as the administrator in the browser you will present from. Sessions last 12 hours; sign in the same day.
- [ ] Workspace selector (top of page) shows **Tidewater Catalog Ops (Demo)**. Header shows **Demo data** and **Demo AI** (or **Live AI** if you have switched it on).
- [ ] Dashboard shows 300 active listings, 46.7% published, 57.3% approved draft, 128 pending. If not, someone has changed the demo data: present from the numbers on screen instead of the ones below.
- [ ] No merchant named **Pier Pantry** exists yet under Merchants & Catalogs. If one does, use another name in step 2.
- [ ] `walkthrough-pier-pantry.csv` is on your desktop (from `fixtures/generated/catalogs/` in the repository).
- [ ] There is no separate worker to start. Jobs run inside the site; keep the catalog page open while a job runs.
- [ ] Rehearse once in **Rehearsal (synthetic data)** using a different merchant name. It does not affect the demo workspace.
- [ ] Have the viewer account's sign-in ready in a second browser profile if you want to show permissions.

## Five-minute script

Signed in as **Avery Okafor** (administrator), workspace **Tidewater Catalog Ops (Demo)**.

**0:00 Dashboard.** Overview. "Every number here is computed from stored records." Point at published coverage 46.7% (140 of 300) versus approved draft 57.3% (172 of 300): approved is not the same as published. Corner Goods has never published, and the page says so.

**0:40 Import.** Merchants & Catalogs → type `Pier Pantry` → **Add merchant** → open it → **Import catalog** → choose `walkthrough-pier-pantry.csv`. The file's own column names are mapped for you. The summary shows 14 rows: 8 accepted, 5 rejected with a reason each, 1 exact duplicate collapsed. For the conflicting code `PP-004`, choose which row to keep, tick the box accepting the excluded rows, **Commit**. "Nothing was saved until I confirmed."

**1:40 Suggestions.** **Run demo analysis** → the dialog says what will be analyzed and that demo mode has no provider cost → confirm. Progress fills; nine suggestions appear. "These are labeled demo suggestions for this synthetic file."

**2:10 Review.** **Review Queue** → filter Merchant: Pier Pantry → open the first item.
- *Whole Milk Gallon*: evidence and alternatives are beside it. Press **A** to approve.
- *Coconut Milk Shampoo*: the suggestion followed the merchant's "Fridge > Milk" category. Search `shampoo`, choose the hair care leaf, give a reason, **Change mapping**. "The person corrects it; the original suggestion stays in the history."
- *Apple*: no description, flagged ambiguous. **Defer**.

**3:10 Publish.** **Releases** → Pier Pantry → **Preview**: 2 mapped, 7 unresolved, listed by reason → type a reason → tick the partial-release acknowledgment → **Publish**. Then **Export ZIP**: `mappings.csv`, `unresolved.csv` and `release.json` match the preview. The title that began with `=SUM(` is neutralized in the file.

**3:50 Dashboard again.** Overview: 309 active listings; Pier Pantry appears in the merchant comparison with 2 of 9 published.

**4:10 Ask.** **Analytics** → type `Which merchant still needs the most review?` → **Interpret**. Read the interpretation aloud: pending review count, by merchant, highest first. **Run analysis**. Corner Goods is first with 67. Click its **Review pending listings** link: the queue opens with exactly those listings.
Back in Analytics, type `Which merchant has the lowest coverage?` → it asks **which** coverage, published or draft, instead of guessing. Choose Published → Run.

**4:50 Close.** Type `Approve everything below 80% coverage`. It refuses: analytics only reads. "The model proposes, the human decides."

### Other questions that work in demo mode

`What is the published coverage?` · `How many listings are pending review by merchant?` · `How many releases were published by week?` · `What is the median review time?` · follow-ups: `Only grocery products`, `Only Daily Basket`, `Draft instead`.

In demo mode the question box matches a fixed set of phrasings and says so on screen. If it answers "not interpreted" and lists a word, rephrase with the metric's name or use **Build an analysis with controls**. With live AI on, free phrasing is interpreted by the model and still validated by the server.

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| Sign-in fails | Check you are on the exact hosted address, not a preview link. Sign-in only works on the configured origin |
| A job stays "Queued" or stops part-way | Keep the catalog page open; it resumes on its own within seconds. Otherwise press **Retry** on the job panel. Decisions and completed suggestions are never lost |
| Live AI shows "AI unavailable" or items fail | Say that this is the designed behavior: no silent substitute. Settings → choose **Demo** → Save. The header shows **Demo AI**, and the script above works unchanged. Listings can always be mapped by hand |
| A question is "not interpreted" | Use one of the example chips under the question box, or the controls |
| The site shows "could not load" | Open `/api/health`. If it is not ok, the database is unreachable: switch to the recording |
| Anything else | Play the recording in `rehearsal-recording/` and narrate. It is a recording of this same journey on a local production build, and should be described as such |

## Demo-mode fallback, stated plainly

Demo mode is a complete, honest presentation on its own: real imports, real validation, real human decisions, real releases, exports and analytics over real stored data. Only two things are stand-ins, and both are labeled on screen: suggestions come from curated fixtures for the synthetic products, and questions are interpreted by fixed rules rather than a model.
