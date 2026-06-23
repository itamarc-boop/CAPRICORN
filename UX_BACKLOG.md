# Capricorn webapp — UX/UX backlog (for a future session)

Status: **approved, deferred to a later session.** This is the prioritized list of UI/UX
improvements to make before / shortly after handing the app to the client. Grounded in a
full code review of every surface on 2026-06-23. File refs are clickable from the repo.

The client is non-technical, bilingual (ES/EN), self-serve. Bar: this is the FIRST thing
he receives. Design contract: see PRODUCT.md + DESIGN.md (editorial-quiet, plain English,
no em dashes, WCAG AA).

---

## Context: the "5 leads → 1" finding (not a bug)

Portugal run, target 5: discovered 24 → 20 enriched → 10 passed score gates → the BDR judge
correctly rejected 9 off-ICP companies (golf shoes, sensory lab, construction chemicals,
ingredient supplier, food distributor, dead site, adjacent-category) → 1 delivered (Faberlic,
T3). The quality gate worked. The real issue is discovery **yield**: see "Funnel tuning."

---

## P0 — fix before handoff (client would see dev-facing content)

1. **Dashboard empty-state shows a Python command.** `webapp/app/page.tsx` (~L234-255) tells
   the user to run `python3 tools/sync_leads_to_supabase.py …`. Replace with a plain CTA:
   "No companies yet — go to Discover to find your first leads" linking to `/discover`.
2. **Login leaks internal jargon.** `webapp/app/login/page.tsx` L58 "Sign in with an
   allowlisted account" + L106 "Google sign-in requires the Supabase Auth Google provider to
   be configured." Reword to plain language; delete the Supabase note (or admin-only).
3. **Discovery failures show raw exceptions.** `webapp/app/discover/discovery-panel.tsx`
   RunCard (~L351) renders `{run.error}` verbatim ("Explorium API error 422…", "pre-ship
   audit FAILED…"). Map to a friendly message; keep raw text for admins only.

## P1 — strongly recommended

Onboarding / first-run
- No guidance ties the workflow together (browse → generate → approve → connect Gmail → send).
  Add a small first-run checklist on the dashboard, shown until each step is done.
- Nothing prompts connecting Gmail before sending; sends silently fail. Show a banner when no
  `integrations` row exists: "Connect your Gmail to send" → `/integrations`.

Trust / clarity
- Two email paths on the dossier ("Generate AI draft" vs "Send email") with no explanation.
  Add one line distinguishing them, or consolidate. `webapp/app/companies/[id]/page.tsx`.
- Set yield expectations on Discover (addresses the 5→1 surprise). Note under the form:
  "We discover many companies and deliver only ones that truly fit, so delivered leads are
  often fewer than the target, especially in new markets." Consider relabel "Target leads" →
  "Aim for." `webapp/app/discover/discovery-panel.tsx`.

State / consistency
- Companies table has no empty state for zero filter matches (blank table under headers).
  `webapp/app/companies/companies-table.tsx` (~L164-247). Add a "No companies match" row.
- Integrations uses locale `new Date().toLocaleString()` in a server component (hydration /
  locale risk; inconsistent). Use the deterministic UTC formatter. `webapp/app/integrations/page.tsx` L82-83.
- Discover run card prints raw lowercase status; use `RUN_STATUS_LABELS` for Title Case.

## P2 — polish
- Activity timeline uses emoji glyphs (✉ ✎ ⟳ ✦); swap for the SVG stroke-icon style used in
  side-nav, or simple dots. `webapp/app/companies/[id]/page.tsx`.
- Dense companies table is horizontal-scroll on mobile; consider a card layout < md.
- Make whole table rows clickable to the dossier, not just the name + "Open →".
- Soften slightly technical micro-labels ("gmail.send only", "Business ID").

## Funnel tuning (the real "5 → 1" fix) — `tools/run_pipeline.py`, `tools/explorium_api.py`
1. Discover far more per target (small): keep-rate after the judge is ~10-30%; to deliver 5
   you need to discover/enrich ~50-80. Raise the discover-to-deliver multiplier.
2. Loop until target or budget (medium): iterate discover → score → judge until target hit or
   credit cap, instead of one-shot.
3. Tighten discovery filters for non-core countries (medium): add ICP keywords/categories +
   local-language terms so fewer adjacent-category companies enter.

## Recommended shortlist (priority order)
1. Replace Python-command empty state with a Discover CTA
2. De-jargon the login screen
3. Friendly error messages on failed Discovery runs
4. "Connect your Gmail to send" banner when no mailbox connected
5. First-run checklist on the dashboard
6. Empty-state row in the companies table
7. Yield-expectation note on Discover + "Aim for" relabel
8. One-line Generate-draft vs Send-email explanation on the dossier
9. Fix Integrations locale dates + run-status casing
10. Bump discovery yield (multiplier now; loop-to-target follow-up)

---

## Flow / IA optimization (added 2026-06-23 — second-pass, higher-altitude review)

# Flow / IA Optimization Plan

## 1. The big picture

The single most important structural change is this: **close the loop so discovered leads land in the CRM, not a spreadsheet.** Right now the app has two memories that never talk to each other, and the one feature the client pays real money to use (Discover) dumps its output into a Google Sheet that a technical operator must manually sync before anything can happen. Fix that and the whole product collapses into one continuous motion: get leads, read the dossier, draft, approve, send, track. The optimized shape is a three-surface app: a **Home cockpit** that shows today's work and the two buttons that start every session (Get new leads, Send approved), a **Companies/dossier** surface where every lead can be fully worked end to end without leaving the page, and **Discover** repositioned as the front door of Companies rather than a separate world. Everything else (Drafts queue, Templates, Integrations) becomes supporting infrastructure, not a peer destination the client has to navigate to do basic work.

## 2. The disconnect: Discover-to-Sheet vs CRM

**Recommendation: yes, unambiguously. Discovered leads must flow into the CRM. This is the highest-leverage change in the entire product and should be built first.**

All four journeys independently name this as the top break, and they are right. The product promise (PRODUCT.md line 13: "the client runs his entire outreach week inside the app without asking the operator for anything") is *severed at the exact moment of value*. The client clicks Run, spends real credits, waits several minutes, and the only thing he can do with the result is "Open Google Sheet" in a new tab (`discovery-panel.tsx:337-348`), which is the literal anti-reference in PRODUCT.md (line 21, the spreadsheet data dump). To act on those leads he needs the operator to run `python3 tools/sync_leads_to_supabase.py` (`app/companies/page.tsx:58`, `app/page.tsx:248`). For a non-technical, self-serve client, that is a dead end dressed up as a feature.

**The concrete change:**
- On run success, the worker upserts qualified companies and contacts into the `companies`/`contacts` tables (status = `new`), tagged with the run via `batch_label` / `run_id`. The logic already exists in `tools/sync_leads_to_supabase.py` — call it from the worker right after `build_lead_rows` in `tools/run_pipeline.py` (around lines 461-470), keyed on `run_id`. No new sync logic, just wire the existing function into the pipeline tail.
- Change the success CTA in `discovery-panel.tsx:337-348` from "Open Google Sheet" to a primary in-app action: **"Review 22 new companies"** linking to `/companies?batch=discovery_portugal` (filtered to this run). Demote the Sheet to a small secondary "Open as sheet" link, not the destination.
- Update the success notice copy from "delivers a Google Sheet" to "adds new companies you can email."

Keep the Sheet generation if the operator finds it useful for QA, but it stops being the client's path. After this change, Discover feeds the dossier-and-outreach loop directly, the operator dependency disappears, and the dollars spent on discovery become immediately actionable. Everything else in this plan is downstream of this one fix.

## 3. Flow fixes, ranked

Duplicates across journeys have been merged. Each item lists the change, why, effort, and file(s).

### Tier 1 — structural, do these first

**1. Land discovered leads in the CRM (the disconnect, above).**
Why: closes the find-to-act loop, removes the operator, makes Discover spend actionable. This unblocks fixes 2, 5, and 8.
Effort: **large.** Files: `tools/run_pipeline.py` (461-470), `tools/sync_leads_to_supabase.py` (reuse), `app/discover/discovery-panel.tsx` (337-348).

**2. Turn Home into a work cockpit, not a stat board.**
Lead the Dashboard with a single **"Today"** work queue *above* the funnel: render the actual drafts waiting (with company/contact and an inline Approve button), replies to follow up (status = `replied`, each opening the dossier), and any failed sends to requeue. Render items, not counts. Demote the funnel and Markets bands below it. Change the header copy from "Where the pipeline stands right now" to an action line like "Your outreach for today."
Why: Home is the most-visited and currently most read-only screen, which directly violates one-action-ahead ("never strand the user in read-only views"). The two highest-intent daily signals (drafts to review, replies to chase) exist today only as bare numbers, forcing a click-out-and-reorient on every session. Approving from Home removes a whole screen hop. Reuse the existing compare-and-swap write from `drafts-queue.tsx` so the write path is proven.
Effort: **medium.** Files: `app/page.tsx`, reuse `updateStatus` from `app/drafts/drafts-queue.tsx`.

**3. Unify on ONE sending model: every email is a reviewable draft, finished where you are.**
Today the same company has two unconnected send paths: instant compose-and-send from the dossier (`ComposeEmail`, immediate Gmail send) vs generate-draft-then-bounce-to-`/drafts`-to-approve-to-send. Nothing explains the difference. Replace the dossier's dual "Generate draft" + instant "Send email" with a single **"Write email"** panel that always produces a reviewable draft, then surface **Approve** and **Send** inline on the dossier for that one company (the same actions `/drafts` exposes). Keep `/drafts` as the batch/queue view, but a single company can be drafted, approved, and sent without ever leaving its dossier.
Why: removes the two-mental-models confusion for a non-technical user (he can today accidentally fire an unreviewed email, or generate a draft and not know where it went), honors one-action-ahead by finishing the action in place, and preserves the human-approval gate that earned-trust depends on.
Effort: **large.** Files: `app/companies/[id]/page.tsx`, `ComposeEmail`, `DraftActions`, reuse `app/drafts/drafts-queue.tsx` logic.

### Tier 2 — high-value, lower effort

**4. Replace every Python-command empty state with a real CTA.**
The empty states in `app/page.tsx:243-249` and `app/companies/page.tsx:44-63` show `python3 tools/sync_leads_to_supabase.py` — a terminal command a non-technical client cannot run, shown at the worst possible moment (first use). Replace with: a short line plus two buttons, **"Discover your first leads"** (→ `/discover`) and **"Connect Gmail"** (→ `/integrations`). Move the CLI instruction to operator-only context.
Why: first-run must be self-serve and on-brand (DESIGN.md: "empty states teach the next action"). This is flagged as high severity in three of four journeys.
Effort: **small.** Files: `app/page.tsx` (243-249), `app/companies/page.tsx` (44-63).

**5. Surface "Get new leads" and "Send approved (N)" globally.**
Add a persistent **"Get new leads"** button and a **"Send approved (N)" / "Drafts to review (N)"** affordance in the topbar (next to Cmd+K) and/or the Dashboard header, sourced from the count query the dashboard already runs. These are the two recurring session intents; today both require hunting through the sidebar.
Why: directly answers the developer's brief ("get new leads whenever he wants" and "take actions without it being annoying to get places"). Collapses the two core verbs to one click from anywhere.
Effort: **small to medium.** Files: `app/layout.tsx` (topbar), `app/page.tsx` (header), reuse dashboard count query.

**6. Make the dossier hero buttons real actions, not anchor scrolls.**
"Generate draft" and "Send email" at the top of the dossier (`app/companies/[id]/page.tsx:278-283`) are `href="#draft"` / `href="#compose"` anchor jumps that scroll a long page. A navy primary button that only scrolls reads as broken to a first-time user, and "Send email" especially looks like it sends. Make "Write email" open/focus the compose panel; remove the standalone "Send email" button (it should only appear as "Approve & send" once a draft exists, per fix 3). On mobile, lift the action rail above the narrative.
Why: aligns label to behavior, surfaces the next step where the eye already is, removes a repeated "is this broken?" moment. Honors tool-disappears.
Effort: **small.** Files: `app/companies/[id]/page.tsx` (278-283).

**7. One-click "Approve & send" for a single draft.**
For the common case of "I reviewed this one, send it," collapse Approve → Send approved → confirm modal into a single guarded action. Reserve the paced-send confirm modal for true batches (3+ approved).
Why: matches effort to stakes. A batch deserves the safety gate; sending one reviewed email should not cost three steps and a modal.
Effort: **medium.** Files: `app/drafts/drafts-queue.tsx`, and the dossier draft row from fix 3.

### Tier 3 — clarity and polish

**8. Carry batch/source context from Discover and Dashboard into Companies and the draft flow.**
Support `/companies?batch=<run or iteration>` filtering with the active batch shown as a chip, so "I just discovered Portugal leads, now work them" is one continuous filtered path from run card → select rows → generate drafts. This is the second half of fix 1.
Why: the client thinks by country/iteration; this reinforces the find-to-understand-to-act narrative as one motion per market.
Effort: **medium.** Files: `app/companies/page.tsx`, `app/discover/discovery-panel.tsx`.

**9. Notify on run completion.**
A Discover run takes several minutes and nothing signals completion (`discovery-panel.tsx` only updates the on-screen card). Add a finished signal that survives navigation: a persistent in-app banner ("Portugal run finished: 22 new companies"), a badge on the Discover nav item, and/or a browser notification.
Why: lets him start a run and walk away instead of babysitting a tab; makes the feature feel dependable.
Effort: **medium.** Files: `app/discover/discovery-panel.tsx`, `app/side-nav.tsx`, possibly a layout-level banner.

**10. Country field becomes an autocomplete of supported countries.**
Today it is free text with no validation; an unrecognized or misspelled name (likely for a bilingual user typing a Spanish name) fails only deep in the pipeline (`run_pipeline.py:221-224`). Turn it into a select/autocomplete derived from `country_to_code` in `explorium_api`, optionally annotating coverage ("Spain · 40 companies"). Validate before the run starts.
Why: prevents wasted multi-minute, real-credit runs on bad input; gives confidence up front.
Effort: **medium.** Files: `app/discover/discovery-panel.tsx`, `explorium_api` country map.

**11. Simplify the client-facing run UI (quietly expensive).**
Collapse Explorium credits, dollar AI cost, and raw stage strings into an operator-only "details" disclosure (`discovery-panel.tsx:187-196, 308-317`, estimate helpers 26-31). Keep one plain cost confirmation. Lead the run card with country, friendly status, and "N new companies."
Why: credits and pipeline internals are the operator's mental model. Leading with them makes a calm tool feel like an engineering console, against quietly-expensive and dossier-not-database.
Effort: **small.** Files: `app/discover/discovery-panel.tsx`.

**12. Split the nav into two altitudes.**
Group the client's daily verbs (Dashboard, Companies, Drafts, Get new leads) at the top and visually separate a small "Settings" group (Templates, Integrations) at the bottom of the sidebar.
Why: six equally-weighted items give a non-technical bilingual user no sense of "where I live" vs "plumbing I rarely touch," inflating perceived complexity.
Effort: **small.** Files: `app/side-nav.tsx`.

**13. Inline "Save email to contact" wherever a send is blocked by a missing address.**
Leads often arrive with no contact email; `ComposeEmail:151-155` shows only a passive tip telling the user to save it elsewhere. Add a small "Save email to contact" field that writes to `contacts` in place.
Why: keeps the client moving instead of hunting for where contacts are edited. Supports tool-disappears.
Effort: **medium.** Files: `ComposeEmail`, `DraftActions`, `contacts` write path.

**14. Make "replied" an actionable list on Home; retire the dead stat.**
Show replies as a real list (account, when they replied, open-dossier link), not just a funnel count. Drop or link the dead "Emails sent / 7 days" stat that currently leads nowhere.
Why: replies are the highest-value, time-sensitive daily event and the hardest to act on from Home. Folded into fix 2.
Effort: **medium** (part of fix 2). Files: `app/page.tsx`.

**15. Extend Cmd+K into a command palette.**
Today it searches only companies/contacts (`app/global-search.tsx`). Add quick actions and sections: "Get new leads," "Review drafts," jump to a country.
Why: turns the one existing global accelerator into a true shortcut for the weekly verbs.
Effort: **medium.** Files: `app/global-search.tsx`. *(Lower priority; nice-to-have once the structural fixes land.)*

## 4. The ideal 3-screen loop

The client's whole week should fit in three surfaces. No terminal, no spreadsheet, no asking the operator.

**Screen 1 — Home (the cockpit). "What do I do now?"**
Must show, top to bottom: a "Today" queue with the actual items that need a decision (drafts waiting, each with an inline Approve; replies to follow up, each opening the dossier; failed sends to requeue), and two always-present header actions: **Get new leads** and **Send approved (N)**. Below the fold, the funnel and Markets as "how am I doing" context. The first thing he reads is his to-do list, not a report. He can approve and send from here without going anywhere.

**Screen 2 — Discover / Get new leads. "Bring me more."**
Pick a country from an autocomplete, confirm one plain cost line, start the run, and walk away. When it finishes he gets a signal from anywhere in the app. The success state is a single in-app action: **"Review 22 new companies"** that drops him into Companies filtered to that run. The leads are already in the CRM. No Sheet, no sync, no operator.

**Screen 3 — Company dossier. "Work this lead."**
The researched case file: why it fits, quoted evidence, contacts, status. One **Write email** panel that produces a reviewable draft, then **Approve & send** inline on the same page. Status updates live in the rail. He never leaves the company to finish acting on it.

The loop: open Home → see today's work or hit Get new leads → land in a filtered Companies list → open a dossier → write, approve, send → status moves → back to Home. Every arrow is one click, and the operator is never in the path.

## 5. Shortlist (build in this order)

- [ ] **1. Land discovered leads in the CRM** — wire `sync_leads_to_supabase.py` into the pipeline tail (`run_pipeline.py:461-470`), keyed on `run_id`. *(unblocks everything)*
- [ ] **2. Change the Discover success CTA** from "Open Google Sheet" to "Review N new companies" → `/companies?batch=<run>`, Sheet demoted to a secondary link (`discovery-panel.tsx:337-348`).
- [ ] **3. Replace the Python-command empty states** with "Discover your first leads" + "Connect Gmail" CTAs (`app/page.tsx:243-249`, `app/companies/page.tsx:44-63`).
- [ ] **4. Make Home a cockpit** with a "Today" work queue (drafts to approve inline, replies to act on) above the funnel; change header copy to an action line (`app/page.tsx`).
- [ ] **5. Surface "Get new leads" and "Send approved (N)" globally** in the topbar/header (`app/layout.tsx`, `app/page.tsx`).
- [ ] **6. Unify sending on one model**: dossier "Write email" → reviewable draft → Approve & send inline; kill the dual instant-send path (`app/companies/[id]/page.tsx`, `ComposeEmail`, reuse `drafts-queue.tsx`).
- [ ] **7. Fix the dossier hero buttons** so they perform actions, not anchor scrolls (`app/companies/[id]/page.tsx:278-283`).
- [ ] **8. Notify on run completion** with a navigation-surviving banner and a Discover nav badge (`discovery-panel.tsx`, `side-nav.tsx`).

Files referenced are all under `/Users/itamarcohen/Documents/Claude Code Projects/Capricorn/webapp/` (app code) and `/Users/itamarcohen/Documents/Claude Code Projects/Capricorn/tools/` (pipeline). Principles cited: PRODUCT.md (one-action-ahead line 28, self-serve promise line 13, spreadsheet anti-reference line 21) and DESIGN.md (empty states teach the next action line 66, quietly expensive).
