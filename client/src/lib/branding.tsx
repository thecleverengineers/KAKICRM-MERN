import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export interface Branding {
  site_title: string;
  site_subtitle: string;
  logo_url: string | null;
  logo_day_url: string | null;
  logo_night_url: string | null;
  legal_company_name: string;
  company_information: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_website: string;
  invoice_logo_url: string | null;
  invoice_footer: string;
  invoice_accent: string;
}

export const defaultBranding: Branding = {
  site_title: 'KAKI CRM',
  site_subtitle: 'Operations hub',
  logo_url: null,
  logo_day_url: null,
  logo_night_url: null,
  legal_company_name: 'M/s Chishikaki Creative Solutions (OPC) Private Limited',
  company_information: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  invoice_logo_url: null,
  invoice_footer: 'Thank you for your business.',
  invoice_accent: '#2f5ea8'
};

const BrandingContext = createContext<Branding>(defaultBranding);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: async () => {
      try {
        const response = await api<{ data: Branding }>('/settings/branding');
        return response.data;
      } catch {
        // Branding must never prevent the login screen or CRM from rendering.
        return defaultBranding;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1
  });
  const branding = query.data ?? defaultBranding;

  useEffect(() => {
    document.title = branding.site_title;
    const favicon = branding.logo_day_url ?? branding.logo_url;
    if (!favicon) return;
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.append(icon);
    }
    icon.href = favicon;
  }, [branding.logo_day_url, branding.logo_url, branding.site_title]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}

export function brandingLogoForTheme(branding: Branding, theme: 'light' | 'dark'): string | null {
  if (theme === 'dark') return branding.logo_night_url ?? branding.logo_day_url ?? branding.logo_url;
  return branding.logo_day_url ?? branding.logo_url ?? branding.logo_night_url;
}
