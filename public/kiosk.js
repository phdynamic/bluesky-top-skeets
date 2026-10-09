// Shared by every page: fills avatar images (<img data-pk-avatar>) from the live
// Bluesky profile. Fails silently, so the text beside the image stands alone.
(function () {
  var imgs = document.querySelectorAll('img[data-pk-avatar]');
  if (!imgs.length) return;
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
    })
    .catch(function () { /* placeholders stay */ });
})();
