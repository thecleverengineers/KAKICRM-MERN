import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, clearAccessToken, getAccessToken, setAccessToken } from '../lib/api.js';

export interface AuthUser {
  recordId: string;
  legacyId: number;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  hasWhatsAppNumber?: boolean;
  record: { fields: Record<string, unknown> };
}

interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  updateWhatsAppNumber: (whatsappNumber: string) => Promise<void>;
  updateProfile: (fields: { name: string; phone?: string | null; whatsapp_number?: string | null; address?: string | null; emergency_contact?: string | null; bio?: string | null; date_of_birth?: string | null }) => Promise<void>;
  uploadProfileImage: (file: File) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission?: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!getAccessToken()) {
      setReady(true);
      return;
    }
    try {
      const result = await api<{ user: AuthUser }>('/auth/me');
      setUser(result.user);
    } catch {
      clearAccessToken();
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setAccessToken(result.token);
    setUser(result.user);
  }, []);

  const updateWhatsAppNumber = useCallback(async (whatsappNumber: string) => {
    const result = await api<{ user: AuthUser }>('/auth/me/whatsapp-number', {
      method: 'PUT',
      body: JSON.stringify({ whatsappNumber })
    });
    setUser(result.user);
  }, []);

  const updateProfile = useCallback(async (fields: { name: string; phone?: string | null; whatsapp_number?: string | null; address?: string | null; emergency_contact?: string | null; bio?: string | null; date_of_birth?: string | null }) => {
    const result = await api<{ user: AuthUser }>('/auth/me/profile', { method: 'PUT', body: JSON.stringify(fields) });
    setUser(result.user);
  }, []);

  const uploadProfileImage = useCallback(async (file: File) => {
    const body = new FormData();
    body.append('image', file);
    const result = await api<{ user: AuthUser }>('/auth/me/profile-image', { method: 'POST', body });
    setUser(result.user);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api('/auth/me/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
  }, []);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* A local logout should always succeed. */ }
    clearAccessToken();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    ready,
    login,
    updateWhatsAppNumber,
    updateProfile,
    uploadProfileImage,
    changePassword,
    refreshUser: refresh,
    logout,
    hasPermission: (permission?: string) => !permission || Boolean(user?.permissions.includes('*') || user?.permissions.includes(permission))
  }), [user, ready, login, updateWhatsAppNumber, updateProfile, uploadProfileImage, changePassword, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
