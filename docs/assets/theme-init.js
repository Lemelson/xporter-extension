(function () {
  try {
    var saved = localStorage.getItem('xporter_theme');
    var theme = saved === 'light' || saved === 'dark' ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (error) { document.documentElement.setAttribute('data-theme', 'dark'); }
})();
