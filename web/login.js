const zh = navigator.language.toLowerCase().startsWith('zh')
const copy = zh ? {
  title: '登录 CirrayaBot', hint: '这是受保护的私人部署，请输入登录密码。',
  label: '登录密码', submit: '登录', working: '正在验证…',
  wrong: '密码不正确，请重试。', locked: '尝试次数过多，请稍后再试。',
  https: '请通过 HTTPS 登录；明文 HTTP 登录已禁用。', failed: '暂时无法连接服务器，请稍后重试。'
} : {
  title: 'Sign in to CirrayaBot', hint: 'This private deployment is protected. Enter the login password.',
  label: 'Password', submit: 'Sign in', working: 'Checking…',
  wrong: 'That password was not accepted. Try again.', locked: 'Too many attempts. Please wait and try again.',
  https: 'Sign in over HTTPS. Password login over plain HTTP is disabled.', failed: 'Could not reach the server. Please try again.'
}

document.documentElement.lang = zh ? 'zh-CN' : 'en'
document.title = `${copy.title} · CirrayaBot`
document.querySelector('#title').textContent = copy.title
document.querySelector('#hint').textContent = copy.hint
document.querySelector('#password-label').textContent = copy.label
const form = document.querySelector('#login-form')
const field = document.querySelector('#password')
const button = document.querySelector('#submit')
const status = document.querySelector('#status')
button.textContent = copy.submit

form.addEventListener('submit', async event => {
  event.preventDefault()
  status.textContent = ''
  button.disabled = true
  button.textContent = copy.working
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: field.value })
    })
    if (response.ok) {
      location.replace('/')
      return
    }
    status.textContent = response.status === 426 ? copy.https
      : response.status === 429 ? copy.locked : copy.wrong
    field.value = ''
    field.focus()
  } catch {
    status.textContent = copy.failed
  } finally {
    button.disabled = false
    button.textContent = copy.submit
  }
})
