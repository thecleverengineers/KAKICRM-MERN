export function isCeoRole(value: string | undefined): boolean {
  return ['ceo', 'chief_executive_officer', 'chief_executive'].includes(String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

export function formatCeoCurrency(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '₹0';
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(amount))}`;
}

export function ceoDate(value: unknown): string {
  if (!value) return '—';
  const parsed = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(parsed.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(parsed);
}
