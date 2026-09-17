import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type PublicRecord } from '../lib/api.js';
import { useBranding } from '../lib/branding.js';
import { date, dateTime, displayValue, money } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface SalarySlipDetail {
  data: PublicRecord;
  employee: PublicRecord | null;
  payroll: PublicRecord | null;
}

const company = {
  name: 'M/s Chishikaki Creative Solutions (OPC) Private Limited',
  address: '132 B Darogapathar, Dimapur, Nagaland, India',
  phone: '+91 88374 02472',
  email: 'kaki.helps.brands@gmail.com'
};

export function SalarySlipPage() {
  const { slipId } = useParams();
  const navigate = useNavigate();
  const branding = useBranding();
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['salary-slip', slipId],
    enabled: Boolean(slipId),
    queryFn: () => api<SalarySlipDetail>(`/payroll/slips/${slipId}`)
  });

  if (query.isPending) return <LoadingState label="Loading salary slip…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const { data: slip, employee } = query.data;
  const fields = slip.fields;
  const employeeFields = employee?.fields ?? {};
  const isOwnSlip = Number(fields.user_id) === user?.legacyId;
  const backTo = isOwnSlip ? '/my-salary' : '/payroll';
  const runPrint = () => window.print();
  const period = salaryMonth(fields.period_month);
  const earnings = [
    { label: 'Basic salary', value: fields.base_salary },
    { label: 'Fixed allowance', value: fields.fixed_allowance },
    { label: 'Fixed incentive', value: fields.fixed_incentive },
    { label: `Overtime pay${overtimeLabel(fields)}`, value: fields.ot_pay }
  ];
  const deductions = [
    { label: 'Fixed deduction', value: fields.fixed_deduction },
    { label: 'Absence deduction', value: fields.absence_deduction },
    { label: 'Half-day deduction', value: fields.half_day_deduction },
    { label: 'Unpaid leave deduction', value: fields.unpaid_leave_deduction }
  ];
  const lineCount = Math.max(4, earnings.length, deductions.length);
  const employeeName = firstValue(fields.employee_name, employeeFields.name);
  const employeeCode = firstValue(fields.employee_code, employeeFields.employee_code, employeeFields.emp_code, employeeFields.code);
  const designation = firstValue(fields.designation, employeeFields.designation);
  const department = firstValue(fields.department, employeeFields.department);
  const bankName = firstValue(employeeFields.bank_name, employeeFields.bank, employeeFields.bank_name_ifsc);
  const accountName = firstValue(employeeFields.bank_account_name, employeeFields.account_holder_name, employeeName);
  const accountNumber = firstValue(employeeFields.bank_account_number, employeeFields.account_number, employeeFields.account_no);

  return <div className="salary-slip-page">
    <PageHeader
      eyebrow="SALARY SLIP"
      title={displayValue(fields.slip_no ?? 'Salary slip')}
      description={`Issued for ${displayValue(fields.period_month)}. This document is ${isOwnSlip ? 'available only to you and authorised HR users' : 'available to authorised payroll users'}.`}
      actions={<><button className="button button--secondary" type="button" onClick={() => navigate(backTo)}><ArrowLeft size={16} /> {isOwnSlip ? 'My salary' : 'Payroll'}</button><button className="button" type="button" onClick={runPrint}><Download size={16} /> Download PDF</button></>}
    />

    <section className="salary-slip-paper" aria-label="Salary slip document">
      <header className="salary-slip-classic-header">
        <div className="salary-slip-classic-brand">{branding.logo_url ? <img src={branding.logo_url} alt="" /> : <span>CCS</span>}<small>CHISHIKAKI</small></div>
        <div className="salary-slip-classic-heading"><h1>SALARY SLIP</h1><strong>{period}</strong></div>
        <div className="salary-slip-classic-confidential">CONFIDENTIAL</div>
      </header>

      <section className="salary-slip-classic-company-info"><strong>{company.name}</strong><span>{company.address}</span><span>Phone: {company.phone} &nbsp;|&nbsp; Email: {company.email}</span></section>

      <section className="salary-slip-classic-employee-grid">
        <dl><SalarySlipMetaRow label="Name" value={employeeName} /><SalarySlipMetaRow label="Employee ID" value={employeeCode} /></dl>
        <dl><SalarySlipMetaRow label="Title" value={designation} /><SalarySlipMetaRow label="Department" value={department} /></dl>
      </section>

      <section className="salary-slip-classic-table" aria-label="Earnings and deductions">
        <div className="salary-slip-classic-table-header"><strong>Description</strong><strong>Earnings</strong><strong>Deductions</strong></div>
        {Array.from({ length: lineCount }, (_, index) => {
          const earning = earnings[index];
          const deduction = deductions[index];
          return <div className="salary-slip-classic-line" key={earning?.label ?? deduction?.label ?? index}>
            <span>{earning?.label ?? ''}</span>
            <b>{earning ? money(earning.value) : ''}</b>
            <span className="salary-slip-classic-deduction">{deduction && <><em>{deduction.label}</em><b>{money(deduction.value)}</b></>}</span>
          </div>;
        })}
        <div className="salary-slip-classic-total"><strong>Total</strong><b>{money(fields.gross_pay)}</b><b>{money(fields.total_deduction)}</b></div>
      </section>

      <section className="salary-slip-classic-bottom">
        <dl className="salary-slip-payment-details"><SalarySlipMetaRow label="Payment date" value={date(firstValue(fields.period_to, fields.generated_at))} /><SalarySlipMetaRow label="Bank name" value={bankName} /><SalarySlipMetaRow label="Bank account name" value={accountName} /><SalarySlipMetaRow label="Bank account #" value={accountNumber} /></dl>
        <div className="salary-slip-classic-net"><div>NET PAY</div><strong>{money(fields.net_pay)}</strong><p>{amountInWords(fields.net_pay)}</p><small>Attendance: {displayValue(fields.present_days)} present · {displayValue(fields.leave_days)} leave · {displayValue(fields.absent_days)} absent</small>{Number(fields.approved_ot_minutes ?? 0) > 0 && <small>Overtime: {overtimeSummary(fields)}</small>}</div>
      </section>

      <footer className="salary-slip-classic-footer"><span>This is a system-generated salary slip for the stated period.</span><span>Slip no. {displayValue(fields.slip_no)} · Generated {dateTime(fields.generated_at)}</span></footer>
    </section>

    <div className="salary-slip-print-action"><button className="button" type="button" onClick={runPrint}><Printer size={16} /> Print / save as PDF</button></div>
  </div>;
}

function SalarySlipMetaRow({ label, value }: { label: string; value: unknown }) {
  return <div><dt>{label}</dt><dd>{displayValue(value)}</dd></div>;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined && String(value).trim()) ?? null;
}

function salaryMonth(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (!match) return displayValue(value);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${match[1]}-${match[2]}-01T00:00:00`));
}

function overtimeLabel(fields: Record<string, unknown>): string {
  const minutes = Number(fields.approved_ot_minutes ?? 0);
  return minutes > 0 ? ` (${duration(minutes)})` : '';
}

function overtimeSummary(fields: Record<string, unknown>): string {
  const parts = [
    ['after-hours', fields.after_hours_ot_minutes],
    ['weekend', fields.weekend_ot_minutes],
    ['holiday', fields.holiday_ot_minutes]
  ]
    .map(([label, value]) => Number(value ?? 0) > 0 ? `${duration(Number(value))} ${label}` : null)
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(' · ') : duration(Number(fields.approved_ot_minutes ?? 0));
}

function duration(value: number): string {
  const minutes = Math.max(0, Math.round(value));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`;
}

function amountInWords(value: unknown): string {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  return `Rupees ${indianNumberWords(amount)} only`;
}

function indianNumberWords(value: number): string {
  if (value === 0) return 'Zero';
  const underTwenty = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const underThousand = (number: number): string => {
    const words: string[] = [];
    if (number >= 100) words.push(`${underTwenty[Math.floor(number / 100)]} Hundred`);
    const remainder = number % 100;
    if (remainder >= 20) words.push(`${tens[Math.floor(remainder / 10)]}${remainder % 10 ? ` ${underTwenty[remainder % 10]}` : ''}`);
    else if (remainder) words.push(underTwenty[remainder]);
    return words.join(' ');
  };
  const groups: Array<[number, string]> = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1_000, 'Thousand']];
  const words: string[] = [];
  let remainder = value;
  for (const [divisor, label] of groups) {
    const part = Math.floor(remainder / divisor);
    if (part) words.push(`${underThousand(part)} ${label}`);
    remainder %= divisor;
  }
  if (remainder) words.push(underThousand(remainder));
  return words.join(' ');
}
