# CirrayaBot desktop client

A native window for Windows and macOS that connects to the server you deployed yourself.
Same backend and same data as the web UI — open it on another computer and you get the same
conversations.

**There's no account system**, so there's no login page: enter the server address and access
token and you're done. Paste the whole `http://host:8080/?k=TOKEN` line the server prints at
startup into the address box and the two fields split themselves.

The UI is available in English (default), Simplified Chinese (简体中文) and Traditional Chinese
(繁體中文); switch on the setup screen or with the 🌐 icon in the sidebar footer.

## Building

```bash
flutter build windows --release     # output in build/windows/x64/runner/Release/
flutter build macos   --release     # output in build/macos/Build/Products/Release/
flutter build linux   --release     # for verification during development
```

macOS needs signing and notarization before you can give it to others (`codesign` +
`notarytool`); that step needs an Apple developer account and isn't configured in the repo.

## Development

```bash
flutter analyze .     # must be clean
flutter test          # 22 tests
flutter run -d linux  # runs right here on this machine
```

**Actually running it on headless Linux** (more useful than a screenshot harness, it exercises
the real network):

```bash
sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev xvfb imagemagick fonts-noto-cjk
flutter build linux --debug
Xvfb :99 -screen 0 1440x900x24 &
DISPLAY=:99 ./build/linux/x64/debug/bundle/multi_agent &
sleep 8 && DISPLAY=:99 import -window root /tmp/shot.png
```

⚠️ **`xdotool type` scrambles Chinese** (synthetic key events have no physical/logical codes;
the log fills with `hardware_keyboard.dart` assertions). That's xdotool, not the app —
drive the UI in English; Chinese goes in by pasting or a real input method.

## How the code is laid out

```
lib/platform.dart              every "this OS is different" decision, in one place only
lib/data/sse.dart              streaming parser for /api/chat (pure function, tested)
lib/data/markup.dart           code blocks / inline code / @names in messages (pure function, tested)
lib/data/api.dart              the server's HTTP surface
lib/data/settings.dart         the only local state: address + token
lib/state/workbench.dart       one ChangeNotifier, the whole window's state
lib/theme/app_theme.dart       the design system lives here, not in the widgets
lib/features/…                 UI
```

**No third-party dependencies.** This client has no local data — conversations, Agents, groups
and memory all live in the server's PostgreSQL; it's just a view. HTTP uses `dart:io`, state uses
`ChangeNotifier`, settings are a JSON file. Pulling in riverpod / http / path_provider would be
adding answers to a problem that doesn't exist.

The settings file is at:

| | Path |
| --- | --- |
| Windows | `%APPDATA%\MultiAgent\settings.json` |
| macOS | `~/Library/Application Support/MultiAgent/settings.json` |
| Linux | `~/.local/share/multi-agent/settings.json` |

It contains only the address and token. **The token is in plain text** — the system keychain
(Keychain / Credential Manager) isn't wired up yet, see below.

## Not done yet

- **Token in the keychain**. Right now it's plain JSON. Doing it means one branch for the macOS
  Keychain and one for the Windows Credential Manager, both native code.
- **Multiple servers**: connects to one at a time; switching servers means changing the settings.
- **Phones aren't an "adaptation"**: the 308px sidebar and three-column layout are desktop
  assumptions; phones need the navigation redone.
