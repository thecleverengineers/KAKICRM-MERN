import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type PublicRecord, type RelationOption } from '../lib/api.js';
import { assetUrl } from '../lib/assets.js';
import { type FieldDefinition, type RelationCollection, type ResourceConfig } from '../config/resources.js';

interface Props {
  open: boolean;
  resource: ResourceConfig;
  record?: PublicRecord | null;
  initialFields?: Record<string, unknown>;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<PublicRecord | void>;
}

export function RecordFormDialog({ open, resource, record, initialFields, onClose, onSubmit }: Props) {
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relationCollections = useMemo(
    () => [...new Set(resource.fields.flatMap((field) => field.relation ? [field.relation] : []))],
    [resource.fields]
  );
  const initialFieldsKey = JSON.stringify(initialFields ?? {});
  const stableInitialFields = useMemo(() => initialFields ?? {}, [initialFieldsKey]);
  const relationsQuery = useQuery({
    queryKey: ['relation-options', relationCollections],
    enabled: open && relationCollections.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const entries = await Promise.all(relationCollections.map(async (collection) => [
        collection,
        (await api<{ data: RelationOption[] }>(`/records/lookups/${resource.id}/${collection}`)).data
      ] as const));
      return Object.fromEntries(entries) as Partial<Record<RelationCollection, RelationOption[]>>;
    }
  });

  useEffect(() => {
    if (open) {
      setFields(record?.fields ?? stableInitialFields);
      setFiles({});
      setSaving(false);
      setError(null);
    }
  }, [open, record, stableInitialFields]);

  if (!open) return null;
  const title = record ? `Edit ${resource.singular}` : `New ${resource.singular}`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await onSubmit(normalizeFields(resource.fields, fields));
      const savedId = record?.legacyId ?? saved?.legacyId;
      for (const [fieldKey, file] of Object.entries(files)) {
        if (!file) continue;
        const endpoint = fileUploadEndpoint(resource.id, fieldKey, savedId);
        if (!endpoint) continue;
        const body = new FormData();
        body.append(fileUploadFormField(fieldKey), file);
        await api(endpoint, { method: 'POST', body });
      }
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save this record.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><p className="eyebrow">{resource.label}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          {resource.fields.map((field) => <FieldInput key={field.key} field={field} value={field.kind === 'image' ? imageFieldValue(field.key, fields) : fields[field.key]} imageFile={files[field.key] ?? null} relationOptions={field.relation ? relationsQuery.data?.[field.relation] : undefined} relationsLoading={relationsQuery.isFetching} onChange={(value) => setFields((current) => ({ ...current, [field.key]: value }))} onFileChange={(file) => setFiles((current) => ({ ...current, [field.key]: file }))} />)}
        </div>
        {relationsQuery.isError && <p className="form-error">Could not load the available names. Please retry.</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button type="submit" className="button" disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button></div>
      </form>
    </section>
  </div>;
}

function FieldInput({ field, value, imageFile, relationOptions, relationsLoading, onChange, onFileChange }: { field: FieldDefinition; value: unknown; imageFile: File | null; relationOptions?: RelationOption[]; relationsLoading: boolean; onChange: (value: unknown) => void; onFileChange: (file: File | null) => void }) {
  const id = `field-${field.key}`;
  if (field.kind === 'textarea') return <label className="field field--wide" htmlFor={id}><span>{field.label}{field.required && ' *'}</span><textarea id={id} value={stringValue(value)} onChange={(event) => onChange(event.target.value)} required={field.required} rows={4} /></label>;
  if (field.kind === 'image') return <ImageFieldInput field={field} value={value} imageFile={imageFile} onFileChange={onFileChange} />;
  if (field.kind === 'select') return <label className="field" htmlFor={id}><span>{field.label}{field.required && ' *'}</span><select id={id} value={stringValue(value)} onChange={(event) => onChange(event.target.value)} required={field.required}><option value="">Select…</option>{field.options?.map((option) => <option value={option} key={option}>{option.replaceAll('_', ' ')}</option>)}</select></label>;
  if (field.kind === 'multiRelation') {
    const selected = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(String);
    return <label className="field field--wide" htmlFor={id}><span>{field.label}{field.required && ' *'}</span><select id={id} multiple size={Math.min(8, Math.max(4, relationOptions?.length ?? 4))} value={selected} onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((option) => Number(option.value)))} required={field.required} disabled={relationsLoading && !relationOptions}>{relationOptions?.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select><small>Hold Ctrl/Cmd to select multiple employees.</small></label>;
  }
  if (field.kind === 'relation') {
    const selected = stringValue(value);
    const hasSelectedOption = relationOptions?.some((option) => String(option.id) === selected);
    return <label className="field" htmlFor={id}><span>{field.label}{field.required && ' *'}</span><select id={id} value={selected} onChange={(event) => onChange(event.target.value)} required={field.required} disabled={relationsLoading && !relationOptions}><option value="">{relationsLoading ? 'Loading names…' : `Select ${field.label.toLowerCase()}…`}</option>{selected && !hasSelectedOption && <option value={selected}>Current record #{selected}</option>}{relationOptions?.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>;
  }
  if (field.kind === 'boolean') return <label className="toggle-field" htmlFor={id}><input id={id} type="checkbox" checked={Boolean(Number(value) || value === true)} onChange={(event) => onChange(event.target.checked ? 1 : 0)} /><span>{field.label}</span></label>;
  return <label className="field" htmlFor={id}><span>{field.label}{field.required && ' *'}</span><input id={id} type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : field.kind === 'email' ? 'email' : 'text'} value={stringValue(value)} onChange={(event) => onChange(event.target.value)} required={field.required} /></label>;
}

function ImageFieldInput({ field, value, imageFile, onFileChange }: { field: FieldDefinition; value: unknown; imageFile: File | null; onFileChange: (file: File | null) => void }) {
  const id = `field-${field.key}`;
  const isSignature = field.key === 'signature_file';
  const isQr = field.key === 'qr_code_primary_file' || field.key === 'qr_code_secondary_file';
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!imageFile) {
      setLocalPreview(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);
  const preview = localPreview ?? assetUrl(value);
  const assetName = isSignature ? 'signature' : isQr ? 'QR code' : 'company logo';
  return <label className={`field field--wide profile-logo-field${isSignature ? ' profile-signature-field' : ''}${isQr ? ' profile-qr-field' : ''}`} htmlFor={id}><span>{field.label}{field.required && ' *'}</span><div className="profile-asset-upload"><input id={id} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => onFileChange(event.target.files?.[0] ?? null)} required={field.required && !value} />{preview && <img className={`profile-asset-preview${isQr ? ' profile-asset-preview--qr' : ''}`} src={preview} alt={`${field.label} preview`} />}</div><small>{imageFile ? `Selected: ${imageFile.name}` : value ? `Current ${assetName} saved. Upload a new file to replace it.` : 'PNG, JPG, WEBP, or SVG · maximum 5 MB'}</small></label>;
}

function normalizeFields(definitions: FieldDefinition[], fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const definition of definitions) {
    if (definition.kind === 'image') continue;
    const value = fields[definition.key];
    if (definition.kind === 'multiRelation') output[definition.key] = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(Number).filter((entry) => Number.isSafeInteger(entry) && entry > 0);
    else if (definition.kind === 'number' || definition.kind === 'relation') output[definition.key] = value === '' || value === null || value === undefined ? null : Number(value);
    else output[definition.key] = value === '' ? null : value;
  }
  return output;
}

function fileUploadEndpoint(resourceId: string, fieldKey: string, legacyId: number | null | undefined): string | null {
  if (!legacyId) throw new Error('The record was saved, but its ID was not returned for the image upload. Please reopen it and try again.');
  if (resourceId === 'billing_profiles' && fieldKey === 'logo_file') return `/billing/profiles/${legacyId}/logo`;
  if (resourceId === 'billing_profiles' && fieldKey === 'signature_file') return `/billing/profiles/${legacyId}/signature`;
  if (resourceId === 'billing_profiles' && fieldKey === 'qr_code_primary_file') return `/billing/profiles/${legacyId}/qr-primary`;
  if (resourceId === 'billing_profiles' && fieldKey === 'qr_code_secondary_file') return `/billing/profiles/${legacyId}/qr-secondary`;
  return null;
}

function fileUploadFormField(fieldKey: string): string {
  if (fieldKey === 'signature_file') return 'signature';
  if (fieldKey === 'qr_code_primary_file') return 'qr_primary';
  if (fieldKey === 'qr_code_secondary_file') return 'qr_secondary';
  return 'logo';
}

function imageFieldValue(fieldKey: string, fields: Record<string, unknown>): unknown {
  if (fieldKey === 'signature_file') return fields.signature_url ?? fields.authority_signature_url ?? fields.authorised_signature_url ?? fields.signature_file ?? fields.signature;
  if (fieldKey === 'qr_code_primary_file') return fields.qr_code_primary_url ?? fields.qr_primary_url ?? fields.qr_code_primary ?? fields.qr_primary ?? fields.qrcode_primary;
  if (fieldKey === 'qr_code_secondary_file') return fields.qr_code_secondary_url ?? fields.qr_secondary_url ?? fields.qr_code_secondary ?? fields.qr_secondary ?? fields.qrcode_secondary;
  return fields.logo_url ?? fields.invoice_logo_url ?? fields.company_logo_path ?? fields.logo;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
