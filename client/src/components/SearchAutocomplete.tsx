import { useEffect, useId, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import '../styles/search-autocomplete.css';

export interface SearchAutocompleteProps<T> {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  suggestions: readonly T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getDetail?: (item: T) => string;
  onSelect: (item: T) => void;
  placeholder: string;
  loading?: boolean;
  error?: boolean;
  noResultsLabel?: string;
  searchActionLabel?: (term: string) => string;
  className?: string;
}

export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

export function SearchAutocomplete<T>({
  value,
  onChange,
  onSubmit,
  suggestions,
  getKey,
  getLabel,
  getDetail,
  onSelect,
  placeholder,
  loading = false,
  error = false,
  noResultsLabel = 'No matching suggestions.',
  searchActionLabel = (term) => `Search all results for “${term}”`,
  className = ''
}: SearchAutocompleteProps<T>) {
  const [open, setOpen] = useState(false);
  const listboxId = useId().replaceAll(':', '');
  const term = value.trim();
  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOpen(false);
    onSubmit();
  };
  return <div className={`search-autocomplete ${className}`} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <form className="search-autocomplete__form" role="search" onSubmit={onFormSubmit}>
      <label className="search-box"><Search size={17} /><input value={value} onFocus={() => setOpen(true)} onChange={(event) => { onChange(event.target.value); setOpen(true); }} placeholder={placeholder} aria-label={placeholder} aria-autocomplete="list" aria-expanded={open && term.length > 0} aria-controls={listboxId} autoComplete="off" /></label>
      <button className="button button--secondary button--compact search-autocomplete__submit" type="submit">Search</button>
    </form>
    {open && term.length > 0 && <div className="search-autocomplete__suggestions" role="listbox" id={listboxId}>
      {loading && <p className="search-autocomplete__message">Finding suggestions…</p>}
      {!loading && error && <p className="search-autocomplete__message">Suggestions are temporarily unavailable.</p>}
      {!loading && !error && !suggestions.length && <p className="search-autocomplete__message">{noResultsLabel}</p>}
      {!loading && !error && suggestions.map((item) => {
        const detail = getDetail?.(item);
        return <button className="search-autocomplete__option" type="button" role="option" aria-selected="false" key={getKey(item)} onClick={() => { setOpen(false); onSelect(item); }}>
          <strong>{getLabel(item)}</strong>{detail ? <small>{detail}</small> : null}
        </button>;
      })}
      <button className="search-autocomplete__all" type="button" onClick={() => { setOpen(false); onSubmit(); }}>{searchActionLabel(term)}</button>
    </div>}
  </div>;
}
