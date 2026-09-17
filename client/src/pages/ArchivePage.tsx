import { useQuery } from '@tanstack/react-query';
import { Database, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { readableCollectionName } from '../config/resources.js';
import { api } from '../lib/api.js';

export function ArchivePage() {
  const query = useQuery({ queryKey: ['archive-collections'], queryFn: () => api<{ data: Array<{ collection: string; count: number }> }>('/records/collections') });
  if (query.isPending) return <LoadingState label="Reading migration archive…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  return <>
    <PageHeader eyebrow="MIGRATION RECONCILIATION" title="Legacy Data Archive" description="Every source MySQL table is preserved in MongoDB. Use this screen to reconcile records before cut-over." />
    <div className="archive-grid">{query.data.data.map((entry) => <Link className="archive-card" key={entry.collection} to={`/data/${entry.collection}`}><span className="archive-icon"><Database size={19} /></span><div><strong>{readableCollectionName(entry.collection)}</strong><small>{entry.count.toLocaleString('en-IN')} records</small></div><ArrowRight size={17} /></Link>)}</div>
  </>;
}
