// The quick add window (desktop): one line from anywhere, added by the main
// window's quick add (so the model reads it there when it is on).
import { getSettings } from './settings.js';

const bridge = window.quickAdd;
const form = document.getElementById('form');
const input = document.getElementById('text');
const buttons = [...document.querySelectorAll('[data-type]')];
const KEY = 'tracker:quick-add-type';
const PLACEHOLDERS = { task: 'Add a task…', idea: 'Capture an idea…', claude: 'What is Claude working on?', doc: 'Document title or link to read…' };

let type = 'task';
try {
  type = localStorage.getItem(KEY) || 'task';
} catch {
  // default
}
const show = () => {
  for (const b of buttons) {
    b.classList.toggle('active', b.dataset.type === type);
    b.setAttribute('aria-pressed', String(b.dataset.type === type));
  }
  input.placeholder = PLACEHOLDERS[type];
};
for (const b of buttons) {
  b.addEventListener('click', () => {
    type = b.dataset.type;
    try {
      localStorage.setItem(KEY, type);
    } catch {
      // not kept
    }
    show();
    input.focus();
  });
}
show();

const { llm, smartAdd } = getSettings();
document.getElementById('hint').innerHTML =
  llm.enabled && llm.chatModel && smartAdd
    ? 'Plain language works: <em>call Ana tomorrow about the invoice, urgent</em>. Or <code>+project</code> <code>#tag</code> <code>!high</code> <code>@tomorrow</code>'
    : 'Shortcuts: <code>+project</code> <code>#tag</code> <code>!high</code> <code>@tomorrow</code> or paste a link';

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!input.value.trim()) return bridge.close();
  await bridge.submit({ text: input.value, type });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    bridge.close();
  }
});
// Clicking elsewhere closes it while it is empty.
bridge.onBlur(() => {
  if (!input.value.trim()) bridge.close();
});
input.focus();
