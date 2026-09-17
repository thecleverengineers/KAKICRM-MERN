export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return new Intl.NumberFormat('en-IN').format(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function money(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(number) : '—';
}

export function dateTime(value: unknown): string {
  if (!value) return '—';
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.valueOf()) ? String(value) : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function date(value: unknown): string {
  if (!value) return '—';
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.valueOf()) ? String(value) : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(parsed);
}

export function initials(name: unknown): string {
  return String(name ?? 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}
