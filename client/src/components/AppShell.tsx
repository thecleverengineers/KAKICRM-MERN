import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Bell, CalendarClock, CheckSquare, ChevronDown, KeyRound, LayoutDashboard, LogOut, Menu, MessageCircle, Moon, PanelLeftClose, PanelLeftOpen, Sun, UserRound, X } from 'lucide-react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { navigation } from '../config/resources.js';
import { BrandVisual } from './BrandVisual.js';
import { ShiftStartAlertListener } from './ShiftStartAlertListener.js';
import { ClaraVoiceAssistant } from './ClaraVoiceAssistant.js';
import { CeoCommandPalette } from './CeoCommandPalette.js';
import { GlobalSearch } from './GlobalSearch.js';
import { brandingLogoForTheme, useBranding } from '../lib/branding.js';
import { initials } from '../lib/format.js';
import { assetUrl } from '../lib/assets.js';
import { applyTheme, readTheme, type AppTheme } from '../lib/theme.js';
import { useAuth } from '../store/auth.js';

export function AppShell() {
  const { user, logout, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('kaki-crm-sidebar-hidden') === '1');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => readTheme());
  const navigate = useNavigate();
  const location = useLocation();
  const branding = useBranding();
  const isInvoiceRoute = location.pathname === '/invoices'
    || location.pathname.startsWith('/invoices/')
    || location.pathname === '/data/invoices'
    || location.pathname.startsWith('/data/invoices/');
  const mobileNavigation = [
    { label: 'Home', to: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
    { label: 'Tasks', to: '/tasks', icon: CheckSquare, permission: 'task.view', roles: ['employee'] },
    { label: 'Shift', to: '/attendance', icon: CalendarClock },
    { label: 'Alerts', to: '/notifications', icon: Bell }
  ].filter((item) => hasPermission(item.permission) || item.roles?.includes(normalizedRole(user?.role)));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };
  const openWorkforce = useCallback(() => navigate('/workforce'), [navigate]);
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setOpen((current) => !current);
      return;
    }
    setSidebarHidden((current) => {
      const next = !current;
      localStorage.setItem('kaki-crm-sidebar-hidden', next ? '1' : '0');
      return next;
    });
  };
  const openProfile = (section?: 'profile' | 'security' | 'salary') => {
    setProfileMenuOpen(false);
    setOpen(false);
    navigate(section === 'salary' ? '/my-salary' : section === 'security' ? '/profile#security' : '/profile');
  };
  const canOpenItem = (item: (typeof navigation)[number]['items'][number]) => hasPermission(item.permission) || Boolean(item.roles?.includes(normalizedRole(user?.role)));

  return (
    <div className={`app-frame${sidebarHidden ? ' app-frame--sidebar-hidden' : ''}`}>
      <ShiftStartAlertListener onOpenWorkforce={openWorkforce} />
      {!isInvoiceRoute && <ClaraVoiceAssistant />}
      <CeoCommandPalette />
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}${sidebarHidden ? ' sidebar--hidden' : ''}`}>
        <div className="brand-row">
          <BrandVisual src={brandingLogoForTheme(branding, theme)} label={branding.site_title} />
          <div><strong>{branding.site_title}</strong><span>{branding.site_subtitle}</span></div>
          <button className="icon-button sidebar-close" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>
        <nav className="side-nav">
          {navigation.map((group) => {
            const items = group.items.filter(canOpenItem);
            if (!items.length) return null;
            return <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {items.map((item) => {
                const Icon = item.icon;
                return <NavLink key={item.to} to={item.to} onClick={() => setOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}>
                  <Icon size={17} /><span>{item.label}</span>
                </NavLink>;
              })}
            </div>;
          })}
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-profile-trigger" type="button" onClick={() => openProfile()} aria-label="Open your profile"><UserAvatar user={user} className="avatar" /><span className="profile-copy"><strong>{user?.name}</strong><span>{user?.role}</span></span></button>
          <button className="icon-button" onClick={() => void handleLogout()} aria-label="Sign out"><LogOut size={17} /></button>
        </div>
      </aside>
      <div className={`sidebar-overlay ${open ? 'sidebar-overlay--visible' : ''}`} onClick={() => setOpen(false)} />
      <main className="main-content">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={toggleSidebar} aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'} title={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}>{sidebarHidden ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}</button>
          <GlobalSearch /><div className="topbar-spacer" />
          <button className="icon-button theme-toggle" aria-label={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`} title={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" aria-label="Notifications" onClick={() => navigate('/notifications')}><Bell size={19} /></button>
          <div className="profile-menu"><button className="topbar-profile-trigger" type="button" onClick={() => setProfileMenuOpen((current) => !current)} aria-label="Open profile menu" aria-expanded={profileMenuOpen}><UserAvatar user={user} className="topbar-avatar" /><ChevronDown size={15} /></button>{profileMenuOpen && <div className="profile-menu-panel"><button type="button" onClick={() => openProfile()}><UserRound size={16} /> My profile</button><button type="button" onClick={() => openProfile('security')}><KeyRound size={16} /> Security & password</button><button type="button" onClick={() => openProfile('salary')}><CalendarClock size={16} /> My salary slips</button><hr /><button className="profile-menu-logout" type="button" onClick={() => void handleLogout()}><LogOut size={16} /> Sign out</button></div>}</div>
        </header>
        <div className="page-container"><Outlet /></div>
      </main>
      <nav className="mobile-appbar" aria-label="Mobile navigation">
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          return <NavLink key={item.to} to={item.to} end={item.to === '/dashboard'} className={({ isActive }) => `mobile-appbar-link ${isActive ? 'mobile-appbar-link--active' : ''}`}>
            <Icon size={20} /><span>{item.label}</span>
          </NavLink>;
        })}
        <button className="mobile-appbar-link mobile-appbar-menu" type="button" onClick={() => setOpen(true)} aria-label="Open all navigation" aria-expanded={open}>
          <Menu size={21} /><span>More</span>
        </button>
      </nav>
    </div>
  );
}

function UserAvatar({ user, className }: { user: ReturnType<typeof useAuth>['user']; className: string }) {
  const fields = user?.record.fields ?? {};
  const image = assetUrl(fields.profile_image_url ?? fields.avatar_url ?? fields.profile_photo_url ?? fields.photo_url);
  return image ? <span className={`${className} ${className}--image`}><img src={image} alt={`${user?.name ?? 'User'} profile`} /></span> : <span className={className}>{initials(user?.name)}</span>;
}

function normalizedRole(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function ProtectedScreen({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  if (!ready) return <div className="screen-center"><div className="loader" /><span>Loading your workspace…</span></div>;
  if (!user) return <NavigateToLogin />;
  if (!hasSavedWhatsAppNumber(user)) return <WhatsAppNumberGate />;
  if (!hasSavedDateOfBirth(user)) return <DateOfBirthGate />;
  return <>{children}</>;
}

function hasSavedDateOfBirth(user: { record: { fields: Record<string, unknown> } }): boolean {
  const value = String(user.record.fields.date_of_birth ?? user.record.fields.dob ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function DateOfBirthGate() {
  const { user, updateProfile, logout } = useAuth();
  const fields = user?.record.fields ?? {};
  const [dateOfBirth, setDateOfBirth] = useState(String(fields.date_of_birth ?? fields.dob ?? ''));
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { await updateProfile({ name: String(fields.name ?? user?.name ?? ''), date_of_birth: dateOfBirth }); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Unable to save your date of birth.'); } finally { setSaving(false); } };
  return <main className="whatsapp-gate"><section className="whatsapp-gate-card" aria-labelledby="dob-gate-title"><div className="whatsapp-gate-icon"><CalendarClock size={25} /></div><p className="eyebrow">REQUIRED PROFILE DETAIL</p><h1 id="dob-gate-title">Add your date of birth</h1><p>Please update your date of birth before accessing your KAKI CRM account. This is required once for every user.</p><form onSubmit={(event) => void submit(event)}><label className="field"><span>Date of birth</span><input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required autoFocus /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--full" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save and continue'}</button></form><button className="text-button whatsapp-gate-signout" type="button" disabled={saving} onClick={() => void logout()}><LogOut size={15} /> Sign out</button></section></main>;
}

function WhatsAppNumberGate() {
  const { updateWhatsAppNumber, logout } = useAuth();
  const [whatsappNumber, setWhatsAppNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateWhatsAppNumber(whatsappNumber);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save your WhatsApp number.');
    } finally {
      setSaving(false);
    }
  };

  return <main className="whatsapp-gate">
    <section className="whatsapp-gate-card" aria-labelledby="whatsapp-gate-title">
      <div className="whatsapp-gate-icon"><MessageCircle size={25} /></div>
      <p className="eyebrow">ONE LAST STEP</p>
      <h1 id="whatsapp-gate-title">Add your WhatsApp number</h1>
      <p>Before opening your KAKI CRM workspace, please add the WhatsApp number to use for work updates.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>WhatsApp number</span>
          <input
            type="tel"
            value={whatsappNumber}
            onChange={(event) => setWhatsAppNumber(event.target.value)}
            placeholder="+91 98765 43210"
            autoComplete="tel"
            inputMode="tel"
            required
            autoFocus
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button--full" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save and continue'}</button>
      </form>
      <button className="text-button whatsapp-gate-signout" type="button" disabled={saving} onClick={() => void logout()}><LogOut size={15} /> Sign out</button>
    </section>
  </main>;
}

function hasSavedWhatsAppNumber(user: { hasWhatsAppNumber?: boolean; record: { fields: Record<string, unknown> } }): boolean {
  if (user.hasWhatsAppNumber) return true;
  return ['whatsapp_number', 'whatsapp', 'whatsapp_no', 'whatsapp_phone'].some((field) => {
    const compact = String(user.record.fields[field] ?? '').trim().replace(/[()\s.-]/g, '');
    return /^\+?[1-9]\d{6,14}$/.test(compact);
  });
}

function NavigateToLogin() {
  return <Navigate to="/login" replace />;
}
