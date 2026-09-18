import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BadgePercent, FileText, Pencil, Plus, Printer, Save, Trash2, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { BrandVisual } from '../components/BrandVisual.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { date, displayValue, money } from '../lib/format.js';
import { useBranding } from '../lib/branding.js';
import { billingProfileSecondaryQrEnabled } from '../lib/assets.js';
import { isCeoRole } from '../lib/ceo.js';
import { CUSTOM_INVOICE_UNIT, INVOICE_UNITS, isPresetInvoiceUnit, resolvedUnit, unitSelection } from '../lib/invoiceUnits.js';
import { useAuth } from '../store/auth.js';

interface InvoiceDetail { data: PublicRecord; items: PublicRecord[]; payments: PublicRecord[]; client: PublicRecord | null; billingProfile: PublicRecord | null; }
type InvoiceDiscountType = 'none' | 'percentage' | 'amount';
interface InvoiceDiscount { type: InvoiceDiscountType; value: number; amount: number; label: string; }

const PAYMENT_MODES = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' }
] as const;

export function InvoiceDetailPage() {
  const { invoiceId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPermission, user } = useAuth();
  const branding = useBranding();
  const [addingItem, setAddingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<PublicRecord | null>(null);
  const [deletingItem, setDeletingItem] = useState<PublicRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [addingPayment, setAddingPayment] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PublicRecord | null>(null);
  const [deletingPayment, setDeletingPayment] = useState<PublicRecord | null>(null);
  const [paymentDeleteError, setPaymentDeleteError] = useState<string | null>(null);
  const [paymentDeleting, setPaymentDeleting] = useState(false);
  const [editingDiscount, setEditingDiscount] = useState(false);
  const [deletingDiscount, setDeletingDiscount] = useState(false);
  const [discountDeleteError, setDiscountDeleteError] = useState<string | null>(null);
  const [discountDeleting, setDiscountDeleting] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [deletingNote, setDeletingNote] = useState(false);
  const [noteDeleteError, setNoteDeleteError] = useState<string | null>(null);
  const [noteDeleting, setNoteDeleting] = useState(false);
  const query = useQuery({ queryKey: ['invoice', invoiceId], enabled: Boolean(invoiceId), queryFn: () => api<InvoiceDetail>(`/billing/invoices/${invoiceId}`) });

  if (query.isPending) return <LoadingState label="Loading invoice…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const invoice = query.data;
  const canManage = hasPermission('billing.manage');
  const canManageSettlement = canManage || isAdminOrHrRole(user?.role);
  const canManageNote = isInvoiceNoteManagerRole(user?.role);
  const canChangeBillingProfile = isAdminOrHrRole(user?.role) || isCeoRole(user?.role);
  const invoiceNote = text(invoice.data.fields.notes).trim();
  const hasInvoiceNote = Boolean(invoiceNote);
  const billingFields = invoice.billingProfile?.fields ?? {};
  const hasSelectedCompanyProfile = Boolean(invoice.billingProfile?.legacyId);
  // The selected billing profile owns the printed issuer heading. Legacy
  // imports used a few different spellings, so resolve all of them before
  // falling back to an invoice snapshot or the CRM branding.
  const issuer = issuerBusinessName(billingFields) || issuerBusinessName(invoice.data.fields) || branding.site_title;
  const profileLogo = profileAssetUrl(firstText(billingFields.logo_url, billingFields.invoice_logo_url, billingFields.company_logo_path, billingFields.logo));
  const profileSignature = profileAssetUrl(firstText(billingFields.signature_url, billingFields.authority_signature_url, billingFields.authorised_signature_url, billingFields.signature_file, billingFields.signature));
  const profileQrPrimary = profileAssetUrl(firstText(billingFields.qr_code_primary_url, billingFields.qr_primary_url, billingFields.qr_code_primary, billingFields.qr_primary, billingFields.qrcode_primary));
  const profileQrSecondary = profileAssetUrl(firstText(billingFields.qr_code_secondary_url, billingFields.qr_secondary_url, billingFields.qr_code_secondary, billingFields.qr_secondary, billingFields.qrcode_secondary));
  const showProfileQrSecondary = Boolean(profileQrSecondary) && billingProfileSecondaryQrEnabled(billingFields);
  const invoiceLogo = hasSelectedCompanyProfile ? profileLogo || null : branding.invoice_logo_url ?? branding.logo_url;
  const invoiceStyle = { '--invoice-accent': branding.invoice_accent } as CSSProperties;
  const spacerRows = Math.max(0, 10 - Math.max(invoice.items.length, 1));
  const bankName = firstText(billingFields.bank_name, billingFields.bank);
  const accountNumber = firstText(billingFields.bank_account_number, billingFields.account_number);
  const bankIfsc = firstText(billingFields.bank_ifsc_code, billingFields.ifsc_code);
  const issuerAddress = firstText(billingFields.address, billingFields.registered_address);
  const issuerGstin = firstText(billingFields.gstin, billingFields.gst_number);
  const phone = firstText(billingFields.phone, billingFields.phone_number, billingFields.mobile);
  const email = firstText(billingFields.email, billingFields.billing_email);
  const profileGstEnabled = optionalBoolean(billingFields.gst_enabled, billingFields.gst_default_enabled, billingFields.gst_registered, billingFields.gst_applicable);
  const invoiceGstEnabled = optionalBoolean(invoice.data.fields.gst_enabled);
  const showIssuerGstin = Boolean(issuerGstin) && (profileGstEnabled ?? invoiceGstEnabled ?? false);
  const discount = invoiceDiscount(invoice.data.fields);
  const hasDiscount = discount.type !== 'none' && discount.amount > 0;
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] }),
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
    ]);
  };
  const deleteItem = async () => {
    if (!deletingItem?.legacyId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/items/${deletingItem.legacyId}`, { method: 'DELETE' });
      setDeletingItem(null);
      await refresh();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'The invoice item could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };
  const deletePayment = async () => {
    if (!deletingPayment?.legacyId) return;
    setPaymentDeleting(true);
    setPaymentDeleteError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/payments/${deletingPayment.legacyId}`, { method: 'DELETE' });
      setDeletingPayment(null);
      await refresh();
    } catch (error) {
      setPaymentDeleteError(error instanceof Error ? error.message : 'The payment record could not be deleted.');
    } finally {
      setPaymentDeleting(false);
    }
  };
  const deleteDiscount = async () => {
    setDiscountDeleting(true);
    setDiscountDeleteError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/discount`, { method: 'DELETE' });
      setDeletingDiscount(false);
      await refresh();
    } catch (error) {
      setDiscountDeleteError(error instanceof Error ? error.message : 'The discount could not be removed.');
    } finally {
      setDiscountDeleting(false);
    }
  };
  const deleteNote = async () => {
    setNoteDeleting(true);
    setNoteDeleteError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/note`, { method: 'DELETE' });
      setDeletingNote(false);
      await refresh();
    } catch (error) {
      setNoteDeleteError(error instanceof Error ? error.message : 'The invoice note could not be deleted.');
    } finally {
      setNoteDeleting(false);
    }
  };

  return <>
    <PageHeader eyebrow="INVOICE DETAIL" title={displayValue(invoice.data.fields.invoice_no)} description={`Issued ${date(invoice.data.fields.issue_date)} · ${displayValue(invoice.client?.fields.name)}`} actions={<><button className="button button--secondary" onClick={() => navigate('/invoices')}><ArrowLeft size={17} /> Invoices</button><button className="button button--secondary" onClick={() => window.print()}><Printer size={17} /> Print</button></>} />
    <article className="invoice-paper invoice-paper--premium invoice-paper--a4" style={invoiceStyle}>
      <div className="invoice-template-corner invoice-template-corner--top" aria-hidden="true" />
      <div className="invoice-template-corner invoice-template-corner--bottom" aria-hidden="true" />
      <div className="invoice-template-content">
        <header className="invoice-template-header">
          <div className="invoice-template-brand"><BrandVisual src={invoiceLogo} label={issuer} className="invoice-template-logo" /><div className="invoice-template-company-copy"><h1 className="invoice-template-business-name">{issuer}</h1><div className="invoice-template-print-title" aria-hidden="true">{issuer}</div>{issuerAddress && <span>{issuerAddress}</span>}{showIssuerGstin && <span>GSTIN: {issuerGstin}</span>}{phone && <span>Phone: {phone}</span>}{email && <span>Email: {email}</span>}{!hasSelectedCompanyProfile && <b>{branding.site_subtitle}</b>}</div></div>
        </header>
        <section className="invoice-template-identity">
          <div className="invoice-template-recipient"><span>Invoice to:</span><strong>{displayValue(invoice.client?.fields.name)}</strong><p>{displayValue(invoice.client?.fields.address)}</p>{Boolean(invoice.client?.fields.gstin) && <p>GSTIN: {displayValue(invoice.client?.fields.gstin)}</p>}</div>
          <dl className="invoice-template-reference"><div><dt>Invoice #</dt><dd>{displayValue(invoice.data.fields.invoice_no)}</dd></div><div><dt>Date</dt><dd>{date(invoice.data.fields.issue_date)}</dd></div>{Boolean(invoice.data.fields.due_date) && <div><dt>Due date</dt><dd>{date(invoice.data.fields.due_date)}</dd></div>}</dl>
        </section>
        <table className="invoice-table invoice-template-table">
          <colgroup><col className="invoice-col-number" /><col className="invoice-col-description" /><col className="invoice-col-qty" /><col className="invoice-col-rate" /><col className="invoice-col-total" />{canManage && <col className="invoice-col-actions" />}</colgroup>
          <thead><tr><th>No.</th><th>Item description</th><th>Qty</th><th>Price</th><th>Total</th>{canManage && <th className="invoice-item-actions-heading">Actions</th>}</tr></thead>
          <tbody>
            {invoice.items.map((item, index) => <tr key={item.id}><td className="invoice-cell-number">{index + 1}</td><td className="invoice-cell-description"><strong>{displayValue(item.fields.label)}</strong>{Boolean(item.fields.description) && <small>{displayValue(item.fields.description)}</small>}</td><td>{displayValue(item.fields.qty)} {text(item.fields.unit)}</td><td>{money(item.fields.rate)}</td><td>{money(item.fields.amount)}</td>{canManage && <td className="invoice-item-actions"><button className="icon-button" type="button" title="Edit invoice item" aria-label={`Edit ${displayValue(item.fields.label)}`} onClick={() => setEditingItem(item)}><Pencil size={16} /></button><button className="icon-button danger" type="button" title={`Delete ${displayValue(item.fields.label)}`} aria-label={`Delete ${displayValue(item.fields.label)}`} onClick={() => { setDeleteError(null); setDeletingItem(item); }}><Trash2 size={16} /></button></td>}</tr>)}
            {!invoice.items.length && <tr className="invoice-empty-row"><td colSpan={canManage ? 6 : 5}>No invoice items are currently recorded.</td></tr>}
            {Array.from({ length: spacerRows }, (_, index) => <tr className="invoice-spacer-row" key={`spacer-${index}`}><td /><td /><td /><td /><td />{canManage && <td />}</tr>)}
          </tbody>
        </table>
        <section className="invoice-template-settlement">
          <div className="invoice-template-payment"><h3>Payment info:</h3><p><strong>Account #:</strong> {accountNumber || 'Available on request'}</p><p><strong>A/C Name:</strong> {issuer}</p>{bankName && <p><strong>Bank details:</strong> {bankName}</p>}{bankIfsc && <p><strong>IFSC:</strong> {bankIfsc}</p>}{showIssuerGstin && <p><strong>GSTIN:</strong> {issuerGstin}</p>}{hasInvoiceNote && <div className="invoice-template-note-block"><strong>Invoice note</strong><p>{invoiceNote}</p></div>}{(profileQrPrimary || showProfileQrSecondary) && <div className="invoice-template-qr-codes" aria-label="Payment QR codes">{profileQrPrimary && <div className="invoice-template-qr-code"><img src={profileQrPrimary} alt="QR Code Primary" /><span>QR Code Primary</span></div>}{showProfileQrSecondary && <div className="invoice-template-qr-code"><img src={profileQrSecondary ?? ''} alt="QR Code Secondary" /><span>QR Code Secondary</span></div>}</div>}</div>
          <div className="invoice-template-totals"><div><span>Sub total</span><strong>{money(invoice.data.fields.subtotal)}</strong></div>{hasDiscount && <div className="invoice-template-discount"><span>Discount</span><strong>−{money(discount.amount)}</strong></div>}<div><span>Tax</span><strong>{money(invoice.data.fields.gst_amount)}</strong></div><div className="invoice-template-total"><span>Total</span><strong>{money(invoice.data.fields.total_amount)}</strong></div><p><span>Paid {money(invoice.data.fields.paid_amount)}</span><strong>Balance {money(invoice.data.fields.balance_amount)}</strong></p></div>
        </section>
        <section className={`invoice-template-signature${profileSignature ? ' invoice-template-signature--signed' : ''}`}><div><strong>Authority</strong>{profileSignature ? <img className="invoice-template-signature-image" src={profileSignature} alt={`${issuer} authority signature`} /> : <div className="invoice-signature-line" />}</div></section>
      </div>
    </article>
    {canChangeBillingProfile && <InvoiceBillingProfileSwitcher invoiceId={invoiceId ?? ''} invoice={invoice.data} currentProfile={invoice.billingProfile} onSaved={refresh} />}
    {(canManage || canManageSettlement || canManageNote) && <section className="invoice-actions-grid">
      {canManage && <article className="content-card"><div className="card-heading"><div><p className="eyebrow">ADD LINE ITEM</p><h2>Invoice items</h2></div><Plus size={18} /></div><p className="muted-copy">Add a complete item with description, quantity, unit and rate.</p><button className="button" type="button" onClick={() => setAddingItem(true)}><Plus size={16} /> Add invoice item</button></article>}
      {canManageSettlement && <article className="content-card invoice-discount-card"><div className="card-heading"><div><p className="eyebrow">INVOICE DISCOUNT</p><h2>Discount</h2></div><BadgePercent size={18} /></div><div className="invoice-discount-summary"><strong>{hasDiscount ? discount.label : 'No discount applied'}</strong><span>{hasDiscount ? `${money(discount.amount)} will be deducted before GST.` : 'Apply a percentage or flat amount to this client invoice.'}</span></div><div className="invoice-card-actions"><button className="button" type="button" onClick={() => setEditingDiscount(true)}><Pencil size={16} /> {hasDiscount ? 'Edit discount' : 'Add discount'}</button>{hasDiscount && <button className="button button--secondary invoice-remove-button" type="button" onClick={() => { setDiscountDeleteError(null); setDeletingDiscount(true); }}><Trash2 size={16} /> Remove</button>}</div></article>}
      {canManageNote && <article className="content-card invoice-note-card"><div className="card-heading"><div><p className="eyebrow">INVOICE NOTE</p><h2>{hasInvoiceNote ? 'Invoice note' : 'Add a note'}</h2></div><FileText size={18} /></div><div className="invoice-note-summary">{hasInvoiceNote ? <p>{invoiceNote}</p> : <span>No note has been added to this invoice yet.</span>}</div><div className="invoice-card-actions"><button className="button" type="button" onClick={() => setEditingNote(true)}><Pencil size={16} /> {hasInvoiceNote ? 'Edit note' : 'Add note'}</button>{hasInvoiceNote && <button className="button button--secondary invoice-remove-button" type="button" onClick={() => { setNoteDeleteError(null); setDeletingNote(true); }}><Trash2 size={16} /> Delete</button>}</div></article>}
      {canManageSettlement && <article className="content-card"><div className="card-heading"><div><p className="eyebrow">PARTIAL PAYMENT</p><h2>Payments</h2></div><button className="button button--secondary invoice-card-heading-action" type="button" onClick={() => setAddingPayment(true)} disabled={numberValue(invoice.data.fields.balance_amount) <= 0}><Plus size={16} /> Record</button></div><p className="muted-copy">Record one or more partial payments for this client. Balance and invoice status update automatically.</p><ul className="simple-list invoice-payment-list">{invoice.payments.map((payment) => <li key={payment.id} className="invoice-payment-row"><div><strong>{money(payment.fields.amount)}</strong><span>{date(payment.fields.payment_date)} · {paymentModeLabel(payment.fields.mode)}{payment.fields.reference ? ` · ${displayValue(payment.fields.reference)}` : ''}</span>{Boolean(payment.fields.note) && <small>{displayValue(payment.fields.note)}</small>}</div><div className="invoice-inline-actions"><button className="icon-button icon-button--small" type="button" title="Edit payment" aria-label={`Edit payment ${money(payment.fields.amount)}`} onClick={() => setEditingPayment(payment)}><Pencil size={16} /></button><button className="icon-button icon-button--small danger" type="button" title="Delete payment" aria-label={`Delete payment ${money(payment.fields.amount)}`} onClick={() => { setPaymentDeleteError(null); setDeletingPayment(payment); }}><Trash2 size={16} /></button></div></li>)}{!invoice.payments.length && <li className="muted-copy">No payments recorded.</li>}</ul></article>}
    </section>}
    {addingItem && <InvoiceItemDialog key="new-invoice-item" invoiceId={invoiceId ?? ''} onClose={() => setAddingItem(false)} onSaved={async () => { setAddingItem(false); await refresh(); }} />}
    {editingItem && <InvoiceItemDialog key={editingItem.id} invoiceId={invoiceId ?? ''} item={editingItem} onClose={() => setEditingItem(null)} onSaved={async () => { setEditingItem(null); await refresh(); }} />}
    {deletingItem && <DeleteInvoiceItemDialog item={deletingItem} deleting={deleting} error={deleteError} onClose={() => { if (!deleting) setDeletingItem(null); }} onConfirm={() => void deleteItem()} />}
    {addingPayment && <InvoicePaymentDialog key="new-payment" invoiceId={invoiceId ?? ''} remainingBalance={numberValue(invoice.data.fields.balance_amount)} clientName={displayValue(invoice.client?.fields.name)} onClose={() => setAddingPayment(false)} onSaved={async () => { setAddingPayment(false); await refresh(); }} />}
    {editingPayment && <InvoicePaymentDialog key={editingPayment.id} invoiceId={invoiceId ?? ''} payment={editingPayment} remainingBalance={numberValue(invoice.data.fields.balance_amount)} clientName={displayValue(invoice.client?.fields.name)} onClose={() => setEditingPayment(null)} onSaved={async () => { setEditingPayment(null); await refresh(); }} />}
    {deletingPayment && <DeleteInvoicePaymentDialog payment={deletingPayment} deleting={paymentDeleting} error={paymentDeleteError} onClose={() => { if (!paymentDeleting) setDeletingPayment(null); }} onConfirm={() => void deletePayment()} />}
    {editingDiscount && <InvoiceDiscountDialog invoiceId={invoiceId ?? ''} invoice={invoice.data} onClose={() => setEditingDiscount(false)} onSaved={async () => { setEditingDiscount(false); await refresh(); }} />}
    {deletingDiscount && <DeleteInvoiceDiscountDialog discount={discount} deleting={discountDeleting} error={discountDeleteError} onClose={() => { if (!discountDeleting) setDeletingDiscount(false); }} onConfirm={() => void deleteDiscount()} />}
    {editingNote && <InvoiceNoteDialog invoiceId={invoiceId ?? ''} note={invoiceNote} onClose={() => setEditingNote(false)} onSaved={async () => { setEditingNote(false); await refresh(); }} />}
    {deletingNote && <DeleteInvoiceNoteDialog deleting={noteDeleting} error={noteDeleteError} onClose={() => { if (!noteDeleting) setDeletingNote(false); }} onConfirm={() => void deleteNote()} />}
  </>;
}

function InvoiceBillingProfileSwitcher({ invoiceId, invoice, currentProfile, onSaved }: { invoiceId: string; invoice: PublicRecord; currentProfile: PublicRecord | null; onSaved: () => Promise<void> }) {
  const profilesQuery = useQuery({ queryKey: ['invoice-billing-profiles'], queryFn: () => api<Paginated<PublicRecord>>('/records/billing_profiles?limit=100') });
  const currentId = String(invoice.fields.billing_profile_id ?? currentProfile?.legacyId ?? '');
  const [selectedId, setSelectedId] = useState(currentId);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(currentId);
  }, [currentId]);

  const selectedProfile = profilesQuery.data?.data.find((profile) => String(profile.legacyId) === selectedId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId) {
      setError('Select a billing profile.');
      return;
    }
    if (selectedId === currentId) {
      setMessage('This invoice is already using the selected billing profile.');
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/billing-profile`, { method: 'PATCH', body: JSON.stringify({ billing_profile_id: Number(selectedId) }) });
      await onSaved();
      setMessage('Billing profile changed for this invoice. Existing billing profiles and invoice amounts were not modified.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not change the invoice billing profile.');
    } finally {
      setSaving(false);
    }
  };

  return <article className="content-card invoice-billing-profile-card"><div className="card-heading"><div><p className="eyebrow">INVOICE ISSUER</p><h2>Change billing profile</h2></div><FileText size={18} /></div><p className="muted-copy">Change only the company profile used by this invoice. The existing billing profile configuration, logo, signature, QR settings, GST and bank details remain unchanged.</p>{profilesQuery.isPending ? <p className="muted-copy">Loading billing profiles…</p> : profilesQuery.isError ? <p className="form-error">Could not load billing profiles. Please retry the invoice page.</p> : <form className="invoice-profile-switcher" onSubmit={(event) => void submit(event)}><label className="field"><span>Billing profile</span><select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setMessage(null); setError(null); }}><option value="">Select billing profile…</option>{profilesQuery.data.data.map((profile) => <option key={profile.id} value={profile.legacyId ?? ''}>{companyProfileName(profile)}</option>)}</select></label><div className="invoice-profile-switcher__details"><strong>{selectedProfile ? companyProfileName(selectedProfile) : 'No profile selected'}</strong><span>{selectedProfile ? 'This profile will be used for the invoice preview and printed/PDF output.' : 'Select an active profile to update this invoice.'}</span></div><button className="button" type="submit" disabled={saving || !selectedId}>{saving ? 'Changing…' : 'Change profile'}</button>{message && <p className="form-success">{message}</p>}{error && <p className="form-error">{error}</p>}</form>}</article>;
}

function InvoiceNoteDialog({ invoiceId, note, onClose, onSaved }: { invoiceId: string; note: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Enter an invoice note before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/note`, { method: 'PATCH', body: JSON.stringify({ note: trimmed }) });
      await onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The invoice note could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-note-modal" role="dialog" aria-modal="true" aria-label={note ? 'Edit invoice note' : 'Add invoice note'} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">INVOICE NOTE</p><h2>{note ? 'Edit invoice note' : 'Add invoice note'}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>Note *</span><textarea value={value} onChange={(event) => setValue(event.target.value)} maxLength={10_000} rows={8} placeholder="Add a note that should appear on this invoice and its PDF…" required autoFocus /><small>This note is visible on the invoice and browser-generated PDF.</small></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save note'}</button></div></form>
  </section></div>;
}

function DeleteInvoiceNoteDialog({ deleting, error, onClose, onConfirm }: { deleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-delete-modal" role="dialog" aria-modal="true" aria-label="Delete invoice note" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">INVOICE NOTE</p><h2>Delete this note?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={deleting} aria-label="Close"><X size={18} /></button></div>
    <p className="invoice-delete-copy">The note will be removed from this invoice and its PDF.</p><p className="invoice-delete-note">This action does not change the invoice amount, payment status, or line items.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete note'}</button></div>
  </section></div>;
}

function InvoicePaymentDialog({ invoiceId, payment, remainingBalance, clientName, onClose, onSaved }: { invoiceId: string; payment?: PublicRecord; remainingBalance: number; clientName: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const isEditing = Boolean(payment?.legacyId);
  const [amount, setAmount] = useState(text(payment?.fields.amount));
  const [paymentDate, setPaymentDate] = useState(inputDate(payment?.fields.payment_date));
  const [mode, setMode] = useState(text(payment?.fields.mode, 'bank_transfer'));
  const [reference, setReference] = useState(text(payment?.fields.reference));
  const [note, setNote] = useState(text(payment?.fields.note));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maximumAmount = Math.max(0, remainingBalance + numberValue(payment?.fields.amount));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Enter a payment amount greater than zero.');
      return;
    }
    if (numericAmount > maximumAmount) {
      setError(`Payment cannot exceed the remaining balance of ${money(maximumAmount)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ amount: numericAmount, payment_date: paymentDate, mode, reference: reference.trim() || null, note: note.trim() || null });
      if (payment?.legacyId) await api(`/billing/invoices/${invoiceId}/payments/${payment.legacyId}`, { method: 'PATCH', body });
      else await api(`/billing/invoices/${invoiceId}/payments`, { method: 'POST', body });
      await onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : `The payment could not be ${isEditing ? 'updated' : 'recorded'}.`);
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-payment-modal" role="dialog" aria-modal="true" aria-label={isEditing ? 'Edit payment' : 'Record partial payment'} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">PARTIAL PAYMENT · {clientName}</p><h2>{isEditing ? 'Edit payment' : 'Record partial payment'}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>Remaining invoice balance</span><output className="invoice-line-preview">{money(maximumAmount)}</output></label><label className="field"><span>Amount *</span><input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0.01" max={maximumAmount || undefined} step="0.01" required autoFocus /></label><label className="field"><span>Payment date *</span><input value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} type="date" required /></label><label className="field"><span>Payment mode *</span><select value={mode} onChange={(event) => setMode(event.target.value)} required>{PAYMENT_MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="field"><span>Reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={255} placeholder="Transaction / receipt reference" /></label><label className="field field--wide"><span>Note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={3} placeholder="Optional payment note" /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : isEditing ? 'Save payment' : 'Record payment'}</button></div></form>
  </section></div>;
}

function DeleteInvoicePaymentDialog({ payment, deleting, error, onClose, onConfirm }: { payment: PublicRecord; deleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-delete-modal" role="dialog" aria-modal="true" aria-label="Delete payment" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">REMOVE PAYMENT</p><h2>Delete this payment?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={deleting} aria-label="Close"><X size={18} /></button></div>
    <p className="invoice-delete-copy"><strong>{money(payment.fields.amount)}</strong> received on {date(payment.fields.payment_date)} will be removed from this invoice.</p><p className="invoice-delete-note">The payment is archived for traceability. The invoice balance and automatic status will recalculate immediately.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete payment'}</button></div>
  </section></div>;
}

function InvoiceDiscountDialog({ invoiceId, invoice, onClose, onSaved }: { invoiceId: string; invoice: PublicRecord; onClose: () => void; onSaved: () => Promise<void> }) {
  const current = invoiceDiscount(invoice.fields);
  const [discountType, setDiscountType] = useState<Exclude<InvoiceDiscountType, 'none'>>(current.type === 'amount' ? 'amount' : 'percentage');
  const [value, setValue] = useState(current.value > 0 ? String(current.value) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subtotal = numberValue(invoice.fields.subtotal);
  const numericValue = numberValue(value);
  const discountAmount = discountType === 'percentage'
    ? Math.round((subtotal * Math.min(100, numericValue) / 100 + Number.EPSILON) * 100) / 100
    : Math.min(subtotal, numericValue);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!numericValue) {
      setError('Enter a discount greater than zero.');
      return;
    }
    if (discountType === 'percentage' && numericValue > 100) {
      setError('Percentage discount cannot exceed 100%.');
      return;
    }
    if (discountType === 'amount' && numericValue > subtotal) {
      setError(`Fixed discount cannot exceed ${money(subtotal)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/billing/invoices/${invoiceId}/discount`, { method: 'PATCH', body: JSON.stringify({ discount_type: discountType, discount_value: numericValue }) });
      await onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The invoice discount could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-discount-modal" role="dialog" aria-modal="true" aria-label={current.type === 'none' ? 'Add invoice discount' : 'Edit invoice discount'} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">INVOICE DISCOUNT</p><h2>{current.type === 'none' ? 'Add discount' : 'Edit discount'}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field"><span>Discount type *</span><select value={discountType} onChange={(event) => setDiscountType(event.target.value as Exclude<InvoiceDiscountType, 'none'>)}><option value="percentage">Percentage (%)</option><option value="amount">Fixed amount (₹)</option></select></label><label className="field"><span>{discountType === 'percentage' ? 'Percentage *' : 'Fixed amount *'}</span><input value={value} onChange={(event) => setValue(event.target.value)} type="number" min="0.01" max={discountType === 'percentage' ? 100 : subtotal || undefined} step="0.01" required autoFocus /></label><div className="field field--wide"><span>Discount preview</span><output className="invoice-line-preview invoice-discount-preview"><strong>−{money(discountAmount)}</strong><small>{discountType === 'percentage' ? `${numericValue || 0}% of ${money(subtotal)}` : 'Deducted before GST is calculated'}</small></output></div></div>{error && <p className="form-error">{error}</p>}<p className="invoice-discount-note">Discount is applied before GST. Invoice total, balance and automatic payment status update immediately.</p><div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save discount'}</button></div></form>
  </section></div>;
}

function DeleteInvoiceDiscountDialog({ discount, deleting, error, onClose, onConfirm }: { discount: InvoiceDiscount; deleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-delete-modal" role="dialog" aria-modal="true" aria-label="Remove invoice discount" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">REMOVE DISCOUNT</p><h2>Remove this discount?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={deleting} aria-label="Close"><X size={18} /></button></div>
    <p className="invoice-delete-copy"><strong>{discount.label}</strong> ({money(discount.amount)}) will be removed from this invoice.</p><p className="invoice-delete-note">GST, total, balance and automatic payment status will be recalculated immediately.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={16} /> {deleting ? 'Removing…' : 'Remove discount'}</button></div>
  </section></div>;
}

function InvoiceItemDialog({ invoiceId, item, onClose, onSaved }: { invoiceId: string; item?: PublicRecord; onClose: () => void; onSaved: () => Promise<void> }) {
  const initialUnit = text(item?.fields.unit, INVOICE_UNITS[0]);
  const [label, setLabel] = useState(text(item?.fields.label));
  const [description, setDescription] = useState(text(item?.fields.description));
  const [qty, setQty] = useState(wholeQuantityText(item?.fields.qty));
  const [unit, setUnit] = useState(unitSelection(initialUnit));
  const [customUnit, setCustomUnit] = useState(isPresetInvoiceUnit(initialUnit) ? '' : initialUnit);
  const [rate, setRate] = useState(text(item?.fields.rate, ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(item?.legacyId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const finalUnit = resolvedUnit(unit, customUnit);
    if (!finalUnit) {
      setError('Enter the custom unit name.');
      return;
    }
    const numericQty = wholeQuantityValue(qty);
    if (numericQty === null) {
      setError('Quantity must be a whole number between 1 and 1,000,000.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ label, description: description || null, qty: numericQty, unit: finalUnit, rate: Number(rate) });
      if (item?.legacyId) await api(`/billing/invoices/${invoiceId}/items/${item.legacyId}`, { method: 'PATCH', body });
      else await api(`/billing/invoices/${invoiceId}/items`, { method: 'POST', body });
      await onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : `The invoice item could not be ${isEditing ? 'updated' : 'added'}.`);
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-item-modal" role="dialog" aria-modal="true" aria-label={isEditing ? 'Edit invoice item' : 'Add invoice item'} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">INVOICE LINE ITEM</p><h2>{isEditing ? 'Edit item' : 'Add item'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>Item *</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={255} required autoFocus /></label><label className="field field--wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} /></label><label className="field"><span>Quantity *</span><input value={qty} onChange={(event) => { if (/^\d*$/.test(event.target.value)) setQty(event.target.value); }} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={7} placeholder="e.g. 1" title="Whole numbers only" required /></label><label className="field"><span>Unit *</span><select value={unit} onChange={(event) => setUnit(event.target.value)} required>{INVOICE_UNITS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>{unit === CUSTOM_INVOICE_UNIT && <label className="field"><span>Custom unit *</span><input value={customUnit} onChange={(event) => setCustomUnit(event.target.value)} maxLength={30} required /></label>}<label className="field"><span>Rate *</span><input value={rate} onChange={(event) => setRate(event.target.value)} type="number" min="0" max="100000000" step="0.01" required /></label><label className="field"><span>New line total</span><output className="invoice-line-preview">{money(Number(qty || 0) * Number(rate || 0))}</output></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : isEditing ? 'Save item' : 'Add item'}</button></div></form>
  </section></div>;
}

function DeleteInvoiceItemDialog({ item, deleting, error, onClose, onConfirm }: { item: PublicRecord; deleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal invoice-delete-modal" role="dialog" aria-modal="true" aria-label="Delete invoice item" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">REMOVE LINE ITEM</p><h2>Delete this item?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={deleting} aria-label="Close"><X size={18} /></button></div>
    <p className="invoice-delete-copy"><strong>{displayValue(item.fields.label)}</strong> will be removed from this invoice. The invoice subtotal, GST, balance, and status will be recalculated immediately.</p><p className="invoice-delete-note">The historical item record is archived for traceability; it is not permanently erased.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete item'}</button></div>
  </section></div>;
}

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function companyProfileName(profile: PublicRecord): string {
  const fields = profile.fields;
  return String(fields.legal_name || fields.business_name || fields.brand_name || fields.code || `Billing profile #${profile.legacyId}`);
}

function wholeQuantityText(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return '1';
  return String(Math.min(1_000_000, Math.max(1, Math.round(parsed))));
}

function wholeQuantityValue(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : null;
}

function inputDate(value: unknown): string {
  const candidate = text(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) return candidate.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstPositiveNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function normalizedDiscountType(value: unknown): InvoiceDiscountType {
  const type = text(value).trim().toLowerCase();
  if (type === 'percentage' || type === 'percent' || type === '%') return 'percentage';
  if (type === 'amount' || type === 'fixed' || type === 'fixed_amount' || type === 'flat') return 'amount';
  return 'none';
}

function invoiceDiscount(fields: Record<string, unknown>): InvoiceDiscount {
  const rawType = text(fields.discount_type).trim();
  const explicitType = normalizedDiscountType(rawType);
  const legacyPercentage = firstPositiveNumber(fields.discount_percent, fields.discount_percentage);
  const legacyAmount = firstPositiveNumber(fields.discount_amount);
  const type = rawType
    ? explicitType
    : legacyPercentage > 0 ? 'percentage' : legacyAmount > 0 ? 'amount' : 'none';
  if (type === 'none') return { type, value: 0, amount: 0, label: 'No discount applied' };
  const subtotal = numberValue(fields.subtotal);
  const value = type === 'percentage'
    ? firstPositiveNumber(fields.discount_value, fields.discount_percent, fields.discount_percentage)
    : firstPositiveNumber(fields.discount_value, fields.discount_amount);
  const calculatedAmount = type === 'percentage'
    ? Math.round((subtotal * Math.min(100, value) / 100 + Number.EPSILON) * 100) / 100
    : Math.min(subtotal, value);
  const amount = firstPositiveNumber(fields.discount_amount) || calculatedAmount;
  const label = type === 'percentage'
    ? `${formatDiscountValue(value)}% discount`
    : `${money(value)} fixed discount`;
  return { type, value, amount, label };
}

function formatDiscountValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function paymentModeLabel(value: unknown): string {
  const mode = text(value, 'bank_transfer').trim().toLowerCase();
  return PAYMENT_MODES.find((option) => option.value === mode)?.label
    ?? mode.split(/[_\s-]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

function isAdminOrHrRole(value: string | undefined): boolean {
  return ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource'].includes(String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function isInvoiceNoteManagerRole(value: string | undefined): boolean {
  return isAdminOrHrRole(value) || isCeoRole(value);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value).trim();
    if (candidate) return candidate;
  }
  return '';
}

function issuerBusinessName(fields: Record<string, unknown>): string {
  return firstText(
    fields.business_name,
    fields.legal_name,
    fields.businessName,
    fields.legalName,
    fields.company_name,
    fields.companyName,
    fields.issuer_business_name,
    fields.issuer_name,
    fields.brand_name,
    fields.brandName,
    fields.name,
    fields.code
  );
}

function optionalBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const normalized = String(value).trim().toLowerCase();
    if (value === true || value === 1 || normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'enabled') return true;
    if (value === false || value === 0 || normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'disabled') return false;
  }
  return null;
}

function profileAssetUrl(value: string): string | null {
  const source = value.trim();
  if (!source) return null;
  if (/^(https?:)?\/\//i.test(source) || source.startsWith('/api/uploads/')) return source;
  const legacyPath = source.replace(/^\/+/, '');
  if (legacyPath.startsWith('uploads/') || legacyPath.startsWith('storage/') || legacyPath.startsWith('public/uploads/')) {
    return `/api/uploads/legacy/${legacyPath}`;
  }
  if (legacyPath.startsWith('modern/')) return `/api/uploads/${legacyPath}`;
  return source;
}
