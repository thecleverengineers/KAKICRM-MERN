import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return <div className="loading-state loading-state--instant" aria-busy="true" aria-label={label}>
    <span className="sr-only">{label}</span>
    <div className="instant-page-shell" aria-hidden="true">
      <span className="instant-page-shell__heading" />
      <span className="instant-page-shell__line instant-page-shell__line--wide" />
      <div className="instant-page-shell__grid"><span /><span /><span /></div>
      <span className="instant-page-shell__line" />
      <span className="instant-page-shell__line instant-page-shell__line--medium" />
    </div>
  </div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-state"><strong>We could not load this page.</strong><span>{message}</span>{onRetry && <button className="button button--secondary" onClick={onRetry}>Try again</button>}</div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{detail && <span>{detail}</span>}{action}</div>;
}
