/* Apply the saved reading preference before the first paint. */
(function () {
  var preference = 'system';
  try {
    var saved = localStorage.getItem('codeos.theme');
    preference = saved === null ? (localStorage.getItem('codeos.learning.theme') || 'system') : saved;
    if (saved === null) localStorage.setItem('codeos.theme', preference === 'light' || preference === 'dark' ? preference : 'system');
  } catch (_) { /* Storage can be unavailable. */ }
  var dark = preference === 'dark' || (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}());
