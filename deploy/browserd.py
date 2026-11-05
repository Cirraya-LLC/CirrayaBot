#!/usr/bin/env python3
# The browser daemon inside each Agent's container.
#
# Why a long-running process instead of a browser per call: page state (a half-filled form,
# the screen reached in an SPA, a logged-in session) lives in the browser process. Restarting
# each time = every step reopens the URL from scratch. Login state is also persisted in
# /work/.browser (the Agent's own disk), so it survives container rebuilds.
#
# Listens on 127.0.0.1 only; reachable only via `docker exec ... curl` from inside the container.
#
# Async (asyncio + Playwright's async API): /stream is a push stream that stays open while
# clicks and screenshots still need handling — a single-threaded blocking server can't do that.
# Actions still run one at a time (lock): one browser can't be driven by two actions at once.
#
# /stream: Chromium's own screencast (CDP Page.startScreencast), a frame only when the page
# changes, pushed as multipart/x-mixed-replace (MJPEG). A browser <img> plays it natively.
import asyncio, base64, json, os, re, sys, time, traceback
from urllib.parse import quote as urlquote, quote_plus, urlsplit
from playwright.async_api import async_playwright

PORT = int(os.environ.get('BROWSERD_PORT', '9230'))
# Input channel: one JSON event per line (mouse, keyboard), for a person driving the Agent's browser.
# Separate from the action API because it must be fast: a mouse move shouldn't queue behind an Agent's page load
INPUT_PORT = PORT + 1
TEXT_MAX = 8000
ELEMS_MAX = 120

# Number everything clickable or fillable on the page; the model acts by number instead of
# writing CSS selectors — selectors are what models get wrong most, a number is what it just saw.
MARK_JS = r"""
(max) => {
  document.querySelectorAll('[data-ma-idx]').forEach(e => e.removeAttribute('data-ma-idx'))
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],summary'
  const out = []
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect(), st = getComputedStyle(e)
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue
    if (out.length >= max) break
    const i = out.length + 1
    e.setAttribute('data-ma-idx', i)
    const tag = e.tagName.toLowerCase()
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.name || e.getAttribute('href') || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    const kind = tag === 'input' ? `input[${e.type}]` : tag
    const inView = r.bottom > 0 && r.top < innerHeight
    out.push(`[${i}] ${kind}${inView ? '' : ' (off-screen)'} ${label}`)
  }
  return out
}
"""


# Listens inside every page for what a person does — clicks, typing, choices, Enter / Tab / Esc, scrolling — and
# hands it to this daemon (the __maRec binding) while a demonstration is recorded. Wherever the input comes from (the
# desktop, the browser view), the page sees it the same way. Elements are described the way a person would point at
# them, never by an input's value: a password field's value goes only to scrub(), never into a step.
REC_JS = r"""
(() => {
  if (window.__maRecOn) return
  window.__maRecOn = true
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const describe = el => {
    if (!el || !el.closest || el === document.body || el === document.documentElement) return null
    const t = el.closest('a,button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],label') || el
    const tag = t.tagName.toLowerCase(), type = (t.getAttribute('type') || '').toLowerCase()
    const field = tag === 'input' || tag === 'textarea' || tag === 'select'
    const text = field ? (['submit', 'button', 'reset'].includes(type) ? clean(t.value) : '') : clean(t.innerText)
    const label = clean(t.getAttribute('aria-label') || (t.labels && t.labels[0] && t.labels[0].innerText) || t.getAttribute('title'))
    return { tag, type, role: t.getAttribute('role') || '', text, label, name: clean(t.getAttribute('name')),
             placeholder: clean(t.getAttribute('placeholder')), href: tag === 'a' ? String(t.href || '').slice(0, 200) : '',
             password: type === 'password' }
  }
  const send = ev => { try { window.__maRec && window.__maRec(ev) } catch (e) {} }
  let enterAt = 0
  // Enter in a form makes the browser itself click the submit button (detail 0, no mouse): that is the Enter.
  addEventListener('click', e => { if (!(e.detail === 0 && Date.now() - enterAt < 500)) send({ kind: 'click', what: describe(e.target) }) }, true)
  addEventListener('input', e => {
    const el = e.target
    if (!el || !(el.matches && el.matches('input,textarea') || el.isContentEditable)) return
    const what = describe(el), secret = !!(what && what.password)
    const value = String(el.isContentEditable ? el.innerText : el.value || '')
    send({ kind: 'type', what, secret, text: secret ? '' : value.slice(0, 400), ...(secret ? { value } : {}) })
  }, true)
  addEventListener('change', e => {
    const el = e.target
    if (el && el.tagName === 'SELECT') send({ kind: 'select', what: describe(el), text: clean(el.selectedOptions[0] && el.selectedOptions[0].text) })
  }, true)
  addEventListener('keydown', e => {
    if (e.key === 'Enter') enterAt = Date.now()
    if (['Enter', 'Tab', 'Escape'].includes(e.key)) send({ kind: 'key', key: e.key })
  }, true)
  addEventListener('wheel', () => send({ kind: 'scroll' }), { capture: true, passive: true })
})()
"""
PROFILE = '/work/.browser'


def no_password_saving(profile):
    """Chromium on the desktop offers to save what a person types into a login form — into this profile, on the agent's
    own machine. Passwords belong in the secret store (fill_secret), so its password manager is off, set before every
    start (the person could have turned it back on in the browser's settings)."""
    path = os.path.join(profile, 'Default', 'Preferences')
    try:
        with open(path) as f:
            prefs = json.load(f)
    except (OSError, ValueError):
        prefs = {}
    prefs['credentials_enable_service'] = False
    prefs.setdefault('profile', {})['password_manager_enabled'] = False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(prefs, f)


def free_profile(profile):
    """Make the profile Chromium's again. A machine that was recreated (new image, new sandbox rules) or stopped while
    its browser ran leaves Chromium's lock behind, naming a host or a pid that is gone; Chromium then refuses the
    profile and, headless, dies with "Can't open display" — the agent's browser never opens again. Only this daemon
    runs Chromium on this profile, and it is starting: whatever still holds the profile is left over, so it goes."""
    me = os.getpid()
    try:
        pids = [p for p in os.listdir('/proc') if p.isdigit()]
    except OSError:
        pids = []       # no /proc (not Linux): nothing to look through
    for pid in pids:
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as f:
                args = f.read().split(b'\0')
        except OSError:
            continue
        if int(pid) != me and f'--user-data-dir={profile}'.encode() in args:
            try:
                os.kill(int(pid), 9)
            except OSError:
                pass
    for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
        try:
            os.unlink(os.path.join(profile, name))
        except FileNotFoundError:
            pass


async def title_of(p):
    """The page's title, or '' — read while a click or Enter is still navigating, Playwright throws "Execution context
    was destroyed", and the action that caused it was reported as failed although it had worked."""
    for _ in range(2):
        try:
            return await p.title()
        except Exception:
            try:
                await p.wait_for_load_state('domcontentloaded', timeout=5000)
            except Exception:
                pass
    return ''


REC_MAX_STEPS = 300
REC_MAX_SECONDS = 600
# Query parameters whose values are hidden in a recording whatever was typed: a login form sent by GET, a token in a link.
SENSITIVE_PARAM = re.compile(r'(pass|pwd|^pw$|token|secret|key|auth|code|sig|session|otp|cred)', re.I)


def scrub(steps, typed):
    """A recording made safe to hand on: what was typed into password fields (kept in memory while recording, never
    returned) is cut out wherever it shows up — a URL, a title, other text — and sensitive-looking query values go too."""
    variants = sorted({v for t in typed if len(t) >= 3 for v in (t, urlquote(t, safe=''), quote_plus(t))}, key=len, reverse=True)

    def clean(s):
        for v in variants:
            s = s.replace(v, '[password]')
        return s

    def clean_url(u):
        parts = urlsplit(u)
        if parts.query:
            q = '&'.join(k + ('=[hidden]' if eq and SENSITIVE_PARAM.search(k) else eq + v)
                         for k, eq, v in (p.partition('=') for p in parts.query.split('&')))
            u = parts._replace(query=q).geturl()
        return clean(u)

    for s in steps:
        for k, v in list(s.items()):
            if isinstance(v, str):
                s[k] = clean_url(v) if k in ('url', 'href') else clean(v)
            elif isinstance(v, dict):
                s[k] = {a: (clean_url(b) if a == 'href' else clean(b)) if isinstance(b, str) else b for a, b in v.items()}
        s.pop('into', None)
    return steps


class Browser:
    def __init__(self):
        self.rec = None              # a person's demonstration being recorded: {at, steps, url}
        self.ctx = None
        self.pw = None
        self.starting = asyncio.Lock()
        self.agent_acts = 0          # the agent's own actions in flight: what happens meanwhile isn't the person's
        self.lock = asyncio.Lock()
        self.watchers = set()        # one asyncio.Queue per stream viewer (holds only the latest frame)
        self.cast_page = None
        self.cdp = None

    async def start(self):
        """On the agent's desktop when it has one (the person sees and uses the same windows), else headless.
        Started again by page() when the person closes its last window."""
        free_profile(PROFILE)
        no_password_saving(PROFILE)
        self.pw = self.pw or await async_playwright().start()
        # Chromium's own sandbox won't start in here; the container (or VM) is this Agent's sandbox.
        args = ['--no-sandbox', '--disable-dev-shm-usage']
        common = dict(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'), locale='zh-CN')
        if os.path.exists('/tmp/.X11-unix/X1'):
            # Without --enable-automation: no "controlled by automated test software" bar across the person's screen.
            self.ctx = await self.pw.chromium.launch_persistent_context(PROFILE, headless=False, no_viewport=True,
                ignore_default_args=['--enable-automation'],
                # --test-type: no "unsupported flag --no-sandbox" bar either (Chromium's own sandbox can't run in an
                # unprivileged machine; the machine is the sandbox).
                env={**os.environ, 'DISPLAY': ':1'}, args=args + ['--start-maximized', '--no-first-run', '--test-type',
                '--no-default-browser-check', '--password-store=basic', '--hide-crash-restore-bubble'], **common)
        else:
            self.ctx = await self.pw.chromium.launch_persistent_context(PROFILE, headless=True, args=args,
                viewport={'width': 1280, 'height': 800}, **common)
        self.ctx.set_default_timeout(20_000)
        ctx = self.ctx
        ctx.on('close', lambda _: self.closed(ctx))
        await ctx.expose_binding('__maRec', self.on_rec)
        await ctx.add_init_script(REC_JS)
        ctx.on('page', self.watch_page)
        for p in ctx.pages:
            self.watch_page(p)

    def closed(self, ctx):
        if self.ctx is ctx:
            self.ctx, self.cast_page, self.cdp = None, None, None

    async def page(self):
        async with self.starting:
            if self.ctx is None:
                await self.start()
        pages = [p for p in self.ctx.pages if not p.is_closed()]
        p = pages[-1] if pages else await self.ctx.new_page()
        # The page changed (new tab, old one closed): move the stream over, or viewers keep seeing the old page
        if self.watchers and p is not self.cast_page:
            await self.cast(p)
        return p

    # ── streaming ──
    def push(self, frame):
        for q in list(self.watchers):
            if q.full():
                q.get_nowait()          # a slow viewer drops old frames; always give the latest
            q.put_nowait(frame)

    async def cast(self, p):
        if self.cdp:
            try:
                await self.cdp.send('Page.stopScreencast')
                await self.cdp.detach()
            except Exception:
                pass
        cdp = await self.ctx.new_cdp_session(p)
        self.cast_page, self.cdp = p, cdp

        async def on_frame(ev):
            try:
                # without an ack Chromium sends no further frames
                await cdp.send('Page.screencastFrameAck', {'sessionId': ev['sessionId']})
            except Exception:
                pass
            try:
                title = await p.title()
            except Exception:
                title = ''
            self.push((base64.b64decode(ev['data']), p.url, title))

        cdp.on('Page.screencastFrame', lambda ev: asyncio.ensure_future(on_frame(ev)))
        await cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 60, 'maxWidth': 1280, 'maxHeight': 800})

    async def stop_cast(self):
        if self.cdp and not self.watchers:
            try:
                await self.cdp.send('Page.stopScreencast')
                await self.cdp.detach()
            except Exception:
                pass
            self.cdp = self.cast_page = None

    async def watch(self):
        q = asyncio.Queue(maxsize=1)
        async with self.lock:
            self.watchers.add(q)
            p = await self.page()
            if p is not self.cast_page:
                await self.cast(p)
            # A still page produces no screencast frames — send a screenshot first, or the viewer stares at a blank.
            # During the screenshot's few tens of ms a screencast frame may arrive; if the queue is full, replace it with the newer one
            shot = (await p.screenshot(type='jpeg', quality=60), p.url, await p.title())
            if q.empty():
                q.put_nowait(shot)
        return q

    async def unwatch(self, q):
        self.watchers.discard(q)
        # Stop when nobody watches: every screencast frame is encoded; don't burn CPU on an empty room
        await self.stop_cast()

    # ── actions ──
    async def target(self, p, a):
        idx = a.get('index')
        # Models often fill unused parameters with 0; indexes start at 1, so 0 means not given
        if idx not in (None, '', 0, '0'):
            return p.locator(f'[data-ma-idx="{int(idx)}"]').first
        if a.get('text'):
            return p.get_by_text(str(a['text'])).first
        if a.get('selector'):
            return p.locator(str(a['selector'])).first
        raise ValueError('give one of index (a number listed by read), text or selector')

    async def settle(self, p):
        # After navigating, wait briefly for the network to go quiet: SPAs render after load. Not getting there isn't an error
        try:
            await p.wait_for_load_state('networkidle', timeout=3000)
        except Exception:
            pass

    async def act(self, a):
        kind = a.get('action')
        if kind == 'record_start':
            p = await self.page()
            self.rec = {'at': time.time(), 'url': p.url, 'typed': [], 'started': time.time(), 'steps': [{'kind': 'start', 'url': p.url, 'title': await title_of(p)}]}
            return {'recording': True}
        if kind == 'record_stop':
            if self.recording():
                await self.note_page(await self.page())
            rec, self.rec = self.rec, None
            if not rec:
                return {'steps': [], 'seconds': 0}
            return {'steps': scrub(rec['steps'], rec['typed']), 'seconds': round(time.time() - rec['started'])}
        agent = not a.get('human')
        self.agent_acts += agent
        try:
            async with self.lock:
                return await self._act(a)
        finally:
            self.agent_acts -= agent

    # ── recording a person's demonstration ──
    def recording(self):
        if self.rec and time.time() - self.rec['at'] > REC_MAX_SECONDS:
            self.rec['steps'].append({'kind': 'limit'})
            self.rec['at'] = -1           # stays readable, records nothing more
        return bool(self.rec) and self.rec['at'] >= 0 and len(self.rec['steps']) < REC_MAX_STEPS

    def note(self, step):
        steps = self.rec['steps']
        last = steps[-1] if steps else None
        # Typing into one field is one step, however many keystrokes; the same for scrolling.
        if last and step['kind'] in ('type', 'select') and last['kind'] == step['kind'] and last['into'] == step['into']:
            if not last.get('secret'):
                last['text'] = step['text']          # the page reports the field's whole value each time
            return
        if last and step['kind'] == 'scroll' and last['kind'] == 'scroll':
            return
        steps.append(step)

    async def note_page(self, p):
        if p.url != self.rec['url']:
            self.rec['url'] = p.url
            self.note({'kind': 'page', 'url': p.url[:300], 'title': (await title_of(p))[:120]})

    def watch_page(self, p):
        # A page moving on (a click, Enter, the address bar) is a step of its own.
        p.on('framenavigated', lambda f: asyncio.ensure_future(self.on_nav(p)) if f == p.main_frame else None)

    async def on_nav(self, p):
        if self.recording() and not self.agent_acts:
            await self.note_page(p)

    async def on_rec(self, source, ev):
        """What the page listener saw (REC_JS). Only while recording, and not while the agent itself is acting."""
        if not self.recording() or self.agent_acts or not isinstance(ev, dict):
            return
        kind = ev.get('kind')
        what = ev.get('what') if isinstance(ev.get('what'), dict) else None
        if kind == 'click':
            self.note({'kind': 'click', 'what': what})
        elif kind in ('type', 'select'):
            # Which field, without what is in it (a contenteditable's text changes with every key).
            into = json.dumps({k: v for k, v in (what or {}).items() if k != 'text'}, sort_keys=True)
            secret = kind == 'type' and bool(ev.get('secret'))
            if secret:      # the field's whole value, kept only so scrub() can cut it out of URLs and titles
                value = str(ev.get('value') or '')
                last = self.rec['steps'][-1]
                if last['kind'] == 'type' and last.get('into') == into and self.rec['typed']:
                    self.rec['typed'][-1] = value
                elif value:
                    self.rec['typed'].append(value)
            self.note({'kind': kind, 'into': into, 'what': what, 'secret': secret, 'text': '' if secret else str(ev.get('text') or '')[:400]})
        elif kind == 'key':
            self.note({'kind': 'key', 'key': str(ev.get('key'))[:20]})
        elif kind == 'scroll':
            self.note({'kind': 'scroll'})

    @staticmethod
    def origin_of(url):
        # scheme://host[:port], default ports left out — the same form the server stores a secret's site in
        s = urlsplit(url)
        if not s.scheme or not s.hostname:
            return ''
        host = f'[{s.hostname}]' if ':' in s.hostname else s.hostname
        port = s.port
        default = {'https': 443, 'http': 80}.get(s.scheme)
        return f'{s.scheme}://{host}' + (f':{port}' if port and port != default else '')

    async def _act(self, a):
        p = await self.page()
        kind = a.get('action')
        out = {}
        if kind == 'open':
            url = str(a.get('url', '')).strip()
            if not url:
                raise ValueError('open needs a url')
            if '://' not in url:
                url = 'https://' + url
            await p.goto(url, wait_until='domcontentloaded')
            await self.settle(p)
        elif kind == 'click':
            await (await self.target(p, a)).click()
            await self.settle(p)
        elif kind == 'type':
            # here text is what to type, not a way to find the element
            el = await self.target(p, {k: a.get(k) for k in ('index', 'selector')})
            await el.fill(str(a.get('text', '')))
            if a.get('submit'):
                await el.press('Enter')
                await self.settle(p)
        elif kind == 'fill_secret':
            # A password typed only into the site it was saved for. Checked here, under the same lock as
            # the typing, so the page can't move between the check and the fill. Never echoed back.
            want, have = str(a.get('origin', '')), self.origin_of(p.url)
            if not want or have != want:
                raise ValueError(f'this page is on {have or p.url}, and the secret is only for {want}')
            el = await self.target(p, {k: a.get(k) for k in ('index', 'selector')})
            await el.fill(str(a.get('text', '')))
            if a.get('submit'):
                await el.press('Enter')
                await self.settle(p)
        elif kind == 'press':
            await p.keyboard.press(str(a.get('key') or 'Enter'))
            await self.settle(p)
        elif kind == 'scroll':
            await p.mouse.wheel(0, int(a.get('dy') or 600))
            await p.wait_for_timeout(300)
        elif kind == 'back':
            await p.go_back(wait_until='domcontentloaded')
            await self.settle(p)
        # ── the ones below are for people (taking over the Agent's browser in the client): they see a picture and click coordinates ──
        elif kind == 'click_xy':
            await p.mouse.click(float(a.get('x', 0)), float(a.get('y', 0)))
            await self.settle(p)
        elif kind == 'type_raw':
            # type into whatever has focus, like a person at the keyboard (no element number needed)
            await p.keyboard.type(str(a.get('text', '')))
        elif kind == 'wheel':
            await p.mouse.move(float(a.get('x', 640)), float(a.get('y', 400)))
            await p.mouse.wheel(float(a.get('dx', 0)), float(a.get('dy', 0)))
            await p.wait_for_timeout(150)
        elif kind == 'reload':
            await p.reload(wait_until='domcontentloaded')
            await self.settle(p)
        elif kind == 'open_tab':
            # A link opened on the desktop (LibreOffice, the file manager, the panel): a tab in this browser.
            url = str(a.get('url', '')).strip()
            if url:
                if '://' not in url and not url.startswith(('about:', 'file:')):
                    url = 'https://' + url
                if p.url not in ('about:blank', ''):
                    p = await self.ctx.new_page()
                await p.goto(url, wait_until='domcontentloaded')
            await p.bring_to_front()
        elif kind == 'noop':
            pass
        elif kind == 'eval':
            out['result'] = json.dumps(await p.evaluate(str(a.get('js', ''))), ensure_ascii=False, default=str)[:TEXT_MAX]
        elif kind == 'read':
            text = await p.inner_text('body') if await p.locator('body').count() else ''
            out['text'] = text[:TEXT_MAX] + (f'\n… (truncated, {len(text)} characters total)' if len(text) > TEXT_MAX else '')
            out['elements'] = await p.evaluate(MARK_JS, ELEMS_MAX)
        elif kind == 'screenshot':
            # JPEG is an order of magnitude smaller than PNG, and screenshots go into the model's context
            out['image'] = base64.b64encode(await p.screenshot(type='jpeg', quality=60, full_page=bool(a.get('full_page')))).decode()
        else:
            raise ValueError(f'unknown action {kind}')
        p = await self.page()        # a new tab opened: later actions and the stream follow it
        out['url'] = p.url
        out['title'] = await title_of(p)
        return out


    # ── direct control by a person: mouse / keyboard events, executed as they arrive ──
    async def input(self, ev):
        p = await self.page()
        t = ev.get('t')
        x, y = float(ev.get('x', 0)), float(ev.get('y', 0))
        button = ev.get('button') or 'left'
        if t == 'move':
            await p.mouse.move(x, y)
        elif t == 'down':
            await p.mouse.move(x, y)
            await p.mouse.down(button=button, click_count=int(ev.get('count') or 1))
        elif t == 'up':
            await p.mouse.move(x, y)
            await p.mouse.up(button=button, click_count=int(ev.get('count') or 1))
        elif t == 'wheel':
            await p.mouse.move(x, y)
            await p.mouse.wheel(float(ev.get('dx', 0)), float(ev.get('dy', 0)))
        elif t == 'keydown':
            await p.keyboard.down(str(ev['key']))
        elif t == 'keyup':
            await p.keyboard.up(str(ev['key']))
        elif t == 'press':
            await p.keyboard.press(str(ev['key']))
        elif t == 'text':
            # typed text (including IME-composed text) is inserted into the page, same as a person typing
            await p.keyboard.insert_text(str(ev.get('text', '')))


B = Browser()


async def send_json(w, body):
    data = json.dumps(body, ensure_ascii=False).encode()
    w.write(b'HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n'
            b'content-length: ' + str(len(data)).encode() + b'\r\nconnection: close\r\n\r\n' + data)
    await w.drain()


async def stream(w):
    w.write(b'HTTP/1.1 200 OK\r\ncache-control: no-store\r\nconnection: close\r\n'
            b'content-type: multipart/x-mixed-replace; boundary=frame\r\n\r\n')
    q = await B.watch()
    try:
        while True:
            try:
                jpeg, url, title = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                # A still page emits no frames for a long time: send an empty heartbeat, which also reveals a departed viewer (the write fails)
                w.write(b'--frame\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n\r\n\r\n')
                await w.drain()
                continue
            w.write(('--frame\r\ncontent-type: image/jpeg\r\ncontent-length: %d\r\n'
                     'x-page-url: %s\r\nx-page-title: %s\r\n\r\n'
                     % (len(jpeg), urlquote(url or '', safe=''), urlquote(title or '', safe=''))).encode()
                    + jpeg + b'\r\n')
            await w.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        await B.unwatch(q)


async def handle(r, w):
    try:
        line = (await r.readline()).decode(errors='replace').split()
        headers = {}
        while True:
            h = await r.readline()
            if h in (b'\r\n', b'\n', b''):
                break
            k, _, v = h.decode(errors='replace').partition(':')
            headers[k.strip().lower()] = v.strip()
        if len(line) < 2:
            return
        method, path = line[0], line[1]
        if method == 'GET' and path.startswith('/stream'):
            return await stream(w)
        if method == 'GET':
            return await send_json(w, {'ok': True})
        body = await r.readexactly(int(headers.get('content-length') or 0))
        try:
            await send_json(w, {'ok': True, **(await B.act(json.loads(body or b'{}')))})
        except Exception as e:
            await send_json(w, {'ok': False, 'error': f'{type(e).__name__}: {e}'.strip()[:600]})
            traceback.print_exc(file=sys.stderr)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        try:
            w.close()
        except Exception:
            pass


async def handle_input(r, w):
    try:
        while True:
            line = await r.readline()
            if not line:
                break
            try:
                await B.input(json.loads(line))
            except Exception:
                traceback.print_exc(file=sys.stderr)   # one bad event must not kill the whole channel
    finally:
        try:
            w.close()
        except Exception:
            pass


async def main():
    await B.start()
    srv = await asyncio.start_server(handle, '127.0.0.1', PORT)
    inp = await asyncio.start_server(handle_input, '127.0.0.1', INPUT_PORT)
    async with srv, inp:
        await asyncio.gather(srv.serve_forever(), inp.serve_forever())


asyncio.run(main())
