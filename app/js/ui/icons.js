import { html } from '../../vendor/preact-htm.js';

// 24×24 stroke icons.
const PATHS = {
  pin: () => html`<path d="M9 4h6l-1 6 3.5 3.5V15h-11v-1.5L10 10z" /><path d="M12 15v6" />`,
  home: () => html`<path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v12h14V9" /><path d="M10 21v-6h4v6" />`,
  board: () => html`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" />`,
  list: () => html`<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />`,
  settings: () => html`<path d="M3 6h11M18 6h3M3 12h3M10 12h11M3 18h13M20 18h1" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" />`,
  plus: () => html`<path d="M12 5v14M5 12h14" />`,
  search: () => html`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`,
  task: () => html`<rect x="3" y="3" width="18" height="18" rx="4" /><path d="m8 12 3 3 5-6" />`,
  idea: () => html`<path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5v1h6v-1c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" />`,
  claude: () => html`<path d="M12 3c.6 5.4 3.6 8.4 9 9-5.4.6-8.4 3.6-9 9-.6-5.4-3.6-8.4-9-9 5.4-.6 8.4-3.6 9-9z" />`,
  doc: () => html`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" />`,
  link: () => html`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />`,
  external: () => html`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
  code: () => html`<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />`,
  calendar: () => html`<rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />`,
  tag: () => html`<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" /><path d="M7.5 7.5h.01" />`,
  trash: () => html`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />`,
  edit: () => html`<path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" />`,
  x: () => html`<path d="M6 6l12 12M18 6 6 18" />`,
  sync: () => html`<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 21v-5h-5" />`,
  cloud: () => html`<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7z" />`,
  cloudOff: () => html`<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7z" /><path d="M3 3l18 18" />`,
  alert: () => html`<path d="M12 4 2.5 20h19z" /><path d="M12 10v4M12 17h.01" />`,
  menu: () => html`<path d="M4 6h16M4 12h16M4 18h16" />`,
  upload: () => html`<path d="M12 15V4M7 9l5-5 5 5M5 20h14" />`,
  download: () => html`<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />`,
  folder: () => html`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />`,
  flag: () => html`<path d="M5 21V4M5 4h11l-2 4 2 4H5" />`,
  check: () => html`<path d="M5 12l5 5 9-10" />`,
  checklist: () => html`<path d="m4 7 2 2 4-4M4 17l2 2 4-4M13 7h7M13 17h7" />`,
  arrowRight: () => html`<path d="M5 12h14M13 6l6 6-6 6" />`,
  eye: () => html`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />`,
  copy: () => html`<rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />`,
  comment: () => html`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z" />`,
  paperclip: () => html`<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4L14.5 7" />`,
  thumbUp: () => html`<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" /><path d="M7 10l4-7a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 17.6 20H7" />`,
  rotate: () => html`<path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />`,
  briefcase: () => html`<rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />`,
  person: () => html`<circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />`,
  chevronDown: () => html`<path d="m6 9 6 6 6-6" />`,
  bell: () => html`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" />`,
  install: () => html`<rect x="6" y="2" width="12" height="20" rx="2" /><path d="M12 7v7M9 11l3 3 3-3M10 18h4" />`,
  sparkle: () => html`<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />`,
  mic: () => html`<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />`,
  send: () => html`<path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />`,
  stop: () => html`<rect x="6" y="6" width="12" height="12" rx="2" />`,
  help: () => html`<circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01" />`,
  popout: () => html`<path d="M14 4h6v6M20 4l-8 8" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />`,
  minimize: () => html`<path d="M6 18h12" />`,
  maximize: () => html`<rect x="5" y="5" width="14" height="14" rx="2" />`,
  restore: () => html`<rect x="4" y="8" width="12" height="12" rx="2" /><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />`,
  columns: () => html`<rect x="3" y="4" width="7" height="16" rx="2" /><rect x="14" y="4" width="7" height="16" rx="2" />`,
};

export function Icon({ name, size = 18, class: cls = '' }) {
  return html`<svg class="icon ${cls}" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]?.() ?? null}</svg>`;
}

export function StatusIcon({ status, size = 18 }) {
  return html`<svg class="status-icon status-${status}" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
    ${status === 'done'
      ? html`<circle cx="12" cy="12" r="9" fill="currentColor" /><path d="m8 12.5 2.8 2.8L16.5 9.5" class="tick" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />`
      : html`<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2" />`}
    ${status === 'in_progress' ? html`<path d="M12 6.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />` : null}
  </svg>`;
}
