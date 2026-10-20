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

// Wide tables scroll sideways instead of squeezing their columns: each table
// gets its own scroll box, and columns with long text get a minimum width.
function layoutTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const longest = [];
    for (const row of table.rows) {
      [...row.cells].forEach((cell, i) => (longest[i] = Math.max(longest[i] ?? 0, cell.textContent.trim().length)));
    }
    for (const row of table.rows) {
      [...row.cells].forEach((cell, i) => {
        if (longest[i] > 40) cell.classList.add('md-wide');
        else if (longest[i] > 15) cell.classList.add('md-mid');
      });
    }
    const box = document.createElement('div');
    box.className = 'md-table';
    table.replaceWith(box);
    box.append(table);
  }
}

export function renderMarkdown(source) {
  if (!source) return '';
  // Template content is inert, so nothing in it runs or loads before sanitizing.
  const template = document.createElement('template');
  template.innerHTML = marked.parse(source);
  layoutTables(template.content);
  return DOMPurify.sanitize(template.innerHTML, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'] });
}
