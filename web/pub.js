'use strict'

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]')
  if (!button) return
  const input = document.getElementById(button.dataset.copy)
  try {
    await navigator.clipboard.writeText(input.value)
    button.textContent = 'Copied'
  } catch {
    input.type = 'text'
    input.classList.add('share-link')
    input.focus()
    input.select()
    button.textContent = 'Link selected'
  }
})

const login = document.querySelector('#finish-sign-in')
if (login) {
  const status = document.querySelector('#login-status')
  const events = new EventSource('/login/events?' + new URLSearchParams({ sc: login.dataset.sc }))
  events.addEventListener('approved', () => {
    events.close()
    login.requestSubmit()
  })
  events.addEventListener('expired', () => {
    events.close()
    status.textContent = 'Sign-in expired. Reload this page to start again.'
  })
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) {
      status.textContent = 'Could not connect. Reload this page to start again.'
    }
  }
}
