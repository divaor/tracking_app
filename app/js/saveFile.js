// Saving a file to the device (Download, Export backup): the browser's downloads; the Android app,
// whose WebView cannot download, asks where to keep it (the phone's own file picker).

/** Saves `blob` as `name`. Resolves false when the person cancelled (Android), else true. */
export async function saveToDevice(name, blob) {
  if (window.desktop?.saveFile) {
    const saved = await window.desktop.saveFile(name, new Uint8Array(await blob.arrayBuffer()), blob.type);
    return saved !== null;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
