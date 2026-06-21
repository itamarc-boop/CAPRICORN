# Market Analysis & Lead Generation System — Requirements

## Project Overview

We are building an automated market analysis workflow that finds, qualifies, and delivers leads for Capricorn's sales team — precisely matching the profile of companies most likely to become clients.

The system works in two stages:
1. **Company discovery**: Finds target companies across your markets using LinkedIn, data APIs, web research, and (optionally) industry event exhibitor lists
2. **Contact identification**: Finds the right person at each qualifying company — name, title, email, and LinkedIn profile

Every company is scored against your ICP using fixed, numeric criteria — not AI judgment. This guarantees consistent quality whether the run returns 10 leads or 500.

Final output: a structured Google Sheet for your team to review, with approved leads pushed directly into your CRM.

---

## Information We Need From You

Please fill in each section as completely as possible. The precision of your answers directly determines the quality of leads the system produces.

---

### 1. Ideal Customer Profile (ICP)

We use ICP tiers to score every company. Tier 1 = best fit, Tier 2 = acceptable fit, Tier 3 = stretch. Please define each tier below.

**Tier 1 — Primary ICP (your ideal client)**

| Field | Your Answer |
|---|---|
| Industries / sectors | |
| Company size (employees) | e.g. 50–500 |
| Annual revenue (USD) | e.g. $5M–$100M |
| Job titles to target | e.g. CEO, Procurement Manager, Supply Chain Director |
| Keywords that indicate fit | e.g. "imports from Asia", "manufacturing", "distributor" |
| Any other qualifying signals | |

**Tier 2 — Secondary ICP**

| Field | Your Answer |
|---|---|
| How does this differ from Tier 1? | |
| Industries / sectors | |
| Company size (employees) | |
| Annual revenue (USD) | |
| Job titles to target | |

**Tier 3 — Stretch ICP** *(optional — skip if not applicable)*

| Field | Your Answer |
|---|---|
| How does this differ from Tier 2? | |
| Company size / sector differences | |

**Hard exclusions — companies to never include:**

| Field | Your Answer |
|---|---|
| Industries to exclude | e.g. retail, government |
| Company sizes to exclude | e.g. under 10 employees |
| Countries to exclude | |
| Any other disqualifying signals | |

---

### 2. Target Countries & Markets

List every country or region you want the system to search in. For each, note any local specifics (e.g. language, dominant directories, regulatory context).

| Country / Region | Priority (High / Medium / Low) | Notes |
|---|---|---|
| | | |
| | | |
| | | |

---

### 3. Lead Data Fields

What information do you need per lead in the output sheet?

**Company-level fields** — check all that apply, add any missing:

- [ ] Company name
- [ ] Website
- [ ] Industry / sector
- [ ] Employee count
- [ ] Estimated annual revenue
- [ ] Country & city
- [ ] LinkedIn company page
- [ ] Brief description
- [ ] ICP tier score (auto-generated)
- [ ] Other: ___________

**Contact-level fields** — check all that apply:

- [ ] Full name
- [ ] Job title
- [ ] LinkedIn profile URL
- [ ] Email address
- [ ] Phone number
- [ ] Other: ___________

---

### 4. Scoring Criteria (Critical)

This section is what prevents quality from degrading over time. We need exact thresholds, not ranges like "medium-sized companies."

For each ICP tier, fill in the scoring weights below (total should add up to 100 points per tier):

| Criterion | Tier 1 Points | Tier 2 Points | Tier 3 Points |
|---|---|---|---|
| Industry match | | | |
| Employee count in range | | | |
| Revenue in range | | | |
| Keyword match (website/description) | | | |
| Located in target country | | | |
| Other: ___________ | | | |
| **Minimum score to qualify** | | | |

Example: A Tier 1 lead might need 70+ points. A Tier 2 lead might need 45–69 points. A Tier 3 lead might need 25–44 points.

---

### 5. Events & Industry Fairs

You mentioned finding leads at trade fairs and industry events. We can build an optional input mode where you provide a fair's exhibitor page URL and the system scores every exhibitor against your ICP automatically.

Please list the recurring events most relevant to your target clients:

| Event Name | Website / Exhibitor List URL | Country | Frequency | Sectors covered |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

---

### 6. Volume & Frequency

| Question | Your Answer |
|---|---|
| How many leads per run do you want? | e.g. 50–100 qualified companies |
| How many contacts per company? | e.g. 1–3 key contacts |
| How often should the system run? | Manual on-demand / Weekly / Monthly |
| If scheduled: preferred day & time | |
| Should it run per country, or all at once? | |

---

### 7. CRM Setup

| Question | Your Answer |
|---|---|
| Do you currently use a CRM? | Yes / No |
| If yes, which one? | HubSpot / Salesforce / Pipedrive / Other |
| If no, are you open to setting one up? | Yes / No / Unsure |
| Who on your team reviews leads in Google Sheets before they go to CRM? | |
| Should rejected leads be archived or deleted? | |
| Any custom fields in your CRM we need to map to? | |

---

### 8. API & Budget

The system requires access to third-party data APIs. These have monthly subscription costs. Please indicate your preferences:

| Tool | Purpose | Approx. Monthly Cost | Approve? |
|---|---|---|---|
| LinkedIn Sales Navigator | Company & people search | ~$100/user/month | Yes / No / Discuss |
| Apollo.io | Contact enrichment + email finding | ~$50–$150/month | Yes / No / Discuss |
| Crunchbase | Company data + funding signals | ~$50/month | Yes / No / Discuss |
| Hunter.io | Email verification | ~$50/month | Yes / No / Discuss |

*Note: We can start with a minimal stack (Apollo alone covers most use cases) and expand as the system proves its value.*

**Total estimated monthly API cost:** $50–$400 depending on selections above.

---

### 9. Success Criteria

How will you know this system is working?

| Question | Your Answer |
|---|---|
| What does a successful run look like to you? | e.g. "80% of leads in Sheet match Tier 1 or Tier 2" |
| What's the target conversion rate from lead → meeting? | |
| Are there any metrics you track today we should connect to? | |
| After how many runs will you evaluate if it's working? | |

---

## Next Steps

Once we receive your completed answers, we will:

1. Build the ICP scoring model and validate it against 20 sample companies you know
2. Set up the data pipeline tools and API connections
3. Run a pilot on one country and review results together
4. Calibrate scoring thresholds based on your feedback
5. Roll out to remaining markets

**Please return this document with your answers to: icohen@oktopost.com**
