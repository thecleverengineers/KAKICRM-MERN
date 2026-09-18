import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { AssetPreview } from '../components/AssetPreview.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { resourceById, readableCollectionName, readableFieldName, type ResourceConfig } from '../config/resources.js';
import { api, type PublicRecord } from '../lib/api.js';
import { billingProfileAssetValue, billingProfileSecondaryQrEnabled } from '../lib/assets.js';
import { dateTime, displayValue } from '../lib/format.js';

export function RecordDetailPage() {
  const { resourceId, recordId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const collection = resourceId ?? '';
  const query = useQuery({ queryKey: ['record', collection, recordId], enabled: Boolean(collection && recordId), queryFn: () => api<{ data: PublicRecord }>(`/records/${collection}/${recordId}`) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const resource = resourceById.get(collection) ?? readOnlyResource(collection, query.data.data);
  const record = query.data.data;
  const labels = new Map(resource.fields.map((field) => [field.key, field.label]));
  const secondaryQrEnabled = collection === 'billing_profiles' && billingProfileSecondaryQrEnabled(record.fields);
  const save = async (fields: Record<string, unknown>) => { await api(`/records/${collection}/${record.legacyId}`, { method: 'PATCH', body: JSON.stringify({ fields }) }); await client.invalidateQueries({ queryKey: ['record', collection, recordId] }); await client.invalidateQueries({ queryKey: ['records', collection] }); };
  const visibleFields = Object.entries(record.fields).filter(([key]) => !(collection === 'billing_profiles' && isBillingAssetField(key)));
  return <><PageHeader eyebrow="RECORD DETAIL" title={`${resource.singular} #${record.legacyId}`} description={resource.description} actions={<><button className="button button--secondary" onClick={() => navigate(`/data/${collection}`)}><ArrowLeft size={17} /> Back</button>{resource.fields.length > 0 && <button className="button" onClick={() => setEditing(true)}><Pencil size={17} /> Edit</button>}</>} />{collection === 'billing_profiles' && <section className="content-card billing-profile-assets-card"><div className="card-heading"><div><p className="eyebrow">PROFILE ASSETS</p><h2>Branding and payment previews</h2><p className="muted-copy">Uploaded company logo, authorized signature, primary QR, and secondary QR are shown here as compact image previews. The secondary QR is included on invoices and PDFs only when enabled.</p></div></div><div className="billing-profile-assets-grid"><div><small>Company Logo</small><AssetPreview value={billingProfileAssetValue(record.fields, 'logo')} label="Company Logo" /></div><div><small>Authorized Signatory Signature</small><AssetPreview value={billingProfileAssetValue(record.fields, 'signature')} label="Authorized Signatory Signature" /></div><div><small>QR Code Primary</small><AssetPreview value={billingProfileAssetValue(record.fields, 'qrPrimary')} label="QR Code Primary" variant="qr" /></div><div><small>QR Code Secondary <em className={secondaryQrEnabled ? 'billing-profile-qr-status billing-profile-qr-status--enabled' : 'billing-profile-qr-status'}>{secondaryQrEnabled ? 'Enabled' : 'Disabled'}</em></small><AssetPreview value={billingProfileAssetValue(record.fields, 'qrSecondary')} label="QR Code Secondary" variant="qr" /></div></div></section>}<article className="content-card record-detail-card"><dl className="record-detail-list">{visibleFields.map(([key, value]) => <div key={key}><dt>{labels.get(key) ?? readableFieldName(key)}</dt><dd>{record.relationLabels?.[key] ?? (/(created_at|updated_at|reviewed_at)$/i.test(key) ? dateTime(value) : displayValue(value))}</dd></div>)}</dl></article><RecordFormDialog open={editing} resource={resource} record={record} onClose={() => setEditing(false)} onSubmit={save} /></>;
}

function isBillingAssetField(key: string): boolean {
  return /^(logo_url|invoice_logo_url|company_logo_path|logo|signature_url|authority_signature_url|authorised_signature_url|signature_file|signature|qr_code_primary_url|qr_primary_url|qr_code_primary|qr_primary|qrcode_primary|qr_code_secondary_url|qr_secondary_url|qr_code_secondary|qr_secondary|qrcode_secondary)$/i.test(key);
}

function readOnlyResource(collection: string, record: PublicRecord): ResourceConfig {
  return { id: collection, label: readableCollectionName(collection), singular: readableCollectionName(collection).replace(/s$/, ''), description: 'This preserved legacy record is available for reconciliation.', icon: Pencil, columns: Object.keys(record.fields).slice(0, 7), fields: [] };
}
