import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/mongoose.js';
import { errorHandler, notFound } from './utils/http.js';
import { configureRealtime } from './realtime.js';
import { authRouter } from './routes/auth.js';
import { attendanceRouter } from './routes/attendance.js';
import { backupsRouter } from './routes/backups.js';
import { billingRouter } from './routes/billing.js';
import { calendarRouter } from './routes/calendar.js';
import { ceoRouter } from './routes/ceo.js';
import { dashboardRouter } from './routes/dashboard.js';
import { driveRouter } from './routes/drive.js';
import { employeesRouter } from './routes/employees.js';
import { leaveRouter } from './routes/leave.js';
import { googleIntegrationRouter, meetingsRouter } from './routes/meetings.js';
import { messengerRouter } from './routes/messenger.js';
import { notificationsRouter } from './routes/notifications.js';
import { payrollRouter } from './routes/payroll.js';
import { projectsRouter } from './routes/projects.js';
import { recordsRouter } from './routes/records.js';
import { recruitmentRouter } from './routes/recruitment.js';
import { remoteWorkRouter } from './routes/remoteWork.js';
import { settingsRouter } from './routes/settings.js';
import { tasksRouter } from './routes/tasks.js';
import { teamsRouter } from './routes/teams.js';
import { uploadsRouter } from './routes/uploads.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();
const httpServer = createServer(app);
const allowedOrigins = env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
const usesHttpsPublicOrigin = allowedOrigins.some((origin) => origin.startsWith('https://'));
const io = new SocketServer(httpServer, { cors: { origin: allowedOrigins, credentials: false } });

app.disable('x-powered-by');
// The public HTTPS domain terminates TLS at Nginx before forwarding locally.
app.set('trust proxy', 1);
app.use((req, _res, next) => {
  req.requestId = crypto.randomUUID();
  next();
});
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      // Direct development IP/port sessions remain usable, while the live
      // HTTPS domain asks browsers to keep all subrequests on HTTPS.
      'upgrade-insecure-requests': usesHttpsPublicOrigin ? [] : null
    }
  }
}));
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'kaki-crm-api', time: new Date().toISOString() }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false }), authRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/records', recordsRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/ceo', ceoRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/leave', leaveRouter);
app.use('/api/integrations/google', googleIntegrationRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/recruitment', recruitmentRouter);
app.use('/api/drive', driveRouter);
app.use('/api/remote-work', remoteWorkRouter);
app.use('/api/payroll', payrollRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/messenger', messengerRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/webhooks', webhooksRouter);

const clientBuild = path.resolve(process.cwd(), 'dist/client');
if (env.NODE_ENV === 'production' && existsSync(clientBuild)) {
  app.use(express.static(clientBuild, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(clientBuild, 'index.html')));
}

app.use(notFound);
app.use(errorHandler);

async function start(): Promise<void> {
  await mkdir(env.uploadRoot, { recursive: true });
  await connectDatabase();
  configureRealtime(io);
  httpServer.listen(env.PORT, env.HOST, () => {
    console.log(`KAKI CRM API listening on http://${env.HOST}:${env.PORT}`);
  });
}

async function stop(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

void start().catch((error: unknown) => {
  console.error('Unable to start KAKI CRM API:', error);
  process.exit(1);
});
