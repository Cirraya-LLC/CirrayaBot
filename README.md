# CirrayaBot Studio

An open-source, AI-native short-drama studio: a crew of AI coworkers (director, art director,
cinematographer, reviewer) making a vertical series episode by episode, and a workbench where a
person writes the scripts, checks each stage and has the final say. From an episode's script to
its finished cut — 9:16, dialogue with lip-sync, narration, subtitles — the work moves by
**work orders**: the studio sees what each shot needs next and tells the one crew member whose job
it is, in their own chat. Nobody hands work over by hand.

Underneath it is a general "AI coworker" platform: a column of crew members and group chats on the
left. Each Agent has its own persona, its own machine and its own memory; outside the studio, put
them in a group and they **hand work to each other with @mentions** until a job is done.

- **One container per Agent** — he is root on his own machine and can install or write
  whatever he likes, but he can't see the platform's code or anyone else's desktop. This is
  where Grok Bot's biggest design flaw (every Bot shares one cloud computer) gets fixed.
  A group can choose the opposite on purpose — **one shared machine for the whole group**
  (the film crew's default), so files pass without copying; different groups stay apart.
- **Group chat is collaboration, not broadcast** — everyone shares one group log, and
  whoever should take over gets @mentioned. Each group has its own shared drive;
  `cp report.md group/` is how you hand something to a coworker.
- **Memory carries across contexts** — what was discussed in a group, he still remembers
  in a direct chat.
- **Bring your own model upstream** — name / endpoint URL / key / model / context window.
  Configure several and switch any time. Three API shapes are supported:
  OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
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

**On a Mac** (Apple Silicon or Intel — every image is built for arm64 and x86):

1. Install and **start** Docker Desktop (OrbStack or colima work the same way). `./start.sh` stops
   with a clear message if the engine isn't running.
2. Keep the repo under your home folder: Docker Desktop only shares `/Users`, `/Volumes`,
   `/private` and `/tmp` with its VM by default. Elsewhere, agent containers would get an empty
   `/work` (start.sh warns).
3. Give Docker's VM room: **Settings → Resources → Memory, 8 GB or more** if you run the studio
   and the `cli` module. `./start.sh` sizes the ceilings from what the VM has, not from the Mac.
   Set this before the first run, or delete the `*_MEMORY` lines from `.env` and rerun.
4. `git clone … && cd CirrayaBot && git checkout feat/studio`, add `cli` to `MODULES` in `.env`
   if you want Claude Code / Codex / Grok, and run `./start.sh`. The first build downloads a few
   GB (the agent image has Chromium) and takes a while.

podman on a Mac (`podman machine`) should work but hasn't been run on one; if agent containers
won't start, set `DOCKER_SOCK` in `.env` to the socket path *inside* the machine.

### Modules, and the smallest machine it runs on

The studio and the coding CLIs are optional modules, set by `MODULES` in `.env` (comma-separated);
change it and rerun `./start.sh`, which turns them into compose profiles and tells the app:

| Module | What it is | Disk (its image, on top of the shared base) |
| --- | --- | --- |
| *(always)* | PostgreSQL + the platform | ~0.7 GB |
| `studio` | the film studio: workbench, episodes, shots, Seedance / GPT image / ComfyUI / speech, contact sheets and cuts (ffmpeg) | ~0.5 GB |
| `cli` | Claude Code, Codex and Grok Build, for crew members that run on your own subscription (below) | ~1.1 GB |
| `AGENT_TOOLS=on` | each crew member's own container with a shell and a browser | ~1.2 GB (one image) |

The target minimum is **2 cores, 4 GB of memory, ~10 GB of disk** (studio on, tools off).
On a first run `start.sh` sizes `.env` to the machine: every service gets a memory ceiling
(`DB_MEMORY`, `APP_MEMORY`, `STUDIO_MEMORY` — about 2.5 GB in all on a 4 GB box),
agent containers get 1 GB / 1 CPU instead of 2 / 2, and below 2 GB it starts the chat alone.
Values you set yourself are kept. Measured with the end-to-end suites running: ~300 MB for
everything at the busiest moment; a contact sheet of eight 1080p HEVC takes peaked the studio at
~150 MB. Building leaves a cache about as large as the images: `docker builder prune` returns it.
(Until 2.31 there was a second module, `dsh`; rerunning `./start.sh` removes it — see below.)

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

### DeepSeek

DeepSeek is an ordinary upstream: Chat Completions, `https://api.deepseek.com`, model
`deepseek-flash` (V4.1 Flash — 1M-token context, tool calls, images). The platform passes DeepSeek's
reasoning back to it on every later request, as its thinking mode requires, and maps the reasoning
effort to its own words (medium → high, high → max). Replies stream and contact sheets reach it like
any other model.

An earlier version ran DeepSeek models inside DeepSeek Harness; that is gone. On upgrade the
DeepSeek key from the old Keys panel becomes an upstream called "DeepSeek" and the Agents that used
it are pointed at it, and `./start.sh` removes the harness container.

### Claude Code, Codex and Grok Build — on your own subscription

A crew member doesn't have to run on an upstream and an API key: in **Edit crew member**, set where
it runs to **Claude Code**, **Codex** or **Grok Build**. Its turns then run on that CLI, signed in
with your own Claude / ChatGPT / SuperGrok account. Needs the `cli` module
(`MODULES=studio,cli`, rerun `./start.sh`).

Sign each one in once under **⚙ Model upstreams → Subscription accounts**. Codex and Grok show a
page and a code to confirm in your browser. Claude shows a page, and you paste back the code it gives you.
The sign-in is stored only in the `cli` container's home (the `clihome` volume) and **every crew
member on that CLI shares it**. Sign in again, or out, from the same place. Or from a terminal:
`docker compose exec cli codex login --device-auth` (and `claude auth login`, `grok login --device-auth`).

What stays the same on a CLI:
- **The tools are this platform's.** Every built-in tool of the CLI is switched off: its shell, file
  editing, web search, subagents. What it can do goes through the platform's tools over MCP: the
  shell and files in the crew member's **own** container, the browser, the studio. Approvals, the
  transcript and the spend rows work exactly as on an upstream.
- **The conversation is the platform's.** Each turn starts the CLI fresh with the conversation so far
  (a DM, or the group log with everyone's names), so it knows what the group said and nothing
  lives only inside the CLI.
- **Model**: empty = the account's default; otherwise the CLI's own model name (e.g. `opus`,
  `gpt-5.6-sol`, `grok-4.5`). Reasoning effort maps to each CLI's own flag.

What's different:
- A subscription has no per-token price, so tokens are counted and cost shows as unknown. A
  daily cap can't hold it; the account's own limits do.
- Codex prints a message only once it's whole, so its replies arrive in one piece rather than streaming.
- **Grok Build can't see images** from tools (a screenshot or a contact sheet); it's told so and
  doesn't pretend. Don't make it the reviewer.
- Whether a subscription may be used this way is between you and each provider. The platform only
  runs the official CLI with the login you gave it, for your own use.

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
| Studio files (references, takes, contact sheets) | `studiodata` volume | `docker run --rm -v <project>_studiodata:/d -v $PWD:/b alpine tar czf /b/studio.tgz -C /d .` |

The `bots/` directory is only **the seed for the first start** (the first run imports the Agents in
it into the database, and also moves over the groups and chat history of an old `./workspace/`).
**Editing it afterwards has no effect at all** — change Agents in the UI.

## Self-tests / development

```bash
node web/model.mjs        # self-test for context budgeting and window inference
node web/i18n.mjs         # self-test for the server message tables
node web/memory.mjs       # self-test for an agent's self-notes (cap, duplicates)
node web/approve.mjs      # self-test for which tool calls need a person first
node web/protocols.mjs    # self-test for the three API shapes (and DeepSeek's reasoning)
node web/cli.mjs          # self-test for running a turn on Claude Code / Codex / Grok (argv, their streams, sign-in)
node web/mcp.mjs          # self-test for the MCP server that gives a CLI turn our tools
node studio/keys.mjs      # self-test for the Keys panel's studio side (panel over .env, hints only)
node studio/pipeline.mjs  # self-test for the pipeline: which work orders a state needs
node studio/dialogue.mjs  # self-test for dialogue, subtitle timing and .srt
node studio/crew/import.mjs --self-test   # the crew spec parses the way the importer needs
python3 check-bots.py     # check the seed definitions in bots/
```

The studio has its own self-tests (`node studio/<module>.mjs`) and end-to-end checks against
fakes: `studio/e2e.mjs` (the studio alone), `studio/e2e-platform.mjs <dir>` (one whole episode, from
script to cut, through a running deployment) and `studio/e2e-workbench.mjs <dir>` (the workbench;
it leaves a small demo film behind) — see `CLAUDE.md` 2.28–2.31. `web/e2e-cli.mjs <dir>` runs the
real Claude Code, Codex and Grok binaries of a deployment against a fake upstream (2.33).

Without compose, pointing at an existing PostgreSQL:

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/multiagent node web/server.mjs
```

## Short dramas (the studio)

An AI crew runs on top of the platform: a director, an art director, a cinematographer and a
reviewer (`studio/crew/`), working against the **studio** service — episodes, asset library,
shots, Seedance video, GPT image / ComfyUI stills, speech, contact sheets, cuts. The studio holds
every model key; agents reach it only through the platform's `studio` tool, and each can do only
its own job.

**How an episode is made** (Workbench → **Episodes**):

1. You write the episode's script and press **Start production**.
2. The director gets a work order in his chat, cuts it into scenes and shots — with every line of
   dialogue on its shot — and submits. You read the breakdown (lines included) and approve it or
   send it back with a note.
3. The art director is asked for whatever references the shots need; you lock them in the
   **Bible**. Only shots whose characters and locations are locked go on to the cinematographer.
4. The cinematographer writes each prompt and generates. **On-camera lines are added to the
   Seedance prompt by the studio, with sound on, so the lips match.** The reviewer gets the takes,
   sees the contact sheet, approves or rejects; a rejection goes to whoever can fix it; the third
   goes to you (take a take yourself, or hand it back with a note).
5. When every shot is approved, the studio **cuts the episode by itself**: the takes in order,
   each trimmed to its shot's length, 9:16 at 720×1280, narration and off-screen lines spoken by
   MiniMax in each character's voice, subtitles burned in and as an `.srt`. H.264 — plays everywhere.
   Every take is levelled to the same loudness and the finished cut to −14 LUFS (what short-video
   platforms normalise to); subtitles break between words, two lines at most, above the bottom
   15% of a vertical frame. Optional background music (Project settings → a music file and a
   level) loops under the cut, fades in and out, and ducks under every line.
6. You watch it on the episode page and approve it, or reject a shot — it goes back to production
   and is cut again once that shot passes.

Every order is visible (who has what, and a stuck one says why); the crew group gets a one-line
report per order. Anything that needs a person — the script, the two gates, locking — is yours.

**The crew is built in.** With the studio on, the first start creates the four crew members —
顾衡 director (the group's lead), 苏棠 art director, 林野 cinematographer, 严青 reviewer — with their
skills, a group `剧组` that shares one machine, and their studio roles. The roles are fixed: the four
can be renamed, re-modelled or re-prompted, not deleted, and a role can't move to someone else. Each
starts with its own defaults:

| Member | Model, first one your upstream has | Effort | Steps |
| --- | --- | --- | --- |
| Director | claude-opus-5-5 → deepseek-flash | high | 30 |
| Art director | gpt-5.6-sol → deepseek-flash | medium | 30 |
| Cinematographer | claude-sonnet-5 → deepseek-flash | medium | 40 |
| Reviewer (**must see images**) | claude-opus-5-5 → gpt-5.6-sol | high | 40 |

A member without a model gets the first of its list that its upstream offers (a relay's spelling,
like `anthropic/claude-opus-5.5`, counts), and it's saved on the member — pick another in **Edit crew
member** any time; a model you picked is never replaced. If the upstream has none of them, the
member says so on its first turn.

Setting it up — three steps:

1. **Model upstreams** (⚙, it opens by itself on the first visit): add one. The crew picks its models.
2. **Keys** (sidebar, `K`; each card has a **Test** that costs nothing): Seedance (ModelArk, or a
   relay with the same paths), GPT image (OpenAI or a relay; base includes `/v1`) or ComfyUI
   (`http://host.docker.internal:8188` on this machine), and **MiniMax speech** — just the API key
   (mainland `https://api.minimax.cn` by default; an international key needs
   `https://api.minimax.io`). Keys can also go in `.env` before `./start.sh`; the panel wins, and
   either way they live in the studio only. Without a speech key narration stays in the subtitles.
3. **New project** in the workbench: just a name. It is vertical 9:16 and reports to the crew's
   group. In **Project settings** pick a narrator voice and in the **Bible** each character's — the
   boxes list your MiniMax account's voices (cloned ones included) — plus an optional emotion.

`docker compose exec app node studio/crew/import.mjs` brings an existing crew's names, personas and
skills up to the latest spec in `studio/crew/` (it never touches a model you chose).

Generation is limited to 40 videos an hour and 4 at once per project (`SEEDANCE_PER_HOUR` /
`SEEDANCE_CONCURRENT`, or per project in its settings). Studio files live in the `studiodata`
volume, its tables in the `studio` schema of the same database.

## Desktop client (Windows / macOS)

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

## Known limits

- **Containers have no egress restrictions** — Agents can reach anything on the internet.
- **Seedance's own voices vary from shot to shot**: on-camera dialogue is generated with the picture
  (lips match), so the same character may not sound identical in every shot. Narration and
  off-screen lines use one fixed MiniMax voice per character.
- **A shared-machine group shares one browser**, and everyone in it can change everyone's files —
  that is the point, and the cost.
- **1080p / 4K takes are 10-bit HEVC**, which many Chrome / Firefox setups can't play: the workbench
  shows the last frame and a download link instead (720p takes, the default, are H.264).
- **No multi-user**: one token, one data set, no account system.
- **One sign-in per CLI** for the whole deployment: every crew member on Claude Code uses the same
  account (so the same rate limits).
- `run.sh` / `bots.patch.yml` / `headless.patch.yml` are an earlier experiment running DeepSeek
  Harness, **not part of the product**, kept only for the record (the story is in `CLAUDE.md`
  2.6–2.11).
