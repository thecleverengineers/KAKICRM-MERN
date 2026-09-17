export type AppTheme = 'light' | 'dark';

const storageKey = 'kaki-crm-theme';

export function readTheme(): AppTheme {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(storageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: AppTheme) {
  if (typeof window === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem(storageKey, theme);
}
