// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/reader.js); keep the two in step.
// Read aloud, one passage at a time, so reading can be paused, skipped and
// highlighted, with a reader's pauses between passages. Two engines:
// - device: the device's own voices (Web Speech API; in the Android app, whose
//   WebView has none, Android's text to speech through the app: androidApp.js
//   `tts`). Free and offline; how natural it sounds depends on the voices
//   installed. In the app the next passages are made into audio while one plays
//   and played here, so a voice slower than speech (Kokoro on the phone) does not
//   leave a silence before each sentence; an engine that cannot do that speaks
//   them itself. The screen stays on while reading, because phones stop speech
//   when it turns off.
// - server: a speech server with an OpenAI-compatible API (Kokoro on this
//   computer, OpenAI, …) for natural voices. Played as audio, the next passage
//   fetched ahead, with play/pause on the lock screen and the screen free to
//   turn off.
import { localFetch } from './localFetch.js';
import { TTS_KEY_SECRET, getSecret, getSettings, originOf, saveSettings } from './settings.js';
import { PAUSES, detectLanguage, passageAt, rankVoices, serverVoiceFor, speechPassages } from './speech.js';

export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// Passage size: device voices speak sentence by sentence, a speech server gets whole paragraphs for better intonation.
const MAX_PASSAGE = { device: 240, server: 700 };
// Passages made ahead of the one playing: a speech server's (each a request), the phone's voices'.
const AHEAD = { server: 2, device: 3 };

let state = { status: 'idle', key: null, name: '', index: 0, total: 0, lang: '', engine: 'device', voice: '', loading: false, error: '' };
let passages = [];
let highlight = () => {};
let shownBy = null; // this reading's own highlighter (a document shows its passages itself)
const show = (passage) => (shownBy ?? highlight)(state.key, passage);
const listeners = new Set();

let run = 0; // bumped whenever speech is interrupted, so callbacks of the old passage do nothing
let gapTimer = null;
let wakeLock = null;
let audio = null; // the server engine's player
let audioIndex = -1; // the passage loaded in it
let audioUrls = new Map(); // passage index → Promise of an object URL
let fetches = null; // AbortController for this reading's server requests
let direct = false; // this reading's phone voices speak each passage themselves (making audio failed)

const synth = () => window.speechSynthesis;
// Android's text to speech in the app, else the browser's.
const native = () => (typeof window !== 'undefined' && window.desktop?.android?.tts) || null;
const webSpeech = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
export const canSpeak = () => Boolean(native()) || webSpeech();
// The Android app speaks with the engine chosen in the settings (the phone's preferred one by default).
const useEngine = () => native()?.setEngine?.(getSettings().tts.androidEngine ?? '');
export const voices = () => (useEngine(), native()?.voices() ?? (webSpeech() ? synth().getVoices() : []));
/** The Android app's engines ({ engine, systemEngine, engines: [{ name, label }] }), elsewhere null. */
export const voiceEngines = () => native()?.engines?.() ?? null;
/** `fn()` when the list of voices changes (they load after the page). */
export function onVoicesChanged(fn) {
  if (native()) return native().onVoicesChanged(fn);
  const s = webSpeech() && synth();
  if (!s?.addEventListener) return () => {};
  s.addEventListener('voiceschanged', fn);
  return () => s.removeEventListener('voiceschanged', fn);
}
export const getReaderState = () => state;
const usesServer = () => getSettings().tts.engine === 'server';
// Played as audio here: a speech server's, and in the Android app the phone's voices made ahead.
const playsAudio = () => state.engine === 'server' || (state.engine === 'device' && !direct && typeof native()?.synthesize === 'function');

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
  updateMediaSession();
}

export function onReaderState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `fn(key, { from, to } | null)` shows the passage being read. */
export function setReaderHighlighter(fn) {
  highlight = fn;
}

async function keepScreenOn(on) {
  if (native()) return native().keepAwake(on);
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    // Not allowed here; reading goes on with the screen's normal timeout.
  }
}

// ---- Device voices -----------------------------------------------------------------

/** The chosen voice (this reading's own, as for a sample), else the most natural-sounding one for the text's language, else the device default. */
function pickVoice(lang) {
  const all = voices();
  const wanted = state.voice || getSettings().tts.voice;
  const chosen = wanted && all.find((v) => v.voiceURI === wanted);
  if (chosen) return chosen;
  const best = rankVoices(all, lang)[0];
  return best && lang && best.lang.toLowerCase().replace('_', '-').startsWith(lang) ? best : null;
}

function speakDevice(passage, next, fail) {
  const voice = pickVoice(state.lang);
  const { rate } = getSettings().tts;
  if (native()) {
    native()
      .speak({ text: passage.text, voice: voice?.voiceURI ?? '', lang: voice?.lang ?? state.lang, rate: passage.kind === 'heading' ? rate * 0.92 : rate })
      .then(next, (err) => err?.code !== 'interrupted' && fail(`Reading stopped: ${err?.message ?? err}.`));
    return;
  }
  const u = new SpeechSynthesisUtterance(passage.text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else if (state.lang) u.lang = state.lang;
  // Headings a touch slower, like a reader announcing a section.
  u.rate = passage.kind === 'heading' ? rate * 0.92 : rate;
  u.onend = next;
  u.onerror = (e) => e.error !== 'interrupted' && e.error !== 'canceled' && fail(e.error === 'not-allowed' ? 'Tap play to start reading.' : `Reading stopped (${e.error}).`);
  synth().speak(u);
}

// ---- Speech server -----------------------------------------------------------------

/** Asks the speech server for one passage; resolves to an object URL of the audio. */
async function synthesize(text, signal) {
  const s = getSettings().tts.server;
  const base = s.baseUrl.trim().replace(/\/+$/, '');
  // The key goes only to the server it was saved for (an old one still in the settings, until it moves).
  const key = s.apiKey || (s.keyOrigin && s.keyOrigin === originOf(base) ? await getSecret(TTS_KEY_SECRET).catch(() => '') : '');
  let res;
  try {
    res = await localFetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: s.model, voice: serverVoiceFor(s, state.lang), input: text, response_format: 'mp3', ...(s.instructions.trim() ? { instructions: s.instructions.trim() } : {}) }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`Could not reach the speech server at ${base}. Is it running?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      detail = JSON.parse(body)?.error?.message ?? JSON.parse(body)?.detail ?? detail;
    } catch {
      // not JSON
    }
    throw new Error(`The speech server answered ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  return URL.createObjectURL(await res.blob());
}

/** The phone's voice reading one passage, made into audio (not played); resolves to an object URL. */
async function phoneAudio(passage) {
  const voice = pickVoice(state.lang);
  const { rate } = getSettings().tts;
  const blob = await native().synthesize({ text: passage.text, voice: voice?.voiceURI ?? '', lang: voice?.lang ?? state.lang, rate: passage.kind === 'heading' ? rate * 0.92 : rate });
  return URL.createObjectURL(blob);
}

function audioFor(index) {
  if (!audioUrls.has(index)) {
    const promise = state.engine === 'server' ? synthesize(passages[index].text, fetches?.signal) : phoneAudio(passages[index]);
    promise.catch(() => audioUrls.get(index) === promise && audioUrls.delete(index));
    audioUrls.set(index, promise);
  }
  return audioUrls.get(index);
}

function forgetAudio(keep = () => false) {
  for (const [i, promise] of audioUrls) {
    if (keep(i)) continue;
    promise.then(URL.revokeObjectURL, () => {});
    audioUrls.delete(i);
  }
}

async function playAudio(passage, myRun, next, fail) {
  const index = state.index;
  if (!audioUrls.has(index)) set({ loading: true });
  let url;
  try {
    url = await audioFor(index);
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'interrupted' || myRun !== run) return;
    if (state.engine === 'device' && !direct) {
      // This phone's engine cannot make audio files: it speaks each passage itself instead.
      direct = true;
      forgetAudio();
      speakCurrent();
      return;
    }
    fail(err.message);
    return;
  } finally {
    if (myRun === run) set({ loading: false });
  }
  if (myRun !== run || state.status !== 'playing') return;
  for (let i = index + 1; i <= Math.min(index + AHEAD[state.engine], passages.length - 1); i++) audioFor(i).catch(() => {});
  forgetAudio((i) => i >= index - 1);
  audio ??= new Audio();
  audio.src = url;
  audioIndex = index;
  // A server's audio is sped up here; the phone's voices were made at the speed already.
  audio.playbackRate = state.engine === 'server' ? getSettings().tts.rate : 1;
  audio.preservesPitch = true;
  audio.onended = next;
  audio.onerror = () => fail(state.engine === 'server' ? 'This device cannot play the audio the speech server sent.' : 'This device cannot play the audio its voice made.');
  try {
    await audio.play();
  } catch (err) {
    // A pause right after the start cancels play() (AbortError); that is not a failure.
    if (err?.name !== 'AbortError' && myRun === run) fail(err?.name === 'NotAllowedError' ? 'Tap play to start reading.' : err.message);
  }
}

// The app's name (index.html's application-name), for the lock screen's player.
const appName = () => (typeof document !== 'undefined' && document.querySelector('meta[name="application-name"]')?.content) || '';

function updateMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || state.engine !== 'server') return;
  const session = navigator.mediaSession;
  if (state.status === 'idle') {
    session.metadata = null;
    session.playbackState = 'none';
    return;
  }
  if (typeof MediaMetadata === 'function') session.metadata = new MediaMetadata({ title: state.name, artist: appName(), album: `Passage ${state.index + 1} of ${state.total}` });
  session.playbackState = state.status === 'playing' ? 'playing' : 'paused';
}

function setMediaHandlers(on) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const handlers = { play: resumeReading, pause: pauseReading, stop: stopReading, previoustrack: () => skipReading(-1), nexttrack: () => skipReading(1) };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, on ? fn : null);
    } catch {
      // action not supported here
    }
  }
}

// ---- Reading ---------------------------------------------------------------------

// Stops whatever is speaking; the passage and position stay.
function silence() {
  run++;
  clearTimeout(gapTimer);
  gapTimer = null;
  if (native()) native().stop();
  else if (webSpeech()) synth().cancel();
  if (audio) audio.pause();
  audioIndex = -1;
}

function speakCurrent() {
  const passage = passages[state.index];
  if (!passage) return finish();
  const myRun = run;
  show(passage);
  const next = () => {
    if (myRun !== run) return;
    if (state.index + 1 >= passages.length) return finish();
    // The device voices get a reader's pause; a speech server's audio already breathes.
    const gap = state.engine === 'device' ? passage.pause / getSettings().tts.rate : 0;
    gapTimer = setTimeout(() => {
      gapTimer = null;
      if (myRun !== run) return;
      set({ index: state.index + 1 });
      speakCurrent();
    }, gap);
  };
  const fail = (message) => myRun === run && finish(message);
  if (playsAudio()) playAudio(passage, myRun, next, fail);
  else speakDevice(passage, next, fail);
}

function finish(error = '') {
  silence();
  show(null);
  shownBy = null;
  fetches?.abort();
  forgetAudio();
  passages = [];
  set({ status: 'idle', index: 0, total: 0, voice: '', loading: false, error });
  setMediaHandlers(false);
  keepScreenOn(false);
}

/**
 * Reads `text` aloud from the passage at `from`; with a selection (to > from),
 * only the selection. Markdown is read as prose. The language (en, es, …) is
 * guessed from the text unless given. `onPassage(key, passage | null)` shows the
 * passages of this reading instead of the editor's highlighter; `kindOf(passage)` may say
 * what a whole paragraph is (a heading, a list item, a table cell: speech.js PAUSES).
 */
export function startReading({ key, name, text, markdown = false, from = 0, to = 0, lang: language = '', onPassage = null, kindOf = null, voice = '' }) {
  const engine = usesServer() ? 'server' : 'device';
  if (engine === 'device' && !canSpeak()) throw new Error('This browser cannot read aloud. Choose a speech server in Settings → Read aloud.');
  if (state.status !== 'idle') finish();
  shownBy = onPassage;
  const lang = language || detectLanguage(text) || (navigator.language || 'en').slice(0, 2).toLowerCase();
  const options = { markdown, lang, maxPassage: MAX_PASSAGE[engine] };
  const selection = to > from;
  let list = selection ? speechPassages(text.slice(from, to), options).map((p) => ({ ...p, from: p.from + from, to: p.to + from })) : speechPassages(text, options);
  if (kindOf) {
    list = list.map((p) => {
      const kind = p.kind === 'paragraph' ? kindOf(p) : null;
      return kind && PAUSES[kind] != null ? { ...p, kind, pause: PAUSES[kind] } : p;
    });
    // A heading follows a longer silence, like a new section.
    list.forEach((p, i) => list[i + 1]?.kind === 'heading' && (p.pause = Math.max(p.pause, PAUSES.heading)));
  }
  if (!list.length) throw new Error('There is nothing to read here.');
  passages = list;
  fetches = new AbortController();
  direct = false;
  if (engine === 'device') {
    if (!native()) synth().cancel(); // clears a queue some browsers keep after a page reload
    keepScreenOn(true);
  } else setMediaHandlers(true);
  useEngine();
  set({ status: 'playing', key, name, index: selection ? 0 : passageAt(list, from), total: list.length, lang, engine, voice, loading: false, error: '' });
  speakCurrent();
}

export function pauseReading() {
  if (state.status !== 'playing') return;
  // Audio pauses mid-sentence; voices that speak themselves restart the passage on resume.
  if (playsAudio() && audioIndex === state.index && !gapTimer) audio.pause();
  else silence();
  set({ status: 'paused' });
  keepScreenOn(false);
}

export function resumeReading() {
  if (state.status !== 'paused') return;
  set({ status: 'playing' });
  if (state.engine === 'device') keepScreenOn(true);
  if (playsAudio() && audio && audioIndex === state.index && !audio.ended) {
    audio.play().catch(() => speakCurrent());
    return;
  }
  speakCurrent();
}

export const toggleReading = () => (state.status === 'playing' ? pauseReading() : resumeReading());
export const stopReading = () => state.status !== 'idle' && finish();

/** Moves `step` passages forward or back. */
export function skipReading(step) {
  if (state.status === 'idle') return;
  const index = Math.max(0, Math.min(passages.length - 1, state.index + step));
  silence();
  set({ index });
  if (state.status === 'playing') speakCurrent();
  else show(passages[index]);
}

// Device voices take a new speed or voice from the start of the current passage (audio made ahead is made again).
function restartPassage() {
  silence();
  forgetAudio();
  if (state.status === 'playing') speakCurrent();
}

export function setReadingRate(rate) {
  saveSettings({ tts: { rate } });
  if (state.engine === 'server') {
    if (audio) audio.playbackRate = rate;
  } else if (state.status !== 'idle') restartPassage();
  set({});
}

export function setReadingVoice(voice) {
  saveSettings({ tts: { voice } });
  state = { ...state, voice: '' };
  if (state.engine === 'device' && state.status !== 'idle') restartPassage();
  set({});
}

/** The Android app: speak with the engine of package `name` ('' = the phone's preferred one), its automatic voice. */
export function setVoiceEngine(name) {
  const info = voiceEngines();
  saveSettings({ tts: { androidEngine: name && name === info?.systemEngine ? '' : name, voice: '' } });
  useEngine();
  if (state.engine === 'device' && state.status !== 'idle') restartPassage();
  set({});
}

if (typeof document !== 'undefined') {
  // The screen lock is dropped when the app is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => state.status === 'playing' && state.engine === 'device' && keepScreenOn(true));
}
