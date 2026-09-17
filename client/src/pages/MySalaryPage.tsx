import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleDollarSign, FileDown, ReceiptText, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type PublicRecord } from '../lib/api.js';
import { dateTime, displayValue, money } from '../lib/format.js';

interface MySalaryHistory {
  data: PublicRecord[];
  slips: PublicRecord[];
}

/**
 * A deliberately self-scoped salary view. The API uses the authenticated user
 * ID rather than an ID supplied by the browser, so an employee can never use
 * this page to read another employee's compensation or salary slips.
 */
export function MySalaryPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['my-salary-history'],
    queryFn: () => api<MySalaryHistory>('/payroll/history/me')
  });

  const payroll = useMemo(() => sortByPeriod(query.data?.data ?? []), [query.data?.data]);
  const slips = useMemo(() => sortByPeriod(query.data?.slips ?? []), [query.data?.slips]);

  if (query.isPending) return <LoadingState label="Loading your salary history…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const latest = payroll[0];
  const generatedSlipPayrollIds = new Set(slips.map((slip) => Number(slip.fields.payroll_id)).filter((value) => Number.isSafeInteger(value) && value > 0));
  return <>
    <PageHeader eyebrow="MY PAY" title="Salary & slips" description="Review your own calculated monthly salary. A printable salary slip becomes available here after HR generates it." />

    <section className="my-salary-summary-grid" aria-label="Your latest salary summary">
      <article className="content-card"><span className="my-salary-summary-icon"><CircleDollarSign size={20} /></span><small>Latest net salary</small><strong>{latest ? money(latest.fields.net_pay) : '—'}</strong><span>{latest ? `For ${displayValue(latest.fields.period_month)}` : 'HR has not calculated a month yet'}</span></article>
      <article className="content-card"><span className="my-salary-summary-icon"><ReceiptText size={20} /></span><small>Generated salary slips</small><strong>{slips.length}</strong><span>{slips.length ? 'Ready to view or save as PDF' : 'No slip has been generated yet'}</span></article>
      <article className="content-card"><span className="my-salary-summary-icon"><ShieldCheck size={20} /></span><small>Private access</small><strong>Only you</strong><span>Your salary information is not visible to other employees.</span></article>
    </section>

    <section className="content-card my-salary-history-card">
      <div className="card-heading"><div><p className="eyebrow">MONTHLY SALARY</p><h2>Calculated salary history</h2><p className="muted-copy">Amounts are calculated by HR from your attendance and the salary structure effective for that month.</p></div><CircleDollarSign size={20} /></div>
      <div className="my-salary-list">
        {payroll.map((record) => {
          const payrollId = record.legacyId;
          const slip = slips.find((item) => Number(item.fields.payroll_id) === payrollId);
          return <article key={record.id}>
            <div className="my-salary-period"><strong>{displayValue(record.fields.period_month)}</strong><span>{displayValue(record.fields.present_days)} present · {displayValue(record.fields.half_days)} half day · {displayValue(record.fields.absent_days)} absent</span></div>
            <StatusPill value={record.fields.salary_status ?? 'calculated'} />
            <div className="my-salary-amount"><small>Net pay</small><b>{money(record.fields.net_pay)}</b></div>
            <div className="my-salary-actions">{slip?.legacyId ? <button className="button button--secondary" type="button" onClick={() => navigate(`/payroll/slips/${slip.legacyId}`)}><FileDown size={16} /> View / download slip</button> : payrollId && generatedSlipPayrollIds.has(payrollId) ? <span className="muted-copy">Slip is being prepared…</span> : <span className="my-salary-awaiting">Awaiting HR salary slip</span>}</div>
          </article>;
        })}
        {!payroll.length && <div className="my-salary-empty"><CircleDollarSign size={24} /><strong>No salary calculation yet</strong><span>Once HR calculates a monthly salary from your attendance, it will appear here.</span></div>}
      </div>
    </section>

    {slips.length > 0 && <section className="content-card my-salary-slip-card">
      <div className="card-heading"><div><p className="eyebrow">SALARY SLIPS</p><h2>Issued documents</h2></div><ReceiptText size={20} /></div>
      <div className="my-salary-issued-list">{slips.map((slip) => <button key={slip.id} className="my-salary-issued-slip" type="button" onClick={() => slip.legacyId && navigate(`/payroll/slips/${slip.legacyId}`)}><span><strong>{displayValue(slip.fields.period_month)}</strong><small>{displayValue(slip.fields.slip_no)} · Generated {dateTime(slip.fields.generated_at)}</small></span><b>{money(slip.fields.net_pay)}</b><ArrowRight size={17} /></button>)}</div>
    </section>}
  </>;
}

function sortByPeriod(records: PublicRecord[]): PublicRecord[] {
  return [...records].sort((left, right) => String(right.fields.period_month ?? '').localeCompare(String(left.fields.period_month ?? '')) || right.updatedAt.localeCompare(left.updatedAt));
}
