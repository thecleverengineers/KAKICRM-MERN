import { Router } from 'express';
import { requireAuth, requireWhatsAppNumber } from '../middleware/auth.js';
import { loadAttendanceMe } from './attendance.js';
import { loadDashboardSummary } from './dashboard.js';
import { loadNotifications } from './notifications.js';
import { loadTaskList } from './tasks.js';
import { asyncHandler, HttpError } from '../utils/http.js';

export const bootstrapRouter = Router();
bootstrapRouter.use(requireAuth, requireWhatsAppNumber);

bootstrapRouter.get('/', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');

  const startedAt = Date.now();
  const [dashboard, tasks, notifications, attendance] = await Promise.all([
    loadDashboardSummary(req.auth),
    loadTaskList(req.auth, { page: 1, limit: 50, order: 'desc' }),
    loadNotifications(req.auth.legacyId, 1, 100),
    loadAttendanceMe(req.auth.legacyId)
  ]);

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    data: { dashboard, tasks, notifications, attendance }
  });
}));
