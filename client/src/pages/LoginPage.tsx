import { useEffect, useState, type FormEvent } from 'react';
import { LockKeyhole, Moon, Sparkles, Sun } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { BrandVisual } from '../components/BrandVisual.js';
import { useBranding } from '../lib/branding.js';
import { applyTheme, readTheme, type AppTheme } from '../lib/theme.js';
import { useAuth } from '../store/auth.js';

export function LoginPage() {
  const { user, ready, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(() => readTheme());
  const branding = useBranding();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  if (ready && user) return <Navigate to="/dashboard" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  return <main className="login-layout">
    <button
      className="login-theme-toggle"
      type="button"
      aria-label={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`}
      title={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`}
      onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      <span>{theme === 'dark' ? 'Day mode' : 'Night mode'}</span>
    </button>
    <section className="login-panel">
      <div className="login-brand"><BrandVisual src={branding.logo_url} label={branding.site_title} /><span>{branding.site_title}</span></div>
      <div className="login-copy"><p className="eyebrow">{branding.site_subtitle.toUpperCase()}</p><h1>Run your workday from one clear place.</h1><p>Projects, people, payments and communication — preserved from the legacy CRM and rebuilt for today.</p><div className="login-feature"><Sparkles size={17} /> Secure modern workspace</div></div>
    </section>
    <section className="login-form-wrap">
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <div className="login-lock"><LockKeyhole size={23} /></div>
        <p className="eyebrow">WELCOME BACK</p><h2>Sign in to {branding.site_title}</h2><p>Use the same email and password from your existing account.</p>
        <label className="field"><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="button button--full" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
        <p className="login-privacy-link"><Link to="/privacy">Privacy policy</Link><span aria-hidden="true"> · </span><Link to="/">About KAKI CRM</Link></p>
      </form>
    </section>
  </main>;
}
