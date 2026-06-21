/**
 * Mustache-style {{var}} substitution. Whitespace inside braces is allowed
 * ({{ company_name }} == {{company_name}}). Missing vars render as empty.
 */
export type LeadVars = {
  company_name?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  website?: string | null;
  icp_tier?: string | null;
  icp_score?: number | null;
  deal_probability?: number | null;
  what_to_sell_gaps?: string | null;
  judge_reason?: string | null;
  judge_pattern?: string | null;
  business_model?: string | null;
  import_evidence?: string | null;
  own_brand_evidence?: string | null;
};

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Helper for the send-email modal: render subject + body together using
 * the same lead variables.
 */
export function renderEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  vars: LeadVars
): { subject: string; body: string } {
  return {
    subject: renderTemplate(subjectTemplate, vars as Record<string, unknown>),
    body: renderTemplate(bodyTemplate, vars as Record<string, unknown>),
  };
}

/**
 * The set of variable names a template author can use. Surfaced in the UI
 * so they don't guess.
 */
export const AVAILABLE_VARS: ReadonlyArray<keyof LeadVars> = [
  'company_name', 'contact_name', 'contact_title', 'contact_email',
  'industry', 'country', 'city', 'website',
  'icp_tier', 'icp_score', 'deal_probability',
  'what_to_sell_gaps', 'judge_reason', 'judge_pattern',
  'business_model', 'import_evidence', 'own_brand_evidence',
];
