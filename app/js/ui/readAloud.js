// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/ui/readAloud.js); keep the two in step.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { getSettings } from '../settings.js';
import { RATES, getReaderState, onReaderState, onVoicesChanged, setReadingRate, setReadingVoice, setVoiceEngine, skipReading, stopReading, toggleReading, voiceEngines, voices } from '../reader.js';
import { serverVoiceFor } from '../speech.js';
import { Icon } from './icons.js';
import { VoicePicker } from './voicePicker.js';

export function useVoices() {
  const [list, setList] = useState(voices);
  useEffect(() => onVoicesChanged(() => setList(voices())), []);
  return list;
}

/** The reader's state (reader.js), kept current. */
export function useReader() {
  const [reader, setReader] = useState(getReaderState);
  useEffect(() => onReaderState(setReader), []);
  return reader;
}

/** The player shown while a file is read aloud: back, play/pause, forward, speed, voice, stop. */
export function ReadAloudBar() {
  const reader = useReader();
  const list = useVoices();
  if (reader.status === 'idle') return null;
  const { rate, voice, server } = getSettings().tts;
  const nextRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
  const playing = reader.status === 'playing';
  return html`<div class="read-bar" role="region" aria-label="Read aloud">
    <button type="button" class="icon-btn sm" aria-label="Previous passage" title="Previous passage" disabled=${reader.index === 0} onClick=${() => skipReading(-1)}><${Icon} name="skipBack" size=${16} /></button>
    <button type="button" class="icon-btn play" aria-label=${playing ? 'Pause' : 'Play'} title=${playing ? 'Pause' : 'Play'} onClick=${toggleReading}><${Icon} name=${playing ? 'pause' : 'play'} size=${18} /></button>
    <button type="button" class="icon-btn sm" aria-label="Next passage" title="Next passage" disabled=${reader.index >= reader.total - 1} onClick=${() => skipReading(1)}><${Icon} name="skipForward" size=${16} /></button>
    <span class="read-progress" title=${reader.name}><span class="read-name">${reader.name}</span> ${reader.loading ? 'Preparing…' : `${reader.index + 1}/${reader.total}`}</span>
    <span class="spacer" />
    <button type="button" class="btn ghost sm read-rate" title="Speed" onClick=${() => setReadingRate(nextRate)}>${rate}×</button>
    ${reader.engine === 'server'
      ? html`<span class="read-server muted small" title="Change it in Settings → Read aloud">${serverVoiceFor(server, reader.lang) || server.model}</span>`
      : html`<${VoicePicker} className="read-voice" voices=${list} value=${voice} lang=${reader.lang} onChange=${setReadingVoice} engines=${voiceEngines()} onEngine=${setVoiceEngine} />`}
    <button type="button" class="icon-btn sm" aria-label="Stop reading" title="Stop" onClick=${stopReading}><${Icon} name="x" size=${16} /></button>
  </div>`;
}
