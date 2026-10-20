// Applies a saved light/dark theme before first paint (classic script, runs synchronously).
try {
  var theme = JSON.parse(localStorage.getItem('tracker.settings.v1') || '{}').theme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) {
  // ignore
}
