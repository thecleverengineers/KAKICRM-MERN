import jwt from 'jsonwebtoken';
import type { Server } from 'socket.io';
import { env } from './config/env.js';
import { buildAuthContext, can, resolveUserByRecordId } from './services/permissions.js';

let io: Server | null = null;

export function configureRealtime(server: Server): void {
  io = server;

  server.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== 'string') return next(new Error('Authentication required'));
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
      const recordId = String(payload.sub ?? '');
      const user = await resolveUserByRecordId(recordId);
      if (!user) return next(new Error('Invalid session'));
      const auth = await buildAuthContext(user);
      socket.data.userRecordId = recordId;
      socket.data.userLegacyId = auth.legacyId;
      socket.data.canViewWorkforce = can(auth, 'attendance.view');
      next();
    } catch {
      next(new Error('Invalid session'));
    }
  });

  server.on('connection', (socket) => {
    const user = String(socket.data.userRecordId ?? '');
    if (user) socket.join(`user-record:${user}`);
    const legacyId = Number(socket.data.userLegacyId);
    if (Number.isSafeInteger(legacyId) && legacyId > 0) socket.join(`user:${legacyId}`);
    if (socket.data.canViewWorkforce === true) socket.join('workforce');
    socket.on('task:join', (taskLegacyId: number) => {
      if (Number.isSafeInteger(taskLegacyId) && taskLegacyId > 0) socket.join(`task:${taskLegacyId}`);
    });
    socket.on('task:leave', (taskLegacyId: number) => socket.leave(`task:${taskLegacyId}`));
  });
}

export function emitRealtime(event: string, payload: unknown, room?: string): void {
  if (!io) return;
  if (room) io.to(room).emit(event, payload);
  else io.emit(event, payload);
}
