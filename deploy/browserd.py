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


# What a person clicked or typed into, described the way a person would say it. Never an input's value:
# clicking into a filled-in password box must not record the password.
DESCRIBE_JS = r"""
([x, y, focused]) => {
  let el = focused ? document.activeElement : document.elementFromPoint(x, y)
  if (!el || el === document.body || el === document.documentElement) return null
  const t = el.closest('a,button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],label') || el
  const tag = t.tagName.toLowerCase(), type = (t.getAttribute('type') || '').toLowerCase()
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const field = tag === 'input' || tag === 'textarea' || tag === 'select'
  const text = field ? (['submit', 'button', 'reset'].includes(type) ? clean(t.value) : '') : clean(t.innerText)
  const label = clean(t.getAttribute('aria-label') || (t.labels && t.labels[0] && t.labels[0].innerText) || t.getAttribute('title'))
  return { tag, type, role: t.getAttribute('role') || '', text, label, name: clean(t.getAttribute('name')),
           placeholder: clean(t.getAttribute('placeholder')), href: tag === 'a' ? String(t.href || '').slice(0, 200) : '',
           password: type === 'password' }
}
"""
PROFILE = '/work/.browser'


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
        self.lock = asyncio.Lock()
        self.watchers = set()        # one asyncio.Queue per stream viewer (holds only the latest frame)
        self.cast_page = None
        self.cdp = None

    async def start(self):
        free_profile(PROFILE)
        pw = await async_playwright().start()
        self.ctx = await pw.chromium.launch_persistent_context(
            PROFILE,
            executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'),
            headless=True,
            # We're root in the container and chromium's sandbox won't start as root; the container itself is this Agent's sandbox
            args=['--no-sandbox', '--disable-dev-shm-usage'],
            viewport={'width': 1280, 'height': 800},
            locale='zh-CN',
        )
        self.ctx.set_default_timeout(20_000)

    async def page(self):
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
        human = a.get('human') and self.recording()
        if human and kind == 'click_xy':        # described before the click: afterwards the page may have changed
            self.note({'kind': 'click', 'what': await self.describe(await self.page(), float(a.get('x', 0)), float(a.get('y', 0)))})
        async with self.lock:
            out = await self._act(a)
        if human:
            await self.note_act(a)
        return out

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
        if last and step['kind'] == 'type' and last['kind'] == 'type' and last['into'] == step['into']:
            if not last.get('secret'):
                last['text'] = (last['text'] + step['text'])[:400]
            return
        if last and step['kind'] == 'scroll' and last['kind'] == 'scroll':
            return
        steps.append(step)

    async def note_page(self, p):
        if p.url != self.rec['url']:
            self.rec['url'] = p.url
            self.note({'kind': 'page', 'url': p.url[:300], 'title': (await title_of(p))[:120]})

    async def describe(self, p, x=0, y=0, focused=False):
        try:
            return await p.evaluate(DESCRIBE_JS, [x, y, focused])
        except Exception:
            return None

    async def note_typed(self, p, text):
        what = await self.describe(p, focused=True)
        secret = bool(what and what.get('password'))
        # Which field, without what is in it (a contenteditable's text changes with every key).
        into = json.dumps({k: v for k, v in (what or {}).items() if k != 'text'}, sort_keys=True)
        if secret:      # kept whole, typed key by key or not, so scrub() can find it wherever it shows up later
            last = self.rec['steps'][-1]
            if last['kind'] == 'type' and last.get('into') == into and self.rec['typed']:
                self.rec['typed'][-1] += str(text)
            else:
                self.rec['typed'].append(str(text))
        self.note({'kind': 'type', 'into': into, 'what': what, 'secret': secret, 'text': '' if secret else str(text)[:400]})

    async def note_input(self, p, ev):
        t = ev.get('t')
        if t == 'down' and (ev.get('button') or 'left') == 'left':
            self.note({'kind': 'click', 'what': await self.describe(p, float(ev.get('x', 0)), float(ev.get('y', 0)))})
        elif t == 'text':
            await self.note_typed(p, ev.get('text', ''))
        elif t in ('keydown', 'press') and str(ev.get('key')) in ('Enter', 'Tab', 'Escape'):
            self.note({'kind': 'key', 'key': str(ev.get('key'))})
        elif t == 'wheel':
            self.note({'kind': 'scroll'})
        # Every event is a chance to see that the page moved on (a click or Enter navigates a moment later).
        await self.note_page(await self.page())

    async def note_act(self, a):
        if not self.recording():
            return
        p = await self.page()
        kind = a.get('action')
        if kind == 'open':
            self.rec['url'] = p.url
            self.note({'kind': 'open', 'url': p.url[:300], 'title': (await title_of(p))[:120]})
        elif kind in ('back', 'reload'):
            self.note({'kind': kind})
        elif kind == 'type_raw':
            await self.note_typed(p, a.get('text', ''))
        elif kind == 'press':
            self.note({'kind': 'key', 'key': str(a.get('key') or 'Enter')})
        await self.note_page(p)

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
        rec = self.recording()
        # A click is described before it happens: afterwards the page may have changed under it.
        if rec and t == 'down':
            await self.note_input(p, ev)
            rec = False
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
        if rec:
            await self.note_input(p, ev)


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
