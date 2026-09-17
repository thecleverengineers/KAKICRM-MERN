import { displayValue } from '../lib/format.js';

export function StatusPill({ value }: { value: unknown }) {
  const text = displayValue(value).replaceAll('_', ' ');
  const tone = text.toLowerCase();
  const className = tone.includes('complete') || tone.includes('paid') || tone.includes('active') || tone.includes('approve') || tone.includes('in progress')
    ? 'status-pill status-pill--positive'
    : tone.includes('pending') || tone.includes('draft') || tone.includes('review') || tone.includes('sent')
      ? 'status-pill status-pill--warning'
      : tone.includes('reject') || tone.includes('overdue') || tone.includes('blocked') || tone.includes('cancel')
        ? 'status-pill status-pill--negative'
        : 'status-pill';
  return <span className={className}>{text}</span>;
}
