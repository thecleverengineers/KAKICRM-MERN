import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Mic, MicOff, Send, Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type PublicRecord } from '../lib/api.js';
import { answerClaraQuestion, type ClaraCustomKnowledge } from '../lib/claraKnowledge.js';
import { useAuth } from '../store/auth.js';

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface VoiceWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface VoiceDestination {
  label: string;
  route: string;
}

/**
 * Clara is deliberately a browser-side voice and navigation layer. It only
 * speaks approved knowledge and routes to existing permission-aware CRM
 * screens; data-changing actions remain in their validated forms/APIs.
 */
export function ClaraVoiceAssistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [active, setActive] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [typedCommand, setTypedCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [customKnowledge, setCustomKnowledge] = useState<ClaraCustomKnowledge[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(false);
  const wakeEnabledRef = useRef(false);
  const listeningRef = useRef(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    wakeEnabledRef.current = wakeEnabled;
  }, [wakeEnabled]);

  useEffect(() => {
    if (!user) {
      setCustomKnowledge([]);
      return undefined;
    }
    let cancelled = false;
    void Promise.all([
      api<{ data: PublicRecord[] }>('/records/clara_knowledge?limit=100'),
      api<{ data: PublicRecord[] }>('/records/clara_training_examples?limit=100')
    ])
      .then(([knowledge, examples]) => {
        if (!cancelled) setCustomKnowledge([...knowledge.data, ...examples.data]);
      })
      .catch(() => {
        // Static, reviewed training remains available when optional custom
        // knowledge is unavailable or the account cannot read that collection.
        if (!cancelled) setCustomKnowledge([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.recordId]);

  const speakReply = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = preferredFemaleVoice(voicesRef.current);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'en-IN';
    }
    utterance.rate = 0.9;
    utterance.pitch = 1.16;
    utterance.volume = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopRecognition = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      recognitionRef.current?.abort();
    }
  }, []);

  const startRecognition = useCallback(() => {
    const speechWindow = window as VoiceWindow;
    const Constructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor) {
      setError('Voice lookup is not available in this browser. You can type a request below.');
      return false;
    }
    if (!recognitionRef.current) {
      const recognition = new Constructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-IN';
      recognition.onresult = (event) => {
        let finalText = '';
        let interimText = '';
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript ?? '';
          if (result?.isFinal) finalText += text;
          else interimText += text;
        }
        const spoken = `${finalText}${interimText}`.trim();
        if (spoken) setTranscript(spoken);
        if (!finalText.trim()) return;
        const command = finalText.trim();
        const wakeMatch = command.match(/^(?:hello|hi)[\s,.:;-]+clara\b[\s,:-]*(.*)$/i);
        if (!activeRef.current) {
          if (!wakeMatch) return;
          setActive(true);
          activeRef.current = true;
          setWakeEnabled(true);
          wakeEnabledRef.current = true;
          setError(null);
          const followUp = wakeMatch[1]?.trim() ?? '';
          if (followUp) void runCommand(followUp);
          else {
            setResponse('I’m listening.');
            speakReply('I’m listening.');
          }
          return;
        }
        const withoutWake = command.replace(/^(?:hello|hi)[\s,.:;-]+clara\b[\s,:-]*/i, '').trim();
        void runCommand(withoutWake || command);
      };
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setError('Microphone access is blocked. Allow microphone access in the browser, or use typed lookup.');
        } else if (event.error && event.error !== 'aborted' && event.error !== 'no-speech') {
          setError('Voice lookup paused. You can retry or type a request.');
        }
        listeningRef.current = false;
        setListening(false);
      };
      recognition.onend = () => {
        listeningRef.current = false;
        setListening(false);
        if (wakeEnabledRef.current) {
          window.setTimeout(() => {
            if (!wakeEnabledRef.current || listeningRef.current) return;
            try {
              recognition.start();
              listeningRef.current = true;
              setListening(true);
            } catch {
              // Browser recognition can reject a restart while still closing.
            }
          }, 280);
        }
      };
      recognitionRef.current = recognition;
    }
    if (listeningRef.current) return true;
    try {
      recognitionRef.current.start();
      listeningRef.current = true;
      setListening(true);
      setError(null);
      return true;
    } catch {
      setError('Microphone access is unavailable. Allow it in the browser or use typed lookup.');
      return false;
    }
  }, [speakReply]);

  const closeAssistant = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    setWakeEnabled(false);
    wakeEnabledRef.current = false;
    stopRecognition();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, [stopRecognition]);

  const activate = useCallback(() => {
    setActive(true);
    activeRef.current = true;
    setWakeEnabled(true);
    wakeEnabledRef.current = true;
    setError(null);
    setResponse('I’m listening.');
    // Speak before opening recognition so Clara does not hear her own prompt.
    speakReply('I’m listening.');
    window.setTimeout(() => { void startRecognition(); }, 180);
  }, [speakReply, startRecognition]);

  // Keep a lightweight wake listener available while the user is signed in.
  // Browsers may still require a one-time microphone permission, but once it
  // is granted both “Hello Clara” and “Hi Clara” activate the hologram without
  // requiring a click on the launcher. The launcher remains a fallback when a
  // browser blocks background microphone start.
  useEffect(() => {
    if (!user) return undefined;
    const activateEvent = () => activate();
    window.addEventListener('clara:activate', activateEvent);
    const timer = window.setTimeout(() => {
      if (!activeRef.current && !listeningRef.current) {
        setWakeEnabled(true);
        wakeEnabledRef.current = true;
        void startRecognition();
      }
    }, 700);
    return () => {
      window.removeEventListener('clara:activate', activateEvent);
      window.clearTimeout(timer);
    };
  }, [activate, startRecognition, user?.recordId]);

  const runCommand = useCallback(async (rawCommand: string) => {
    const command = rawCommand.trim();
    if (!command) {
      setResponse('I’m listening.');
      speakReply('I’m listening.');
      return;
    }
    const normalized = command.toLowerCase();
    if (/^(?:stop|cancel|close|goodbye|that’s all|thats all)\b/.test(normalized)) {
      setResponse('Voice lookup is paused.');
      speakReply('Voice lookup is paused.');
      setActive(false);
      activeRef.current = false;
      setWakeEnabled(false);
      wakeEnabledRef.current = false;
      stopRecognition();
      return;
    }

    if (/\b(?:brief me|daily briefing|today(?:'s|s)? summary|work summary)\b/.test(normalized)) {
      try {
        const summary = await api<{
          metrics: Array<{ label: string; value: number }>;
          myTasks: PublicRecord[];
          notifications: Array<{ fields: Record<string, unknown> }>;
        }>('/dashboard/summary');
        const dueToday = summary.metrics.find((metric) => /due today/i.test(metric.label))?.value;
        const unread = summary.notifications.filter((item) => !Number(item.fields.is_read)).length;
        const taskCount = summary.myTasks.filter((task) => String(task.fields.status ?? '').toLowerCase() !== 'completed').length;
        const answer = `Today you have ${taskCount} assigned open task${taskCount === 1 ? '' : 's'}${typeof dueToday === 'number' ? `, ${dueToday} due today` : ''}, and ${unread} recent unread notification${unread === 1 ? '' : 's'}.`;
        setResponse(answer);
        speakReply(answer);
      } catch {
        const answer = 'I could not load your live dashboard summary right now.';
        setResponse(answer);
        speakReply(answer);
      }
      return;
    }

    const knowledgeAnswer = answerClaraQuestion(command, customKnowledge);
    if (knowledgeAnswer) {
      setResponse(knowledgeAnswer);
      speakReply(knowledgeAnswer);
      return;
    }

    const destination = resolveVoiceDestination(normalized);
    if (destination) {
      const answer = `Opening ${destination.label}.`;
      setResponse(answer);
      speakReply(answer);
      navigate(destination.route);
      return;
    }

    const answer = 'I can open tasks, employees, projects, departments, chat, invoices, clients, payroll, attendance and billing profiles. Ask me to open one of those areas, or ask a question about your authorised CRM work.';
    setResponse(answer);
    speakReply(answer);
  }, [customKnowledge, navigate, speakReply, stopRecognition]);

  useEffect(() => {
    if (!user) closeAssistant();
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // The browser may already have disposed the recognition session.
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [closeAssistant, user]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return undefined;
    const updateVoices = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    updateVoices();
    window.speechSynthesis.addEventListener('voiceschanged', updateVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', updateVoices);
  }, []);

  if (!user) return null;

  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    const command = typedCommand.trim();
    if (!command) return;
    setTranscript(command);
    setTypedCommand('');
    const wakeMatch = command.match(/^(?:hello|hi)[\s,.:;-]+clara\b[\s,:-]*(.*)$/i);
    if (wakeMatch && !activeRef.current) {
      activate();
      const followUp = wakeMatch[1]?.trim();
      if (followUp) window.setTimeout(() => { void runCommand(followUp); }, 180);
      return;
    }
    void runCommand(command);
  };

  return <>
    {!active && <button className="clara-voice-launcher" type="button" onClick={activate} aria-label="Activate Clara voice lookup"><span className="clara-voice-launcher__orb"><Sparkles size={18} /></span><span><strong>Clara</strong><small>Voice lookup</small></span><Mic size={17} /></button>}
    {active && <div className="clara-voice-backdrop" role="presentation">
      <section className="clara-voice-panel" role="dialog" aria-modal="true" aria-label="Clara voice lookup">
        <button className="icon-button clara-voice-close" type="button" onClick={closeAssistant} aria-label="Stop Clara"><X size={18} /></button>
        <ClaraHologram />
        <p className="eyebrow">CLARA VOICE LOOKUP</p>
        <h2>How can I help?</h2>
        <p className="clara-voice-status"><span className={`clara-voice-status__dot${listening ? ' clara-voice-status__dot--live' : ''}`} />{listening ? 'Listening for “Hello Clara” or your request' : 'Microphone paused'}</p>
        {transcript && <p className="clara-voice-transcript"><Mic size={15} /> “{transcript}”</p>}
        {response && <p className="clara-voice-response"><MessageCircle size={16} /> {response}</p>}
        {error && <p className="form-error clara-voice-error" role="alert">{error}</p>}
        <form className="clara-voice-form" onSubmit={submitTyped}><input value={typedCommand} onChange={(event) => setTypedCommand(event.target.value)} placeholder="Type a request to Clara…" aria-label="Type a request to Clara" /><button className="button" type="submit" disabled={!typedCommand.trim()}><Send size={16} /> Ask</button></form>
        <div className="clara-voice-actions"><button className="button button--secondary" type="button" onClick={() => { if (listening) stopRecognition(); else void startRecognition(); }}>{listening ? <><MicOff size={16} /> Pause microphone</> : <><Mic size={16} /> Start microphone</>}</button><button className="text-button" type="button" onClick={closeAssistant}>Stop and close</button></div>
        <small className="clara-voice-privacy">Voice lookup stays visible, uses browser speech controls, and does not secretly record meetings.</small>
      </section>
    </div>}
  </>;
}

function ClaraHologram() {
  return <div className="clara-holo-scene" aria-hidden="true">
    <div className="clara-office-room"><span className="clara-office-room__window" /><span className="clara-office-room__light clara-office-room__light--one" /><span className="clara-office-room__light clara-office-room__light--two" /><span className="clara-office-room__desk" /><span className="clara-office-room__plant" /></div>
    <div className="clara-hologram"><div className="clara-hologram__rings" />
      <svg className="clara-avatar" viewBox="0 0 220 300" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="claraSkin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffe0d1"/><stop offset=".55" stopColor="#f4b9af"/><stop offset="1" stopColor="#c9798d"/></linearGradient>
          <linearGradient id="claraHair" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#241c46"/><stop offset=".45" stopColor="#5f3e86"/><stop offset="1" stopColor="#9d6ab1"/></linearGradient>
          <linearGradient id="claraDress" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#b8ecff" stopOpacity=".9"/><stop offset=".48" stopColor="#6e9cff" stopOpacity=".7"/><stop offset="1" stopColor="#bc78ed" stopOpacity=".75"/></linearGradient>
          <filter id="claraGlow"><feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <ellipse cx="110" cy="282" rx="57" ry="9" fill="#64d9ff" opacity=".38" filter="url(#claraGlow)"/>
        <path d="M48 285c3-53 19-77 45-87h34c31 11 43 37 47 87z" fill="url(#claraDress)" stroke="#b9f4ff" strokeOpacity=".8" strokeWidth="2"/>
        <path d="M86 205l24 25 24-25 15 80H71z" fill="#d9f7ff" opacity=".42"/>
        <path d="M91 177h38v38c-9 10-28 10-38 0z" fill="url(#claraSkin)" stroke="#ffd8dd" strokeWidth="1.5"/>
        <path d="M55 111c-1-52 26-86 59-86 43 0 61 38 52 94 17 30 6 78-17 91-23 15-65 8-80-16-12-20-16-54-14-83z" fill="url(#claraHair)" stroke="#9fdbff" strokeOpacity=".56" strokeWidth="2"/>
        <ellipse cx="110" cy="123" rx="43" ry="58" fill="url(#claraSkin)" stroke="#ffdce2" strokeOpacity=".9" strokeWidth="1.4"/>
        <path d="M69 104c-5-33 12-68 43-70 35-2 53 31 44 70-13-20-30-23-43-22-17 1-27 8-44 22z" fill="url(#claraHair)"/>
        <path d="M72 93c-8-25 4-54 29-65-4 20 8 29 17 37-16 2-29 11-46 28z" fill="#3a2860" opacity=".9"/>
        <path d="M147 73c16 10 18 36 13 61 17 22 11 54-5 72 5-26 2-48-8-63z" fill="#71488f" opacity=".72"/>
        <ellipse cx="65" cy="126" rx="8" ry="15" fill="url(#claraSkin)" stroke="#ffd8df" strokeWidth="1.2"/><ellipse cx="155" cy="126" rx="8" ry="15" fill="url(#claraSkin)" stroke="#ffd8df" strokeWidth="1.2"/>
        <path d="M80 111q11-8 21 0M119 111q11-8 21 0" fill="none" stroke="#4c315e" strokeWidth="4" strokeLinecap="round"/>
        <ellipse cx="92" cy="126" rx="8" ry="10" fill="#25355e"/><ellipse cx="129" cy="126" rx="8" ry="10" fill="#25355e"/><circle cx="94" cy="123" r="3" fill="#effdff"/><circle cx="131" cy="123" r="3" fill="#effdff"/>
        <path d="M110 130c-3 8-5 14 2 16" fill="none" stroke="#bc7180" strokeWidth="2" strokeLinecap="round"/><path d="M98 155q12 10 25 0" fill="#b94c77" stroke="#ffb4cf" strokeWidth="2"/><path d="M101 157q9 4 19 0" fill="none" stroke="#ffe5ed" strokeWidth="1.5"/>
        <circle cx="62" cy="143" r="4" fill="#b8f2ff"/><circle cx="158" cy="143" r="4" fill="#b8f2ff"/><path d="M61 146l-5 13M159 146l5 13" stroke="#8ceaff" strokeWidth="1.5"/>
        <path d="M89 211l21 20 21-20" fill="none" stroke="#e9fcff" strokeWidth="2" opacity=".85"/><path d="M72 241h76M67 260h86" stroke="#d2f8ff" strokeWidth="1" opacity=".55"/>
      </svg><span /></div>
  </div>;
}

function resolveVoiceDestination(command: string): VoiceDestination | null {
  const recordId = command.match(/(?:task|employee|project|department|invoice|client|billing profile)\s+#?(\d+)/)?.[1];
  if (/\b(?:feature|features|home|dashboard)\b/.test(command)) return { label: 'your dashboard', route: '/dashboard' };
  if (/\b(?:task|tasks|work|to do|todo)\b/.test(command)) return { label: recordId ? `task ${recordId}` : 'tasks', route: recordId ? `/tasks/${recordId}` : '/tasks' };
  if (/\b(?:employee|employees|people|staff)\b/.test(command)) return { label: recordId ? `employee ${recordId}` : 'employees', route: recordId ? `/data/users/${recordId}` : '/data/users' };
  if (/\b(?:project|projects)\b/.test(command)) return { label: recordId ? `project ${recordId}` : 'projects', route: recordId ? `/projects/${recordId}` : '/projects' };
  if (/\b(?:department|departments)\b/.test(command)) return { label: recordId ? `department ${recordId}` : 'departments', route: recordId ? `/data/departments/${recordId}` : '/data/departments' };
  if (/\b(?:team|teams)\b/.test(command)) return { label: 'teams', route: '/data/teams' };
  if (/\b(?:chat|chats|message|messenger|conversation)\b/.test(command)) return { label: 'messenger', route: '/messenger' };
  if (/\b(?:invoice|invoices)\b/.test(command)) return { label: recordId ? `invoice ${recordId}` : 'invoices', route: recordId ? `/invoices/${recordId}` : '/invoices' };
  if (/\b(?:client|clients)\b/.test(command)) return { label: recordId ? `client ${recordId}` : 'clients', route: recordId ? `/data/clients/${recordId}` : '/data/clients' };
  if (/\b(?:payroll|salary|salaries|payslip|pay slip)\b/.test(command)) return { label: 'payroll and salary', route: /\bmy\b|\bmy salary\b/.test(command) ? '/my-salary' : '/payroll' };
  if (/\b(?:attendance|shift|overtime|leave)\b/.test(command)) return { label: 'attendance', route: '/attendance' };
  if (/\b(?:billing profile|billing profiles)\b/.test(command)) return { label: 'billing profiles', route: '/data/billing_profiles' };
  if (/\b(?:drive|files|documents)\b/.test(command)) return { label: 'Drive', route: '/data/drive_items' };
  if (/\b(?:notification|notifications|alerts)\b/.test(command)) return { label: 'notifications', route: '/notifications' };
  return null;
}

function preferredFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang));
  const candidates = english.length ? english : voices;
  const female = /female|clara|zira|samantha|victoria|karen|moira|tessa|veena|heera|raveena|susan|hazel|linda|aria|jenny|sonia|natasha|ava|emma|olivia/i;
  return candidates.find((voice) => female.test(voice.name)) ?? candidates.find((voice) => voice.localService) ?? candidates[0];
}
