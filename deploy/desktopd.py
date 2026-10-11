#!/usr/bin/env python3
# The desktop daemon inside each Agent's container: a screen of its own (Xvfb on :1) with a window
# manager and a terminal, streamed as MJPEG and driven by mouse and keyboard — by a person (the input
# channel, the same events the browser view sends) and by the agent (the computer tool, POST /).
# Same shape as browserd.py, so the clients' browser viewer shows a desktop too.
#
# Started on demand (the server pushes this file and runs it), never at container start: an X server
# idling in every agent's container costs memory for nothing.
#
# Listens on 127.0.0.1 only; reached through `docker exec ... curl` like the browser daemon.
import asyncio, base64, hashlib, io, json, os, subprocess, sys, time, traceback

from PIL import Image
from Xlib import X, XK, display
from Xlib.ext import xtest

PORT = 9240
INPUT_PORT = PORT + 1
SCREEN = ':1'
W, H = 1280, 800
FPS = 6
os.environ['DISPLAY'] = SCREEN


def spawn(argv, log):
    return subprocess.Popen(argv, stdout=open(log, 'ab'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            start_new_session=True, cwd='/work')


def start_screen():
    """The X server, its window manager, and a terminal to begin with — only when the screen is new: the
    daemon restarting (a new version pushed) must not open another terminal on a screen already in use."""
    if os.path.exists('/tmp/.X11-unix/X1'):
        return
    spawn(['Xvfb', SCREEN, '-screen', '0', f'{W}x{H}x24', '-nolisten', 'tcp', '-dpi', '96'], '/tmp/xvfb.log')
    for _ in range(100):
        if os.path.exists('/tmp/.X11-unix/X1'):
            break
        time.sleep(0.1)
    time.sleep(0.3)
    spawn(['openbox'], '/tmp/openbox.log')
    spawn(['xsetroot', '-solid', '#2b2f36'], '/tmp/xsetroot.log')
    terminal()


def terminal():
    """A terminal window, in /work, where the person (or the agent) can type commands."""
    spawn(['xterm', '-fa', 'DejaVu Sans Mono', '-fs', '11', '-bg', '#1e1f24', '-fg', '#e6e6e6', '-geometry', '110x30+60+50',
           '-title', 'Terminal', '-e', 'bash', '-l'], '/tmp/xterm.log')


class Screen:
    def __init__(self):
        self.d = display.Display(SCREEN)             # input, on the event loop
        self.g = display.Display(SCREEN)             # grabbing, in a worker thread (a connection isn't thread-safe)
        self.root = self.g.screen().root
        self.watchers = set()          # one asyncio.Queue per viewer, holding only the newest frame
        self.lock = asyncio.Lock()
        self.last = None
        self.scratch = None            # a keycode borrowed to type characters the keymap doesn't have

    # ── seeing ──
    def grab(self):
        raw = self.root.get_image(0, 0, W, H, X.ZPixmap, 0xffffffff).data
        return raw, Image.frombytes('RGB', (W, H), raw, 'raw', 'BGRX')

    def jpeg(self, img, quality=70):
        out = io.BytesIO()
        img.save(out, 'JPEG', quality=quality)
        return out.getvalue()

    async def casting(self):
        """While anyone watches: a frame when the screen changed, at most FPS a second."""
        while self.watchers:
            try:
                raw, img = await asyncio.to_thread(self.grab)
                sig = hashlib.md5(raw[::7]).digest()
                if sig != self.last:
                    self.last = sig
                    frame = await asyncio.to_thread(self.jpeg, img)
                    for q in list(self.watchers):
                        if q.full():
                            q.get_nowait()
                        q.put_nowait(frame)
            except Exception:
                traceback.print_exc(file=sys.stderr)
            await asyncio.sleep(1 / FPS)

    async def watch(self):
        q = asyncio.Queue(maxsize=1)
        first = not self.watchers
        self.watchers.add(q)
        self.last = None               # a new viewer gets a frame at once
        if first:
            asyncio.ensure_future(self.casting())
        return q

    def unwatch(self, q):
        self.watchers.discard(q)

    # ── doing ──
    def move(self, x, y):
        xtest.fake_input(self.d, X.MotionNotify, x=max(0, min(W - 1, int(x))), y=max(0, min(H - 1, int(y))))

    def button(self, b, down):
        xtest.fake_input(self.d, X.ButtonPress if down else X.ButtonRelease, b)

    def keycode(self, keysym):
        """The keycode for a keysym, and whether Shift is needed for it; a borrowed one when the keymap has none."""
        kc = self.d.keysym_to_keycode(keysym)
        if kc and kc != self.scratch:
            return kc, self.d.keycode_to_keysym(kc, 0) != keysym and self.d.keycode_to_keysym(kc, 1) == keysym
        if self.scratch is None:       # the highest keycode with nothing on it
            first = self.d.display.info.min_keycode
            maps = self.d.get_keyboard_mapping(first, self.d.display.info.max_keycode - first + 1)
            self.scratch = next((first + i for i in range(len(maps) - 1, -1, -1) if not any(maps[i])), 253)
        self.d.change_keyboard_mapping(self.scratch, [(keysym, keysym)])
        self.d.sync()
        return self.scratch, False

    def tap(self, keysym, mods=()):
        kc, shift = self.keycode(keysym)
        held = [self.d.keysym_to_keycode(XK.string_to_keysym(m)) for m in mods] + \
               ([self.d.keysym_to_keycode(XK.XK_Shift_L)] if shift else [])
        for m in held:
            xtest.fake_input(self.d, X.KeyPress, m)
        xtest.fake_input(self.d, X.KeyPress, kc)
        xtest.fake_input(self.d, X.KeyRelease, kc)
        for m in reversed(held):
            xtest.fake_input(self.d, X.KeyRelease, m)
        self.d.sync()

    async def type_text(self, text):
        for ch in str(text):
            if ch == '\n':
                self.tap(XK.XK_Return)
                continue
            if ch == '\t':
                self.tap(XK.XK_Tab)
                continue
            cp = ord(ch)
            keysym = cp if 0x20 <= cp <= 0x7e or 0xa0 <= cp <= 0xff else 0x01000000 | cp
            borrowed = not self.d.keysym_to_keycode(keysym) or self.d.keysym_to_keycode(keysym) == self.scratch
            if borrowed:
                # A character the keymap doesn't have goes through one borrowed key, remapped each time.
                # Programs read the new mapping only after the change reaches them: without the pauses,
                # every character of 中文也可以 comes out as the last one.
                self.keycode(keysym)
                await asyncio.sleep(0.03)
            self.tap(keysym)
            if borrowed:
                await asyncio.sleep(0.03)

    def press_combo(self, combo):
        """"ctrl+c", "alt+F4", "Return", "shift+Tab" — xdotool's names, plus the browser view's (Enter, ArrowLeft…)."""
        parts = [p for p in str(combo).replace(' ', '').split('+') if p]
        if not parts:
            return
        mods = [MOD_NAMES.get(p.lower(), p) for p in parts[:-1]]
        self.tap(keysym_of(parts[-1]), [m for m in mods if m])

    def wheel(self, dx, dy):
        for b, n in ((5 if dy > 0 else 4, dy), (7 if dx > 0 else 6, dx)):
            for _ in range(min(20, round(abs(n) / 60) or (1 if n else 0))):
                self.button(b, True)
                self.button(b, False)

    async def input(self, ev):
        """The person's mouse and keyboard, as the browser view sends them."""
        t = ev.get('t')
        x, y = ev.get('x'), ev.get('y')
        if x is not None and y is not None:
            self.move(float(x), float(y))
        b = BUTTONS.get(ev.get('button') or 'left', 1)
        if t == 'down':
            for _ in range(max(1, int(ev.get('count') or 1)) - 1):     # a double click arrives as count 2
                self.button(b, True)
                self.button(b, False)
            self.button(b, True)
        elif t == 'up':
            self.button(b, False)
        elif t == 'wheel':
            self.wheel(float(ev.get('dx', 0)), float(ev.get('dy', 0)))
        elif t in ('keydown', 'keyup'):
            kc, _ = self.keycode(keysym_of(str(ev.get('key', ''))))
            xtest.fake_input(self.d, X.KeyPress if t == 'keydown' else X.KeyRelease, kc)
        elif t == 'press':
            self.press_combo(ev.get('key', ''))
        elif t == 'text':
            await self.type_text(ev.get('text', ''))
        self.d.sync()

    async def act(self, a):
        """The agent's computer tool. Every action answers with a screenshot of what came of it."""
        async with self.lock:
            action = a.get('action')
            x, y = a.get('x'), a.get('y')
            if action in ('click', 'double_click', 'right_click', 'move', 'drag', 'scroll') and (x is None or y is None):
                raise ValueError(f'{action} needs x and y (pixels on the {W}x{H} screen)')
            if action == 'terminal':
                terminal()
            elif action in ('click', 'double_click', 'right_click'):
                self.move(x, y)
                b = 3 if action == 'right_click' else 1
                for _ in range(2 if action == 'double_click' else 1):
                    self.button(b, True)
                    self.button(b, False)
            elif action == 'move':
                self.move(x, y)
            elif action == 'drag':
                self.move(x, y)
                self.button(1, True)
                self.d.sync()
                await asyncio.sleep(0.05)
                self.move(a.get('to_x', x), a.get('to_y', y))
                self.d.sync()
                await asyncio.sleep(0.05)
                self.button(1, False)
            elif action == 'scroll':
                self.move(x, y)
                self.wheel(0, float(a.get('dy', 3)) * 60)
            elif action == 'type':
                await self.type_text(a.get('text', ''))
            elif action == 'key':
                self.press_combo(a.get('keys', ''))
            elif action != 'screenshot':
                raise ValueError(f'unknown action {action}')
            self.d.sync()
            await asyncio.sleep(0.6 if action != 'screenshot' else 0)
            _, img = await asyncio.to_thread(self.grab)
            return {'image': base64.b64encode(await asyncio.to_thread(self.jpeg, img, 75)).decode(), 'width': W, 'height': H}


BUTTONS = {'left': 1, 'middle': 2, 'right': 3}
MOD_NAMES = {'ctrl': 'Control_L', 'control': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'super': 'Super_L',
             'meta': 'Super_L', 'cmd': 'Control_L', 'win': 'Super_L'}
# The browser view's key names (KeyboardEvent.key) → X keysym names
KEY_NAMES = {'Enter': 'Return', 'Backspace': 'BackSpace', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up',
             'ArrowDown': 'Down', 'PageUp': 'Prior', 'PageDown': 'Next', 'Control': 'Control_L', 'Shift': 'Shift_L',
             'Alt': 'Alt_L', 'Meta': 'Super_L', 'Esc': 'Escape', ' ': 'space', 'Space': 'space'}


def keysym_of(name):
    name = KEY_NAMES.get(name) or name
    if len(name) == 1:
        cp = ord(name)
        return cp if 0x20 <= cp <= 0x7e or 0xa0 <= cp <= 0xff else 0x01000000 | cp
    ks = XK.string_to_keysym(name)
    if not ks:
        raise ValueError(f'unknown key {name}')
    return ks


async def send_json(w, body):
    data = json.dumps(body, ensure_ascii=False).encode()
    w.write(b'HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n'
            b'content-length: ' + str(len(data)).encode() + b'\r\nconnection: close\r\n\r\n' + data)
    await w.drain()


async def stream(w):
    w.write(b'HTTP/1.1 200 OK\r\ncache-control: no-store\r\nconnection: close\r\n'
            b'content-type: multipart/x-mixed-replace; boundary=frame\r\n\r\n')
    q = await S.watch()
    try:
        while True:
            try:
                jpeg = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                # a still screen sends nothing for a while: a heartbeat, which also finds a viewer that has gone
                w.write(b'--frame\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n\r\n\r\n')
                await w.drain()
                continue
            w.write(('--frame\r\ncontent-type: image/jpeg\r\ncontent-length: %d\r\nx-page-title: Desktop\r\n\r\n'
                     % len(jpeg)).encode() + jpeg + b'\r\n')
            await w.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        S.unwatch(q)


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
            await send_json(w, {'ok': True, **(await S.act(json.loads(body or b'{}')))})
        except Exception as e:
            await send_json(w, {'ok': False, 'error': f'{type(e).__name__}: {e}'.strip()[:600]})
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
                await S.input(json.loads(line))
            except Exception:
                traceback.print_exc(file=sys.stderr)   # one bad event must not end the channel
    finally:
        try:
            w.close()
        except Exception:
            pass


async def main():
    global S
    start_screen()
    S = Screen()
    srv = await asyncio.start_server(handle, '127.0.0.1', PORT)
    inp = await asyncio.start_server(handle_input, '127.0.0.1', INPUT_PORT)
    async with srv, inp:
        await asyncio.gather(srv.serve_forever(), inp.serve_forever())


asyncio.run(main())
