// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/ui/voicePicker.js); keep the two in step.
// Picking a voice: our own list instead of a <select>, whose popup a phone draws itself (large
// text, one line) where many voices look alike. Each voice shows its name and, smaller, what it
// is (speech.js describeVoice: accent, gender, model, needs internet). The voices for the text's
// language come first; the others fold away unless searched. In the Android app the engine
// (Google's, VoxSherpa…) can be chosen here too, and in Settings each voice can be heard.
import { html, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { describeVoice, isNaturalVoice, languageName, rankVoices } from '../speech.js';
import { Icon } from './icons.js';

const sheetScreen = () => matchMedia('(max-width: 640px)').matches;

/**
 * A button showing the voice in use, opening the list. `voices` as reader.js gives them, `value` a
 * voiceURI ('' = automatic), `lang` the text's language; `engines` ({ engine, engines }) with
 * `onEngine(name)` lets the Android app's engine be chosen; `onSample(voice)` plays one.
 */
export function VoicePicker({ voices, value, onChange, lang = '', engines = null, onEngine, onSample, className = '' }) {
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  const current = voices.find((v) => v.voiceURI === value);
  const about = current && describeVoice(current);
  const shown = about ? about.title : `Automatic${lang ? ` (${languageName(lang)})` : ''}`;
  return html`<button type="button" ref=${button} class="voice-btn ${className}" aria-haspopup="listbox" aria-expanded=${open}
      title=${about ? `${about.title} · ${about.detail}` : 'The most natural voice for the text’s language'} onClick=${() => setOpen(!open)}>
      <span class="voice-btn-name">${shown}</span><${Icon} name="chevronDown" size=${14} />
    </button>
    ${open &&
    html`<${VoiceList} voices=${voices} value=${value} lang=${lang} engines=${engines} onEngine=${onEngine} onSample=${onSample} owner=${button}
      onPick=${(v) => {
        setOpen(false);
        onChange(v);
        button.current?.focus();
      }}
      onClose=${() => {
        setOpen(false);
        button.current?.focus();
      }} />`}`;
}

function VoiceList({ voices, value, lang, engines, onEngine, onSample, owner, onPick, onClose }) {
  const ref = useRef(null);
  const [query, setQuery] = useState('');
  const [others, setOthers] = useState(false);
  const [pos, setPos] = useState(null);
  const sheet = sheetScreen();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!sheet) {
      // Under the button, or over it when there is more room above (the read-aloud bar is at the bottom).
      const b = owner.current.getBoundingClientRect();
      const width = Math.min(380, innerWidth - 16);
      const left = Math.max(8, Math.min(b.left, innerWidth - width - 8));
      const below = innerHeight - b.bottom - 12;
      const above = b.top - 12;
      setPos(below >= Math.min(420, above) ? { left, top: b.bottom + 4, width, maxHeight: Math.min(480, below) } : { left, bottom: innerHeight - b.top + 4, width, maxHeight: Math.min(480, above) });
    }
    (el.querySelector('.voice-search') ?? el.querySelector('.voice-row.selected .voice-pick') ?? el.querySelector('.voice-pick'))?.focus({ preventScroll: true });
    el.querySelector('.voice-row.selected')?.scrollIntoView({ block: 'nearest' });
    const onDown = (e) => !el.contains(e.target) && !owner.current?.contains(e.target) && onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...el.querySelectorAll('.voice-search, .voice-pick')];
        const i = buttons.indexOf(document.activeElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const groups = useMemo(() => {
    const rows = rankVoices(voices, lang).map((v) => ({ v, ...describeVoice(v), natural: isNaturalVoice(v) }));
    const q = query.trim().toLowerCase();
    const found = (r) => !q || `${r.title} ${r.detail} ${r.v.name} ${r.v.lang}`.toLowerCase().includes(q);
    const mine = (r) => Boolean(lang) && r.v.lang.toLowerCase().replace('_', '-').startsWith(lang);
    return { mine: rows.filter((r) => mine(r) && found(r)), other: rows.filter((r) => !mine(r) && found(r)) };
  }, [voices, lang, query]);
  const showOthers = others || Boolean(query.trim()) || !lang || !groups.mine.length;
  const list = engines?.engines ?? [];

  const row = (r) => html`<div class="voice-row ${r.v.voiceURI === value ? 'selected' : ''}" key=${r.v.voiceURI} role="option" aria-selected=${r.v.voiceURI === value}>
    <button type="button" class="voice-pick" onClick=${() => onPick(r.v.voiceURI)}>
      <span class="voice-title">${r.natural && html`<span class="voice-star" title="Natural-sounding">★</span>`}${r.title}</span>
      <span class="voice-detail">${r.detail || r.v.lang}</span>
    </button>
    ${onSample && html`<button type="button" class="icon-btn sm voice-sample" aria-label=${`Hear ${r.title}`} title="Hear it" onClick=${() => onSample(r.v)}><${Icon} name="play" size=${13} /></button>`}
    ${r.v.voiceURI === value && html`<${Icon} name="check" size=${15} class="voice-check" />`}
  </div>`;

  return html`${sheet && html`<div class="voice-scrim" />`}
    <div class="voice-list ${sheet ? 'sheet' : ''}" ref=${ref} role="listbox" aria-label="Voices"
      style=${pos ? { left: `${pos.left}px`, top: pos.top != null ? `${pos.top}px` : 'auto', bottom: pos.bottom != null ? `${pos.bottom}px` : 'auto', width: `${pos.width}px`, maxHeight: `${pos.maxHeight}px` } : undefined}>
      ${list.length > 1 &&
      html`<div class="voice-engines" role="group" aria-label="Engine">
        <span class="voice-engines-label">Engine</span>
        ${list.map((e) => html`<button type="button" key=${e.name} class="chip ${e.name === engines.engine ? 'on' : ''}" aria-pressed=${e.name === engines.engine}
          title=${e.name === engines.systemEngine ? 'The phone’s preferred engine' : e.name} onClick=${() => onEngine?.(e.name)}>${e.label}</button>`)}
      </div>`}
      ${voices.length > 8 && html`<input class="voice-search" type="search" placeholder="Find a voice: name, accent, language…" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />`}
      <div class="voice-rows">
        <div class="voice-row ${!value ? 'selected' : ''}" role="option" aria-selected=${!value}>
          <button type="button" class="voice-pick" onClick=${() => onPick('')}>
            <span class="voice-title">Automatic</span>
            <span class="voice-detail">The most natural voice for the text’s language${lang ? ` (now ${languageName(lang)})` : ''}</span>
          </button>
          ${!value && html`<${Icon} name="check" size=${15} class="voice-check" />`}
        </div>
        ${lang && groups.mine.length > 0 && html`<div class="voice-group">${languageName(lang)}</div>`}
        ${groups.mine.map(row)}
        ${groups.other.length > 0 &&
        (showOthers
          ? html`${lang && groups.mine.length > 0 && html`<div class="voice-group">Other languages</div>`}${groups.other.map(row)}`
          : html`<button type="button" class="voice-more" onClick=${() => setOthers(true)}>Other languages (${groups.other.length})</button>`)}
        ${voices.length > 0 && query.trim() && !groups.mine.length && !groups.other.length && html`<p class="voice-empty">No voice matches “${query.trim()}”.</p>`}
        ${!voices.length && html`<p class="voice-empty">No voices yet. ${list.length ? 'Try another engine above, or add voices in its settings.' : 'Add some in the device’s text-to-speech settings.'}</p>`}
      </div>
    </div>`;
}
