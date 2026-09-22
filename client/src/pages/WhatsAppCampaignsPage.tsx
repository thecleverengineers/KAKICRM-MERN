import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, MessageCircle, Send, ShieldCheck } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api } from '../lib/api.js';
import './whatsappCampaigns.css';

interface CampaignPhone { key: string; displayPhoneNumber: string | null; verifiedName: string | null; activationStatus: string | null }
interface CampaignAccount { id: string; name: string; connected: boolean; phones: CampaignPhone[] }
interface CampaignTemplate { id: string; name: string; status: string; language: string | null; components: unknown[] }
interface Campaign { id: string; name: string; accountName: string; phone: string | null; templateName: string; status: string; totalRecipients: number; sentCount: number; failedCount: number; pendingCount: number; createdAt: string | null; updatedAt: string | null; lastError: string | null }
interface RecipientDraft { phone: string; variables: string[] }

const root = '/settings/integrations/whatsapp-business';

export function WhatsAppCampaignsPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [phoneKey, setPhoneKey] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const accountsQuery = useQuery({ queryKey: ['whatsapp-campaign-accounts'], queryFn: async () => (await api<{ data: CampaignAccount[] }>(`${root}/campaign-accounts`)).data });
  const accounts = accountsQuery.data ?? [];
  const account = accounts.find((item) => item.id === accountId) ?? accounts[0] ?? null;
  const phones = account?.phones ?? [];
  const phone = phones.find((item) => item.key === phoneKey) ?? phones[0] ?? null;
  const templatesQuery = useQuery({ queryKey: ['whatsapp-campaign-templates', account?.id], enabled: Boolean(account), queryFn: async () => (await api<{ data: CampaignTemplate[] }>(`${root}/${account!.id}/templates`)).data });
  const campaignsQuery = useQuery({ queryKey: ['whatsapp-campaigns'], queryFn: async () => (await api<{ data: Campaign[] }>(`${root}/campaigns`)).data });
  const approvedTemplates = (templatesQuery.data ?? []).filter((item) => item.status.toUpperCase() === 'APPROVED' && isCampaignTemplateSupported(item));
  const template = approvedTemplates.find((item) => item.id === templateId) ?? approvedTemplates[0] ?? null;
  const variableCount = getBodyVariableCount(template);
  const createCampaign = useMutation({
    mutationFn: (input: { name: string; accountId: string; phoneKey: string; templateId: string; recipients: RecipientDraft[]; allRecipientsOptedIn: true }) => api<{ data: Campaign }>(`${root}/campaigns`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (response) => { setNotice({ error: false, text: `Campaign “${response.data.name}” is ready. Send it in batches of 10 recipients.` }); void queryClient.invalidateQueries({ queryKey: ['whatsapp-campaigns'] }); }
  });
  const sendBatch = useMutation({
    mutationFn: (id: string) => api<{ data: Campaign }>(`${root}/campaigns/${id}/send-next`, { method: 'POST' }),
    onSuccess: (response) => { setNotice({ error: false, text: `${response.data.sentCount} accepted by Meta, ${response.data.failedCount} failed, ${response.data.pendingCount} remaining.` }); void queryClient.invalidateQueries({ queryKey: ['whatsapp-campaigns'] }); }
  });

  if (accountsQuery.isPending) return <LoadingState label="Checking WhatsApp Business connections…" />;
  if (accountsQuery.isError) return <ErrorState message={accountsQuery.error.message} onRetry={() => void accountsQuery.refetch()} />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    if (!account || !phone || !template) { setNotice({ error: true, text: 'Select a connected account, active phone, and approved template.' }); return; }
    const form = new FormData(event.currentTarget);
    let recipients: RecipientDraft[];
    try { recipients = parseRecipients(String(form.get('recipients') ?? ''), variableCount); }
    catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : 'Check the recipient list.' }); return; }
    if (form.get('optedIn') !== 'on') { setNotice({ error: true, text: 'Confirm that all recipients opted in to WhatsApp messages.' }); return; }
    createCampaign.mutate({ name: String(form.get('name') ?? '').trim(), accountId: account.id, phoneKey: phone.key, templateId: template.id, recipients, allRecipientsOptedIn: true });
  };

  const requestBatch = (campaign: Campaign) => {
    if (window.confirm(`Send the next batch of up to 10 template messages in “${campaign.name}”?`)) sendBatch.mutate(campaign.id);
  };
  const problem = createCampaign.error ?? sendBatch.error;
  const campaigns = campaignsQuery.data ?? [];

  return <>
    <PageHeader eyebrow="TEAM MESSAGING" title="WhatsApp campaigns" description="Send Meta-approved message templates through a connected company number. Campaign access is available to signed-in staff." />
    {notice && <div className={`wa-campaign-alert${notice.error ? ' wa-campaign-alert--error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{notice.text}</div>}
    {problem && <div className="wa-campaign-alert wa-campaign-alert--error" role="alert"><AlertCircle size={17} />{problem instanceof Error ? problem.message : 'The campaign request failed.'}</div>}
    {accounts.length === 0 ? <section className="content-card wa-campaign-empty"><span><MessageCircle size={22} /></span><h2>Campaigns are unavailable</h2><p>An admin, HR, manager, or CEO must connect an active WhatsApp Business account before staff can create campaigns.</p></section> : <>
      <section className="content-card wa-campaign-compose">
        <div className="card-heading"><div><p className="eyebrow">NEW CAMPAIGN</p><h2>Choose a sender and template</h2><p className="muted-copy">Only active numbers and Meta-approved templates can be used.</p></div><Send size={21} /></div>
        {templatesQuery.isError ? <ErrorState message={templatesQuery.error.message} onRetry={() => void templatesQuery.refetch()} /> : <form className="wa-campaign-form" onSubmit={(event) => void submit(event)}>
          <label className="field"><span>Campaign name</span><input name="name" required minLength={2} maxLength={100} placeholder="e.g. September service update" /></label>
          <label className="field"><span>WhatsApp Business account</span><select value={account?.id ?? ''} onChange={(event) => { setAccountId(event.target.value); setTemplateId(''); }} required>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>Sender phone number</span><select value={phone?.key ?? ''} onChange={(event) => setPhoneKey(event.target.value)} required>{phones.map((item) => <option key={item.key} value={item.key}>{item.displayPhoneNumber ?? 'WhatsApp phone'} · {item.activationStatus ?? 'Status unknown'}</option>)}</select></label>
          <label className="field"><span>Approved template</span><select value={template?.id ?? ''} onChange={(event) => setTemplateId(event.target.value)} required disabled={templatesQuery.isPending || !approvedTemplates.length}><option value="" disabled>{templatesQuery.isPending ? 'Loading templates…' : approvedTemplates.length ? 'Select template' : 'No eligible approved templates'}</option>{approvedTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.language ?? 'language unavailable'}</option>)}</select><small>Campaigns support text body variables. Media headers and variables in headers or buttons need a richer campaign composer.</small></label>
          <label className="field field--wide"><span>Recipients</span><textarea name="recipients" required rows={8} placeholder={variableCount ? `+919876543210, Mostafa${variableCount > 1 ? ', value for {{2}}' : ''}\n+919812345678, Rina${variableCount > 1 ? ', another value' : ''}` : '+919876543210\n+919812345678'} /><small>{variableCount ? `One recipient per line: international phone number, then ${variableCount} template body value(s) in placeholder order.` : 'One international phone number per line. Separate entries with a newline.'} Up to 1,000 recipients can be saved; messages are sent in batches of 10.</small></label>
          <label className="wa-campaign-consent"><input name="optedIn" type="checkbox" required /><span>I confirm these contacts have opted in to receive WhatsApp messages from our company, and the selected template is appropriate for them.</span></label>
          <div className="wa-campaign-footnote"><ShieldCheck size={16} /><span>Meta credentials stay on the server. This campaign sends template messages only; recipient numbers are encrypted in storage.</span></div>
          <div className="wa-campaign-actions"><button className="button" type="submit" disabled={createCampaign.isPending || templatesQuery.isPending || !template}>{createCampaign.isPending ? 'Preparing campaign…' : 'Create campaign'}</button></div>
        </form>}
      </section>
    </>}
    <section className="content-card wa-campaign-history">
      <div className="card-heading"><div><p className="eyebrow">YOUR CAMPAIGNS</p><h2>Campaign activity</h2><p className="muted-copy">Resume sending in batches. Results show messages accepted or rejected by Meta, not final delivery or read receipts.</p></div></div>
      {campaignsQuery.isPending ? <LoadingState label="Loading your campaigns…" /> : campaignsQuery.isError ? <ErrorState message={campaignsQuery.error.message} onRetry={() => void campaignsQuery.refetch()} /> : campaigns.length === 0 ? <div className="wa-campaign-history-empty">No campaigns yet.</div> : <div className="wa-campaign-list">{campaigns.map((campaign) => <article className="wa-campaign-row" key={campaign.id}><div className="wa-campaign-row__main"><div className="wa-campaign-row__title"><h3>{campaign.name}</h3><span className={`wa-campaign-status wa-campaign-status--${campaign.status}`}>{campaign.status}</span></div><p>{campaign.accountName} · {campaign.phone ?? 'WhatsApp phone'} · {campaign.templateName}</p><div className="wa-campaign-progress"><span>Accepted {campaign.sentCount}</span><span>Failed {campaign.failedCount}</span><span>Remaining {campaign.pendingCount}</span><span>Total {campaign.totalRecipients}</span></div>{campaign.lastError && <small className="wa-campaign-last-error">Latest error: {campaign.lastError}</small>}</div>{campaign.pendingCount > 0 && <button className="button" type="button" disabled={sendBatch.isPending} onClick={() => requestBatch(campaign)}><Send size={15} />{sendBatch.isPending ? 'Sending…' : campaign.status === 'sending' ? 'Check / resume batch' : 'Send next 10'}</button>}</article>)}</div>}
    </section>
  </>;
}

function parseRecipients(value: string, variableCount: number): RecipientDraft[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Enter at least one recipient.');
  if (lines.length > 1_000) throw new Error('A campaign can contain at most 1,000 recipients.');
  const rows = lines.map((line) => line.split(/[\t,]/).map((item) => item.trim()));
  if (rows.some((row) => row.length !== variableCount + 1)) throw new Error(`Each row needs a phone number${variableCount ? ` and exactly ${variableCount} template value(s)` : ''}.`);
  const phonePattern = /^\+[1-9]\d{7,14}$/;
  const seen = new Set<string>();
  return rows.map(([phone, ...variables]) => {
    if (!phonePattern.test(phone ?? '')) throw new Error('Use international phone format, such as +919876543210.');
    if (seen.has(phone!)) throw new Error('Each phone number must appear only once.');
    seen.add(phone!);
    return { phone: phone!, variables };
  });
}

function getBodyVariableCount(template: CampaignTemplate | null): number {
  const body = template?.components.find((component) => component && typeof component === 'object' && String((component as Record<string, unknown>).type).toUpperCase() === 'BODY') as Record<string, unknown> | undefined;
  return typeof body?.text === 'string' ? (body.text.match(/\{\{\d+\}\}/g) ?? []).length : 0;
}

function isCampaignTemplateSupported(template: CampaignTemplate): boolean {
  return template.components.every((component) => {
    if (!component || typeof component !== 'object') return false;
    const row = component as Record<string, unknown>;
    const type = String(row.type ?? '').toUpperCase();
    if (type === 'BODY') return true;
    if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(row.format ?? '').toUpperCase())) return false;
    return !/\{\{\d+\}\}/.test(JSON.stringify(row));
  });
}
