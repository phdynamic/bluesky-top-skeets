// Night mode button for simple pages that have a #themeToggle and no script of their own.
(function () {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  function label() { btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️ Day mode' : '🌙 Night mode'; }
  btn.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) {}
    label();
  });
  label();
})();
