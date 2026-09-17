import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return <div className="loading-state"><div className="loader" /><span>{label}</span></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-state"><strong>We could not load this page.</strong><span>{message}</span>{onRetry && <button className="button button--secondary" onClick={onRetry}>Try again</button>}</div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{detail && <span>{detail}</span>}{action}</div>;
}
