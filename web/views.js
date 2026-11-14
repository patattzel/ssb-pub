'use strict'

const escape = (value) => String(value).replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const a = escape

function layout(title, body, { admin = false, status = 200 } = {}) {
  const nav = admin
    ? '<a href="/">View pub</a><form method="post" action="/logout"><button class="text-button">Sign out</button></form>'
    : '<a href="/admin">Admin sign-in</a>'
  return { status, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${a(title)}</title><link rel="icon" href="/assets/icon.png"><link rel="stylesheet" href="/assets/pub.css">
<script defer src="/assets/pub.js"></script></head>
<body><header class="site-header"><div class="shell header-row">
<a class="brand" href="/"><img src="/assets/icon.png" alt="" width="34" height="34">SSB Pub</a>
<nav aria-label="Account">${nav}</nav></div></header>
<main class="shell">${body}</main></body></html>` }
}

function avatar(profile, size = '') {
  const src = profile.image ? '/profile-image/' + profile.image : '/assets/icon.png'
  return `<img class="avatar ${size}" src="${src}" alt="">`
}

const copy = (id) => `<button type="button" class="button secondary" data-copy="${id}">Copy link</button>`

function publicPage(profile, { invite, app, unavailable } = {}) {
  const heading = invite ? 'Join ' + profile.name : profile.name
  const action = invite
    ? `<section class="join"><h2>Connect in Manyverse</h2>
<p>Open the invitation in Manyverse, or copy the link and paste it under Connections.</p>
<div class="actions">${app ? `<a class="button" href="${a(app)}">Open in Manyverse</a>` : ''}${copy('invite-link')}</div>
<label class="sr-only" for="invite-link">Invitation link</label>
<input type="hidden" id="invite-link" readonly value="${a(invite)}"></section>`
    : `<section class="join"><h2>Join this pub</h2><p>${unavailable
      ? 'This invitation has expired or is invalid. Ask the pub operator for a new link.'
      : 'Ask the pub operator for an invitation, then open it in Manyverse.'}</p></section>`
  return layout(heading, `<article class="pub-card">
<div class="pub-heading">${avatar(profile, 'hero-avatar')}<div><h1>${a(heading)}</h1><p class="description">${a(profile.description)}</p></div></div>
${action}</article>`, { status: unavailable ? 404 : 200 })
}

function login(profile, { active, hasPassword, adminId, link, qr, sc, remote, error }) {
  const manyverse = !active ? '<p>Set up the administrator from the app’s Web Terminal with <code>/app/code/pubctl admin</code>.</p>'
    : !link ? '<p><a href="/login?ssb-http-auth=1">Start a new Manyverse sign-in</a>.</p>'
    : `<div class="auth-method"><h2>Manyverse</h2><p>Approve the sign-in using your administrator’s SSB identity.</p>
<a class="button" href="${a(link)}">Open Manyverse</a>
${qr ? `<details><summary>Use Manyverse on another device</summary><img class="qr" width="180" height="180" alt="Scan to open this sign-in on your phone" src="${a(qr)}"></details>` : ''}
${remote ? '<p>Return to the original browser after approving the sign-in.</p>' : `<p id="login-status" aria-live="polite">Waiting for approval in Manyverse…</p>
<form id="finish-sign-in" method="post" action="/login/complete" data-sc="${a(sc)}"><input type="hidden" name="sc" value="${a(sc)}"></form>`}</div>`
  const password = hasPassword && !remote ? `<form class="auth-method" method="post" action="/login/password">
<h2>Sign in with password</h2><label for="password">Admin password</label>
<input type="text" name="username" autocomplete="username" value="${a(adminId)}" hidden>
<input type="password" id="password" name="password" autocomplete="current-password" required maxlength="256">
<button class="button secondary">Sign in</button></form>` : ''
  return layout('Admin sign-in', `<article class="pub-card narrow">
<h1>Admin sign-in</h1><p class="description">${a(profile.name)}</p>
${error ? `<p class="notice error" role="alert">${a(error)}</p>` : ''}${manyverse}${password}</article>`)
}

function dashboard(profile, { feed, address, saved, invite, error }) {
  return layout('Pub settings', `<div class="admin-title"><h1>Pub settings</h1>
<p>Manage the profile peers see in Manyverse and invite people to connect.</p></div>
${saved ? '<p class="notice" role="status">Profile saved and published to the pub’s SSB feed.</p>' : ''}
${error ? `<p class="notice error" role="alert">${a(error)}</p>` : ''}
<div class="settings-grid">
<section class="panel"><h2>Pub profile</h2>
<form method="post" action="/admin/profile" enctype="multipart/form-data" class="profile-form">
<label for="name">Pub name</label><input id="name" name="name" value="${a(profile.name)}" required maxlength="80">
<label for="description">Description</label><textarea id="description" name="description" rows="4" maxlength="1200">${a(profile.description)}</textarea>
<div class="image-field">${avatar(profile)}<div><label for="image">Profile image</label>
<input id="image" type="file" name="image" accept="image/png,image/jpeg,image/webp" aria-describedby="image-help">
<p class="hint" id="image-help">PNG, JPEG or WebP · up to 4 MB</p>
${profile.image ? '<label class="check"><input type="checkbox" name="reset" value="yes"> Use the default image</label>' : ''}</div></div>
<div class="actions"><button class="button">Save profile</button></div></form></section>
<aside><section class="panel"><h2>Invitations</h2><p>Each link enrolls one SSB identity and expires after seven days.</p>
<form method="post" action="/admin/invite"><button class="button">Create invitation</button></form>
${invite ? `<div class="created-invite"><label for="invite-link">New invitation</label><input class="share-link" id="invite-link" readonly value="${a(invite)}">${copy('invite-link')}</div>` : ''}
</section><section class="panel connection"><h2>Connection details</h2><dl>
<dt>Pub SSB ID</dt><dd><code>${a(feed)}</code></dd><dt>Address</dt><dd><code>${a(address)}</code></dd>
</dl></section></aside></div>`, { admin: true, status: error ? 400 : 200 })
}

module.exports = { login, dashboard, publicPage }
