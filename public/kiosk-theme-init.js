// Applies the saved (or system) colour theme before first paint so there is no light flash.
// Kept as a file, not inline, so pages that use it can run under a strict script policy.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
})();
