// Where the page runs: the desktop app (Electron, window.desktop from its preload), the Android
// app (Capacitor, window.desktop from androidApp.js with platform 'android'), or a browser.
// Features check the part of window.desktop they use; these say which app it is.

export const isAndroidApp = () => globalThis.window?.desktop?.platform === 'android';
export const isDesktopApp = () => Boolean(globalThis.window?.desktop) && !isAndroidApp();
