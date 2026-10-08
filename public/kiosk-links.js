// Shared by the browser pages (Tracer, Skeet Receipt) and the server: one parser for post links,
// so every part of the site accepts exactly the same shapes.
//
// Accepted:
//   https://{any-host}/profile/{handle-or-did}/post/{rkey}   (scheme optional, query/fragment/trailing slash ok)
//   at://{handle-or-did}/app.bsky.feed.post/{rkey}
// Anything else (profile links, feed links, list links, plain text) returns null.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KioskLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var RKEY = '[A-Za-z0-9._~:-]+';
  var AT = new RegExp('^at://([^/\\s]+)/app\\.bsky\\.feed\\.post/(' + RKEY + ')/?$');
  var WEB = new RegExp('^(?:https?://)?(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,}(?::\\d+)?/profile/([^/\\s?#]+)/post/(' + RKEY + ')/?(?:[?#].*)?$');
  var DID = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;
  var HANDLE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

  function parsePostLink(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return null;
    var m = s.match(AT) || s.match(WEB);
    if (!m) return null;
    var id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return null; }
    if (!DID.test(id) && !HANDLE.test(id)) return null;
    return { id: id, rkey: m[2] };
  }

  return { parsePostLink: parsePostLink };
});
