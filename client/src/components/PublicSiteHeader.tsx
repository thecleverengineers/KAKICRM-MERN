import { Moon, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { BrandVisual } from './BrandVisual.js';
import { assetUrl } from '../lib/assets.js';
import { useBranding } from '../lib/branding.js';
import { applyTheme, readTheme, type AppTheme } from '../lib/theme.js';
import { useAuth } from '../store/auth.js';

export function PublicSiteHeader({ active }: { active?: 'home' | 'privacy' }) {
  const branding = useBranding();
  const { user } = useAuth();
  const [theme, setTheme] = useState<AppTheme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return <header className="public-nav">
    <Link className="public-brand" to="/" aria-label={`${branding.site_title} home`}>
      <BrandVisual src={assetUrl(branding.logo_url)} label={branding.site_title} className="public-brand-mark" />
      <span><strong>{branding.site_title}</strong><small>{branding.site_subtitle}</small></span>
    </Link>
    <nav className="public-nav-links" aria-label="Public navigation">
      <Link className={active === 'home' ? 'public-nav-link public-nav-link--active' : 'public-nav-link'} to="/">Home</Link>
      <Link className={active === 'privacy' ? 'public-nav-link public-nav-link--active' : 'public-nav-link'} to="/privacy">Privacy</Link>
      {user ? <Link className="button public-nav-workspace" to="/dashboard">Open workspace</Link> : <Link className="button public-nav-workspace" to="/login">Sign in</Link>}
      <button className="public-theme-toggle" type="button" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`} title={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </nav>
  </header>;
}

export function PublicSiteFooter() {
  const branding = useBranding();
  return <footer className="public-footer">
    <div><strong>{branding.site_title}</strong><span>{branding.site_subtitle} for connected teams.</span></div>
    <div className="public-footer-links"><Link to="/privacy">Privacy policy</Link><Link to="/login">Sign in</Link></div>
    <small>© {new Date().getFullYear()} M/s Chishikaki Creative Solutions (OPC) Private Limited.</small>
  </footer>;
}
