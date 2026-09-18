import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { hasCollectionAccess } from '../middleware/rbac.js';
import { listLegacyRecords } from '../services/legacyRepository.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const searchableCollections = [
  ['users', 'Employees', '/data/users'],
  ['employees', 'Employee records', '/data/employees'],
  ['departments', 'Department', '/data/departments'],
  ['department_projects', 'Project', '/projects'],
  ['tasks', 'Task', '/tasks'],
  ['clients', 'Client', '/data/clients'],
  ['invoices', 'Invoice', '/invoices'],
  ['meetings', 'Meeting', '/data/meetings'],
  ['leave_requests', 'Leave request', '/leave'],
  ['billing_profiles', 'Billing profile', '/data/billing_profiles'],
  ['payments', 'Payment', '/data/payments'],
  ['drive_items', 'Drive item', '/data/drive_items']
] as const;

const searchFields = ['name', 'title', 'description', 'email', 'phone', 'status', 'code', 'legal_name', 'invoice_no', 'client_name', 'company', 'subject', 'body', 'role', 'designation', 'reference'];

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get('/', asyncHandler(async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (query.length < 2) throw new HttpError(400, 'Enter at least two characters to search.');
  const mode = req.query.mode === 'all' ? 'all' : 'any';
  const selected = new Set(String(req.query.collections ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const results = (await Promise.all(searchableCollections
    .filter(([collection]) => !selected.size || selected.has(collection))
    .filter(([collection]) => hasCollectionAccess(req, collection, 'read'))
    .map(async ([collection, kind, basePath]) => {
      const result = await listLegacyRecords(collection, { page: 1, limit: 8, search: query, searchMode: mode, searchFields });
      return result.data.map((record) => ({
        id: `${collection}:${record.legacyId ?? record.id}`,
        kind,
        label: String(record.fields.name ?? record.fields.title ?? record.fields.invoice_no ?? record.fields.code ?? `${kind} #${record.legacyId ?? ''}`),
        detail: String(record.fields.email ?? record.fields.status ?? record.fields.description ?? record.fields.company ?? '').trim(),
        href: buildHref(collection, basePath, record.legacyId)
      }));
    }))).flat().slice(0, 50);
  res.json({ data: results, query, mode });
}));

function buildHref(collection: string, basePath: string, legacyId: number | null): string {
  if (!legacyId) return basePath;
  if (collection === 'users') return `/data/users/${legacyId}`;
  if (collection === 'tasks') return `/tasks/${legacyId}`;
  if (collection === 'department_projects' || collection === 'projects') return `/projects/${legacyId}`;
  if (collection === 'invoices') return `/invoices/${legacyId}`;
  if (collection === 'leave_requests') return `/leave/${legacyId}`;
  if (collection === 'meetings') return `/data/meetings/${legacyId}`;
  return `${basePath}/${legacyId}`;
}
