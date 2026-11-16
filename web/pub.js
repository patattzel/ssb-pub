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
  const url = '/login/status?' + new URLSearchParams({ sc: login.dataset.sc })
  async function checkApproval() {
    try {
      const result = await fetch(url)
      if (result.status === 200) login.requestSubmit()
      else if (result.status === 204) setTimeout(checkApproval, 700)
      else if (result.status === 403) status.textContent = 'Sign-in expired. Reload this page to start again.'
      else throw new Error('Could not check sign-in')
    } catch {
      status.textContent = 'Could not connect. Reload this page to start again.'
    }
  }
  checkApproval()
}
