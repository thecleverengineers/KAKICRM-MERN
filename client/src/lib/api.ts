export interface PublicRecord {
  id: string;
  legacyId: number | null;
  fields: Record<string, unknown>;
  relationLabels?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface RelationOption {
  id: number;
  label: string;
}

export interface ApiErrorShape {
  error: string;
  issues?: Array<{ path: string; message: string }>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: ApiErrorShape['issues']) {
    super(message);
  }
}

const tokenKey = 'kaki-crm-access-token';
const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api';

/** Builds an API path for authenticated binary downloads as well as JSON calls. */
export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

export function getAccessToken(): string | null {
  return localStorage.getItem(tokenKey);
}

export function setAccessToken(token: string): void {
  localStorage.setItem(tokenKey, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(tokenKey);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiUrl(path), { ...init, headers });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({ error: 'The server returned an invalid response.' })) as T | ApiErrorShape;
  if (!response.ok) {
    const problem = payload as ApiErrorShape;
    throw new ApiError(response.status, problem.error || 'Request failed.', problem.issues);
  }
  return payload as T;
}

export function queryString(values: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}
