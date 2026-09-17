import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { buildAuthContext, resolveUserByRecordId } from '../services/permissions.js';

interface TokenPayload extends jwt.JwtPayload {
  sub: string;
}

export function signAccessToken(recordId: string): string {
  return jwt.sign({ sub: recordId }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication is required.' });
      return;
    }

    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
    const user = await resolveUserByRecordId(payload.sub);
    if (!user) {
      res.status(401).json({ error: 'This session is no longer valid.' });
      return;
    }

    req.auth = await buildAuthContext(user);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

/**
 * Dashboard data stays unavailable until the signed-in user has supplied a
 * valid WhatsApp number. The update endpoint remains under /api/auth, so the
 * user can always complete this required profile step.
 */
export function requireWhatsAppNumber(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }

  if (!req.auth.hasWhatsAppNumber) {
    res.status(403).json({ error: 'Add your WhatsApp number before accessing the dashboard.' });
    return;
  }

  next();
}

export function readBearerToken(req: Request): string | null {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim() || null;
}
