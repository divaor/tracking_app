import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { NOTIFY_EVENTS } from '../devices.js';
import { DEFAULT_NOTIFY, testDesktopNotification } from '../notifier.js';
import {
  disablePush,
  enablePush,
  fetchVapidKey,
  isPushActive,
  normalizeConnectorUrl,
  pushSupport,
  readDevices,
  sendTestPush,
  updatePushEvents,
} from '../push.js';
import { getSettings, isSyncConfigured, saveSettings } from '../settings.js';
import { Icon } from './icons.js';

const eventsFrom = (prefs) => NOTIFY_EVENTS.map((e) => e.id).filter((id) => prefs[id]);

function Check({ checked, onChange, label, hint, disabled = false }) {
  return html`<label class="field checkbox">
    <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span>${label}${hint && html`<small>${hint}</small>`}</span>
  </label>`;
}

function Categories({ prefs, onChange, withDevices }) {
  return html`<div class="notify-options">
    ${NOTIFY_EVENTS.map((e) => html`<${Check} key=${e.id} checked=${prefs[e.id]} label=${e.label} hint=${e.hint} onChange=${(v) => onChange({ [e.id]: v })} />`)}
    ${withDevices &&
    html`<${Check} checked=${prefs.devices} label="Changes from my other devices" hint="For example a task you completed on your phone. Give each device its own name under Sync."
      onChange=${(v) => onChange({ devices: v })} />`}
  </div>`;
}

function DesktopNotifications({ prefs, setPrefs }) {
  const [background, setBackground] = useState(null);
  useEffect(() => {
    window.desktop.getRunInBackground?.().then(setBackground, () => setBackground(null));
  }, []);
  return html`
    <p class="muted">The desktop app checks for changes every minute and shows a notification when Claude sends something or changes your tracker.</p>
    <${Check} checked=${prefs.desktop} label="Show desktop notifications" onChange=${(v) => setPrefs({ desktop: v })} />
    <${Categories} prefs=${prefs} onChange=${setPrefs} withDevices />
    ${background !== null &&
    html`<${Check} checked=${background} label="Keep running in the background when the window is closed"
      hint="Tracker stays in the system tray so notifications keep coming. Quit from the tray icon."
      onChange=${async (v) => setBackground(await window.desktop.setRunInBackground(v))} />`}
    <div class="form-actions">
      <button type="button" class="btn sm" disabled=${!prefs.desktop} onClick=${testDesktopNotification}><${Icon} name="bell" size=${15} />Send a test notification</button>
    </div>`;
}

function PushNotifications({ prefs, setPrefs, actions }) {
  const support = pushSupport();
  const [connectorUrl, setConnectorUrl] = useState(getSettings().connectorUrl);
  const [key, setKey] = useState({ value: '', error: '' });
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!support.supported) return;
    isPushActive().then(setActive);
    if (!connectorUrl && isSyncConfigured()) {
      readDevices()
        .then((doc) => doc.connectorUrl && setConnectorUrl((current) => current || doc.connectorUrl))
        .catch(() => {});
    }
  }, []);

  // Fetch the connector's public key ahead of the click: iOS only asks for
  // permission when the request starts directly from the tap.
  useEffect(() => {
    if (!support.supported || !/^https:\/\/[^/]+\.[^/]+/.test(connectorUrl.trim())) {
      setKey({ value: '', error: '' });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchVapidKey(connectorUrl).then(
        (value) => !cancelled && setKey({ value, error: '' }),
        (err) => !cancelled && setKey({ value: '', error: err.message }),
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectorUrl]);

  if (!support.supported) {
    const message = {
      'ios-install': 'On iPhone and iPad, add Tracker to your Home Screen (Share → Add to Home Screen), open it from the new icon, then turn on notifications here.',
      insecure: 'Push notifications need the app to be opened over https (for example from GitHub Pages).',
      unsupported: 'This browser cannot receive push notifications. Try Chrome, Edge, Firefox or Safari.',
    }[support.reason];
    return html`<p class="notice warn"><${Icon} name="alert" size=${16} />${message}</p>`;
  }

  const run = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) actions.toast(done);
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      await enablePush({ connectorUrl, vapidKey: key.value, events: eventsFrom(prefs) });
      setActive(true);
    }, 'Notifications are on for this device');
  const turnOff = () =>
    run(async () => {
      await disablePush();
      setActive(false);
    }, 'Notifications are off for this device');

  return html`
    <p class="muted">Get a notification on this device when Claude sends a document for review, stores a file, or adds or updates items, even when the app is closed. The Claude connector sends them.</p>
    ${!isSyncConfigured() && html`<p class="notice warn"><${Icon} name="alert" size=${16} />Set up GitHub sync first.</p>`}
    <label class="field">
      <span>Connector address</span>
      <input value=${connectorUrl} onInput=${(e) => setConnectorUrl(e.currentTarget.value)} onBlur=${() => saveSettings({ connectorUrl: normalizeConnectorUrl(connectorUrl) })}
        placeholder="https://tracker-mcp.your-name.workers.dev" autocomplete="off" autocapitalize="off" spellcheck=${false} inputmode="url" />
      <small>${key.error ? html`<span class="field-error">${key.error}</span>` : key.value ? 'Connector found.' : 'The address of your deployed connector (without /mcp).'}</small>
    </label>
    <${Categories} prefs=${prefs} onChange=${setPrefs} />
    <div class="form-actions">
      ${active
        ? html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => run(() => sendTestPush(connectorUrl), 'Test sent — it should arrive in a few seconds')}>
              <${Icon} name="bell" size=${15} />Send a test notification
            </button>
            <button type="button" class="btn ghost danger sm" disabled=${busy} onClick=${turnOff}>Turn off</button>`
        : html`<button type="button" class="btn primary sm" disabled=${busy || !key.value || !isSyncConfigured()} onClick=${turnOn}>
            <${Icon} name="bell" size=${15} />Turn on notifications
          </button>`}
    </div>
    ${active && html`<p class="muted small">On for this device. Turn them on separately on each phone or browser.</p>`}`;
}

export function NotificationsCard({ actions }) {
  const [prefs, setPrefsState] = useState(() => ({ ...DEFAULT_NOTIFY, ...getSettings().notify }));
  const setPrefs = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    saveSettings({ notify: next });
    if (!window.desktop && getSettings().push && ('documents' in patch || 'items' in patch)) {
      updatePushEvents(eventsFrom(next)).catch((err) => actions.toast(err.message, { kind: 'error' }));
    }
  };
  return html`<section class="settings-card" id="notifications">
    <h2><${Icon} name="bell" size=${18} />Notifications</h2>
    ${window.desktop
      ? html`<${DesktopNotifications} prefs=${prefs} setPrefs=${setPrefs} />`
      : html`<${PushNotifications} prefs=${prefs} setPrefs=${setPrefs} actions=${actions} />`}
  </section>`;
}
