(() => {
  let preference = 'system';
  try { const saved = localStorage.getItem('bridge-theme'); if (['light', 'dark', 'system'].includes(saved)) preference = saved; } catch {}
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.dispatchEvent(new Event('bridge-theme-change'));
  };
  window.bridgeTheme = { get: () => preference, set: value => {
    preference = ['light', 'dark', 'system'].includes(value) ? value : 'system';
    try { localStorage.setItem('bridge-theme', preference); } catch {}
    apply();
  } };
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
