// Markdown → sanitized HTML (GitHub-flavoured, links open outside the app).
import { marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // Task-list checkboxes become clickable; clicks are mapped back to the source.
  if (node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox') {
    node.removeAttribute('disabled');
    node.classList.add('md-check');
  }
});

export function renderMarkdown(source) {
  if (!source) return '';
  return DOMPurify.sanitize(marked.parse(source), { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'] });
}
