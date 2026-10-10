// Help dialog shared by every tool page. The page supplies <button id="helpBtn"> and
// <dialog class="k-help" id="help"> (with a close button, id="helpX"); this wires them up.
(function () {
  var dlg = document.getElementById('help'), btn = document.getElementById('helpBtn');
  if (!dlg || !btn) return;
  function open() { if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', ''); }
  function close() { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); btn.focus(); }
  btn.addEventListener('click', open);
  var x = document.getElementById('helpX'); if (x) x.addEventListener('click', close);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
  dlg.addEventListener('close', function () {
    btn.focus();
    if (location.hash === '#help') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  });
  if (location.hash === '#help') open();
})();
