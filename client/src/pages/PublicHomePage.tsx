import { ArrowRight, BarChart3, CalendarDays, CheckCircle2, FileText, LockKeyhole, MessageCircle, ShieldCheck, Sparkles, UsersRound, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PublicSiteFooter, PublicSiteHeader } from '../components/PublicSiteHeader.js';
import { useBranding } from '../lib/branding.js';
import { useAuth } from '../store/auth.js';

const features = [
  { icon: Workflow, title: 'Work in one flow', detail: 'Tasks, projects, teams and daily updates stay connected so everyone knows what is moving next.' },
  { icon: UsersRound, title: 'People-first operations', detail: 'Role-aware employee, attendance, leave and payroll workspaces keep access focused and accountable.' },
  { icon: BarChart3, title: 'Clear business control', detail: 'Invoices, payments, expenses and executive insights make decisions easier to review.' },
  { icon: CalendarDays, title: 'A shared company calendar', detail: 'Meetings, holidays, milestones, shifts and deadlines are visible in the right context.' },
  { icon: MessageCircle, title: 'Helpful communication', detail: 'Task chat, notifications and approved WhatsApp work updates keep important changes visible.' },
  { icon: LockKeyhole, title: 'Secure by design', detail: 'Permission checks, encrypted integration credentials, audit trails and recoverable archives protect the workspace.' }
];

export function PublicHomePage() {
  const branding = useBranding();
  const { user } = useAuth();
  const workspaceHref = user ? '/dashboard' : '/login';
  const workspaceLabel = user ? 'Open your workspace' : 'Sign in to KAKI CRM';

  return <div className="public-page">
    <div className="public-shell">
      <PublicSiteHeader active="home" />
      <main>
        <section className="public-hero">
          <div className="public-hero-copy">
            <p className="public-eyebrow"><Sparkles size={14} /> {branding.site_subtitle} · connected work</p>
            <h1>One calm command centre for the workday.</h1>
            <p className="public-hero-lead">{branding.site_title} brings people, tasks, projects, conversations, meetings, attendance, payroll and business records into one permission-aware workspace.</p>
            <div className="public-actions">
              <Link className="button public-primary-action" to={workspaceHref}>{workspaceLabel} <ArrowRight size={16} /></Link>
              <Link className="button button--secondary" to="/privacy">How we handle data</Link>
            </div>
            <div className="public-trust-row"><span><ShieldCheck size={16} /> Role-based access</span><span><CheckCircle2 size={16} /> Audit-ready workflows</span><span><LockKeyhole size={16} /> Secure integrations</span></div>
          </div>
          <div className="public-hero-visual" aria-label="KAKI CRM workspace overview">
            <div className="public-hero-visual-glow" />
            <div className="public-hero-visual-top"><span>OPERATIONS COMMAND</span><b>LIVE WORKSPACE</b></div>
            <div className="public-hero-panel-title"><span className="public-status-dot" /> Your workday, in context</div>
            <div className="public-hero-metrics">
              <div><small>WORKFLOW</small><strong>Connected</strong><span>Tasks · projects · people</span></div>
              <div><small>VISIBILITY</small><strong>Permission-aware</strong><span>Only the right work is shown</span></div>
              <div><small>DECISIONS</small><strong>Traceable</strong><span>Updates and approvals stay auditable</span></div>
              <div><small>ASSISTANCE</small><strong>Clara ready</strong><span>Human-friendly guidance on demand</span></div>
            </div>
            <div className="public-hero-visual-footer"><span>Tasks</span><span>Meetings</span><span>Payroll</span><span>Reports</span></div>
          </div>
        </section>

        <section className="public-proof-strip" aria-label="Workspace capabilities">
          <div><strong>01</strong><span>Bring daily work together</span></div><div><strong>02</strong><span>Give each role the right view</span></div><div><strong>03</strong><span>Keep important changes accountable</span></div>
        </section>

        <section className="public-section" aria-labelledby="public-features-title">
          <div className="public-section-heading"><p className="public-eyebrow">BUILT FOR REAL OPERATIONS</p><h2 id="public-features-title">Everything your team needs to move with confidence.</h2><p>From the first task update to an executive decision, KAKI CRM keeps the work understandable, searchable and ready for the next action.</p></div>
          <div className="public-feature-grid">{features.map(({ icon: Icon, title, detail }) => <article className="public-feature-card" key={title}><span className="public-feature-icon"><Icon size={19} /></span><h3>{title}</h3><p>{detail}</p></article>)}</div>
        </section>

        <section className="public-privacy-callout" aria-labelledby="public-privacy-title"><div className="public-privacy-callout-icon"><FileText size={21} /></div><div><p className="public-eyebrow">TRANSPARENT BY DEFAULT</p><h2 id="public-privacy-title">Your data has a clear purpose.</h2><p>We describe the account, work, file, notification and Google integration data KAKI CRM uses, why it is needed, how it is protected and how you can request help or deletion.</p></div><Link className="text-button" to="/privacy">Read the privacy policy <ArrowRight size={15} /></Link></section>

        <section className="public-final-cta"><p className="public-eyebrow">READY WHEN YOU ARE</p><h2>Make the next workday easier to see.</h2><p>Sign in to your existing account, or share this page with a teammate who needs to understand KAKI CRM before connecting.</p><Link className="button public-primary-action" to={workspaceHref}>{workspaceLabel} <ArrowRight size={16} /></Link></section>
      </main>
      <PublicSiteFooter />
    </div>
  </div>;
}
