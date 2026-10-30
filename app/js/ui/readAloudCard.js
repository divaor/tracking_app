// Settings → Read aloud: the voices Listen uses (as in Tracker Editor's card): the device's own,
// or a speech server with an OpenAI-compatible API (Kokoro on this computer, OpenAI), whose key
// is a secret kept for that server's origin only.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { setVoiceEngine, startReading, stopReading, voiceEngines } from '../reader.js';
import { getSecret, originOf, saveSettings, setSecret, TTS_KEY_SECRET } from '../settings.js';
import { isNaturalVoice, languageName } from '../speech.js';
import { Segmented } from './components.js';
import { Icon } from './icons.js';
import { useVoices } from './readAloud.js';
import { VoicePicker } from './voicePicker.js';

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

const SPEECH_PRESETS = [
  {
    id: 'kokoro',
    label: 'Kokoro (this computer)',
    server: { baseUrl: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart', otherVoices: 'es=ef_dora, pt=pf_dora', instructions: '' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    server: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      otherVoices: '',
      instructions: 'Read like a warm, engaging audiobook narrator: natural pacing, clear enunciation, and short pauses between ideas.',
    },
  },
];
const SAMPLE = {
  en: 'Hi! This is how I sound when I read your items. I take a short breath between sentences, and a longer one between paragraphs.',
  es: 'Hola. Así sueno cuando leo tus pendientes. Hago una pausa corta entre frases, y una más larga entre párrafos.',
  pt: 'Olá! É assim que eu soo quando leio os seus itens. Faço uma pausa curta entre as frases e uma mais longa entre os parágrafos.',
};

const desktopApp = () => Boolean(window.desktop) && window.desktop.platform !== 'android';
const androidApp = () => window.desktop?.platform === 'android';

// Where a speech server can be reached from here, when the address will not work as it is.
function serverReach(url) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url.trim());
  if (desktopApp()) return null;
  if (androidApp()) return local ? 'localhost is this phone. For Kokoro on your computer, use the computer’s address on your network instead, such as http://192.168.1.20:8880/v1 (both on the same Wi-Fi).' : null;
  if (/^http:/i.test(url.trim()) && !local) return 'A browser reaches a speech server only on this device (localhost) or at an https address. The desktop app also reaches one elsewhere on your network.';
  return local ? 'A server at localhost is only reachable from the device it runs on. On a phone, use a server with an https address, such as OpenAI.' : null;
}

export function ReadAloudCard({ settings, actions }) {
  const { tts } = settings;
  const [server, setServer] = useState(tts.server);
  // The key is a secret: typed here, saved for this server's origin only.
  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  useEffect(() => {
    getSecret(TTS_KEY_SECRET).then((v) => setKeySaved(Boolean(v)), () => {});
  }, []);
  const keyHost = (() => {
    try {
      return tts.server.keyOrigin ? new URL(tts.server.keyOrigin).host : '';
    } catch {
      return '';
    }
  })();
  const keyHere = keySaved && tts.server.keyOrigin && tts.server.keyOrigin === originOf(server.baseUrl);
  const saveServer = async () => {
    const { apiKey: _old, ...rest } = server;
    let keyOrigin = tts.server.keyOrigin;
    try {
      if (key.trim()) {
        await setSecret(TTS_KEY_SECRET, key);
        keyOrigin = originOf(server.baseUrl);
        setKeySaved(true);
        setKey('');
      }
    } catch (err) {
      return actions.toast(`The key could not be saved: ${err.message}`, { kind: 'error' });
    }
    saveSettings({ tts: { server: { ...rest, apiKey: '', keyOrigin }, engine: 'server' } });
    actions.toast('Speech server saved');
  };
  const forgetKey = async () => {
    await setSecret(TTS_KEY_SECRET, '').catch(() => {});
    setKeySaved(false);
    saveSettings({ tts: { server: { keyOrigin: '' } } });
    actions.toast('The speech server’s key was removed from this device');
  };
  const reach = serverReach(server.baseUrl);
  const [sampleLang, setSampleLang] = useState(() => (Object.hasOwn(SAMPLE, navigator.language.slice(0, 2)) ? navigator.language.slice(0, 2) : 'en'));
  const list = useVoices();
  const natural = list.filter(isNaturalVoice).length;
  const engines = voiceEngines();
  const engineLabel = engines?.engines?.find((e) => e.name === engines.engine)?.label;
  const set = (patch) => setServer({ ...server, ...patch });
  // A sample in the chosen voice, or in `voice` (heard from the list) in its own language when there is a sample for it.
  const sample = (voice = null) => {
    const own = voice?.lang?.slice(0, 2).toLowerCase();
    const lang = voice && Object.hasOwn(SAMPLE, own) ? own : sampleLang;
    try {
      stopReading();
      startReading({ key: null, name: 'Voice sample', text: SAMPLE[lang], lang, voice: voice?.voiceURI ?? '' });
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    }
  };
  const field = (name, label, hint, extra = {}) => html`<${Field} label=${label} hint=${hint} wide=${extra.wide}>
    <input type=${extra.type ?? 'text'} value=${server[name]} onInput=${(e) => set({ [name]: e.currentTarget.value })} placeholder=${extra.placeholder ?? ''} spellcheck=${false} autocomplete="off" />
  </${Field}>`;
  return html`<${Card} title="Read aloud" icon="volume" id="read-aloud">
    <p class="muted">Listen (the speaker in an item, or L) reads the item to you: its title, notes, the document open in it and the comments, with a reader's pauses after sentences, paragraphs and headings. Plans, reviews and documents have their own Listen. How human it sounds depends mostly on the voice.</p>
    <${Segmented} label="Voices" value=${tts.engine} onChange=${(engine) => saveSettings({ tts: { engine } })}
      options=${[{ id: 'device', label: 'This device' }, { id: 'server', label: 'Speech server' }]} />
    ${tts.engine === 'device'
      ? html`<div class="field-grid">
          <div class="field span-2"><span>Voice</span>
            <${VoicePicker} className="wide" voices=${list} value=${tts.voice} lang=${sampleLang} onChange=${(voice) => saveSettings({ tts: { voice } })}
              engines=${engines} onEngine=${setVoiceEngine} onSample=${sample} />
            <small class="hint">${list.length ? `${list.length} voices${engineLabel ? ` from ${engineLabel}` : ' on this device'}${natural ? `, ${natural} of them natural-sounding (★)` : ''}. The list shows ${languageName(sampleLang)} first; ▶ plays one.` : 'This device lists no voices.'}</small>
          </div>
        </div>
        <details class="help"><summary>How do I get more natural voices?</summary>
          <ul>
            <li><strong>Android:</strong> in Settings, search for <em>Text-to-speech output</em>, choose <em>Speech Services by Google</em>, open its settings, then <em>Install voice data</em>, pick your language and try its voices.</li>
            <li><strong>iPhone and Mac:</strong> Settings → Accessibility → Spoken Content → Voices, and download an <em>Enhanced</em> or <em>Premium</em> voice.</li>
            <li><strong>Windows:</strong> in Microsoft Edge, the voices named <em>Online (Natural)</em> sound the most human; in Chrome, the <em>Google</em> voices. The desktop app only has the voices installed in Windows, so use a speech server there.</li>
          </ul>
        </details>`
      : html`<div class="field-grid">
          <div class="field span-2"><span>Server</span>
            <div class="input-row">
              <input value=${server.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder="http://localhost:8880/v1" spellcheck=${false} />
              ${SPEECH_PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${server.baseUrl === p.server.baseUrl ? 'primary' : ''}" onClick=${() => set({ ...p.server })}>${p.label}</button>`)}
            </div>
          </div>
          ${field('model', 'Model', 'kokoro, gpt-4o-mini-tts, tts-1-hd…')}
          ${field('voice', 'Voice', 'Kokoro: af_heart, af_bella, am_michael, bf_emma… OpenAI: coral, sage, nova, onyx…')}
          ${field('otherVoices', 'Voices for other languages', 'Used when an item is in that language, e.g. es=ef_dora, pt=pf_dora', { wide: true, placeholder: 'es=ef_dora, pt=pf_dora' })}
          ${field('instructions', 'Reading style', 'OpenAI gpt-4o-mini-tts only: how to read, in your words', { wide: true })}
          <${Field} label="API key"
            hint=${keyHere ? `Saved for ${keyHost}. Type a new one to replace it.` : keySaved && keyHost ? `The saved key is for ${keyHost}, so it is not sent to this server. Type one if this server needs it.` : 'Only if the server needs one (OpenAI). Kept in this device’s secure storage and sent only to this server.'}>
            <input type="password" value=${key} onInput=${(e) => setKey(e.currentTarget.value)} placeholder=${keyHere ? '••••••••' : ''} autocomplete="off" spellcheck=${false} />
          </${Field}>
          <div class="form-actions span-2">
            <button type="button" class="btn primary" onClick=${saveServer}>Save</button>
            ${keySaved && html`<button type="button" class="btn ghost" onClick=${forgetKey}>Remove the key</button>`}
          </div>
        </div>
        ${reach && html`<p class="notice"><${Icon} name="alert" size=${15} /><span>${reach}</span></p>`}
        <details class="help"><summary>How do I run Kokoro on my computer?</summary>
          <ol>
            <li>Install Docker Desktop, then run <code>docker run -d -p 8880:8880 --restart unless-stopped ghcr.io/remsky/kokoro-fastapi-cpu:latest</code> (with an NVIDIA graphics card, <code>kokoro-fastapi-gpu</code> is faster).</li>
            <li>Press <strong>Kokoro (this computer)</strong>, then <strong>Save</strong> and <strong>Hear a sample</strong>. It is free and nothing leaves your computer.</li>
            <li>Voices starting with <code>a</code> are American English, <code>b</code> British, <code>e</code> Spanish and <code>p</code> Portuguese; <code>f</code>/<code>m</code> is female or male.</li>
            <li>The same server works for Tracker Editor: set it up once in each app.</li>
          </ol>
        </details>`}
    <div class="form-actions">
      <button type="button" class="btn" onClick=${() => sample()}><${Icon} name="volume" size=${15} />Hear a sample</button>
      <select class="sample-lang" aria-label="Sample language" value=${sampleLang} onChange=${(e) => setSampleLang(e.currentTarget.value)}>
        <option value="en">English</option><option value="es">Español</option><option value="pt">Português</option>
      </select>
    </div>
  </${Card}>`;
}
