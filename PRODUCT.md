# Product

## Register

product

## Users

Two people. Primary: the Capricorn client (a packaging/disposables sourcing businessperson, non-technical, Spanish/English bilingual) who works his lead pipeline self-serve: browses vetted companies by market, reads the evidence for why each is a fit, generates and approves AI email drafts, sends them from his own Gmail, and tracks where each account stands. Secondary: the operator (Itamar) who maintains the data pipeline behind it and occasionally checks state. Low volume, high stakes: dozens of researched leads per iteration, not thousands of rows.

## Product Purpose

A CRM-lite over an automated lead-research pipeline. The pipeline discovers and scores importer/distributor companies against a locked ICP model; this app is where that research becomes outreach: organized by country, drafted with AI grounded in quoted evidence, approved by a human, sent at a safe pace, and tracked through a simple funnel (new, contacted, replied, meeting, won). Success: the client runs his entire outreach week inside the app without asking the operator for anything.

## Brand Personality

Calm, confident, editorial. The interface should feel like a private banker's desk: warm paper, deep navy ink, serif headlines, printed-feel badges. Quietly expensive, never busy. Evidence is presented like a researched dossier, not a data dump.

## Anti-references

- Excel / a spreadsheet data dump: walls of label:value cells, undifferentiated grids, raw text blobs. Data must carry hierarchy; evidence must be presented (quotes, verdicts, sources).
- Generic SaaS admin: the Tailwind-blue dashboard with identical stat cards, gradient accents, glassmorphism, and shadcn-default everything. The editorial identity is the differentiator.
- Flashy marketing surfaces: no scroll choreography, no decorative motion. This is a working tool; motion exists only for state and feedback.

## Design Principles

1. **Dossier, not database.** Every company is a researched case file: lead with the narrative (why it fits, the quoted evidence), keep raw fields subordinate.
2. **One action ahead.** Each screen makes the next outreach step obvious: generate, approve, send. Never strand the user in read-only views.
3. **Earned trust through provenance.** Always show where a claim came from (quote, source link, batch). The client must be able to verify any assertion in 30 seconds.
4. **Quietly expensive.** Restraint over decoration: warm neutrals, one navy, tiny accents. Density where the task needs it, generosity where the eye rests.
5. **The tool disappears into the task.** Familiar affordances (tables, selects, inline edit); no invented controls, no surprise.

## Accessibility & Inclusion

WCAG AA: body and label text at >=4.5:1 against its surface, visible keyboard focus everywhere, full keyboard operability, `prefers-reduced-motion` respected on all animation. Copy in plain English (client reads English as a second language); no em dashes in user-facing copy (client style rule).
