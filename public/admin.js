// Admin tools: reports, game actions, account suppression. Everything shown comes from /api/admin with
// the secret kept in this tab's sessionStorage only. All text is put on the page with textContent.
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var KEY = 'kiosk-admin-secret';
  var secret = '';
  try { secret = sessionStorage.getItem(KEY) || ''; } catch (e) {}

  function el(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k === 'onclick') n.addEventListener('click', props[k]);
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function say(t, bad) { var m = $('#msg'); m.textContent = t || ''; m.style.color = bad ? '#b91c1c' : ''; }
  function when(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return ''; } }

  async function call(method, path, body) {
    var res = await fetch('/api/admin' + path, { method: method, headers: Object.assign({ Authorization: 'Bearer ' + secret }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    var json = null; try { json = await res.json(); } catch (e) {}
    if (res.status === 401) { signOut(); var le = $('#loginErr'); le.textContent = (json && json.message) || 'Wrong secret.'; le.hidden = false; throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((json && json.message) || 'Something went wrong.');
    return json;
  }

  function signOut() {
    secret = ''; try { sessionStorage.removeItem(KEY); } catch (e) {}
    $('#app').hidden = true; $('#login').hidden = false; $('#signOut').hidden = true; $('#openCount').hidden = true; $('#secret').value = '';
  }
  async function enter() {
    $('#loginErr').hidden = true;
    try { await call('GET', '/reports?status=open'); } catch (e) { return; }
    try { sessionStorage.setItem(KEY, secret); } catch (e) {}
    $('#login').hidden = true; $('#app').hidden = false; $('#signOut').hidden = false;
    loadReports();
  }
  $('#signIn').onclick = function () { secret = $('#secret').value; enter(); };
  $('#secret').addEventListener('keydown', function (e) { if (e.key === 'Enter') { secret = $('#secret').value; enter(); } });
  $('#signOut').onclick = signOut;

  // tabs
  document.querySelectorAll('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-tab]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); x.classList.toggle('on', x === b); });
      ['reports', 'lookup', 'log'].forEach(function (t) { $('#tab-' + t).hidden = t !== b.dataset.tab; });
      if (b.dataset.tab === 'log') loadLog(); if (b.dataset.tab === 'reports') loadReports();
    });
  });

  var REASONS = { personal_info: 'Personal info', harassment: 'Harassment', label: 'Should be labeled', wrong: 'Wrong or misleading', removal: 'Remove my post', other: 'Something else' };

  function gameActions(g, after) {
    var row = el('div', { class: 'row' });
    function act(label, action, confirmText, cls) {
      row.appendChild(el('button', { class: 'k-btn ' + (cls || ''), type: 'button', text: label, onclick: async function () {
        if (confirmText && !confirm(confirmText)) return;
        try { await call('POST', '/game/' + g.id, { action: action }); say(label + ': done for ' + g.id); after(); } catch (e) { say(e.message, true); }
      } }));
    }
    if (g.status === 'active') act('Hide game', 'hide', null, 'coral'); if (g.status === 'hidden') act('Unhide', 'unhide');
    if (g.status !== 'deleted') { act(g.frozen ? 'Unfreeze' : 'Freeze', g.frozen ? 'unfreeze' : 'freeze'); act('Delete game', 'delete', 'Delete every version and post of game ' + g.id + '? This cannot be undone.', 'coral'); }
    return row;
  }
  function gameCard(g, after, extra) {
    var kids = [
      el('h2', { text: 'Game ' + g.id }),
      el('div', { class: 'kv' }, [
        el('span', {}, [el('b', { text: g.status }), ' ']), g.frozen ? el('span', { text: 'frozen' }) : null,
        el('span', { text: g.counts.live + ' live, ' + g.counts.tombstones + ' wiped, ' + g.counts.versions + ' version(s)' }),
        el('span', { text: g.openReports + ' open report(s)' }),
      ]),
      el('p', { class: 'meta', text: 'Created ' + when(g.createdAt) + (g.lastCheckedAt ? ' · last checked ' + when(g.lastCheckedAt) : '') }),
      el('div', { class: 'row' }, [
        g.status !== 'deleted' ? el('a', { class: 'k-btn', href: g.link, target: '_blank', rel: 'noopener', text: 'Open saved game' }) : null,
        g.rootLink ? el('a', { class: 'k-btn', href: g.rootLink, target: '_blank', rel: 'noopener', text: 'Original post' }) : null,
      ]),
      extra || null, gameActions(g, after),
    ];
    return el('div', { class: 'card' }, kids);
  }

  async function loadReports() {
    var box = $('#reports'); box.textContent = '';
    try {
      var d = await call('GET', '/reports?status=' + encodeURIComponent($('#rstatus').value));
      var oc = $('#openCount'); oc.textContent = d.open + ' open'; oc.hidden = false;
      if (!d.reports.length) { box.appendChild(el('p', { class: 'empty', text: 'Nothing here.' })); return; }
      d.reports.forEach(function (r) {
        var card = el('div', { class: 'card' });
        card.appendChild(el('div', { class: 'row', style: 'margin-top:0' }, [el('span', { class: 'pill r', text: REASONS[r.reason] || r.reason }), el('span', { class: 'pill', text: r.status }), el('span', { class: 'meta', text: '#' + r.id + ' · ' + when(r.createdAt) + ' · game ' + r.gameId })]));
        if (r.note) card.appendChild(el('p', { text: r.note }));
        if (r.node) {
          card.appendChild(el('div', { class: 'meta', text: 'Reported card: ' + (r.node.state === 'live' ? '@' + r.node.handle : 'already wiped (' + r.node.state + ')') }));
          if (r.node.text) card.appendChild(el('div', { class: 'quote', text: r.node.text }));
          if (r.node.state === 'live') {
            var sel = el('select', { 'aria-label': 'Wipe as' }, [el('option', { value: 'deleted', text: 'Wipe as deleted' }), el('option', { value: 'label_hidden', text: 'Wipe as labeled' }), el('option', { value: 'removed_by_author', text: 'Wipe as removed by author' })]);
            card.appendChild(el('div', { class: 'row' }, [sel, el('button', { class: 'k-btn coral', type: 'button', text: 'Wipe this card', onclick: async function () { try { await call('POST', '/node/' + r.node.id + '/tombstone', { state: sel.value }); say('Card wiped.'); loadReports(); } catch (e) { say(e.message, true); } } })]));
          }
        }
        if (r.game) card.appendChild(el('div', {}, [gameActions(r.game, loadReports), el('div', { class: 'row' }, [el('a', { class: 'k-btn', href: r.game.link, target: '_blank', rel: 'noopener', text: 'Open saved game' })])]));
        if (r.status === 'open') {
          card.appendChild(el('div', { class: 'row' }, [
            el('button', { class: 'k-btn primary', type: 'button', text: 'Mark resolved', onclick: async function () { try { await call('POST', '/report/' + r.id, { status: 'resolved' }); loadReports(); } catch (e) { say(e.message, true); } } }),
            el('button', { class: 'k-btn', type: 'button', text: 'Dismiss', onclick: async function () { try { await call('POST', '/report/' + r.id, { status: 'dismissed' }); loadReports(); } catch (e) { say(e.message, true); } } }),
          ]));
        }
        box.appendChild(card);
      });
    } catch (e) { if (e.message !== 'unauthorized') say(e.message, true); }
  }
  $('#rstatus').onchange = loadReports; $('#rreload').onclick = loadReports;

  $('#find').onclick = async function () {
    var out = $('#found'); out.textContent = ''; say('');
    try {
      var d = await call('GET', '/lookup?q=' + encodeURIComponent($('#q').value));
      if (!d.games.length) out.appendChild(el('p', { class: 'empty', text: 'No saved game found.' }));
      d.games.forEach(function (g) { out.appendChild(gameCard(g, function () { $('#find').onclick(); }, g.posts ? el('p', { class: 'meta', text: 'This account has ' + g.posts + ' stored post(s) here.' }) : null)); });
      if (d.accounts && d.accounts[0]) { $('#acct').value = d.accounts[0].did; }
    } catch (e) { if (e.message !== 'unauthorized') say(e.message, true); }
  };
  $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#find').onclick(); });
  $('#suppress').onclick = async function () {
    var acct = $('#acct').value.trim(), scope = $('#scope').value.trim() || 'all';
    if (!acct) return say('Give a handle or DID.', true);
    if (!confirm('Wipe everything stored for ' + acct + ' (' + scope + ') and keep them out?')) return;
    try { var d = await call('POST', '/suppress', { account: acct, scope: scope }); say('Done. ' + d.wiped + ' post(s) wiped; the account will not be stored again (' + scope + ').'); } catch (e) { say(e.message, true); }
  };

  async function loadLog() {
    var box = $('#log'); box.textContent = '';
    try {
      var d = await call('GET', '/log');
      if (!d.log.length) { box.appendChild(el('p', { class: 'empty', text: 'No admin actions yet.' })); return; }
      d.log.forEach(function (l) { box.appendChild(el('p', { class: 'meta', text: when(l.at) + '  ' + l.action + '  ' + l.target })); });
    } catch (e) { if (e.message !== 'unauthorized') say(e.message, true); }
  }

  if (secret) enter();
})();
