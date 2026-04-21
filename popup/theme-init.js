// Early theme apply — read storage directly (no IPC) to prevent FOUC.
// Must run before body content renders.
chrome.storage.local.get('xporter_settings', (r) => {
  if (r.xporter_settings?.theme === 'light') document.body.classList.add('light');
});
