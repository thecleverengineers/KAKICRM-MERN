import type { AuthContext } from '../services/permissions.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

export {};
