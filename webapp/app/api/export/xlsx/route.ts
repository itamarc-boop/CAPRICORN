import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/export/xlsx?batch=&country=&tier=&status=
 * Builds a real .xlsx of the leads from the CRM (two tabs: "Leads" clean view +
 * "Decision detail" with the evidence/judgment columns) and streams it as a
 * download. Replaces the Google Sheet for clients who live in Microsoft/Excel —
 * no Google account needed. Mirrors tools/export_to_sheets.py columns.
 */

// Tab 1 — clean delivery columns (key on the assembled row, header label).
const LEADS_COLUMNS: Array<{ key: string; header: string; width: number }> = [
  { key: 'company_name', header: 'Company name', width: 30 },
  { key: 'country', header: 'Country', width: 14 },
  { key: 'city', header: 'City', width: 16 },
  { key: 'industry', header: 'Industry', width: 22 },
  { key: 'website', header: 'Website', width: 28 },
  { key: 'employee_count', header: 'Employee count', width: 16 },
  { key: 'estimated_revenue', header: 'Estimated revenue', width: 18 },
  { key: 'icp_tier', header: 'ICP tier', width: 10 },
  { key: 'icp_score', header: 'ICP score', width: 10 },
  { key: 'contact_name', header: 'Contact name', width: 22 },
  { key: 'contact_title', header: 'Contact title', width: 24 },
  { key: 'contact_email', header: 'Contact email', width: 28 },
  { key: 'contact_phone', header: 'Contact phone', width: 18 },
  { key: 'contact_linkedin_url', header: 'Contact LinkedIn URL', width: 30 },
  { key: 'linkedin_company_page', header: 'LinkedIn company page', width: 30 },
];

// Tab 2 — every Leads column plus the evidence / judgment fields.
const DETAIL_EXTRA: Array<{ key: string; header: string; width: number }> = [
  { key: 'deal_probability', header: 'Deal probability', width: 14 },
  { key: 'business_model', header: 'Business model', width: 20 },
  { key: 'import_evidence', header: 'Import evidence', width: 50 },
  { key: 'own_brand_evidence', header: 'Own brand evidence', width: 50 },
  { key: 'third_party_brands', header: 'Third party brands', width: 30 },
  { key: 'evidence_urls', header: 'Evidence URLs', width: 40 },
  { key: 'what_to_sell_gaps', header: 'What to sell gaps', width: 40 },
  { key: 'judge_reason', header: 'Judge reason', width: 50 },
  { key: 'judge_pattern', header: 'Judge pattern', width: 22 },
  { key: 'needs_human_check', header: 'Needs human check', width: 30 },
];
const DETAIL_COLUMNS = [...LEADS_COLUMNS, ...DETAIL_EXTRA];

const COMPANY_SELECT =
  'company_name, country, city, industry, website, employee_count, estimated_revenue, ' +
  'icp_tier, icp_score, deal_probability, business_model, import_evidence, own_brand_evidence, ' +
  'third_party_brands, evidence_urls, what_to_sell_gaps, judge_reason, judge_pattern, ' +
  'needs_human_check, linkedin_company_page, batch_label, ' +
  'contacts(full_name, title, email, phone, linkedin_url, is_primary)';

type ContactRow = {
  full_name: string | null; title: string | null; email: string | null;
  phone: string | null; linkedin_url: string | null; is_primary: boolean | null;
};

function primaryContact(contacts: ContactRow[]): ContactRow | null {
  if (!contacts || contacts.length === 0) return null;
  return contacts.find((c) => c.is_primary) ?? contacts[0];
}

export async function GET(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  const batch = sp.get('batch');
  const country = sp.get('country');
  const tier = sp.get('tier');
  const status = sp.get('status');

  const supabase = await getServerSupabase();
  let q = supabase
    .from('companies')
    .select(COMPANY_SELECT)
    .order('icp_tier', { ascending: true })
    .order('icp_score', { ascending: false, nullsFirst: false });
  if (batch) q = q.eq('batch_label', batch);
  if (status) q = q.eq('status', status);
  if (tier) q = q.eq('icp_tier', tier);
  if (country) q = country === '__unknown__' ? q.is('country', null) : q.eq('country', country);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Assemble flat rows (one per company, primary contact merged in).
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((c) => {
    const contact = primaryContact((c.contacts as ContactRow[]) ?? []);
    const dp = c.deal_probability as number | null;
    return {
      company_name: c.company_name ?? '',
      country: c.country ?? '',
      city: c.city ?? '',
      industry: c.industry ?? '',
      website: c.website ?? '',
      employee_count: c.employee_count ?? '',
      estimated_revenue: c.estimated_revenue ?? '',
      icp_tier: c.icp_tier ?? '',
      icp_score: c.icp_score ?? '',
      contact_name: contact?.full_name ?? '',
      contact_title: contact?.title ?? '',
      contact_email: contact?.email ?? '',
      contact_phone: contact?.phone ?? '',
      contact_linkedin_url: contact?.linkedin_url ?? '',
      linkedin_company_page: c.linkedin_company_page ?? '',
      deal_probability: dp != null ? `${Math.round(dp * 100)}%` : '',
      business_model: c.business_model ?? '',
      import_evidence: c.import_evidence ?? '',
      own_brand_evidence: c.own_brand_evidence ?? '',
      third_party_brands: c.third_party_brands ?? '',
      evidence_urls: c.evidence_urls ?? '',
      what_to_sell_gaps: c.what_to_sell_gaps ?? '',
      judge_reason: c.judge_reason ?? '',
      judge_pattern: c.judge_pattern ?? '',
      needs_human_check: c.needs_human_check ?? '',
    } as Record<string, unknown>;
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Capricorn Lead Ops';
  for (const [tabName, cols] of [
    ['Leads', LEADS_COLUMNS] as const,
    ['Decision detail', DETAIL_COLUMNS] as const,
  ]) {
    const ws = wb.addWorksheet(tabName);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Capricorn Leads.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
}
