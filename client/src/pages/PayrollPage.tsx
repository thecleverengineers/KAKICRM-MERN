import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, FileDown, ReceiptText, Save, WalletCards } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type PublicRecord } from '../lib/api.js';
import { date, displayValue, money } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface PayrollEmployeeOption { id: number; label: string; department: string; designation: string; employeeCode: string; }
interface EmployeePayrollDetail { employee: PublicRecord; activeStructure: PublicRecord; salaryProfiles: PublicRecord[]; salaryStructures: PublicRecord[]; payroll: PublicRecord[]; slips: PublicRecord[]; }

export function PayrollPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { user, hasPermission } = useAuth();
  const today = useMemo(() => new Date(), []);
  const [employeeId, setEmployeeId] = useState('');
  const [month, setMonth] = useState(String(today.getMonth() + 1));
  const [year, setYear] = useState(String(today.getFullYear()));
  const [savingStructure, setSavingStructure] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [generatingSlip, setGeneratingSlip] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const employeesQuery = useQuery({ queryKey: ['payroll-employees'], queryFn: () => api<{ data: PayrollEmployeeOption[] }>('/payroll/employees') });
  const detailsQuery = useQuery({ queryKey: ['payroll-employee', employeeId], enabled: Boolean(employeeId), queryFn: () => api<EmployeePayrollDetail>(`/payroll/employees/${employeeId}`) });
  const canManage = hasPermission('payroll.manage') || hasPermission('salary.manage') || hasPermission('employees.manage') || isAdminOrHr(user?.role);
  const [structure, setStructure] = useState({ effective_from: localDate(today), base_salary: '', allowances: '0', incentives: '0', deductions: '0', ot_hourly_rate: '0', working_hours_per_day: '8', notes: '' });

  useEffect(() => {
    if (!employeeId && employeesQuery.data?.data[0]) setEmployeeId(String(employeesQuery.data.data[0].id));
  }, [employeeId, employeesQuery.data]);
  useEffect(() => {
    const current = detailsQuery.data?.activeStructure?.fields;
    if (!current || !detailsQuery.data) return;
    setStructure({
      effective_from: inputDate(current.effective_from, localDate(today)),
      base_salary: numericText(current.base_salary ?? current.monthly_salary),
      allowances: numericText(current.allowances ?? current.fixed_allowance),
      incentives: numericText(current.incentives ?? current.fixed_incentive),
      deductions: numericText(current.deductions ?? current.fixed_deduction),
      ot_hourly_rate: numericText(current.ot_hourly_rate),
      working_hours_per_day: numericText(current.working_hours_per_day, '8'),
      notes: text(current.notes)
    });
  }, [detailsQuery.data, today]);

  const saveStructure = async (event: FormEvent) => {
    event.preventDefault();
    if (!employeeId) return;
    setSavingStructure(true); setError(null); setMessage(null);
    try {
      await api(`/payroll/employees/${employeeId}/salary-structure`, { method: 'PUT', body: JSON.stringify({
        effective_from: structure.effective_from,
        base_salary: Number(structure.base_salary),
        allowances: Number(structure.allowances),
        incentives: Number(structure.incentives),
        deductions: Number(structure.deductions),
        ot_hourly_rate: Number(structure.ot_hourly_rate),
        working_hours_per_day: Number(structure.working_hours_per_day),
        notes: structure.notes.trim() || null
      }) });
      await client.invalidateQueries({ queryKey: ['payroll-employee', employeeId] });
      setMessage('Salary structure saved. Its effective date will be used for future payroll calculations.');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Unable to save the salary structure.'); } finally { setSavingStructure(false); }
  };

  const calculate = async () => {
    if (!employeeId) return;
    setCalculating(true); setError(null); setMessage(null);
    try {
      await api('/payroll/calculate', { method: 'POST', body: JSON.stringify({ userId: Number(employeeId), month: Number(month), year: Number(year) }) });
      await client.invalidateQueries({ queryKey: ['payroll-employee', employeeId] });
      setMessage(`Monthly salary calculated from attendance for ${monthName(Number(month))} ${year}.`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Unable to calculate monthly salary.'); } finally { setCalculating(false); }
  };

  const generateSlip = async (payroll: PublicRecord) => {
    if (!payroll.legacyId) return;
    setGeneratingSlip(payroll.legacyId); setError(null);
    try {
      const response = await api<{ data: PublicRecord }>(`/payroll/monthly/${payroll.legacyId}/slip`, { method: 'POST', body: JSON.stringify({}) });
      await client.invalidateQueries({ queryKey: ['payroll-employee', employeeId] });
      if (response.data.legacyId) navigate(`/payroll/slips/${response.data.legacyId}`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Unable to generate the salary slip.'); } finally { setGeneratingSlip(null); }
  };

  if (employeesQuery.isPending) return <LoadingState label="Loading employees for payroll…" />;
  if (employeesQuery.isError) return <ErrorState message={employeesQuery.error.message} onRetry={() => void employeesQuery.refetch()} />;
  const employees = employeesQuery.data.data;
  const selected = employees.find((employee) => String(employee.id) === employeeId);
  const detail = detailsQuery.data;
  return <>
    <PageHeader eyebrow="HR & FINANCE" title="Payroll & salary" description="Set an employee’s effective salary structure, calculate a selected month from attendance, and generate the employee’s salary slip." />
    <section className="payroll-control-card content-card"><div className="form-grid"><label className="field field--wide"><span>Employee *</span><select value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setMessage(null); setError(null); }}><option value="">Select employee…</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}{employee.designation ? ` · ${employee.designation}` : ''}</option>)}</select></label><label className="field"><span>Payroll month</span><select value={month} onChange={(event) => setMonth(event.target.value)}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{monthName(index + 1)}</option>)}</select></label><label className="field"><span>Year</span><input type="number" min="2020" max="2100" value={year} onChange={(event) => setYear(event.target.value)} /></label></div>{selected && <p className="payroll-selected-employee"><strong>{selected.label}</strong><span>{[selected.designation, selected.department, selected.employeeCode].filter(Boolean).join(' · ')}</span></p>}{error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}</section>
    {detailsQuery.isPending && employeeId ? <LoadingState label="Loading employee salary details…" /> : detailsQuery.isError ? <ErrorState message={detailsQuery.error.message} onRetry={() => void detailsQuery.refetch()} /> : detail && <>
      <section className="payroll-summary-grid"><article className="content-card"><small>Current base salary</small><strong>{money(detail.activeStructure.fields.base_salary ?? detail.activeStructure.fields.monthly_salary)}</strong><span>Effective {date(detail.activeStructure.fields.effective_from)}</span></article><article className="content-card"><small>Fixed allowances</small><strong>{money(detail.activeStructure.fields.allowances ?? detail.activeStructure.fields.fixed_allowance)}</strong><span>Plus incentives and approved overtime</span></article><article className="content-card"><small>Working day target</small><strong>{displayValue(detail.activeStructure.fields.working_hours_per_day ?? 8)} hrs</strong><span>Used in monthly attendance reporting</span></article></section>
      {canManage && <section className="payroll-workspace-grid"><article className="content-card"><div className="card-heading"><div><p className="eyebrow">SALARY STRUCTURE</p><h2>Effective compensation</h2></div><Save size={19} /></div><form onSubmit={(event) => void saveStructure(event)}><div className="form-grid"><label className="field"><span>Effective from *</span><input type="date" value={structure.effective_from} onChange={(event) => setStructure((current) => ({ ...current, effective_from: event.target.value }))} required /></label><label className="field"><span>Base monthly salary *</span><input type="number" min="0.01" step="0.01" value={structure.base_salary} onChange={(event) => setStructure((current) => ({ ...current, base_salary: event.target.value }))} required /></label><label className="field"><span>Fixed allowances</span><input type="number" min="0" step="0.01" value={structure.allowances} onChange={(event) => setStructure((current) => ({ ...current, allowances: event.target.value }))} /></label><label className="field"><span>Fixed incentives</span><input type="number" min="0" step="0.01" value={structure.incentives} onChange={(event) => setStructure((current) => ({ ...current, incentives: event.target.value }))} /></label><label className="field"><span>Fixed deductions</span><input type="number" min="0" step="0.01" value={structure.deductions} onChange={(event) => setStructure((current) => ({ ...current, deductions: event.target.value }))} /></label><label className="field"><span>Overtime hourly rate</span><input type="number" min="0" step="0.01" value={structure.ot_hourly_rate} onChange={(event) => setStructure((current) => ({ ...current, ot_hourly_rate: event.target.value }))} /></label><label className="field"><span>Working hours / day</span><input type="number" min="0.25" max="24" step="0.25" value={structure.working_hours_per_day} onChange={(event) => setStructure((current) => ({ ...current, working_hours_per_day: event.target.value }))} /></label><label className="field field--wide"><span>Notes</span><textarea rows={3} value={structure.notes} onChange={(event) => setStructure((current) => ({ ...current, notes: event.target.value }))} maxLength={2000} /></label></div><div className="modal-actions"><button className="button" disabled={savingStructure}><Save size={16} /> {savingStructure ? 'Saving…' : 'Save salary structure'}</button></div></form></article>
        <article className="content-card payroll-calculate-card"><div className="card-heading"><div><p className="eyebrow">MONTHLY PAYROLL</p><h2>Calculate from attendance</h2></div><Calculator size={19} /></div><p className="muted-copy">Present, half-day, approved leave, absence, working minutes, overtime and the dated salary structure are included in the calculation.</p><div className="payroll-period-summary"><strong>{monthName(Number(month))} {year}</strong><span>{detail.employee.fields.name ? String(detail.employee.fields.name) : selected?.label}</span></div><button className="button" type="button" onClick={() => void calculate()} disabled={calculating || !structure.base_salary}><Calculator size={16} /> {calculating ? 'Calculating…' : 'Generate monthly salary'}</button></article></section>}
      <section className="content-card payroll-history-card"><div className="card-heading"><div><p className="eyebrow">PAYROLL HISTORY</p><h2>Calculated months & salary slips</h2></div><WalletCards size={19} /></div><div className="payroll-history-list">{detail.payroll.map((record) => { const slip = detail.slips.find((item) => Number(item.fields.payroll_id) === record.legacyId); return <article key={record.id}><div><strong>{displayValue(record.fields.period_month)}</strong><span>{displayValue(record.fields.present_days)} present · {displayValue(record.fields.half_days)} half day · {displayValue(record.fields.absent_days)} absent</span></div><StatusPill value={record.fields.salary_status} /><b>{money(record.fields.net_pay)}</b><div className="payroll-history-actions">{slip?.legacyId ? <button className="button button--secondary" type="button" onClick={() => navigate(`/payroll/slips/${slip.legacyId}`)}><ReceiptText size={15} /> View slip</button> : canManage && <button className="button button--secondary" type="button" onClick={() => void generateSlip(record)} disabled={generatingSlip === record.legacyId}><FileDown size={15} /> {generatingSlip === record.legacyId ? 'Generating…' : 'Generate slip'}</button>}</div></article>; })}{!detail.payroll.length && <p className="muted-copy">No monthly salary has been calculated for this employee yet.</p>}</div></section>
    </>}
  </>;
}

function isAdminOrHr(role: string | undefined): boolean { return ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource'].includes(String(role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')); }
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
function numericText(value: unknown, fallback = '0'): string { const parsed = Number(value); return Number.isFinite(parsed) ? String(parsed) : fallback; }
function inputDate(value: unknown, fallback: string): string { const candidate = text(value).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : fallback; }
function localDate(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function monthName(value: number): string { return new Intl.DateTimeFormat('en-IN', { month: 'long' }).format(new Date(Date.UTC(2026, Math.max(0, value - 1), 1))); }
