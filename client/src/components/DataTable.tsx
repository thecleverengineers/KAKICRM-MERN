import { ChevronLeft, ChevronRight, Eye, Pencil, Trash2 } from 'lucide-react';
import type { PublicRecord } from '../lib/api.js';
import { date, dateTime, displayValue, money } from '../lib/format.js';
import { readableFieldName, type ResourceConfig } from '../config/resources.js';
import { EmptyState } from './LoadingState.js';
import { StatusPill } from './StatusPill.js';
import { AssetPreview } from './AssetPreview.js';
import { billingProfileAssetValue } from '../lib/assets.js';

interface Props {
  records: PublicRecord[];
  columns: string[];
  resource?: ResourceConfig;
  page?: number;
  pages?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onOpen?: (record: PublicRecord) => void;
  clickableRows?: boolean;
  selectable?: boolean;
  selectedLegacyIds?: number[];
  onSelectedLegacyIdsChange?: (ids: number[]) => void;
  onEdit?: (record: PublicRecord) => void;
  onArchive?: (record: PublicRecord) => void;
  emptyTitle?: string;
}

export function DataTable({ records, columns, resource, page = 1, pages = 1, total = records.length, onPageChange, onOpen, clickableRows = false, selectable = false, selectedLegacyIds = [], onSelectedLegacyIdsChange, onEdit, onArchive, emptyTitle = 'No records found' }: Props) {
  if (!records.length) return <EmptyState title={emptyTitle} detail="Try changing the search or add a new record." />;
  const labels = new Map(resource?.fields.map((field) => [field.key, field.label]));
  const selectableRecords = records.filter((record): record is PublicRecord & { legacyId: number } => Number.isSafeInteger(record.legacyId) && (record.legacyId ?? 0) > 0);
  const selectedIdSet = new Set(selectedLegacyIds);
  const allVisibleSelected = selectableRecords.length > 0 && selectableRecords.every((record) => selectedIdSet.has(record.legacyId));
  const updateSelection = (nextIds: Set<number>) => onSelectedLegacyIdsChange?.([...nextIds]);
  const toggleRecord = (legacyId: number, checked: boolean) => {
    const nextIds = new Set(selectedLegacyIds);
    if (checked) nextIds.add(legacyId);
    else nextIds.delete(legacyId);
    updateSelection(nextIds);
  };
  const toggleVisible = (checked: boolean) => {
    const nextIds = new Set(selectedLegacyIds);
    for (const record of selectableRecords) {
      if (checked) nextIds.add(record.legacyId);
      else nextIds.delete(record.legacyId);
    }
    updateSelection(nextIds);
  };
  return <div className="table-card">
    <div className="table-scroll">
      <table>
        <thead><tr>{selectable && <th className="table-select-cell"><input className="table-select" type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleVisible(event.target.checked)} aria-label="Select all visible records" /></th>}<th>ID</th>{columns.map((column) => <th key={column}>{labels.get(column) ?? readableFieldName(column)}</th>)}{(onOpen || onEdit || onArchive) && <th aria-label="Actions" />}</tr></thead>
        <tbody>
          {records.map((record) => {
            const rowIsClickable = clickableRows && Boolean(onOpen);
            const openRecord = () => onOpen?.(record);
            const primaryLinkColumn = resource?.id === 'users' || resource?.id === 'teams' || resource?.id === 'department_projects' ? 'name' : resource?.id === 'billing_profiles' ? 'legal_name' : resource?.id === 'tasks' ? 'title' : resource?.id === 'leave_requests' ? 'leave_type' : 'invoice_no';
            return <tr key={record.id} className={rowIsClickable ? 'table-row--clickable' : undefined} tabIndex={rowIsClickable ? 0 : undefined} role={rowIsClickable ? 'link' : undefined} aria-label={rowIsClickable ? `Open ${resource?.singular ?? 'record'} ${String(record.fields.name ?? record.fields.invoice_no ?? record.legacyId ?? '')}`.trim() : undefined} onClick={rowIsClickable ? openRecord : undefined} onKeyDown={rowIsClickable ? (event) => {
              if (event.currentTarget !== event.target) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openRecord();
              }
            } : undefined}>
              {selectable && <td className="table-select-cell"><input className="table-select" type="checkbox" disabled={!Number.isSafeInteger(record.legacyId) || (record.legacyId ?? 0) <= 0} checked={typeof record.legacyId === 'number' && selectedIdSet.has(record.legacyId)} onClick={(event) => event.stopPropagation()} onChange={(event) => { if (typeof record.legacyId === 'number' && Number.isSafeInteger(record.legacyId) && record.legacyId > 0) toggleRecord(record.legacyId, event.target.checked); }} aria-label={`Select ${resource?.singular?.toLowerCase() ?? 'record'} ${String(record.fields.title ?? record.fields.name ?? record.legacyId ?? '')}`.trim()} /></td>}
              <td className="table-id">#{record.legacyId ?? '—'}</td>
              {columns.map((column) => {
                const definition = resource?.fields.find((field) => field.key === column);
                const value = resource?.id === 'billing_profiles' && definition?.kind === 'image'
                  ? billingProfileAssetValue(record.fields, billingAssetKey(column))
                  : record.fields[column];
                return <td key={column} className={column === primaryLinkColumn && rowIsClickable ? 'table-cell--primary-link' : undefined}>{renderValue(column, value, record.relationLabels?.[column], definition?.kind === 'image' ? definition.label : undefined)}</td>;
              })}
              {(onOpen || onEdit || onArchive) && <td className="table-actions">
                {onOpen && <button className="icon-button icon-button--small" onClick={(event) => { event.stopPropagation(); onOpen(record); }} aria-label="Open"><Eye size={16} /></button>}
                {onEdit && <button className="icon-button icon-button--small" onClick={(event) => { event.stopPropagation(); onEdit(record); }} aria-label="Edit"><Pencil size={16} /></button>}
                {onArchive && <button className="icon-button icon-button--small danger" onClick={(event) => { event.stopPropagation(); onArchive(record); }} aria-label="Archive"><Trash2 size={16} /></button>}
              </td>}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    {onPageChange && <div className="pagination"><span>{total} record{total === 1 ? '' : 's'}</span><div><button className="icon-button icon-button--small" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button><span>Page {page} of {pages}</span><button className="icon-button icon-button--small" disabled={page >= pages} onClick={() => onPageChange(page + 1)} aria-label="Next page"><ChevronRight size={17} /></button></div></div>}
  </div>;
}

function renderValue(column: string, value: unknown, relationLabel?: string, imageLabel?: string) {
  if (imageLabel) return <AssetPreview value={value} label={imageLabel} variant={column.includes('qr_code') ? 'qr' : 'default'} />;
  if (relationLabel) return <span className="truncate-cell" title={relationLabel}>{relationLabel}</span>;
  if (/(status|priority|stage)$/i.test(column)) return <StatusPill value={value} />;
  if (/(amount|salary|fee|rate|pay|deduction|subtotal|total)$/i.test(column)) return money(value);
  if (/(date)$/i.test(column)) return date(value);
  if (/(at|time)$/i.test(column)) return dateTime(value);
  return <span className="truncate-cell" title={displayValue(value)}>{displayValue(value)}</span>;
}

function billingAssetKey(column: string): 'logo' | 'signature' | 'qrPrimary' | 'qrSecondary' {
  if (column === 'signature_file') return 'signature';
  if (column === 'qr_code_primary_file') return 'qrPrimary';
  if (column === 'qr_code_secondary_file') return 'qrSecondary';
  return 'logo';
}
