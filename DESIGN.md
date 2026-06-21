# Design

Visual system of the Capricorn Lead Ops webapp (`webapp/`). Source of truth for tokens is `webapp/app/globals.css`; fonts in `webapp/app/fonts.ts`; shared status/tier style maps in `webapp/lib/db/types.ts`. Register: product (see PRODUCT.md).

## Theme

Editorial-quiet, light only. Warm ivory paper ground, white card surfaces, deep navy as the single emphasis color. Feels printed: hairline warm borders, tinted "ink on paper" badges, serif display headings over a grotesque body. An app shell (navy sidebar + glass top bar) frames it.

## Colors

Defined as CSS custom properties on `:root` in `globals.css`. Use tokens only; never hard-code hex values in components.

| Token | Value | Role |
|---|---|---|
| `--navy` | `#1F4E5F` | Primary actions, focus, fills |
| `--navy-deep` | `#0F2E3A` | Sidebar, headings, strongest ink |
| `--navy-soft` | `#2D6478` | Primary hover |
| `--ground` | `#F8F4EC` | Page background (warm ivory) |
| `--surface` | `#FFFFFF` | Cards, inputs |
| `--surface-2` | `#FBF8F1` | Table headers, subtle wells |
| `--line-strong` / `--line` / `--line-soft` | `#DDD4C0` / `#ECE6D6` / `#F4EFE2` | Border ramp |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `#1B1D1C` / `#3A3A37` / `#6E6A60` / (see note) | Text ramp: body / secondary / muted / micro-labels |
| `--t1-*` `--t2-*` `--t3-*` | navy / sienna / stone ink+bg pairs | Tier badges (Tier 1/2/3) |
| `--ok-*` `--warn-*` `--info-*` `--muted-*` | tinted ink+bg pairs | Status semantics (success / warning / info / neutral) |

Contrast bar: every text/background pair >=4.5:1 (AA). `--ink-4` exists for micro-labels and must stay AA-compliant against `--ground` and `--surface`; if it ever reads as decorative gray, darken the token, not the usage.

Status colors are semantic and centralized: funnel statuses via `COMPANY_STATUS_STYLES`, draft lifecycle via `DRAFT_STATUS_STYLES`, tiers via `TIER_STYLES` (all in `lib/db/types.ts`). Never invent ad-hoc status colors.

## Typography

Three families, loaded via `next/font` (variables on `<html>`):

- **Display: Newsreader (serif)** as `--font-display` / `.font-display`. H1 page titles (28–34px), section headings (15px), hero company names. Weights 400–600, italics allowed for flavor ("Lead Ops").
- **Body: Geist (sans)** as `--font-body`. Default at 14.5px/1.55; UI text runs 12.5–13.5px.
- **Data: Geist Mono** as `--font-mono` / `.font-tabular`. Scores, percentages, emails, IDs, dates, counts; `tabular-nums` on.

Fixed rem/px scale (product register, no fluid type). Micro-labels: 10.5px uppercase, tracking-wider, `--ink-4`, max four words. Body prose capped near 70ch.

## Components

- **`.card-soft`** white card, 1px `--line` border, 6px radius, layered soft navy-tinted shadow. The only card. Never nest cards.
- **`.pill`** 11px uppercase badge, tinted bg + matching ink from the semantic maps. Used for statuses, tiers, verdicts, labels.
- **`.btn-primary`** navy fill, white text, 5px radius; hover `--navy-soft`; disabled 45% opacity. **`.btn-ghost`** white with `--line-strong` border. Labels are verb+object.
- **`.tbl`** dense data table: 10.5px uppercase header row on `--surface-2`, 12–14px cells, hairline row separators, navy-tint row hover.
- **`.link-soft`** navy-deep underline-on-hover links.
- **Inputs** white, `--line-strong` border, navy focus ring (`box-shadow` 3px navy at 12%); global `:focus-visible` outline in navy. Placeholder text must meet AA.
- **App shell**: fixed navy-deep sidebar 230px (brand, icon nav with active left-bar, user + sign-out), `.topbar-glass` sticky top bar with global search (Cmd+K), content `max-w-[1200px]`.
- **Micro-feedback**: inline "Saving… / Saved / Error" text beside section headings; ok/warn tinted notice boxes.
- **Evidence blockquotes** (company dossier): verdict pill + serif italic quote with 2px navy left rule + muted gloss. Reserved for quoted evidence only.

## Layout

- Page = heading block (display serif h1 + 12.5px muted subtitle), then content sections spaced `space-y-5`/`gap-5`.
- Two-column records: `lg:grid-cols-3` (narrative left 2 cols, action rail right).
- Grids of cards: `repeat(auto-fit)`-style responsive or explicit 2/3-col at `md`/`xl`.
- Density is welcome in tables and stat bands; generosity around narrative prose.
- Breakpoint behavior is structural: sidebar hides below `lg` (horizontal nav strip appears), grids collapse to single column.

## Motion

Product register: 150–250ms, state and feedback only. `ease-out` family curves, no bounce. Hover transitions on buttons/rows/links ~120ms. Dropdowns and notices may fade/slide 150ms. No page-load choreography, no scroll animation. Every animation has a `prefers-reduced-motion: reduce` fallback (instant).

## Voice

Plain English, sentence case, no em dashes anywhere in UI copy (client style rule; use commas, colons, or middle dots). Buttons: verb+object ("Generate draft", "Send approved"). Empty states teach the next action and link to it. Errors say what happened and what to do.
