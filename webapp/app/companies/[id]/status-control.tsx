'use client';
import { useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import {
  COMPANY_STATUSES,
  COMPANY_STATUS_LABELS,
  type CompanyStatus,
} from '@/lib/db/types';

export default function StatusControl(
  { companyId, status }: { companyId: string; status: CompanyStatus }
) {
  const [value, setValue] = useState<CompanyStatus>(status);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onChange(next: CompanyStatus) {
    const prev = value;
    setValue(next); // optimistic
    setSaving(true);
    setMessage(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase
      .from('companies')
      .update({ status: next })
      .eq('id', companyId);
    setSaving(false);
    if (error) {
      setValue(prev);
      setMessage(`Error: ${error.message}`);
      return;
    }
    setMessage('Saved');
  }

  return (
    <div className="space-y-2 text-[13px]">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CompanyStatus)}
        disabled={saving}
        className="w-full rounded px-2.5 py-1.5 text-[13px] border"
        style={{ borderColor: 'var(--line-strong)' }}
      >
        {COMPANY_STATUSES.map((s) => (
          <option key={s} value={s}>{COMPANY_STATUS_LABELS[s]}</option>
        ))}
      </select>

      <div className="flex items-center justify-between">
        <p className="text-[11.5px] leading-snug" style={{ color: 'var(--ink-4)' }}>
          Contacted is set automatically on the first sent email. Manual changes are allowed.
        </p>
        {(saving || message) && (
          <div
            className="text-[12px] ml-2 shrink-0"
            style={{ color: message?.startsWith('Error') ? 'var(--warn-ink)' : 'var(--ink-3)' }}
          >
            {saving ? 'Saving…' : message}
          </div>
        )}
      </div>
    </div>
  );
}
