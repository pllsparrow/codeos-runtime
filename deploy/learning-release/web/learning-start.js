const login = document.querySelector('#login')
const workspaces = document.querySelector('#workspaces')
const status = document.querySelector('#status')
const logout = document.querySelector('#logout')

async function showSession() {
  const response = await fetch('/api/auth/session', { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not check your session. Reload to try again.')
  const session = await response.json()
  login.hidden = session.authenticated
  workspaces.hidden = !session.authenticated
  status.textContent = ''
}

login.addEventListener('submit', async event => {
  event.preventDefault()
  const button = login.querySelector('button')
  button.disabled = true
  status.textContent = 'Signing in…'
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(login))),
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'Invalid email or password.' : 'Sign-in is unavailable. Try again.')
    login.reset()
    location.assign('/')
  } catch (error) {
    status.textContent = error.message
  } finally {
    button.disabled = false
  }
})

logout.addEventListener('click', async () => {
  const cookie = document.cookie.split('; ').find(entry => entry.startsWith('codeos_csrf='))
  logout.disabled = true
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST', headers: { 'X-CSRF-Token': cookie?.slice('codeos_csrf='.length) ?? '' },
    })
    if (!response.ok) throw new Error('Could not sign out. Try again.')
    await showSession()
  } catch (error) {
    status.textContent = error.message
  } finally {
    logout.disabled = false
  }
})

showSession().catch(error => { status.textContent = error.message })
