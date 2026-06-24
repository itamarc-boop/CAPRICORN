/**
 * Shared row types for the Phase 2.5 schema (0002_companies_contacts.sql).
 * Single source of truth — components must import from here instead of
 * declaring inline row types.
 */

export const COMPANY_STATUSES = [
  'new',
  'contacted',
  'replied',
  'meeting',
  'won',
  'not_interested',
  'archived',
] as const;

export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  meeting: 'Meeting',
  won: 'Won',
  not_interested: 'Not interested',
  archived: 'Archived',
};

/** Pill colors per status, using the design-system CSS variables. */
export const COMPANY_STATUS_STYLES: Record<CompanyStatus, { ink: string; bg: string }> = {
  new:            { ink: 'var(--info-ink)',  bg: 'var(--info-bg)' },
  contacted:      { ink: 'var(--ok-ink)',    bg: 'var(--ok-bg)' },
  replied:        { ink: 'var(--navy-deep)', bg: 'var(--surface-2)' },
  meeting:        { ink: 'var(--t2-ink)',    bg: 'var(--t2-bg)' },
  won:            { ink: 'var(--ok-ink)',    bg: 'var(--ok-bg)' },
  not_interested: { ink: 'var(--muted-ink)', bg: 'var(--muted-bg)' },
  archived:       { ink: 'var(--muted-ink)', bg: 'var(--muted-bg)' },
};

export const TIER_STYLES: Record<string, { ink: string; bg: string }> = {
  'Tier 1': { ink: 'var(--t1-ink)', bg: 'var(--t1-bg)' },
  'Tier 2': { ink: 'var(--t2-ink)', bg: 'var(--t2-bg)' },
  'Tier 3': { ink: 'var(--t3-ink)', bg: 'var(--t3-bg)' },
};

export type Company = {
  id: string;
  business_id: string | null;
  company_name: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  employee_count: string | null;
  estimated_revenue: string | null;
  description: string | null;
  linkedin_company_page: string | null;
  icp_tier: string | null;
  icp_score: number | null;
  deal_probability: number | null;
  business_model: string | null;
  judge_pattern: string | null;
  judge_reason: string | null;
  import_evidence: string | null;
  own_brand_evidence: string | null;
  third_party_brands: string | null;
  evidence_urls: string | null;
  what_to_sell_gaps: string | null;
  needs_human_check: string | null;
  iteration: number | null;
  batch_label: string | null;
  status: CompanyStatus;
  status_changed_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Contact = {
  id: string;
  company_id: string;
  full_name: string | null;
  title: string | null;
  email: string | null;
  email_label: string | null;
  linkedin_url: string | null;
  phone: string | null;
  is_primary: boolean;
  source: 'pipeline' | 'manual';
  created_at: string;
  updated_at: string;
};

export const DRAFT_STATUSES = [
  'draft',
  'approved',
  'rejected',
  'sending',
  'sent',
  'failed',
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  rejected: 'Rejected',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
};

export const DRAFT_STATUS_STYLES: Record<DraftStatus, { ink: string; bg: string }> = {
  draft:    { ink: 'var(--info-ink)',  bg: 'var(--info-bg)' },
  approved: { ink: 'var(--t2-ink)',    bg: 'var(--t2-bg)' },
  rejected: { ink: 'var(--muted-ink)', bg: 'var(--muted-bg)' },
  sending:  { ink: 'var(--navy-deep)', bg: 'var(--surface-2)' },
  sent:     { ink: 'var(--ok-ink)',    bg: 'var(--ok-bg)' },
  failed:   { ink: 'var(--warn-ink)',  bg: 'var(--warn-bg)' },
};

export type EmailDraft = {
  id: string;
  company_id: string;
  contact_id: string;
  template_id: string | null;
  generation_batch_id: string | null;
  language: string;
  to_email: string | null;
  subject: string;
  body: string;
  status: DraftStatus;
  error: string | null;
  send_attempts: number;
  scheduled_at: string | null;
  sending_started_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  sent_at: string | null;
  model: string | null;
  gen_input_tokens: number | null;
  gen_output_tokens: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailLogRow = {
  id: string;
  lead_id: string | null;
  company_id: string | null;
  contact_id: string | null;
  draft_id: string | null;
  template_id: string | null;
  sent_by: string | null;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body: string | null;
  gmail_message_id: string | null;
  sent_at: string;
};

export type Template = {
  id: string;
  name: string;
  subject_template: string;
  body_template: string;
  created_at?: string;
  updated_at?: string;
};

/** Draft-generation languages offered in the UI. */
export const DRAFT_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'fr', label: 'French' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'el', label: 'Greek' },
  { code: 'ro', label: 'Romanian' },
  { code: 'he', label: 'Hebrew' },
];

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ─────────────────────────────────────────────────────────────────
   Discovery runs (0003_pipeline_runs.sql). The webapp enqueues a run,
   a GitHub Actions worker drains it queued → running → succeeded/failed.
   ───────────────────────────────────────────────────────────────── */

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Pill colors per run status, using the design-system CSS variables. */
export const RUN_STATUS_STYLES: Record<RunStatus, { ink: string; bg: string }> = {
  queued:    { ink: 'var(--info-ink)',  bg: 'var(--info-bg)' },
  running:   { ink: 'var(--navy-deep)', bg: 'var(--surface-2)' },
  succeeded: { ink: 'var(--ok-ink)',    bg: 'var(--ok-bg)' },
  failed:    { ink: 'var(--warn-ink)',  bg: 'var(--warn-bg)' },
  cancelled: { ink: 'var(--muted-ink)', bg: 'var(--muted-bg)' },
};

export type PipelineRun = {
  id: string;
  country: string;
  target_leads: number;
  status: RunStatus;
  stage: string | null;
  discovered_count: number | null;
  enriched_count: number | null;
  qualified_count: number | null;
  leads_delivered: number | null;
  sheet_url: string | null;
  sheet_id: string | null;
  error: string | null;
  explorium_credits: number | null;
  anthropic_usd: number | null;
  /** Whether discovered leads synced into the CRM. null=not attempted, false=sync failed. */
  crm_synced: boolean | null;
  batch_label: string | null;
  requested_by: string | null;
  gh_run_url: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};
