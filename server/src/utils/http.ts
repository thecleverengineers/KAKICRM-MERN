import type { NextFunction, Request, Response } from 'express';
import type { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Endpoint not found.' });
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'An unexpected server error occurred.';
  const zod = error as ZodError | undefined;
  const issues = Array.isArray(zod?.issues) ? zod.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) : undefined;

  if (status >= 500) {
    console.error(`[${req.requestId ?? 'request'}]`, error);
  }

  res.status(status).json({ error: message, issues });
}
