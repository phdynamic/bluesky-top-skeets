// Sign in with Bluesky, then remove your own posts or manage a game you started. Everything shown is put on
// the page with textContent; every change sends the CSRF token the server gave this session.
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var me = null;

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k]; else if (k === 'class') n.className = props[k];
      else if (k === 'onclick') n.addEventListener('click', props[k]); else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function say(t, bad) { var m = $('#msg'); m.textContent = t || ''; m.style.color = bad ? '#b91c1c' : ''; }
  function show(id) { ['unavailable', 'signedOut', 'signedIn'].forEach(function (x) { $('#' + x).hidden = x !== id; }); $('#signOut').hidden = id !== 'signedIn'; }

  async function api(method, path, body) {
    var headers = {}; if (body) headers['content-type'] = 'application/json'; if (me && me.csrf && method !== 'GET') headers['x-csrf-token'] = me.csrf;
    var res = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    var type = res.headers.get('content-type') || '';
    if (!/json/.test(type)) { var e = new Error('not set up'); e.notSetUp = true; throw e; }
    var json = await res.json();
    if (!res.ok) { var err = new Error(json.message || 'Something went wrong.'); err.status = res.status; throw err; }
    return json;
  }

  async function loadGames() {
    var d = await api('GET', '/api/me/games');
    var ap = $('#appear'); ap.textContent = '';
    if (!d.appearances.length) ap.appendChild(el('p', { class: 'empty', text: 'None of your posts are in a saved game.' }));
    d.appearances.forEach(function (g) {
      ap.appendChild(el('div', { class: 'game' }, [
        el('div', { class: 'what' }, [el('a', { href: g.link, target: '_blank', rel: 'noopener', text: 'Game ' + g.id }), ' · ' + g.posts + ' of your post' + (g.posts === 1 ? '' : 's')]),
        el('button', { class: 'k-btn', type: 'button', text: 'Remove from this game', onclick: function () { removeFrom(g.id, 'this game'); } }),
      ]));
    });
    var st = $('#started'); st.textContent = '';
    if (!d.started.length) st.appendChild(el('p', { class: 'empty', text: "You haven't started any saved games." }));
    d.started.forEach(function (g) {
      st.appendChild(el('div', { class: 'game' }, [
        el('div', { class: 'what' }, [el('a', { href: g.link, target: '_blank', rel: 'noopener', text: 'Game ' + g.id }), ' · ' + g.quotes + ' quote' + (g.quotes === 1 ? '' : 's') + (g.frozen ? ' · frozen' : '')]),
        el('div', { class: 'row', style: 'margin:0' }, [
          el('button', { class: 'k-btn', type: 'button', text: g.frozen ? 'Unfreeze' : 'Freeze', onclick: function () { owner(g.id, g.frozen ? 'unfreeze' : 'freeze'); } }),
          el('button', { class: 'k-btn coral', type: 'button', text: 'Delete this game', onclick: function () { if (confirm('Delete game ' + g.id + ' and every version of it? This cannot be undone.')) owner(g.id, 'delete'); } }),
        ]),
      ]));
    });
  }
  async function removeFrom(scope, label) {
    if (!confirm('Remove your posts from ' + label + '? This cannot be undone here.')) return;
    try { var d = await api('POST', '/api/me/remove', { scope: scope }); say('Done. ' + d.wiped + ' of your post' + (d.wiped === 1 ? ' was' : 's were') + ' removed from ' + label + (scope === 'all' ? ', and you will be kept out of future saved games.' : ' and will not be added back.')); await loadGames(); }
    catch (e) { say(e.message, true); }
  }
  async function owner(id, action) {
    try { await api('POST', '/api/me/game/' + id + '/owner', { action: action }); say(action === 'delete' ? 'Game deleted.' : action === 'freeze' ? 'Game frozen.' : 'Game unfrozen.'); await loadGames(); }
    catch (e) { say(e.message, true); }
  }
  $('#removeAll').onclick = function () { removeFrom('all', 'every game'); };

  $('#signIn').onclick = async function () {
    var err = $('#signErr'); err.hidden = true;
    var btn = $('#signIn'); btn.disabled = true;
    try {
      var d = await api('POST', '/api/auth/start', { handle: $('#handle').value });
      location.href = d.url;
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
  };
  $('#handle').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#signIn').click(); });
  $('#signOut').onclick = async function () {
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* the page reloads either way */ }
    me = null; location.href = '/g/account';
  };

  (async function start() {
    var qs = new URLSearchParams(location.search), why = qs.get('signin');
    try { me = await api('GET', '/api/me'); } catch (e) { show('unavailable'); return; }
    if (!me.signedIn) {
      show('signedOut');
      if (why) { var err = $('#signErr'); err.textContent = why === 'denied' ? 'The sign-in was cancelled, so nothing was changed.' : "The sign-in didn't finish. Please try again."; err.hidden = false; }
      return;
    }
    show('signedIn');
    $('#who').textContent = 'Signed in as ' + me.did + ' (signs out by itself after an hour)';
    if (why) history.replaceState(null, '', '/g/account' + location.hash);
    try { await loadGames(); } catch (e) { say(e.message, true); }
    if (location.hash === '#owner') $('#owner').scrollIntoView(); else if (location.hash === '#remove') $('#remove').scrollIntoView();
  })();
})();
