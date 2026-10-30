import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { getSettings } from '../settings.js';
import { Icon } from './icons.js';

// Dictation into quick add, with the browser's speech service (as Tracker
// Editor's voice notes), or in the Android app the phone's own speech input (its
// WebView has none). The desktop app has no speech service.
const Recognition = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const phoneDictation = () => globalThis.window?.desktop?.android?.dictate ?? null;
export const dictationSupported = () => Boolean(phoneDictation()) || (Boolean(Recognition()) && !globalThis.window?.desktop);

export const DICTATION_LANGUAGES = [
  { id: '', label: "This device's language" },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-MX', label: 'Spanish (Mexico)' },
  { id: 'es-ES', label: 'Spanish (Spain)' },
  { id: 'es-US', label: 'Spanish (US)' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
];

const PROBLEMS = {
  'not-allowed': 'Allow the microphone for this app to dictate.',
  'service-not-allowed': 'Allow the microphone for this app to dictate.',
  'audio-capture': 'No microphone was found.',
  network: 'Dictation needs a connection: the browser turns speech into text with its speech service.',
};

/**
 * The microphone in quick add: listens to one phrase and hands it to
 * `onText(text, final)` as it is heard. Tap again to stop.
 */
export function MicButton({ onText, onError }) {
  const [listening, setListening] = useState(false);
  const rec = useRef(null);
  useEffect(() => () => rec.current?.abort(), []);
  if (!dictationSupported()) return null;
  // The phone's speech input: its own screen listens to one phrase.
  const startPhone = async () => {
    setListening(true);
    try {
      const text = await phoneDictation()({ lang: getSettings().dictationLang || navigator.language || '' });
      if (text) onText(text.trim(), true);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setListening(false);
    }
  };
  const start = () => {
    if (phoneDictation()) return startPhone();
    const R = Recognition();
    const r = (rec.current = new R());
    r.lang = getSettings().dictationLang || navigator.language || 'en-US';
    r.continuous = false;
    r.interimResults = true;
    r.onresult = (e) => {
      const text = [...e.results].map((res) => res[0].transcript).join('');
      onText(text.trim(), e.results[e.results.length - 1].isFinal);
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(PROBLEMS[e.error] ?? `Dictation stopped (${e.error}).`);
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      setListening(true);
    } catch (err) {
      onError?.(err.message);
    }
  };
  return html`<button type="button" class="icon-btn mic-btn ${listening ? 'listening' : ''}" aria-pressed=${listening}
    aria-label=${listening ? 'Stop dictating' : 'Dictate'} title=${listening ? 'Listening… tap to stop' : 'Say it instead of typing'}
    onClick=${() => (listening ? rec.current?.stop() : start())}><${Icon} name="mic" size=${18} /></button>`;
}

/** Starts dictating into quick add (the Android app's Voice note shortcut): its microphone, pressed. */
export function dictateIntoQuickAdd() {
  document.querySelector('.quick-add .mic-btn:not(.listening)')?.click();
}
