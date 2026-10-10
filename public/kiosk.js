// Shared by every page. Fills avatar images (<img data-pk-avatar>) and the browser-tab icon from the
// live Bluesky profile. Fails silently: the footer text stands alone and the tab keeps the PK badge.
(function () {
  var ICON_KEY = 'pk-avatar-url';
  function setIcon(url) {
    var l = document.querySelector('link[rel="icon"]');
    if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
    l.removeAttribute('type'); l.href = url;
  }
  // The last avatar seen is remembered, so the next page opens with the right icon straight away.
  try { var cached = localStorage.getItem(ICON_KEY); if (cached && /^https:\/\//.test(cached)) setIcon(cached); } catch (e) {}

  var imgs = document.querySelectorAll('img[data-pk-avatar]');
  fetch('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=professorkiosk.wtf')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (profile) {
      if (!profile || !profile.avatar) return;
      Array.prototype.forEach.call(imgs, function (img) {
        img.src = profile.avatar;
        img.hidden = false;
      });
      var fallback = document.getElementById('heroFallback');
      if (fallback && document.getElementById('heroAvatar')) fallback.hidden = true;
      if (/^https:\/\//.test(profile.avatar)) {
        var probe = new Image();   // only use it as the icon once it has actually loaded
        probe.onload = function () { setIcon(profile.avatar); try { localStorage.setItem(ICON_KEY, profile.avatar); } catch (e) {} };
        probe.src = profile.avatar;
      }
    })
    .catch(function () { /* placeholders stay */ });
})();
