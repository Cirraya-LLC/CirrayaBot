# CirrayaBot

An open-source "AI coworker": a column of Agents and group chats on the left. Each Agent has
its own persona, its own container and its own memory; put them in a group and the lead
**hands pieces of the work to colleagues, who do them in parallel** and report back, instead
of each answering on their own.

- **One container per Agent** — he is root on his own machine and can install or write
  whatever he likes, but he can't see the platform's code or anyone else's desktop. This is
  where Grok Bot's biggest design flaw (every Bot shares one cloud computer) gets fixed.
- **Group chat is collaboration, not broadcast** — one Agent answers each message (the one you
  @mention, else the group's lead) and hands work to colleagues as background tasks. Each group
  has its own shared drive at `/groups/<id>` in every member's container; copying a file there is
  how you hand something to a coworker.
- **Background tasks: the conversation stays free** — anything that takes a while runs as a
  task in the background (in a DM, the Agent itself; in a group, whichever colleague it went to),
  while the conversation goes on. One Agent's tasks queue; different Agents' run side by side.
  When a task needs something only you can give, it pauses and asks: the Agent you're talking to
  tells you, or you answer on the task's card (that answer goes to the task alone — handy for a
  password). Finished work comes back into the conversation and gets summarized. Every task is in
  the right panel, with what it ran and a Stop button.
- **Files both ways** — attach files to a message (📎, drag them in, or paste a screenshot); the
  Agent sees images and text files directly and finds every file in its inbox. Agents send files
  back (a report, a chart, an archive). Images, video and audio play in place; PDF, Markdown and
  text open in a preview; anything else downloads. Up to 50 MB a file (`UPLOAD_MAX_MB`).
- **Memory carries across contexts** — what was discussed in a group, he still remembers
  in a direct chat.
- **Sessions, and search across them** — a DM or a group holds as many separate sessions as you
  like (the ▾ next to the name in the chat header: new, switch, rename, delete). The model only
  sees the session on screen; memory and skills carry across all of them. The same panel searches
  everything said in that conversation and jumps to the message. Scheduled tasks write into a
  session of their own, and an imported history becomes a new session.
- **Works on its own until the job is done (auto mode, the default)** — an Agent writes a plan
  and works through it without waiting for you to say "continue", checks its own work, and only
  stops when it's done or needs something only you can give. Closing the page doesn't stop it: a dot marks the
  conversations still being worked on, and **Stop** is on the conversation. Switch an Agent (or
  the whole platform, in ⚙) to *manual* to go back to a few steps per message. Approvals and the
  daily cap apply either way.
- **Bring your own model upstream** — name / endpoint URL / key / model / context window.
  Configure several and switch any time. Three API shapes are supported:
  OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
- **Notifications** — when a reply lands, or an Agent needs an answer or an approval, while you aren't
  looking: in the browser (the bell in the sidebar footer) and on Android, also when the app is closed (a small
  background connection; no Google services needed).
- **Three UI languages** — the web UI and the desktop client support English (default),
  Simplified Chinese (简体中文) and Traditional Chinese (繁體中文), switchable in the UI
  (the 🌐 icon in the sidebar footer; the desktop client also on its setup screen).

## Running it

You need docker (or podman) plus the compose plugin. **It's one command**:

```bash
./start.sh
```

It generates `.env` (with a random database password and access token), starts PostgreSQL,
builds and starts the service, and finally prints the address with the token in it:

```
Up: http://127.0.0.1:8080/?k=xxxxxxxx
```

The first time you open it, the "Model upstreams" dialog pops up; fill it in and you can start
talking. After that:

```bash
docker compose up -d      # start
docker compose down       # stop (data lives in the pgdata volume and is kept)
docker compose logs -f app
```

**Running a second instance on the same machine**: change `COMPOSE_PROJECT_NAME`, `WEB_PORT`
and `AGENT_PREFIX` in `.env` first — all three. If you don't change the project name, the
second instance attaches to the first one's database container, and the passwords differ —
the symptom is being stuck forever at "waiting for PostgreSQL…".

**podman**: `./start.sh` detects it by itself and points the socket at podman's.
The socket has to be running: `systemctl --user enable --now podman.socket`.

## Configuring model upstreams

Bottom left: the **⚙** icon (Model upstreams). First choose which API the upstream speaks, then fill in
the fields:

| Protocol | Endpoint called | Typical upstreams |
| --- | --- | --- |
| Chat Completions | `<URL>/chat/completions` | OpenAI, OpenRouter, vLLM, ollama, most relays |
| Responses | `<URL>/responses` | OpenAI's newer API, Codex-style relays |
| Messages | `<URL>/messages` | Anthropic official, Claude relays (uses `x-api-key`) |


| Field | What to enter |
| --- | --- |
| Name | Anything you'll recognise |
| Endpoint URL | Up to and including `/v1`, e.g. `https://api.openai.com/v1` |
| API Key | When editing an existing upstream, leave empty = unchanged |
| Model name | `gpt-4o` / `claude-opus-5` / `qwen3-max` / your self-hosted one |

The **context window** decides how much history is kept. Two ways to set it:

- **Auto**: first ask the upstream's `/models` (OpenRouter, vLLM, ollama and most relay
  gateways answer); if that fails, infer from the model name. The UI states clearly whether
  the number was **asked** or **guessed**.
- **Manual**: enter it yourself. Use this when the upstream doesn't report it and the model
  name isn't known either.

Both buttons next to it are worth pressing: **Probe** only checks the window, **Test connection**
really calls the upstream once — a wrong key, a wrong model name or a dead relay channel shows up
here, instead of half an hour later as "some Agent isn't talking".

With several upstreams, click the small dot on the left to switch which one is in use.

## What it costs, and holding it back

Every model call is recorded: tokens, and money when the upstream has prices. The left column's
footer shows today's and this month's total; the right panel shows it per Agent in the open
conversation, with the cap in force.

- **Prices** go on the upstream, per million tokens (`Input $/M` / `Output $/M`). Leave them
  empty if you don't know them: calls are still counted in tokens, but they have no cost —
  and no cap can hold them. Unknown is shown as `—`, never as `$0.00`.
- **The daily cap** is per Agent (Edit Agent → *Daily spend cap $*), falling back to a
  platform-wide default set next to the prices. It is checked before every model call, so a
  turn that runs a dozen tools stops at the dozenth, not after it. Past the cap the Agent
  refuses the turn with a message saying so; a scheduled task records the reason and is **not**
  counted as a failure, so a cap pauses it rather than disabling it. The day resets at midnight
  in the server's timezone.

## Letting Agents actually do things

By default Agents can only talk. Set `AGENT_TOOLS=on` in `.env` and run `docker compose up -d`;
they then get `bash` / read file / write file, executed **inside their own containers**.

> ⚠️ Once it's on, **whoever has the access token = has a shell in a container**.
> And any external text an Agent reads (web pages, logs, coworkers' messages) may be a prompt
> injection. This is a switch a person deliberately flips, not a default.

What each container can reach:

- **Files**: its own desk (`/work`) and the shared drive of **each group it is in**
  (`/groups/<id>`, and `group/` while it speaks in that group). A group it isn't in doesn't exist
  in there; leaving a group takes the container down at once, and the next turn starts it without
  that drive. The platform's code and `.env` are never mounted.
- **Network**: the Agents share a bridge of their own with container-to-container traffic off, so
  they can't reach one another. They **can** reach the internet, and any service on the host that
  listens on all interfaces (the host's SSH, this app's own port if `BIND_ADDR=0.0.0.0`) — put a
  firewall in front of those if that matters to you.
- **Privileges**: root inside the container, but with a short capability list and
  `no-new-privileges`, so `apt install` works and raw sockets don't.
- The file tools refuse a name in a group drive that is a symlink out of it (a group-mate can't
  plant `report.md -> /work/...` to make you read or overwrite your own files). Plain `bash` in the
  container isn't policed that way.
- The access token's cookie is `HttpOnly`, and marked `Secure` behind a TLS proxy that sends
  `X-Forwarded-Proto: https`. Over plain HTTP the token travels in the clear — put HTTPS in front
  of a public deployment.

### Asking before acting

An Agent asks you first before running anything that matches a pattern list — `rm -rf`, `sudo`,
`git push`, piping a download into a shell, and so on. The card in the transcript grows **Deny**
and **Approve** buttons and the turn waits for you. Under **Model upstreams** you can switch the
whole platform to *never ask* or *ask every time*, and edit the list; each Agent can override it
for itself in its editor.

The patterns are regular expressions matched against the command itself, never against the
contents of a file being written. A refusal goes back to the Agent as the result of that call, so
it reports it and moves on instead of retrying. **Scheduled tasks have nobody to ask, so anything
that would ask is refused there** — a task will never sit waiting for a person who isn't looking.

The point of doing it here rather than in the persona: a sentence in a persona is something one
prompt injection can rewrite. A tool that doesn't run isn't.

## Exposing it to the internet

Set `BIND_ADDR=0.0.0.0` in `.env`, then `docker compose up -d`.
From then on `ACCESS_TOKEN` is the only door — don't paste the link with `?k=` anywhere public.
If it is asked to listen externally without a token, the service **refuses to start** rather than
printing a warning nobody reads.

## Where the data lives

| What | Where | Backup |
| --- | --- | --- |
| Agents, groups, chat history, shared memory, upstream config | PostgreSQL (`pgdata` volume) | `docker compose exec db pg_dump -U multiagent multiagent > x.sql` |
| Each Agent's working directory, group shared drives | `./data/workspace/` | Just archive this directory |

The `bots/` directory is only **the seed for the first start** (the first run imports the Agents in
it into the database, and also moves over the groups and chat history of an old `./workspace/`).
**Editing it afterwards has no effect at all** — change Agents in the UI.

## Self-tests / development

```bash
node web/model.mjs        # self-test for context budgeting and window inference
node web/i18n.mjs         # self-test for the server message tables
node web/memory.mjs       # self-test for an agent's self-notes (cap, duplicates)
node web/approve.mjs      # self-test for which tool calls need a person first
python3 check-bots.py     # check the seed definitions in bots/
```

Without compose, pointing at an existing PostgreSQL:

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/multiagent node web/server.mjs
```

## Desktop client (Windows / macOS) and Android

`app/` is a Flutter client that talks to the same server and the same data.
**There's no account system**: enter the server address and token and go — paste the whole
`http://host:8080/?k=TOKEN` line printed at startup into the address box and the two fields
split themselves.

```bash
cd app
flutter build windows --release
flutter build macos   --release
```

Chatting, creating / editing / deleting Agents and groups, and configuring model upstreams all
work in the client, on the same data as the web UI. Details in `app/README.md`.

### Android

The same client builds for Android phones (Android 7 and later). On a phone it shows one thing at
a time: the conversation list, then the chat (back arrow or the system back gesture to return);
the side panel slides in from the right. Files are picked with the system picker; PDFs, videos and
the like open in your phone's own apps, and "Share…" saves or sends them. The paperclip can also take a photo or record a
video. Notifications keep coming while the app is closed; the first start asks for permission and to be spared
from battery optimisation (without it the phone cuts the connection while it sleeps). Everything is drawn 15%
larger on a phone; Appearance → Size changes it.

```bash
cd app
flutter build apk --release --split-per-abi    # → build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
adb install build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
```

**HTTPS.** Put a domain that points at this machine into `.env` as `PUBLIC_HOST=` and run `./start.sh`
again: a Caddy container serves `https://<PUBLIC_HOST>` on port 443 and gets the certificate itself
(only port 443 has to be reachable — port 80 isn't used). Plain http keeps working on `WEB_PORT`. No
domain? `203-0-113-7.sslip.io` resolves to `203.0.113.7`.

The release build is signed with the debug key — fine for installing it yourself, not for Google
Play. The phone has to reach the server: a public address, the LAN, or over USB with
`adb reverse tcp:8080 tcp:8080` and `http://127.0.0.1:8080` as the address. Plain `http://` is
allowed (a self-hosted server on a LAN often has no certificate); a server on the internet should
be behind HTTPS.

## Known limits

- **Containers have no egress restrictions** — Agents can reach anything on the internet.
- **No multi-user**: one token, one data set, no account system.
- `run.sh` / `bots.patch.yml` / `headless.patch.yml` are an earlier experiment running DeepSeek
  Harness, **not part of the product**, kept only for the record (the story is in `CLAUDE.md`
  2.6–2.11).
