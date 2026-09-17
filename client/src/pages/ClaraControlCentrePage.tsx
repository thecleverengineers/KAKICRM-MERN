import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, CheckCircle2, Clock3, FileCheck2, LockKeyhole, Plus, Save, ShieldCheck, Sparkles, Trash2, Volume2 } from 'lucide-react';
import { ErrorState, EmptyState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { CLARA_ANNOUNCEMENT_RULES, CLARA_ROLE_RULES, CLARA_SAFETY_RULES, CLARA_TRAINING_CATALOG, CLARA_TRAINING_VERSION, CLARA_VOICE_RULES } from '../lib/claraKnowledge.js';
import { useAuth } from '../store/auth.js';

export function ClaraControlCentrePage() {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [knowledgeForm, setKnowledgeForm] = useState({ title: '', triggers: '', content: '', category: 'company' });
  const [exampleForm, setExampleForm] = useState({ question: '', expectedAnswer: '', action: '' });
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [savingExample, setSavingExample] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = normalizedRole(user?.role) === 'admin' || normalizedRole(user?.role) === 'administrator';
  const knowledgeQuery = useQuery({
    queryKey: ['clara', 'knowledge'],
    queryFn: () => api<Paginated<PublicRecord>>('/records/clara_knowledge?limit=100')
  });
  const examplesQuery = useQuery({
    queryKey: ['clara', 'training-examples'],
    queryFn: () => api<Paginated<PublicRecord>>('/records/clara_training_examples?limit=100')
  });

  if (!isAdmin || !hasPermission('rbac.manage')) return <ErrorState message="Only administrators can access Clara AI Control Centre." />;
  if (knowledgeQuery.isPending || examplesQuery.isPending) return <LoadingState label="Loading Clara controls…" />;
  if (knowledgeQuery.isError) return <ErrorState message={knowledgeQuery.error.message} onRetry={() => void knowledgeQuery.refetch()} />;
  if (examplesQuery.isError) return <ErrorState message={examplesQuery.error.message} onRetry={() => void examplesQuery.refetch()} />;

  const saveKnowledge = async (event: FormEvent) => {
    event.preventDefault();
    setSavingKnowledge(true);
    setError(null);
    setMessage(null);
    try {
      await api('/records/clara_knowledge', {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            title: knowledgeForm.title.trim(),
            triggers: knowledgeForm.triggers.trim(),
            content: knowledgeForm.content.trim(),
            category: knowledgeForm.category,
            status: 'approved',
            source: 'Admin Clara Control Centre',
            training_version: CLARA_TRAINING_VERSION,
            access_scope: 'role-permission-filtered'
          }
        })
      });
      setKnowledgeForm({ title: '', triggers: '', content: '', category: 'company' });
      setMessage('Approved knowledge entry saved for Clara.');
      await queryClient.invalidateQueries({ queryKey: ['clara', 'knowledge'] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save the knowledge entry.');
    } finally {
      setSavingKnowledge(false);
    }
  };

  const saveExample = async (event: FormEvent) => {
    event.preventDefault();
    setSavingExample(true);
    setError(null);
    setMessage(null);
    try {
      await api('/records/clara_training_examples', {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            question: exampleForm.question.trim(),
            expected_answer: exampleForm.expectedAnswer.trim(),
            action: exampleForm.action.trim(),
            status: 'approved',
            source: 'Admin Clara Control Centre',
            training_version: CLARA_TRAINING_VERSION
          }
        })
      });
      setExampleForm({ question: '', expectedAnswer: '', action: '' });
      setMessage('Approved training example saved.');
      await queryClient.invalidateQueries({ queryKey: ['clara', 'training-examples'] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save the training example.');
    } finally {
      setSavingExample(false);
    }
  };

  const removeEntry = async (collection: 'clara_knowledge' | 'clara_training_examples', record: PublicRecord) => {
    if (!record.legacyId || !window.confirm('Archive this Clara entry? It can be recovered by an administrator.')) return;
    setError(null);
    try {
      await api(`/records/${collection}/${record.legacyId}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['clara'] });
      setMessage('Entry archived.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to archive this entry.');
    }
  };

  const knowledge = knowledgeQuery.data.data;
  const examples = examplesQuery.data.data;
  return <>
    <PageHeader eyebrow="AI OPERATIONS" title="Clara AI Control Centre" description="Review Clara’s approved CRM training, safety boundaries, voice rules and controlled company knowledge." actions={<span className="clara-control-version"><CheckCircle2 size={15} /> Training {CLARA_TRAINING_VERSION}</span>} />
    {(error || message) && <p className={error ? 'form-error' : 'form-success'} role="status">{error ?? message}</p>}

    <section className="clara-control-overview" aria-label="Clara status overview">
      <div className="clara-control-stat"><span className="clara-control-stat__icon clara-control-stat__icon--ready"><CheckCircle2 size={18} /></span><small>Availability</small><strong>Ready</strong><span>CRM fallback remains available if voice or AI services pause.</span></div>
      <div className="clara-control-stat"><span className="clara-control-stat__icon"><BookOpen size={18} /></span><small>Knowledge entries</small><strong>{knowledge.length}</strong><span>Admin-approved, versioned entries.</span></div>
      <div className="clara-control-stat"><span className="clara-control-stat__icon"><ShieldCheck size={18} /></span><small>Safety mode</small><strong>Permission aware</strong><span>High-risk actions require confirmation.</span></div>
      <div className="clara-control-stat"><span className="clara-control-stat__icon"><Volume2 size={18} /></span><small>Announcements</small><strong>Event-only</strong><span>Status, upload, submit, notification and message events.</span></div>
    </section>

    <div className="clara-control-grid">
      <section className="content-card clara-control-card clara-control-card--wide"><div className="card-heading"><div><p className="eyebrow">TRAINING CATALOG</p><h2>CRM intelligence layers</h2><p className="muted-copy">These reviewed layers shape Clara’s answers without granting unrestricted database access.</p></div><Sparkles size={21} /></div><div className="clara-control-catalog">{CLARA_TRAINING_CATALOG.map((card) => <article className="clara-control-catalog-item" key={card.id}><span className="clara-control-pill">{card.id}</span><h3>{card.title}</h3><p>{card.summary}</p><ul>{card.details.map((detail) => <li key={detail}>{detail}</li>)}</ul></article>)}</div></section>

      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">ACCESS MODEL</p><h2>Role guardrails</h2></div><LockKeyhole size={21} /></div><ul className="clara-control-rule-list">{CLARA_ROLE_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul></section>
      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">SECURITY</p><h2>Action safety</h2></div><ShieldCheck size={21} /></div><ul className="clara-control-rule-list">{CLARA_SAFETY_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul></section>
      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">VOICE POLICY</p><h2>Announcements</h2></div><Volume2 size={21} /></div><ul className="clara-control-rule-list">{CLARA_ANNOUNCEMENT_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul></section>
      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">VOICE EXPERIENCE</p><h2>Holographic lookup</h2></div><Sparkles size={21} /></div><ul className="clara-control-rule-list">{CLARA_VOICE_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul></section>

      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">KNOWLEDGE BASE</p><h2>Add approved knowledge</h2></div><Plus size={21} /></div><form className="clara-control-form" onSubmit={(event) => void saveKnowledge(event)}><label className="field"><span>Title *</span><input value={knowledgeForm.title} onChange={(event) => setKnowledgeForm((current) => ({ ...current, title: event.target.value }))} required maxLength={180} /></label><label className="field"><span>Trigger words</span><input value={knowledgeForm.triggers} onChange={(event) => setKnowledgeForm((current) => ({ ...current, triggers: event.target.value }))} placeholder="holiday policy, sunday overtime" /></label><label className="field"><span>Category</span><select value={knowledgeForm.category} onChange={(event) => setKnowledgeForm((current) => ({ ...current, category: event.target.value }))}><option value="company">Company policy</option><option value="faq">FAQ</option><option value="sop">SOP</option><option value="terminology">Terminology</option></select></label><label className="field"><span>Approved answer *</span><textarea value={knowledgeForm.content} onChange={(event) => setKnowledgeForm((current) => ({ ...current, content: event.target.value }))} rows={5} required maxLength={5000} /></label><button className="button" type="submit" disabled={savingKnowledge}><Save size={16} /> {savingKnowledge ? 'Saving…' : 'Approve knowledge'}</button></form></section>
      <section className="content-card clara-control-card"><div className="card-heading"><div><p className="eyebrow">TRAINING STUDIO</p><h2>Add an approved example</h2></div><FileCheck2 size={21} /></div><form className="clara-control-form" onSubmit={(event) => void saveExample(event)}><label className="field"><span>User question *</span><textarea value={exampleForm.question} onChange={(event) => setExampleForm((current) => ({ ...current, question: event.target.value }))} rows={3} required maxLength={1000} placeholder="How many open tasks are assigned to me?" /></label><label className="field"><span>Expected answer *</span><textarea value={exampleForm.expectedAnswer} onChange={(event) => setExampleForm((current) => ({ ...current, expectedAnswer: event.target.value }))} rows={4} required maxLength={5000} /></label><label className="field"><span>Validated action (optional)</span><input value={exampleForm.action} onChange={(event) => setExampleForm((current) => ({ ...current, action: event.target.value }))} placeholder="Open /tasks after confirmation" /></label><button className="button" type="submit" disabled={savingExample}><Save size={16} /> {savingExample ? 'Saving…' : 'Approve example'}</button></form></section>

      <section className="content-card clara-control-card clara-control-card--wide"><div className="card-heading"><div><p className="eyebrow">APPROVED ENTRIES</p><h2>Knowledge currently available to Clara</h2></div><Clock3 size={21} /></div>{knowledge.length ? <div className="clara-control-entry-list">{knowledge.map((record) => <article className="clara-control-entry" key={record.id}><div><strong>{String(record.fields.title ?? 'Untitled knowledge')}</strong><span>{String(record.fields.category ?? 'company')} · {String(record.fields.training_version ?? CLARA_TRAINING_VERSION)}</span><p>{String(record.fields.content ?? '')}</p></div><button className="icon-button clara-control-danger" type="button" onClick={() => void removeEntry('clara_knowledge', record)} aria-label={`Archive ${String(record.fields.title ?? 'knowledge entry')}`}><Trash2 size={16} /></button></article>)}</div> : <EmptyState title="No custom knowledge yet" detail="Use the form above to add a reviewed company answer." />}</section>
      <section className="content-card clara-control-card clara-control-card--wide"><div className="card-heading"><div><p className="eyebrow">APPROVED EXAMPLES</p><h2>Training examples</h2></div><FileCheck2 size={21} /></div>{examples.length ? <div className="clara-control-entry-list">{examples.map((record) => <article className="clara-control-entry" key={record.id}><div><strong>{String(record.fields.question ?? 'Question')}</strong><span>{String(record.fields.training_version ?? CLARA_TRAINING_VERSION)}</span><p>{String(record.fields.expected_answer ?? '')}</p>{String(record.fields.action ?? '').trim() && <small>Action: {String(record.fields.action)}</small>}</div><button className="icon-button clara-control-danger" type="button" onClick={() => void removeEntry('clara_training_examples', record)} aria-label="Archive training example"><Trash2 size={16} /></button></article>)}</div> : <EmptyState title="No custom examples yet" detail="Approved examples help Clara answer company-specific questions consistently." />}</section>
    </div>
  </>;
}

function normalizedRole(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
