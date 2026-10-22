import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { createAsyncLlmClient, parseProfile, PLACEHOLDERS, PROFILE_EXAMPLE } from '../asyncLlm.js';
import { llmClient } from '../assistant.js';
import { DICTATION_LANGUAGES, dictationSupported } from './dictation.js';
import { DEFAULT_LLM_URL } from '../llm.js';
import { localFetch } from '../localFetch.js';
import { getSecret, getSettings, saveSettings, setSecret } from '../settings.js';
import { Segmented } from './components.js';
import { Icon } from './icons.js';

function Card({ title, icon, children, id }) {
  return html`<section class="settings-card" id=${id}>
    <h2>${icon && html`<${Icon} name=${icon} size=${18} />`}${title}</h2>
    ${children}
  </section>`;
}

function Field({ label, hint, children, wide = false }) {
  return html`<label class="field ${wide ? 'span-2' : ''}">
    <span>${label}</span>
    ${children}
    ${hint && html`<small>${hint}</small>`}
  </label>`;
}

function Check({ checked, onChange, label, hint, disabled = false }) {
  return html`<label class="field checkbox">
    <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span>${label}${hint && html`<small>${hint}</small>`}</span>
  </label>`;
}

const Notice = ({ check }) =>
  check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`;

const PRESETS = [
  { id: 'ollama', label: 'Ollama', url: DEFAULT_LLM_URL },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI-compatible server' },
  { id: 'async', label: 'Service that answers later' },
];

/** The model, set up as in Tracker Editor: a server on this computer, or a service that answers later. */
export function ModelCard({ actions }) {
  const settings = getSettings();
  const [provider, setProvider] = useState(settings.llm.provider || 'openai');
  return html`<${Card} title="Model" icon="sparkle" id="model">
    <p>With a model connected, quick add understands plain language (“call Ana tomorrow about the invoice, urgent”), each item gets <strong>Ask the model about this</strong> (summarize, break into steps, draft your review of a document, risks, translate, or any question), and the Overview can plan your day or review your week.</p>
    <div class="field span-2"><span>Connection</span>
      <${Segmented} options=${PROVIDERS} value=${provider} onChange=${setProvider} label="Connection" />
    </div>
    ${provider === 'async' ? html`<${AsyncModelForm} actions=${actions} />` : html`<${OpenAiModelForm} actions=${actions} />`}
  </${Card}>`;
}

function OpenAiModelForm({ actions }) {
  const { llm } = getSettings();
  const [form, setForm] = useState(llm);
  const [models, setModels] = useState(null);
  const [check, setCheck] = useState(null);
  const set = (patch) => setForm({ ...form, ...patch });
  const test = async () => {
    setCheck({ state: 'busy', text: 'Connecting…' });
    try {
      const list = (await llmClient({ llm: { ...form, provider: 'openai' } }).listModels()).filter((m) => !/embed|bge|e5|minilm|nomic/i.test(m));
      setModels(list);
      setForm((f) => ({ ...f, chatModel: f.chatModel || list[0] || '' }));
      setCheck({ state: 'ok', text: list.length ? `Connected. ${list.length} model${list.length === 1 ? '' : 's'} available.` : 'Connected, but no models are downloaded yet (for Ollama: ollama pull llama3.2).' });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = () => {
    saveSettings({ llm: { ...form, provider: 'openai', webhook: llm.webhook, enabled: true } });
    actions.toast('Model saved and turned on.');
  };
  const options = [...new Set([form.chatModel, ...(models ?? [])].filter(Boolean))];
  return html`
    <p class="muted">A model running on this computer: nothing leaves your machine. Works with <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a> and other servers with an OpenAI-compatible API. Tracker Editor can use the same one.</p>
    ${!window.desktop && html`<p class="notice"><${Icon} name="alert" size=${15} />In a browser this only reaches the model if the server allows this site. The desktop app needs no extra setup.</p>`}
    <div class="field-grid">
      <div class="field span-2"><span>Server</span>
        <div class="input-row">
          <input value=${form.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder=${DEFAULT_LLM_URL} spellcheck=${false} aria-label="Server" />
          ${PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${form.baseUrl === p.url ? 'primary' : ''}" onClick=${() => set({ baseUrl: p.url })}>${p.label}</button>`)}
        </div>
      </div>
      <${Field} label="Chat model" hint="e.g. llama3.2, qwen2.5, mistral">
        ${models
          ? html`<select value=${form.chatModel} onChange=${(e) => set({ chatModel: e.currentTarget.value })}><option value="">Choose…</option>${options.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`
          : html`<input value=${form.chatModel} onInput=${(e) => set({ chatModel: e.currentTarget.value })} placeholder="llama3.2" spellcheck=${false} />`}
      </${Field}>
      <${Field} label="API key" hint="Only if your server needs one"><input type="password" value=${form.apiKey} onInput=${(e) => set({ apiKey: e.currentTarget.value })} autocomplete="off" /></${Field}>
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${!form.chatModel} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" onClick=${test}>Test and list models</button>
        ${llm.enabled && llm.provider !== 'async' && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      <${Notice} check=${check} />
    </div>
    <details class="help"><summary>How do I set up Ollama?</summary>
      <ol>
        <li>Install Ollama from ollama.com and start it.</li>
        <li>In a terminal: <code>ollama pull llama3.2</code>.</li>
        <li>Press <strong>Ollama</strong>, then <strong>Test and list models</strong>, pick the model and press <strong>Save and turn on</strong>.</li>
        ${!window.desktop && html`<li>In the browser, Ollama must also allow this site: set <code>OLLAMA_ORIGINS=${location.origin}</code> and restart it. The desktop app needs none of this.</li>`}
      </ol>
    </details>`;
}

// A model service that takes a request, answers with a task id, and gives the
// answer later (asyncLlm.js). Everything about the service is in the profile.
function AsyncModelForm({ actions }) {
  const { llm } = getSettings();
  const [profileText, setProfileText] = useState(llm.profile);
  const [model, setModel] = useState(llm.provider === 'async' ? llm.chatModel : '');
  const [apiKey, setApiKey] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [hook, setHook] = useState(llm.webhook);
  const [check, setCheck] = useState(null);
  const [saved, setSaved] = useState({ key: false, secret: false });
  useEffect(() => {
    Promise.all([getSecret('llm-api-key'), getSecret('llm-webhook-secret')]).then(([k, sec]) => setSaved({ key: Boolean(k), secret: Boolean(sec) }));
  }, []);
  const parsed = profileText.trim() ? parseProfile(profileText) : { error: 'Paste the connection profile for your service, or start from the example.' };
  const setHookField = (patch) => setHook({ ...hook, ...patch });
  const storeSecrets = async () => {
    if (apiKey) await setSecret('llm-api-key', apiKey);
    if (hookSecret) await setSecret('llm-webhook-secret', hookSecret);
    setSaved({ key: saved.key || Boolean(apiKey), secret: saved.secret || Boolean(hookSecret) });
    setApiKey('');
    setHookSecret('');
  };
  const test = async () => {
    if (parsed.error) return setCheck({ state: 'error', text: parsed.error });
    setCheck({ state: 'busy', text: 'Sending a test question…' });
    try {
      const client = createAsyncLlmClient({ profile: parsed.profile, apiKey: apiKey || (await getSecret('llm-api-key')), fetchImpl: localFetch });
      const started = Date.now();
      const answer = await client.chat({
        model,
        purpose: 'test',
        messages: [{ role: 'user', content: 'Reply with one short sentence: say that the connection works.' }],
        onState: (state) => setCheck({ state: 'busy', text: `Task ${state || 'sent'}… (${Math.round((Date.now() - started) / 1000)} s)` }),
      });
      setCheck({ state: 'ok', text: `It answered in ${Math.round((Date.now() - started) / 1000)} s: ${answer.slice(0, 300)}` });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = async () => {
    if (parsed.error) return setCheck({ state: 'error', text: parsed.error });
    await storeSecrets();
    saveSettings({ llm: { enabled: true, provider: 'async', profile: profileText, chatModel: model || 'default', webhook: hook } });
    actions.toast('Model service saved and turned on.');
  };
  return html`<p class="muted">For a model service that answers later: a request gives back a task id, and the answer comes from a status address, or by webhook to this computer. Describe the service in a connection profile (the same as in Tracker Editor); the API key is stored ${window.desktop ? 'in this computer’s keychain' : 'in this browser'}, not in the profile.</p>
    ${!window.desktop && html`<p class="notice"><${Icon} name="alert" size=${15} />In a browser the service must allow requests from this page (CORS), and webhooks are not available. The desktop app needs neither.</p>`}
    <div class="field-grid">
      <label class="field span-2"><span>Connection profile (JSON)</span>
        <textarea class="profile-input" rows="12" spellcheck=${false} value=${profileText} onInput=${(e) => setProfileText(e.currentTarget.value)} placeholder="{ &quot;submit&quot;: { … }, &quot;status&quot;: { … } }" />
      </label>
      <div class="form-actions span-2">
        <button type="button" class="btn sm" onClick=${() => setProfileText(JSON.stringify(PROFILE_EXAMPLE, null, 2))}>Start from the example</button>
        <span class="muted small ${parsed.error ? 'error-text' : ''}">${parsed.error ?? 'The profile looks right.'}</span>
      </div>
      <${Field} label="Model or agent name" hint="Fills {{model}} in the profile"><input value=${model} onInput=${(e) => setModel(e.currentTarget.value)} spellcheck=${false} /></${Field}>
      <${Field} label="API key" hint=${saved.key ? 'Saved. Type a new one to replace it.' : 'Sent in the header the profile names'}><input type="password" value=${apiKey} onInput=${(e) => setApiKey(e.currentTarget.value)} placeholder=${saved.key ? '••••••••' : ''} autocomplete="off" /></${Field}>
      ${window.desktop?.webhook &&
      html`<${Check} checked=${hook.enabled} label="Receive answers by webhook" hint="The service calls this computer when a task ends; the app still checks the status now and then" onChange=${(v) => setHookField({ enabled: v })} />
        ${hook.enabled &&
        html`<${Field} label="Port" hint="Not the same port as Tracker Editor's"><input type="number" min="1024" max="65535" value=${hook.port} onInput=${(e) => setHookField({ port: Number(e.currentTarget.value) })} /></${Field}>
          <${Field} label="Path"><input value=${hook.path} onInput=${(e) => setHookField({ path: e.currentTarget.value })} spellcheck=${false} /></${Field}>
          <${Field} label="Address the service calls" wide hint=${`Fills {{webhook_url}}, e.g. http://my-pc.example.com:${hook.port}${hook.path}`}><input value=${hook.publicUrl} onInput=${(e) => setHookField({ publicUrl: e.currentTarget.value.trim() })} spellcheck=${false} /></${Field}>
          <${Field} label="Webhook secret" wide hint=${saved.secret ? 'Saved. Events must be signed with it (HMAC-SHA256).' : 'Strongly advised: without it, anything on your network could send answers.'}><input type="password" value=${hookSecret} onInput=${(e) => setHookSecret(e.currentTarget.value)} placeholder=${saved.secret ? '••••••••' : ''} autocomplete="off" /></${Field}>`}`}
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${Boolean(parsed.error)} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" disabled=${check?.state === 'busy'} onClick=${test}>Send a test question</button>
        ${llm.enabled && llm.provider === 'async' && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      <${Notice} check=${check} />
    </div>
    <details class="help"><summary>How do I write the profile?</summary>
      <ul>
        <li><code>submit</code>: the address, method and JSON body that send a question, and <code>taskId</code>, where the task id is in the answer.</li>
        <li><code>status</code>: how to ask how the task is going; <code>state</code>, <code>answer</code> and <code>error</code> say where those are, <code>done</code> and <code>failed</code> list the states that end it.</li>
        <li>Placeholders: ${PLACEHOLDERS.map((p, i) => html`${i ? ', ' : ''}<code>{{${p}}}</code>`)}. Tracker Editor's README describes every field.</li>
      </ul>
    </details>`;
}

// "CommandOrControl+Alt+T" → "Ctrl+Alt+T" (⌘ on a Mac).
const shortcutLabel = (accelerator) => accelerator.replace(/CommandOrControl|CmdOrCtrl/g, window.desktop?.platform === 'darwin' ? '⌘' : 'Ctrl');

/** A key press as an Electron accelerator, e.g. Ctrl+Alt+T → "CommandOrControl+Alt+T" ('' while only modifiers are held). */
function acceleratorFrom(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return '';
  const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.code === 'Space' ? 'Space' : '';
  const mods = [(e.ctrlKey || e.metaKey) && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return key && mods.length ? [...mods, key].join('+') : '';
}

const SHORTCUT_PROBLEMS = {
  taken: 'Another app already uses this shortcut. Pick another one.',
  invalid: 'That is not a shortcut this computer can use. Pick another one.',
};

/** Quick add: plain language with the model, dictation on phones, and a shortcut that works anywhere on the desktop. */
export function QuickAddCard() {
  const settings = getSettings();
  const [capture, setCapture] = useState(null);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    window.desktop?.capture?.get().then(setCapture);
  }, []);
  const setPrefs = async (patch) => setCapture(await window.desktop.capture.set(patch));
  const problem = capture?.enabled && SHORTCUT_PROBLEMS[capture.status];
  return html`<${Card} title="Quick add" icon="plus" id="quick-add">
    <p class="muted">Type <code>Write report +project #tag !high @tomorrow</code>, or paste a link.</p>
    <div class="field-grid">
      <${Check} checked=${settings.smartAdd} disabled=${!settings.llm.enabled} label="Understand plain language with the model"
        hint=${settings.llm.enabled ? '“call Ana tomorrow about the invoice, urgent” gets its due date, priority, project and tags. What you type with + # ! @ stays as typed.' : 'Connect a model under Model first.'}
        onChange=${(v) => saveSettings({ smartAdd: v })} />
      ${dictationSupported() &&
      html`<${Field} label="Dictation language" hint="For the microphone in quick add (it uses your browser's speech service)">
        <select value=${settings.dictationLang} onChange=${(e) => saveSettings({ dictationLang: e.currentTarget.value })}>
          ${DICTATION_LANGUAGES.map((l) => html`<option key=${l.id} value=${l.id}>${l.label}</option>`)}
        </select>
      </${Field}>`}
    </div>
    ${capture &&
    html`<h3 class="settings-sub">From anywhere on this computer</h3>
      <p class="muted small">A shortcut that works in any app opens a small window to add a task or an idea. It keeps working with the window closed while Tracker runs in the tray.</p>
      <div class="field-grid">
        <${Check} checked=${capture.enabled} label="Quick add shortcut" onChange=${(v) => setPrefs({ enabled: v })} />
        <${Field} label="Shortcut">
          <span class="shortcut-field">
            <input readonly value=${recording ? 'Press the keys…' : shortcutLabel(capture.shortcut)} aria-label="Quick add shortcut" class=${problem ? 'invalid' : ''}
              onFocus=${() => setRecording(true)} onBlur=${() => setRecording(false)}
              onKeyDown=${(e) => {
                if (e.key === 'Tab') return;
                e.preventDefault();
                if (e.key === 'Escape') return e.currentTarget.blur();
                const accelerator = acceleratorFrom(e);
                if (!accelerator) return;
                e.currentTarget.blur();
                setPrefs({ shortcut: accelerator });
              }} />
            <button type="button" class="btn sm" onClick=${() => window.desktop.capture.open()}>Try it</button>
          </span>
        </${Field}>
        ${problem && html`<p class="notice error span-2" role="alert">${problem}</p>`}
      </div>`}
  </${Card}>`;
}
