# Multi-Agent

An open-source "AI coworker": a column of Agents and group chats on the left. Each Agent has
its own persona, its own container and its own memory; put them in a group and they
**hand the work to each other with @mentions** until a job is done, instead of each
answering on their own.

- **One container per Agent** — he is root on his own machine and can install or write
  whatever he likes, but he can't see the platform's code or anyone else's desktop. This is
  where Grok Bot's biggest design flaw (every Bot shares one cloud computer) gets fixed.
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
  (web: the language selector in the sidebar footer; desktop: on the setup screen and in
  the sidebar footer).

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

Bottom left: **⚙ Model upstreams**. First choose which API the upstream speaks, then fill in
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

### DeepSeek models run on DeepSeek Harness

An Agent whose model name starts with `deepseek` doesn't use the loop above: each of its turns runs
in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (the `dsh` service), with the
platform's tools handed to it over MCP. History, memory, the transcript, approvals, spending and
the daily cap work exactly as for any other Agent.

- The key: sidebar → **Keys** → DeepSeek. Without one there, the Agent's own upstream key is used,
  if that upstream speaks Chat Completions.
- Replies arrive a message at a time, not token by token. **Images a tool returns (contact sheets,
  screenshots) are not shown to it**, so don't make a DeepSeek model the film crew's reviewer — the
  Agent editor warns when you pick one.
- Usage is priced with the prices of the Agent's upstream.

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
node web/dsh.mjs          # self-test for driving DeepSeek Harness (turns, MCP, keys)
node studio/keys.mjs      # self-test for the Keys panel's studio side (panel over .env, hints only)
node studio/crew/import.mjs --self-test   # the crew spec parses the way the importer needs
python3 check-bots.py     # check the seed definitions in bots/
```

The studio has its own self-tests (`node studio/<module>.mjs`) and two end-to-end checks against
fakes: `studio/e2e.mjs` and `studio/e2e-platform.mjs` — see `CLAUDE.md` 2.28. DeepSeek Harness
and the Keys panel have one too, against a running deployment: `node deploy/dsh/e2e.mjs <dir>`.

Without compose, pointing at an existing PostgreSQL:

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/multiagent node web/server.mjs
```

## Film crew (studio)

An AI film crew runs on top of the platform: a director, an art director, a cinematographer and a
reviewer (`studio/crew/`), working in a group against the **studio** service — asset library, shots,
Seedance video, GPT image / ComfyUI stills, contact sheets. The studio holds every model key; agents
reach it only through the platform's `studio` tool, and each can do only its own job.

1. Model keys: sidebar → **Keys** (each card has a **Test** that costs nothing), or in `.env` before
   `./start.sh`. What the panel holds wins over `.env`; either way the keys live in the studio
   only — the panel's in the studio's own table, `.env`'s in the studio container's environment.
   Seedance: ModelArk, or a relay with the same paths. GPT image: OpenAI, or a relay; the base
   includes `/v1`. ComfyUI on this machine: `http://host.docker.internal:8188`.
2. Import the crew — 4 Agents, 5 skills, a group, their studio roles:
   `docker compose exec app node studio/crew/import.mjs` (safe to rerun; `--dry-run` shows the plan).
3. In **Edit Agent**, give each one an upstream and a model (the reviewer's must accept images).
4. In the **Studio** panel (sidebar), create the project and pick the crew's group as its notice group.
   Locking characters and locations as final also happens there — only a person can.

Then post the script in the group. Generation is limited to 40 videos an hour and 4 at once per
project (`SEEDANCE_PER_HOUR` / `SEEDANCE_CONCURRENT`, or per project in its settings). Studio files
live in the `studiodata` volume, its tables in the `studio` schema of the same database.

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
- **DeepSeek Agents don't see images tools return**, and their replies aren't streamed token by token.
- **No multi-user**: one token, one data set, no account system.
- `run.sh` / `bots.patch.yml` / `headless.patch.yml` are an earlier experiment running DeepSeek
  Harness, **not part of the product**, kept only for the record (the story is in `CLAUDE.md`
  2.6–2.11).
