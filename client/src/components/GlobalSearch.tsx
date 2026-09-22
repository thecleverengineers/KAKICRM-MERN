import { useEffect, useState } from 'react';
import { useDebouncedValue } from './SearchAutocomplete.js';
import { useQuery } from '@tanstack/react-query';
import { FileText, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, queryString } from '../lib/api.js';

interface GlobalSearchResult { id: string; kind: string; label: string; detail: string; href: string }

export function GlobalSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const debouncedValue = useDebouncedValue(value.trim());
  const query = useQuery({
    queryKey: ['global-search', debouncedValue],
    enabled: open && debouncedValue.length >= 1 && debouncedValue === value.trim(),
    queryFn: () => api<{ data: GlobalSearchResult[] }>('/search' + queryString({ q: debouncedValue, mode: 'any' }))
  });

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const openResult = (href: string) => { setOpen(false); setValue(''); navigate(href); };
  const results = query.data?.data ?? [];
  return <div className={`global-search${open ? ' global-search--open' : ''}`}>
    <label className="global-search-input"><Search size={16} /><input value={value} onFocus={() => setOpen(true)} onChange={(event) => { setValue(event.target.value); setOpen(true); }} placeholder="Search workspace…" aria-label="Search workspace" /><button type="button" className="global-search-clear" onClick={() => { setValue(''); setOpen(false); }} aria-label="Clear search"><X size={14} /></button></label>
    {open && value.trim().length >= 1 && <div className="global-search-results" role="listbox">{debouncedValue !== value.trim() || query.isFetching ? <p className="global-search-empty">Finding suggestions…</p> : null}{debouncedValue === value.trim() && query.isPending && !query.isFetching && <p className="global-search-empty">Searching authorised records…</p>}{debouncedValue === value.trim() && query.isError && <p className="global-search-empty">Search is temporarily unavailable.</p>}{debouncedValue === value.trim() && !query.isPending && !query.isFetching && !query.isError && !results.length && <p className="global-search-empty">No matching authorised records.</p>}{debouncedValue === value.trim() && !query.isFetching && results.map((result) => <button type="button" key={result.id} className="global-search-result" onClick={() => openResult(result.href)}><span className="global-search-icon"><FileText size={15} /></span><span><strong>{result.label}</strong><small>{result.kind}{result.detail ? ` · ${result.detail}` : ''}</small></span></button>)}</div>}
  </div>;
}
