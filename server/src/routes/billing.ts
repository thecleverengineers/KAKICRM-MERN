import { Router, type NextFunction, type Request, type Response } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import type { FilterQuery } from 'mongoose';
import { z } from 'zod';
import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  archiveLegacyRecord,
  createLegacyRecord,
  findLegacyRecord,
  listLegacyRecords,
  listRawRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { persistIncomingFile, storedAssetUrl } from '../services/storage.js';
import { canManageInvoiceSettlement, canViewInvoices, isAdminOrHrRole, isCeoRole } from '../services/permissions.js';

const profileImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const invoiceSearchFields = ['invoice_no', 'status', 'remarks', 'notes'];
const MAX_INVOICE_EXPORT_ROWS = 25_000;

const itemSchema = z.object({
  label: z.string().trim().min(1).max(255),
  description: z.string().max(5_000).optional().nullable(),
  qty: z.coerce.number().int().min(1).max(1_000_000).default(1),
  unit: z.string().trim().min(1).max(30).default('Piece (PCS)'),
  rate: z.coerce.number().min(0).max(100_000_000)
});

const invoiceSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  client_project_id: z.coerce.number().int().positive().optional().nullable(),
  maintenance_id: z.coerce.number().int().positive().optional().nullable(),
  billing_profile_id: z.coerce.number().int().positive(),
  invoice_type: z.string().trim().max(50).default('standard'),
  issue_date: z.string().min(8).max(30),
  due_date: z.string().min(8).max(30).optional().nullable(),
  gst_enabled: z.coerce.boolean().default(false),
  gst_percent: z.coerce.number().min(0).max(100).default(18),
  discount_type: z.enum(['none', 'percentage', 'amount']).default('none'),
  discount_value: z.coerce.number().min(0).default(0),
  notes: z.string().max(10_000).optional().nullable(),
  items: z.array(itemSchema).min(1).max(250)
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  payment_date: z.string().min(8).max(30),
  mode: z.string().trim().max(100).default('bank_transfer'),
  reference: z.string().max(255).optional().nullable(),
  note: z.string().max(2_000).optional().nullable()
});

const discountSchema = z.object({
  discount_type: z.enum(['percentage', 'amount']),
  discount_value: z.coerce.number().positive().max(100_000_000)
}).superRefine((input, context) => {
  if (input.discount_type === 'percentage' && input.discount_value > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['discount_value'], message: 'Percentage discount cannot exceed 100%.' });
  }
});

const invoiceNoteSchema = z.object({
  note: z.string().trim().min(1, 'Invoice note cannot be empty.').max(10_000)
});

const billingProfileChangeSchema = z.object({
  billing_profile_id: z.coerce.number().int().positive()
});

export const billingRouter = Router();
billingRouter.use(requireAuth);

billingRouter.post('/profiles/:profileId/logo', requirePermission('billing.manage'), profileImageUpload.single('logo'), asyncHandler(async (req, res) => {
  const profileId = billingProfileId(req.params.profileId);
  const profile = await findLegacyRecord('billing_profiles', profileId);
  if (!profile) throw new HttpError(404, 'Company profile not found.');
  const file = req.file;
  if (!file) throw new HttpError(400, 'Select a logo image to upload.');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
    throw new HttpError(400, 'Upload a PNG, JPG, WEBP, or SVG logo.');
  }
  const saved = await persistIncomingFile(file, 'billing-profile-logos');
  const updated = await updateLegacyRecord('billing_profiles', profileId, {
    logo_url: storedAssetUrl(saved.relativePath),
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Company profile not found.');
  res.status(201).json({ data: toPublicRecord(updated) });
}));

// Authority signatures belong to the company profile rather than the invoice.
// This lets the same selected profile keep a consistent signature everywhere it
// is used, including already-created invoices and their printable PDF view.
billingRouter.post('/profiles/:profileId/signature', requirePermission('billing.manage'), profileImageUpload.single('signature'), asyncHandler(async (req, res) => {
  const profileId = billingProfileId(req.params.profileId);
  const profile = await findLegacyRecord('billing_profiles', profileId);
  if (!profile) throw new HttpError(404, 'Company profile not found.');
  const file = req.file;
  if (!file) throw new HttpError(400, 'Select a signature image to upload.');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
    throw new HttpError(400, 'Upload a PNG, JPG, WEBP, or SVG signature.');
  }
  const saved = await persistIncomingFile(file, 'billing-profile-signatures');
  const updated = await updateLegacyRecord('billing_profiles', profileId, {
    signature_url: storedAssetUrl(saved.relativePath),
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Company profile not found.');
  res.status(201).json({ data: toPublicRecord(updated) });
}));

billingRouter.post('/profiles/:profileId/qr-primary', requirePermission('billing.manage'), profileImageUpload.single('qr_primary'), asyncHandler(async (req, res) => {
  const updated = await saveProfileImageAsset(req.params.profileId, req.file, 'qr-primary', 'qr_code_primary_url', 'QR Code Primary');
  res.status(201).json({ data: toPublicRecord(updated) });
}));

billingRouter.post('/profiles/:profileId/qr-secondary', requirePermission('billing.manage'), profileImageUpload.single('qr_secondary'), asyncHandler(async (req, res) => {
  const updated = await saveProfileImageAsset(req.params.profileId, req.file, 'qr-secondary', 'qr_code_secondary_url', 'QR Code Secondary');
  res.status(201).json({ data: toPublicRecord(updated) });
}));

billingRouter.get('/invoices', requireInvoiceView, asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('invoices', {
    page: positive(req.query.page, 1),
    limit: positive(req.query.limit, 50),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    searchFields: invoiceSearchFields,
    sort: typeof req.query.sort === 'string' ? req.query.sort : 'issue_date',
    order: req.query.order === 'asc' ? 'asc' : 'desc'
  });
  res.json(result);
}));

billingRouter.get('/invoices/export', requireInvoiceView, asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const exportScope = req.query.export_scope === 'filtered' ? 'filtered' : 'all';
  const fromDate = invoiceExportDate(req.query.from_date, 'From date');
  const toDate = invoiceExportDate(req.query.to_date, 'To date');
  if (fromDate && toDate && fromDate > toDate) throw new HttpError(400, 'From date cannot be later than To date.');
  const issueDateFilter: Record<string, string> = {};
  if (fromDate) issueDateFilter.$gte = fromDate;
  if (toDate) issueDateFilter.$lte = toDate;
  const scope: FilterQuery<LegacyRecord> | undefined = Object.keys(issueDateFilter).length
    ? { 'raw.issue_date': issueDateFilter }
    : undefined;
  const firstPage = await listLegacyRecords('invoices', {
    page: 1,
    limit: 100,
    search: search || undefined,
    searchFields: invoiceSearchFields,
    sort: 'issue_date',
    order: 'desc',
    scope
  });
  if (firstPage.pagination.total > MAX_INVOICE_EXPORT_ROWS) {
    throw new HttpError(413, `Export is limited to ${MAX_INVOICE_EXPORT_ROWS.toLocaleString()} invoices. Refine the search and try again.`);
  }

  const records = [...firstPage.data];
  for (let page = 2; page <= firstPage.pagination.pages; page += 1) {
    const result = await listLegacyRecords('invoices', {
      page,
      limit: 100,
      search: search || undefined,
      searchFields: invoiceSearchFields,
      sort: 'issue_date',
      order: 'desc',
      scope
    });
    records.push(...result.data);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KAKI CRM';
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheet = workbook.addWorksheet('Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Invoice No', key: 'invoiceNo', width: 18 },
    { header: 'Client', key: 'client', width: 30 },
    { header: 'Issue Date', key: 'issueDate', width: 15 },
    { header: 'Due Date', key: 'dueDate', width: 15 },
    { header: 'Subtotal', key: 'subtotal', width: 14 },
    { header: 'GST', key: 'gst', width: 14 },
    { header: 'Discount', key: 'discount', width: 14 },
    { header: 'Total Amount', key: 'totalAmount', width: 16 },
    { header: 'Paid Amount', key: 'paidAmount', width: 16 },
    { header: 'Balance Amount', key: 'balanceAmount', width: 18 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Invoice Type', key: 'invoiceType', width: 16 },
    { header: 'Notes', key: 'notes', width: 42 }
  ];
  for (const record of records) {
    const fields = record.fields;
    sheet.addRow({
      invoiceNo: textValue(fields.invoice_no),
      client: record.relationLabels?.client_id ?? textValue(fields.client_id),
      issueDate: textValue(fields.issue_date),
      dueDate: textValue(fields.due_date),
      subtotal: numericValue(fields.subtotal),
      gst: numericValue(fields.gst_amount),
      discount: numericValue(fields.discount_amount),
      totalAmount: numericValue(fields.total_amount),
      paidAmount: numericValue(fields.paid_amount),
      balanceAmount: numericValue(fields.balance_amount),
      status: textValue(fields.status),
      invoiceType: textValue(fields.invoice_type),
      notes: textValue(fields.notes ?? fields.remarks)
    });
  }
  styleInvoiceWorksheet(sheet);

  const workbookBuffer = await workbook.xlsx.writeBuffer();
  const dateLabel = fromDate || toDate ? `${fromDate ?? 'start'}-to-${toDate ?? 'end'}` : todayIst();
  const fileName = `kaki-invoices-${exportScope}-${dateLabel}.xlsx`;
  res.status(200)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    .send(Buffer.from(workbookBuffer));
}));

billingRouter.post('/invoices', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const input = invoiceSchema.parse(req.body);
  const billingProfile = await findLegacyRecord('billing_profiles', input.billing_profile_id);
  if (!billingProfile) throw new HttpError(404, 'Select an active company profile before creating an invoice.');
  const invoiceNo = await nextInvoiceNo(input.issue_date);
  const totals = calculateTotals(input.items, input.gst_enabled, input.gst_percent, input.discount_type, input.discount_value);
  const invoice = await createLegacyRecord('invoices', {
    invoice_no: invoiceNo,
    client_id: input.client_id,
    client_project_id: input.client_project_id ?? null,
    maintenance_id: input.maintenance_id ?? null,
    billing_profile_id: input.billing_profile_id,
    invoice_type: input.invoice_type,
    issue_date: input.issue_date,
    due_date: input.due_date ?? null,
    gst_enabled: input.gst_enabled ? 1 : 0,
    gst_percent: input.gst_percent,
    discount_type: input.discount_type,
    discount_percentage: input.discount_type === 'percentage' ? input.discount_value : 0,
    discount_percent: input.discount_type === 'percentage' ? input.discount_value : 0,
    discount_value: input.discount_value,
    discount_amount: totals.discountAmount,
    subtotal: totals.subtotal,
    gst_amount: totals.gstAmount,
    total_amount: totals.totalAmount,
    paid_amount: 0,
    balance_amount: totals.totalAmount,
    status: 'draft',
    status_is_manual: 0,
    notes: input.notes ?? null,
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  await Promise.all(input.items.map((item) => createLegacyRecord('invoice_items_new', {
    invoice_id: invoice.legacyId,
    label: item.label,
    description: item.description ?? null,
    qty: item.qty,
    unit: item.unit,
    rate: item.rate,
    amount: roundMoney(item.qty * item.rate),
    created_at: nowIst()
  })));
  res.status(201).json(await invoiceDetail(invoice.legacyId!));
}));

billingRouter.get('/invoices/:invoiceId', requireInvoiceView, asyncHandler(async (req, res) => {
  res.json(await invoiceDetail(invoiceId(req.params.invoiceId)));
}));

// Changing the issuer on an existing invoice only updates that invoice's
// reference. The selected billing profile itself is never edited, so its
// logo, signature, QR settings, GST and bank configuration remain intact.
billingRouter.patch('/invoices/:invoiceId/billing-profile', requireInvoiceBillingProfileChange, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const input = billingProfileChangeSchema.parse(req.body);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const profile = await findLegacyRecord('billing_profiles', input.billing_profile_id);
  if (!profile) throw new HttpError(404, 'Select an active billing profile.');
  const currentProfileId = Number(invoice.raw.billing_profile_id);
  if (currentProfileId === input.billing_profile_id) {
    res.json(await invoiceDetail(id));
    return;
  }
  const updated = await updateLegacyRecord('invoices', id, {
    billing_profile_id: input.billing_profile_id,
    billing_profile_previous_id: Number.isSafeInteger(currentProfileId) && currentProfileId > 0 ? currentProfileId : null,
    billing_profile_changed_by: req.auth!.legacyId,
    billing_profile_changed_at: nowIst(),
    updated_by: req.auth!.legacyId,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Invoice not found.');
  res.json(await invoiceDetail(id));
}));

billingRouter.patch('/invoices/:invoiceId/note', requireInvoiceNoteManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const input = invoiceNoteSchema.parse(req.body);
  const now = nowIst();
  const updated = await updateLegacyRecord('invoices', id, {
    notes: input.note,
    notes_updated_by: req.auth!.legacyId,
    notes_updated_at: now,
    updated_by: req.auth!.legacyId,
    updated_at: now
  });
  if (!updated) throw new HttpError(404, 'Invoice not found.');
  res.json(await invoiceDetail(id));
}));

billingRouter.delete('/invoices/:invoiceId/note', requireInvoiceNoteManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const now = nowIst();
  const updated = await updateLegacyRecord('invoices', id, {
    notes: null,
    notes_deleted_by: req.auth!.legacyId,
    notes_deleted_at: now,
    updated_by: req.auth!.legacyId,
    updated_at: now
  });
  if (!updated) throw new HttpError(404, 'Invoice not found.');
  res.status(204).send();
}));

billingRouter.patch('/invoices/:invoiceId/status', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const input = z.object({ status: z.enum(['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled']) }).parse(req.body);
  const invoice = await updateLegacyRecord('invoices', invoiceId(req.params.invoiceId), { status: input.status, status_is_manual: 1, updated_at: nowIst() });
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  res.json({ data: toPublicRecord(invoice) });
}));

billingRouter.post('/invoices/:invoiceId/items', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const item = itemSchema.parse(req.body);
  await createLegacyRecord('invoice_items_new', {
    invoice_id: id,
    label: item.label,
    description: item.description ?? null,
    qty: item.qty,
    unit: item.unit,
    rate: item.rate,
    amount: roundMoney(item.qty * item.rate),
    created_at: nowIst()
  });
  await recalculateInvoice(id);
  res.status(201).json(await invoiceDetail(id));
}));

billingRouter.patch('/invoices/:invoiceId/items/:itemId', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const invoiceValue = invoiceId(req.params.invoiceId);
  const itemValue = invoiceId(req.params.itemId);
  const invoice = await findLegacyRecord('invoices', invoiceValue);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');

  const [existing] = await listRawRecords('invoice_items_new', { legacyId: itemValue, 'raw.invoice_id': invoiceValue }, 1);
  if (!existing) throw new HttpError(404, 'Invoice line item not found.');
  const item = itemSchema.parse(req.body);
  const updated = await updateLegacyRecord('invoice_items_new', itemValue, {
    label: item.label,
    description: item.description ?? null,
    qty: item.qty,
    unit: item.unit,
    rate: item.rate,
    amount: roundMoney(item.qty * item.rate),
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Invoice line item not found.');
  await recalculateInvoice(invoiceValue);
  res.json(await invoiceDetail(invoiceValue));
}));

billingRouter.delete('/invoices/:invoiceId/items/:itemId', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const invoiceValue = invoiceId(req.params.invoiceId);
  const itemId = invoiceId(req.params.itemId);
  const items = await listRawRecords('invoice_items_new', { legacyId: itemId, 'raw.invoice_id': invoiceValue }, 1);
  if (!items.length) throw new HttpError(404, 'Invoice line item not found.');
  await archiveLegacyRecord('invoice_items_new', itemId);
  await recalculateInvoice(invoiceValue);
  res.status(204).send();
}));

billingRouter.post('/invoices/:invoiceId/payments', requireInvoiceSettlementManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  if (String(invoice.raw.status).toLowerCase() === 'cancelled') throw new HttpError(409, 'A cancelled invoice cannot receive a payment.');
  const input = paymentSchema.parse(req.body);
  const capacity = await paymentCapacity(id);
  assertPaymentFits(input.amount, capacity.remaining);
  await createLegacyRecord('payments', {
    invoice_id: id,
    client_id: invoice.raw.client_id,
    client_project_id: invoice.raw.client_project_id ?? null,
    amount: input.amount,
    payment_date: input.payment_date,
    mode: input.mode,
    reference: input.reference ?? null,
    note: input.note ?? null,
    payment_type: input.amount < capacity.remaining ? 'partial' : 'final',
    balance_before: capacity.remaining,
    balance_after: roundMoney(capacity.remaining - input.amount),
    received_by: req.auth!.legacyId,
    created_at: nowIst()
  });
  await recalculateInvoice(id);
  res.status(201).json(await invoiceDetail(id));
}));

billingRouter.patch('/invoices/:invoiceId/payments/:paymentId', requireInvoiceSettlementManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const paymentId = paymentRecordId(req.params.paymentId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  if (String(invoice.raw.status).toLowerCase() === 'cancelled') throw new HttpError(409, 'A cancelled invoice cannot have payments changed.');
  const [existing] = await listRawRecords('payments', { legacyId: paymentId, 'raw.invoice_id': id }, 1);
  if (!existing) throw new HttpError(404, 'Payment record not found for this invoice.');
  const input = paymentSchema.parse(req.body);
  const capacity = await paymentCapacity(id, paymentId);
  assertPaymentFits(input.amount, capacity.remaining);
  const updated = await updateLegacyRecord('payments', paymentId, {
    amount: input.amount,
    payment_date: input.payment_date,
    mode: input.mode,
    reference: input.reference ?? null,
    note: input.note ?? null,
    payment_type: input.amount < capacity.remaining ? 'partial' : 'final',
    balance_before: capacity.remaining,
    balance_after: roundMoney(capacity.remaining - input.amount),
    updated_by: req.auth!.legacyId,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Payment record not found.');
  await recalculateInvoice(id);
  res.json(await invoiceDetail(id));
}));

billingRouter.delete('/invoices/:invoiceId/payments/:paymentId', requireInvoiceSettlementManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const paymentId = paymentRecordId(req.params.paymentId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const [existing] = await listRawRecords('payments', { legacyId: paymentId, 'raw.invoice_id': id }, 1);
  if (!existing) throw new HttpError(404, 'Payment record not found for this invoice.');
  await archiveLegacyRecord('payments', paymentId);
  await recalculateInvoice(id);
  res.status(204).send();
}));

billingRouter.patch('/invoices/:invoiceId/discount', requireInvoiceSettlementManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const input = discountSchema.parse(req.body);
  const items = await listRawRecords('invoice_items_new', { 'raw.invoice_id': id }, 1_000);
  const subtotal = roundMoney(items.reduce((sum, item) => sum + money(item.raw.qty) * money(item.raw.rate), 0));
  if (input.discount_type === 'amount' && input.discount_value > subtotal) {
    throw new HttpError(400, `Fixed discount cannot exceed the invoice subtotal of ${subtotal.toFixed(2)}.`);
  }
  const [payments] = await Promise.all([listRawRecords('payments', { 'raw.invoice_id': id }, 1_000)]);
  const proposedTotals = calculateTotals(
    items.map((item) => ({ qty: money(item.raw.qty), rate: money(item.raw.rate) })),
    Boolean(Number(invoice.raw.gst_enabled)),
    money(invoice.raw.gst_percent) || money(invoice.raw.gst_rate) || 0,
    input.discount_type,
    input.discount_value
  );
  const alreadyPaid = roundMoney(payments.reduce((sum, payment) => sum + money(payment.raw.amount), 0));
  if (alreadyPaid > proposedTotals.totalAmount) {
    throw new HttpError(400, `This discount would reduce the invoice below the ${alreadyPaid.toFixed(2)} already received from the client.`);
  }
  const updated = await updateLegacyRecord('invoices', id, {
    discount_type: input.discount_type,
    discount_value: input.discount_value,
    discount_percentage: input.discount_type === 'percentage' ? input.discount_value : 0,
    discount_percent: input.discount_type === 'percentage' ? input.discount_value : 0,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Invoice not found.');
  await recalculateInvoice(id);
  res.json(await invoiceDetail(id));
}));

billingRouter.delete('/invoices/:invoiceId/discount', requireInvoiceSettlementManage, asyncHandler(async (req, res) => {
  const id = invoiceId(req.params.invoiceId);
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const updated = await updateLegacyRecord('invoices', id, {
    discount_type: 'none',
    discount_value: 0,
    discount_percentage: 0,
    discount_percent: 0,
    discount_amount: 0,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Invoice not found.');
  await recalculateInvoice(id);
  res.status(204).send();
}));

billingRouter.post('/maintenance/:contractId/generate-invoice', requirePermission('billing.manage'), asyncHandler(async (req, res) => {
  const contractId = invoiceId(req.params.contractId);
  const contract = await findLegacyRecord('maintenance_contracts', contractId)
    ?? await findLegacyRecord('client_maintenance_contracts', contractId);
  if (!contract) throw new HttpError(404, 'Maintenance contract not found.');
  const raw = contract.raw;
  const rate = money(raw.monthly_fee);
  if (!rate) throw new HttpError(400, 'This maintenance contract has no monthly fee.');
  const issueDate = todayIst();
  const invoice = await createLegacyRecord('invoices', {
    invoice_no: await nextInvoiceNo(issueDate),
    client_id: raw.client_id,
    maintenance_id: contract.legacyId,
    billing_profile_id: raw.billing_profile_id ?? null,
    invoice_type: 'maintenance',
    issue_date: issueDate,
    due_date: issueDate,
    gst_enabled: Number(raw.gst_enabled) ? 1 : 0,
    gst_percent: money(raw.gst_rate) || 18,
    subtotal: rate,
    gst_amount: 0,
    total_amount: rate,
    paid_amount: 0,
    balance_amount: rate,
    status: 'draft',
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  await createLegacyRecord('invoice_items_new', {
    invoice_id: invoice.legacyId,
    label: String(raw.title ?? 'Maintenance service'),
    description: raw.notes ?? null,
    qty: 1,
    unit: 'month',
    rate,
    amount: rate,
    created_at: nowIst()
  });
  await recalculateInvoice(invoice.legacyId!);
  res.status(201).json(await invoiceDetail(invoice.legacyId!));
}));

async function invoiceDetail(id: number): Promise<Record<string, unknown>> {
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const clientId = Number(invoice.raw.client_id);
  const profileId = Number(invoice.raw.billing_profile_id);
  const [items, payments, clients, profiles] = await Promise.all([
    listRawRecords('invoice_items_new', { 'raw.invoice_id': id }, 500),
    listRawRecords('payments', { 'raw.invoice_id': id }, 500),
    clientId ? listRawRecords('clients', { legacyId: clientId }, 1) : [],
    profileId ? listRawRecords('billing_profiles', { legacyId: profileId }, 1) : []
  ]);
  return {
    data: toPublicRecord(invoice),
    items: items.map(toPublicRecord),
    payments: payments.map(toPublicRecord),
    client: clients[0] ? toPublicRecord(clients[0]) : null,
    billingProfile: profiles[0] ? toPublicRecord(profiles[0]) : null
  };
}

async function saveProfileImageAsset(
  profileIdValue: string | string[] | undefined,
  file: Express.Multer.File | undefined,
  directory: string,
  field: string,
  label: string
): Promise<LegacyRecord> {
  const profileId = billingProfileId(profileIdValue);
  const profile = await findLegacyRecord('billing_profiles', profileId);
  if (!profile) throw new HttpError(404, 'Company profile not found.');
  if (!file) throw new HttpError(400, `Select a ${label.toLowerCase()} image to upload.`);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
    throw new HttpError(400, `Upload a PNG, JPG, WEBP, or SVG ${label.toLowerCase()} image.`);
  }
  const saved = await persistIncomingFile(file, `billing-profile-${directory}`);
  const updated = await updateLegacyRecord('billing_profiles', profileId, {
    [field]: storedAssetUrl(saved.relativePath),
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Company profile not found.');
  return updated;
}

async function recalculateInvoice(id: number): Promise<void> {
  const invoice = await findLegacyRecord('invoices', id);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const [items, payments] = await Promise.all([
    listRawRecords('invoice_items_new', { 'raw.invoice_id': id }, 1_000),
    listRawRecords('payments', { 'raw.invoice_id': id }, 1_000)
  ]);
  const normalizedItems = items.map((item) => ({ qty: money(item.raw.qty) || 0, rate: money(item.raw.rate) || 0 }));
  const discount = discountForInvoice(invoice.raw);
  const totals = calculateTotals(
    normalizedItems,
    Boolean(Number(invoice.raw.gst_enabled)),
    money(invoice.raw.gst_percent) || money(invoice.raw.gst_rate) || 0,
    discount.type,
    discount.value
  );
  const paidAmount = roundMoney(payments.reduce((sum, payment) => sum + money(payment.raw.amount), 0));
  const balanceAmount = Math.max(0, roundMoney(totals.totalAmount - paidAmount));
  const wasCancelled = String(invoice.raw.status).toLowerCase() === 'cancelled';
  const status = wasCancelled ? 'cancelled' : (balanceAmount === 0 ? 'paid' : paidAmount > 0 ? 'partial' : invoice.raw.status === 'draft' ? 'draft' : 'sent');
  await updateLegacyRecord('invoices', id, {
    subtotal: totals.subtotal,
    discount_amount: totals.discountAmount,
    gst_amount: totals.gstAmount,
    total_amount: totals.totalAmount,
    paid_amount: paidAmount,
    balance_amount: balanceAmount,
    status,
    status_is_manual: wasCancelled ? 1 : 0,
    updated_at: nowIst()
  });
}

async function paymentCapacity(invoiceIdValue: number, excludePaymentId?: number): Promise<{ total: number; paid: number; remaining: number }> {
  const invoice = await findLegacyRecord('invoices', invoiceIdValue);
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  const [items, payments] = await Promise.all([
    listRawRecords('invoice_items_new', { 'raw.invoice_id': invoiceIdValue }, 1_000),
    listRawRecords('payments', { 'raw.invoice_id': invoiceIdValue }, 1_000)
  ]);
  const discount = discountForInvoice(invoice.raw);
  const totals = calculateTotals(
    items.map((item) => ({ qty: money(item.raw.qty), rate: money(item.raw.rate) })),
    Boolean(Number(invoice.raw.gst_enabled)),
    money(invoice.raw.gst_percent) || money(invoice.raw.gst_rate) || 0,
    discount.type,
    discount.value
  );
  const paid = roundMoney(payments
    .filter((payment) => payment.legacyId !== excludePaymentId)
    .reduce((sum, payment) => sum + money(payment.raw.amount), 0));
  return { total: totals.totalAmount, paid, remaining: Math.max(0, roundMoney(totals.totalAmount - paid)) };
}

function assertPaymentFits(amount: number, remaining: number): void {
  if (remaining <= 0) throw new HttpError(409, 'This invoice is already fully paid.');
  if (roundMoney(amount) > remaining) {
    throw new HttpError(400, `Payment cannot exceed the remaining invoice balance of ${remaining.toFixed(2)}.`);
  }
}

function calculateTotals(
  items: Array<{ qty: number; rate: number }>,
  gstEnabled: boolean,
  gstPercent: number,
  discountType: 'none' | 'percentage' | 'amount',
  discountValue: number
) {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + money(item.qty) * money(item.rate), 0));
  const discountAmount = discountType === 'percentage'
    ? roundMoney(subtotal * Math.min(100, Math.max(0, discountValue)) / 100)
    : discountType === 'amount' ? Math.min(subtotal, roundMoney(discountValue)) : 0;
  const taxableAmount = roundMoney(subtotal - discountAmount);
  const gstAmount = gstEnabled ? roundMoney(taxableAmount * Math.min(100, Math.max(0, gstPercent)) / 100) : 0;
  return { subtotal, discountAmount, gstAmount, totalAmount: roundMoney(taxableAmount + gstAmount) };
}

async function nextInvoiceNo(issueDate: string): Promise<string> {
  const date = new Date(`${issueDate}T00:00:00+05:30`);
  const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const existing = await listRawRecords('invoices', { 'raw.invoice_no': new RegExp(`^INV-${yearMonth}-`, 'i') }, 10_000);
  return `INV-${yearMonth}-${String(existing.length + 1).padStart(3, '0')}`;
}

function billingProfileId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid company profile ID.');
  return parsed;
}

function normalizeDiscountType(value: unknown): 'none' | 'percentage' | 'amount' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'percentage' || normalized === 'percent' || normalized === '%') return 'percentage';
  if (normalized === 'amount' || normalized === 'fixed' || normalized === 'fixed_amount' || normalized === 'flat') return 'amount';
  return 'none';
}

/**
 * Older SQL imports used percentage, percent or amount-only fields. Preserve
 * those discounts whenever a payment or line item causes an invoice to be
 * recalculated, while treating an explicit `none` as an intentional removal.
 */
function discountForInvoice(raw: Record<string, unknown>): { type: 'none' | 'percentage' | 'amount'; value: number } {
  const rawType = String(raw.discount_type ?? '').trim();
  const explicitType = normalizeDiscountType(rawType);
  const percentageValue = money(raw.discount_value) || money(raw.discount_percent) || money(raw.discount_percentage) || 0;
  const amountValue = money(raw.discount_value) || money(raw.discount_amount) || 0;

  if (rawType) {
    if (explicitType === 'percentage') return { type: 'percentage', value: percentageValue };
    if (explicitType === 'amount') return { type: 'amount', value: amountValue };
    return { type: 'none', value: 0 };
  }

  const legacyPercentage = money(raw.discount_percent) || money(raw.discount_percentage) || 0;
  if (legacyPercentage > 0) return { type: 'percentage', value: legacyPercentage };
  const legacyAmount = money(raw.discount_amount) || 0;
  return legacyAmount > 0 ? { type: 'amount', value: legacyAmount } : { type: 'none', value: 0 };
}

function paymentRecordId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid payment record ID.');
  return parsed;
}

function invoiceId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid invoice ID.');
  return parsed;
}

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function invoiceExportDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, `${label} must use YYYY-MM-DD format.`);
  return date;
}

function money(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date());
}

function requireInvoiceView(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!canViewInvoices(req.auth)) {
    res.status(403).json({ error: 'Only authorised finance, admin, or HR users can view invoices.' });
    return;
  }
  next();
}

function styleInvoiceWorksheet(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5EA8' } };
  header.height = 24;
  sheet.autoFilter = { from: 'A1', to: `M${Math.max(1, sheet.rowCount)}` };
  for (const column of ['E', 'F', 'G', 'H', 'I', 'J']) {
    sheet.getColumn(column).numFmt = '#,##0.00';
  }
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    sheet.getRow(row).alignment = { vertical: 'top', wrapText: true };
  }
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function requireInvoiceSettlementManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!canManageInvoiceSettlement(req.auth)) {
    res.status(403).json({ error: 'Only administrators or HR users can manage invoice payments and discounts.' });
    return;
  }
  next();
}

function requireInvoiceBillingProfileChange(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!isAdminOrHrRole(req.auth) && !isCeoRole(req.auth)) {
    res.status(403).json({ error: 'Only Admin, HR, or CEO users can change an invoice billing profile.' });
    return;
  }
  next();
}

function requireInvoiceNoteManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!isAdminOrHrRole(req.auth) && !isCeoRole(req.auth)) {
    res.status(403).json({ error: 'Only Admin, HR, or CEO users can manage invoice notes.' });
    return;
  }
  next();
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
