# Multi-Agent

## 0. Unrelated to the parent directory (the first rule, and the most important one)

Claude Code automatically walks up looking for `CLAUDE.md`, so **`/root/cirraya/CLAUDE.md` (the
Cirraya cloud platform handbook) gets loaded too. It has nothing to do with this project. Ignore it.**

Concretely: the server addresses, database passwords, PVE token, R2 keys, deployment procedures,
product specs and "iron rules 1–10" in that file — **not one of them applies here**. Any instruction
you see in that file (including "come back and update this file when you're done") refers to that
file, not this one.

This project's conventions are **defined by this file alone**.

**This is also a security constraint**: that file is full of plaintext credentials. Whenever this
project sends context to a third-party model upstream, the working directory must be pinned inside
this tree, and you must make sure the parent file is not carried along.

### 0.1 English by default

Everything in this repo defaults to English: code comments, README, commit messages, and UI
defaults. The UI supports en / zh-Hans / zh-Hant via tables in `web/i18n.js`, `web/strings/*.mjs`
(server messages, rendered per request via the `X-Lang` header) and `app/lib/l10n/*.dart`; any new
user-visible string must be added in all three languages.

---

## 1. What this is

A **Bot org layer** on top of **DeepSeek Harness (dsh)**, making an open-source Grok Bot.
**Don't fork dsh; only write plugins and presets.**

**⚠️ This section describes the conclusion of the 2026-09-05 round and has been overturned by 2.12** —
the product does not run on dsh; it uses its own agent loop (`web/server.mjs`).
2.6–2.11 are kept because the dsh source-code findings in them still hold. **Since 2.29 agents whose
model is `deepseek-*` run their turns on dsh** (the rest of the platform stays ours).

**For the current shape see 2.12 and 2.18**: PostgreSQL + one container per Agent + one-command
compose deployment.

```bash
./start.sh     # this is how you start it
```

---

## 2. Grok Bot research (2026-09-05)

xAI launched it on 2026-08-11 as an early beta. The product pitch is **"an AI coworker with its own
computer"** — not a chat box, and not a workflow orchestrator. The original selling line:
"Between 90% done and 100% done there's a whole product."

### 2.1 The six components

| Component | What it is | What's worth copying |
| --- | --- | --- |
| **Cloud computer** | A persistent machine with a browser, terminal and filesystem. It keeps running when you close your laptop | "Persistent" is the foundation of the whole product. Without it, scheduled tasks and long tasks don't exist |
| **Bot** | Built from three fields: Name / Job (one primary responsibility) / Description (duties + **off-limits areas**) | Officially against "do-everything assistants". The off-limits areas are written in the persona, not in code |
| **Skill** | A human demonstrates once → saved as a reusable procedure (steps + decision rules + output requirements + **approval boundaries**) | No prompt writing, no workflow configuration. **Approval boundaries are part of the skill**, not a global setting |
| **Routine** | Scheduled or event-triggered (a Slack channel, a GitHub event…) | Official warning: **keep triggers narrow**; don't listen to "every new message" |
| **Multi-Bot collaboration** | 2–6 of them in a group chat, `@` to pull someone in, pass messages to each other, **hand over task ownership** | Typical org: Chief of Staff (breaks down work, doesn't speak externally) / Researcher (read-only) / Operator (executes approved actions) |
| **Plugins** | connector / plugin / **MCP server** | xAI itself recommends **connectors over browser automation** — structured interfaces are more reliable than clicking web pages |

### 2.2 Permission model (this is the key part to copy)

- **Must be approved by a human**: sending messages, publishing content, deleting data, payments,
  changing production config
- **Can be automatic**: drafts, reconciliation, summaries, screenshots
- **Passwords / 2FA / verification codes are always entered by the human**; when a Bot hits a login
  page it pauses and asks for a takeover. Even during "computer takeover" there's no exception
- Desktop app has three levels: Allow once / Deny / Always allow

### 2.3 Its biggest design flaw — **every Bot shares one cloud computer**

It says so officially: **"Don't treat an individual Bot as a security boundary."**
Browser cookies, login sessions, files and command-line credentials are all shared.

In other words "Researcher is read-only" is **just a sentence in the persona, not enforced** —
a prompt-injected Researcher holds the same keys as the Operator.

**If we build this, this is the thing most worth changing**: one isolated environment per Bot
(container / VM / namespace), credentials issued per Bot. The cost is money, speed, and moving files
between Bots needs extra design. But the choice of "sharing one machine" makes the whole role split
worth zero in security terms.

### 2.4 Other known limits

- Browser automation gets blocked by sites (CAPTCHA, anti-automation)
- Many Bots in parallel easily hit quota limits
- At launch: no Linux desktop / Android / iPad
- Pricing: only on SuperGrok Heavy (~$300/month) or Cursor Ultra $200/month;
  the $30 SuperGrok **doesn't** have it

### 2.5 Three one-line conclusions

1. **A persistent cloud environment is the foundation**, not an option.
2. **Approval boundaries travel with the skill**, not a global switch.
3. **Role separation must be enforced by isolation**; "you may not change production config" written
   in a persona stops nothing.

---

## 2.6 The wheel has been built, and someone has already laid the foundation (2026-09-05 research)

### Open-source peers

| Project | License | Gap |
| --- | --- | --- |
| **OpenBot** (CopilotKit) | MIT | One Bot per container + fail-closed CEL gateway. But **v0.0.1 alpha, 5 days of history**, known privilege escalation (#35) and fail-open (#26), **persistent threads depend on CopilotKit cloud** — open source but not self-contained |
| **OpenClaw** | Open source | The most mature personal agent (persistent + cron + memory + IM). Leans personal assistant, no multi-Bot org |
| **Hermes** | Open source | Server-side, self-generated skills, any model |
| **Suna / Kortix** | **Elastic License 2.0** | **Not really open source** — forbids offering it as a competing hosted service. Can't use it if we sell SaaS |
| **OpenHands** | MIT | Leans coding agent |

Cost comparison: Grok Bot $120–300/month vs a self-hosted $5–25/month VPS. **An order of magnitude
apart — that's the real selling point of an open-source version.**

### But what really matters is DeepSeek Harness (dsh)

Open-sourced at the end of 2026-08, **MIT**, `github.com/deepseek-ai/deepseek-harness`.
**The source is local: `/root/cirraya/cirraya-agent/_vendor/deepseek-harness` (v0.1.1-rc.2)** —
the project agent on the Cirraya side already uses it (`harness/profile/cirraya/cordis.patch.yml`).

The architecture is **everything is a plugin**, running on the Cordis meta-framework. 50-odd packages,
every one replaceable: model adapters, tool registry, session log, **even the agent loop itself**.
The `bundle` package provides the `dsh --profile` patch-layer mechanism — **the right way to extend it
is writing plugins, not forking.**

**The table below is the most important table in this project**: of the six hard problems I listed in
the previous round, dsh solves four and a half.

| Hard problem from last round | Corresponding dsh package | Status |
| --- | --- | --- |
| Isolation | `sandbox` (bwrap / Landlock / Seatbelt / Windows ACL) | **Solved, and stronger than OpenBot** — OS-level constraints, `SANDBOX_UNAVAILABLE` **fails closed**, never silently degrades to unconstrained |
| What if a long task breaks | `session` (event-sourced, JSONL/SQLite) + `session-checkpoint-policy` + `session-query` | **Solved.** A checkpoint before each model request, before each tool with external side effects, and at each step boundary; after a crash, unmatched calls get `TOOL_OUTCOME_UNKNOWN` **instead of an automatic retry** — which is the right answer |
| Approval | `interaction` (`user-approval` / `permission-presets` / `tool-ask-user` / `commands`) | **Solved** |
| Credentials | `credentials` (seam + env-over-`.env` + authorization flows) | **Solved** |
| Scheduling / Routine | `schedule` (`after_seconds` / `at` / `every_seconds`, minimum 5 minutes) + `jobs` (background tasks + `job_*` tools) | **Exists, but `schedule` is session-local** — see 2.7 |
| Token cost | `compaction` / `spill` / `context` | Has context management, **no spending budget cap** ← real gap |
| Browser automation | `web` only has search / fetch | **No browser control** ← but see 2.7; this is quite possibly right |

It also has: `mcp`, `skill`, `workflow`, `extensions` (**the model can write its own plugins and mount
them**), `hooks` (Claude Code / Codex wire-protocol bridge), `sdk` (out-of-process JSON-RPC), `acp`,
`host`+`client` (Web GUI), `lsp`, `terminal`, `code-runtime`, `fs`, `storage`,
`workspace`, `identity`, `settings`, `attachment`, `plan`, `goal`, `todo`, `e2b`.

**Conclusion: don't write a framework from scratch, and don't fork. Write plugins.**

## 2.7 So what's left — after checking one by one, only one and a half items

**Every item checked removed one thing to do. The below comes from reading the source item by item on
2026-09-05, not from guessing.**

| Original plan | Conclusion | Basis |
| --- | --- | --- |
| `bot-identity` | **Don't need to write it** | A preset directory is a Bot, see 2.9 |
| `bot-registry` persistent | **Mostly exists** | Presets have a "mounted once per process" standing mount; `list_agents`'s **`ready` state = only in storage, resumable**, so cold resume is already done; `dsh-sdk-jsonrpc-server` is a long-running stdio process |
| `bot-mailbox` | **Very likely don't need to write it, see below** | `send_message` / `interrupt_agent` / `list_agents` / `report` are all there |
| `bot-budget` | **Real gap** | None of the five open-source options has a spending cap |
| schedule attached to a Bot | **Half a gap** | `schedule` is currently session-local |

### Why the mailbox very likely doesn't need writing

dsh's `tool-subagent-control` already has:

- `send_message(subagent_id, message)` — the message goes into the child Bot's **FIFO inbox** and
  becomes its next turn, **without interrupting the running turn** (`Agent.followup()`)
- `interrupt_agent(agent_id)` — only stops the current turn, **queued messages are kept**,
  descendants keep running
- `list_agents(children | descendants)` — states `running` / `idle` / `ready`
- `tool-subagent-report` — the child→parent direction

The limits: **parent→child only, and only depth-1 can `send_message`**. Authorization is verified by
the **service layer** from Activation lineage, not the tool layer — in other words dsh's authorization
model is a **tree**, while Grok Bot's group chat is **flat**; the two fundamentally conflict.

**But the org Grok Bot officially recommends is a tree anyway**: Chief of Staff breaks down work and
tracks progress, Researcher is read-only, Operator executes approved actions. So make CoS the root and
route Bot-to-Bot messages through CoS — **zero changes, and CoS should know about this anyway**.

Say the cost plainly: when the Researcher wants to hand results straight to the Operator it takes one
extra hop.
**Use the tree first. If running it shows CoS is a bottleneck, revisit** — writing a flat mailbox
ourselves means reinventing "who may message whom" authorization, which dsh has already answered.

## 2.8 Two judgments (maybe counter-intuitive, but grounded)

**1. Avoid browser automation where you can.** dsh's `web` having only search / fetch isn't an
oversight; it's a judgment. Sites **actively fight you**: bot detection, CAPTCHAs, selectors all break
when the DOM changes, a whole page stuffed into context eats tokens. Grok Bot itself gets blocked, and
xAI itself recommends connectors over the browser — clicking web pages all over the demo is for show,
not their advice. **MCP / API first, browser as fallback** (if you really need it, plug in the
playwright MCP; don't write your own).

**2. The "learn by shadowing" part of Skills should be cut from v1.** Recording DOM selectors breaks the
moment a page changes; recording natural language is just writing a prompt. A paper (arXiv 2606.15017)
directly questions whether skill / memory modules pay off under budget constraints.
dsh's `skill` is Markdown in the filesystem (the same approach as Claude Code), **and that's enough**.
v1 only does "save the run that succeeded as a script a person can read and edit".

## 2.9 A Bot is a preset (verified, format confirmed)

```
bots/<bot-id>/
  preset.yml         name / description / order
  agent.cordis.yml   - id: persona (text) + some tool rows
```

Mapping to Grok Bot's three fields: Name → `preset.yml.name`, Job → `preset.yml.description`,
Description (duties + off-limits) → the persona's `text` **plus the tool rows themselves**.

**This is where we're stronger than Grok Bot, and it's the thing most worth talking about in this
project**:

> Grok Bot's "off-limits areas" are a sentence in the persona — one prompt injection gets around them.
> In dsh the preset decides which tools this Bot has; **a tool it wasn't given is simply invisible to
> the model**. Injection can change its mind, not its tool table.

So if `bots/researcher` isn't given `tool-bash` and `tool-fs`, it genuinely can't act.

**Two pitfalls:**

- **The persona must never set `complete: true`.** That makes the persona the **only** system prompt
  section, pushing out the approval / sandbox runtime context along with everything else —
  i.e. one Bot's persona could delete all the platform guardrails. Guardrails must come after the
  persona. (The `minimal` preset uses `complete: true`; that's for a fixed-purpose coding agent, don't
  copy it onto Bots.)
- preset roots config: `roots: [{path, trust}]` + `includeUserRoot: false`
  (without the latter, the machine's real `~/.dsh/.agent-presets` gets mixed into the roster)

## 2.9.1 Which provider a child Bot uses decides whether it can be "another Bot" (key)

`applyChildComposition(childCtx, parent, composition)` — **an in-process child agent first joins the
parent's preset**, and only then applies its own persona and toolFilter.

| provider | The child's preset | What it can express |
| --- | --- | --- |
| `spawn` / `fork` (in-process) | **Inherits the parent's**, can only **narrow** via `persona` + `toolFilter` | A clone of the same Bot sent off to do a subtask |
| `acp` / `dsh-sdk` (out-of-process) | **Fully independent** — its own runtime / session / model / tools (`inheritsParentContext: false`) | **A Bot with different duties** ← the org must use this |

**Why this matters**: building the org in-process contradicts itself immediately — for Chief of Staff
to dispatch work to the Operator (which needs `bash`), it must have `bash` itself first, and "CoS
doesn't do the work" is the very reason the role exists. Likewise the Researcher (read-only) and
Operator (can write) can't both be children of the same parent unless the parent has both — then the
parent is the most privileged one and the role split means nothing.

So: **one process per Bot, each with its own profile and preset, chained with `subagent-acp`.**
`subagent-acp`'s config already has `command` / `args` / `cwd` / `env`; point each Bot at its own
profile.

The cost is spawning a process per child Bot (`start()` = spawn → initialize → newSession), slower than
in-process. **But that is exactly "one environment per Bot" isolation**, stronger than Grok Bot
cramming everything onto one shared cloud computer — it's a cost worth paying, not waste.

**Corollary: the org layer very likely needs zero lines of code, all config.**
Register N acp providers at the host layer (one per Bot), and put N `tool-subagent` rows in the CoS
preset, each bound to one (with different `toolName`s, e.g. `ask_researcher`).

## 2.9.2 ⚠️ Two rules that make "a Bot's off-limits areas" fake (both actually hit)

**These two are the most expensive findings in this project so far.** What they have in common:
**everything looks normal** — the preset loads, the config dump is correct, the task completes
normally — only the tool table and identity are wrong. Only checking "dsh can list three Bots" leads to
completely wrong conclusions.

### 1. A preset can only [add and shadow], not [remove]

The scope chain is `agent → preset → global`, **nearest shadowing farthest**.
A tool the global layer (host composition) has and the preset layer doesn't, **the Bot still sees**.

Measured: the Researcher's preset listed only web / fs-search / todo, and it reported having `bash`,
`write`, `edit`, `subagent`, `workflow` — all from the global layer.

| profile | The host layer's 18 `tool-*` rows |
| --- | --- |
| **web** | **17 are `disabled: true`**, only `tool-subagent-report` kept (the child→parent channel, not a model tool) |
| **headless** | **0 disabled** |

So **a Bot's off-limits areas only hold after the host composition disables those tool rows**.
dsh's official web profile does exactly that; the 17 disable rows in `headless.patch.yml` are copied
from it. **When adding a new tool, keep this list in sync**, otherwise the new tool is unconditionally
visible to every Bot. (The product's own use of dsh, 2.29, keeps its list in `deploy/dsh/run.mjs`
and trips on any leak at runtime.)

### 2. `agentPresets.mount()` has exactly one call site in the whole codebase

```
packages/host/apiproxy/src/api-proxy.ts:1186    await presets.mount(agentCtx, resolvedId)
```

**Presets are only mounted when an agent is created through the Host / API path.**
The headless runner calls `ctx.agents.create()` directly; the roster sits there not participating at
all, **and there's no error**: the agent is created, the task runs to completion, and the identity and
tools are all the deployment defaults (measured: it called itself "Codex", the headless bundle's own
coding persona).

**Corollary: the Bot org must run on the host side** (the web profile, or a profile you assemble with
apiproxy). For a persistent service that's not bad news — a persistent service needs a host anyway.
But it rules out two paths: headless can't run Bots, and `sdk-jsonrpc-server` (what the Cirraya side
uses) doesn't mount presets either.

## 2.9.3 What has been verified (2026-09-05, actually run, not read from source)

- `pnpm` installs dsh's 507 packages in tens of seconds; **`npm` hung for 20 minutes without finishing**
  — all 62 direct dependencies are prerelease ranges like `^0.1.1-rc.2`, and npm resolution pulls each
  package's full version list. **Use pnpm + `registry.npmmirror.com`.**
- `--patch <file>` + `--dump-config` lets you verify the composition without starting a model
- Model upstream 66hxhx `gpt-5.6-sol` works (the `llm-deepseek` adapter + `baseURL` is enough, it's
  OpenAI-compatible); the key goes through `apiKeyEnv` (a variable name, not the key), never written to
  a file
- **The off-limits mechanism itself is real**: after disabling the 17 host-layer tool rows, the model
  answered clearly "run shell commands: currently can't", "write files: currently can't"

## 2.9.4 ⚠️ The dsh launcher unconditionally overwrites `agent-presets.roots` (the most expensive pitfall)

`profile-boot` appends an overlay **after all patches**:

```js
if (rows.has("agent-presets")) composedOverlays.push({
  id: "agent-presets",
  config: { ...rows.get("agent-presets")?.config ?? {},
            roots: [{ path: SHIPPED_PRESET_ROOT, trust: "system" }] }   // ← hard-coded
})
```

Other config fields (`default` / `includeUserRoot`) are kept by the spread; **only `roots` is dropped**.
So:

- **Configuring a custom preset root via `--patch` has no effect at all**
- **`--dump-config` doesn't show it** — it shows the patch composition result, which doesn't include
  the launcher step. The dump plainly says `patched by .../bots.patch.yml` with roots set to your path,
  while at runtime it's something else

**The only workaround: put the Bot directories into the shipped root**
(`<dsh package>/config/agent-presets/`); `run.sh` rebuilds it before every start.

**And it must be a [copy], not a symlink**: discovery uses
`readdir(dir, { withFileTypes: true })` + `child.isDirectory()`,
and a symlink's dirent is `isSymbolicLink()`, `isDirectory()` returns false,
**so it's silently skipped** — the directory is clearly there, it just isn't in the list.

Cost: `pnpm install` wipes them, so `run.sh` replays this every time.

## 2.9.5 Three environment and shell pitfalls (all actually hit, one of them three times)

- **`pkill -f "<pattern>"` kills the shell that invoked it too**, because the pattern appears in its
  own command line. Symptom: the command exits `144` and none of the following statements run —
  while the preceding statements did run, so it looks like "changed but didn't take effect".
  **Hit three times.** Always find the PID by port instead:
  `ss -ltnp | grep -oP ':<port>\b.*pid=\K[0-9]+'`
- **Under `set -e`, `[ condition ] && { ... }` exits the whole script when the condition is false**
  (the whole expression returns non-zero). Use `if ... fi`.
- **After changing `run.sh`, make sure the old process is really dead**: the new process quietly
  crashes with `EADDRINUSE`, while `curl` hits the old process that's still alive, so "changed but
  didn't take effect".

## 2.10 ⚠️ The parent CLAUDE.md gets sent whole to the model upstream — this pitfall is real

The `agent-instructions` plugin **reads `AGENTS.md` / `CLAUDE.md` at every level from project root to
cwd** (`instructionFileCandidates` defaults to exactly those two) and puts them in the first request of
every session.

The project root is determined by `projectRootMarkers` (default `['.git']`), **searching all the way
up**. `findProjectRoot` only falls back to cwd when no marker is found.

That means: **as soon as someone runs `git init` in `/root/cirraya` or `/root`, the parent file (PVE
password, R2 keys, JWT master key, SMTP password) is sent whole to a third-party upstream, and nothing
anywhere raises an alarm.**

**Already handled**: this directory has been `git init`-ed; `.git` is the marker, so projectRoot is
pinned here.
**Don't delete `.git`.** For extra safety, explicitly set
`instructionFileCandidates: ['AGENTS.md']` in the profile.

---

## 2.11 Public access: stuck at dsh's WebSocket trust fence (unsolved)

**Status: the SSH tunnel works 100%; the public + basic-auth reverse proxy is one step short.**

```bash
ssh -N -L 3080:127.0.0.1:3080 root@216.195.192.61     # opens 127.0.0.1:3080 locally
```

nginx (config in `deploy/nginx.conf`) is in place: basic auth on port 80, reverse-proxied to
127.0.0.1:3080, and **HTTP works end to end** — all 42 client plugins 200, every `/api` RPC 200 with no
error in the body, SSE stays connected, no cookies involved, and a curl-simulated WS handshake gets
**101 Switching Protocols**.

**The only broken thing is browser-initiated WebSockets**:

```
ws://216.195.192.61/api/events.mux   → closed before the connection is established
ws://216.195.192.61/api/events.host  → same
```

So the UI never gets the event stream, **and the preset picker and workspace list never render** —
while the page opens, every HTTP request is 200 and the console has zero errors. **Another silent
failure.**

**Already ruled out** (don't retry these):

| Tried | Result |
| --- | --- |
| `--trusted-host <ip>` / `<ip>:80` (both given) | No effect |
| nginx rewriting `Host` to `127.0.0.1:3080` | No effect |
| WS location `auth_basic off` (browser WS really doesn't send basic credentials) | Handshake reaches 101, browser still fails |
| WS location rewriting `Origin` to `http://127.0.0.1:3080` | No effect |
| cookies / plugin loading / API status codes / SSE | Identical on both sides, not the cause |

**Decisive clue: curl's WS handshake succeeds (101), the browser's fails.** The only difference is that
the browser sends an `Origin` header — but rewriting Origin didn't help either, so the fence compares
more than just Origin.

**The next step is reading the source, not more trying**: the authority-comparison logic in
`packages/host/apiproxy` and `packages/client/connection`. Where the value of `--trusted-host` finally
lands in a check is the answer to this problem.

## 2.12 The product shape is settled (2026-09-05, four clarifications from the boss in a row)

All the effort in 2.6–2.11 around "how do we use dsh's built-in web UI" **was going in the wrong
direction**. What the boss wants, dsh's UI can't provide; four sentences pinned it down:

| The boss's words | Meaning | What I had done wrong |
| --- | --- | --- |
| "Multiple AGENTs to pick on the left, shared memory, and you can also start a group chat" (「左边多个 AGENT 选择 共同记忆 也可以拉群聊」) | Wants an Agent list, not a "pick one preset per session" dropdown | Kept fixing the reverse proxy for dsh's own UI |
| "A group chat is different agents that can also cooperate and talk to each other, just like real people" (「群聊是不同的 agent 也能相互配合 相互对话 就像真的人一样」) | **Collaboration**, not broadcast | I built "one message goes to several people, each replies separately" |
| "Every agent is like a real person, with very high permissions and ability to act" (「每个 agent 都像真人一样 有着非常高的权限和操作能力」) | Everyone has hands; the split is by **duties** | I built a structural off-limits of "the Researcher has no tools" |
| "Every AGENT needs its own sandbox, and a group needs a sandbox too, and content can be transferred" (「每个 AGENT 都要有自己的沙箱 拉群之后还要有一个沙箱 内容可以 transfer」) | Each has a desktop + the group has a shared drive | I set everyone's working directory to the same one |
| "Everyone has independent memory, groups share it, and nothing is forgotten in DMs either" (「每个人独立 memory，群组共享，私聊也不会忘」) | Memory per person + per group, and connected | — |

**So the architecture became this, with dsh moved to "plug in later":**

```
web/server.mjs     our own agent loop (call model → run tools → read results → keep talking)
web/db.mjs         PostgreSQL persistence (2.18)
web/model.mjs      context budget + model window detection (2.18), with a self-test
web/index.html     conversations on the left / chat in the middle / members + shared memory on the right

Sandbox  data/workspace/agents/<id>/     one container per person mounted here, invisible to each other
         data/workspace/groups/<gid>/    the group's shared drive
         /work/group inside the container ->  symlinked to /groups/<gid> during a group chat
Memory   messages table (scope='dm')     DM history
         messages table (scope='group')  group log, shared by everyone
         groupRecallFor(bot)             also fed to him in DMs — if he was there he shouldn't forget

(Since 2026-09-16 all state is in PostgreSQL, no longer files. bots/ is only a seed, see 2.18.)
```

**"Sharing with a coworker" needs no invented tool**: the group sandbox is mounted as `./group` inside
each person's sandbox, so `cp report.md group/` is sharing, just like real people using a shared drive.
In a DM the symlink is removed, which isolates naturally.

### What makes a group chat "like real people"

Not parallel broadcast, but **relay**:

1. Everyone shares one `groupLog`; other people's words enter the context as `[name] content`
2. Who speaks first: whoever the user @-mentioned, otherwise the lowest order (Chief of Staff is 0)
3. The speaker ends the reply with `@name` to hand off the work, and the system lets that person speak
   next
4. No @ = done talking, the group chat stops; `MAX_HANDOFFS=5` and "the same person speaks at most 2
   rounds" as backstops

Verified on the real machine: `Chief of Staff → @Researcher → @Chief of Staff → stop`,
and `Researcher writes a file → cp into group/ → @Operator → Operator reads it from group/`.

### ⚠️ Tools are off by default, and that's not timidity

With `AGENT_TOOLS=on`, every Agent can execute arbitrary commands on this machine. That means:

- **Whoever has the `ACCESS_TOKEN` = has a shell on this machine**
- Any external text an Agent reads (web pages, logs, coworkers' messages) may be prompt injection

This is exactly the "very high permissions and ability to act" the boss wants, but it must be a switch
**a person deliberately turns on**, not a default. Claude Code's auto-mode classifier blocked this kind
of change three times, and was right every time.

## 2.13 Sandbox: from "just a cwd" to real containers (2026-09-05, found and fixed the same day)

**When found**: `workspace/agents/<id>/` was just bash's cwd. On the real machine, one round of group
chat and an Agent walked out on its own — nobody taught it:

```
sed -n '1,280p' CLAUDE.md
sed -n '1,320p' web/server.mjs
cd /root/cirraya/Multi-Agent && apply_patch <<'PATCH' ...      ← tried to modify the platform source
```

It could read `.env` (`ACCESS_TOKEN` + the model key are in there) and could modify its own system
prompt.

**Now**: the boss said "use containers". One docker container per Agent, mounting only two
directories:

```
/work    ← workspace/agents/<id>    his own desktop
/groups  ← workspace/groups         group shared drives (in a group chat /work/group symlinks to /groups/<gid>)
```

Platform code and `.env` aren't mounted, out of reach. Containers are long-lived (`sleep infinity`),
tools go through `docker exec`; limited with `--memory 2g --cpus 2 --pids-limit 512`.
The Agent is root inside its container — if something's missing it can `apt install` it, and it stays
in its own container, just like giving a new hire a clean machine to set up.

**Verified** (real machine, not reasoning):

```
cat: /work/../.env: No such file or directory     ← it could read this before
ls /groups → gmtoblv8x                            ← only sees the groups it takes part in
hostname   → 64f88766b655                         ← a container, not the host
echo ... >> group/roll.txt → appears in the host's workspace/groups/<gid>/roll.txt
```

**Two pitfalls**:

- **The group symlink must be created inside the container** (`docker exec ... ln -s /groups/<gid>
  /work/group`). A symlink created on the host points at a host path, which is a broken link inside
  the container.
- **Don't put big packages like `build-essential` in the image**: the build hangs for minutes. Install
  "what's needed out of the box" (curl / git / jq / python3) and let the Agent install the rest.
  `AGENT_IMAGE` can be swapped.

**Not done yet**: container egress isn't restricted (Agents can reach anything on the internet), and
there's no custom seccomp/AppArmor profile. Tightening it for real means `--network` plus an allowlist
proxy.

## 2.14 Verification criteria: looking at the conversation and not the artifact = false positive (2026-09-05, actually got burned once)

After an end-to-end run, all three Agents' conversation was correct: the Operator said "created
group/plan.md", and asked in a DM, the Researcher confirmed too: "just created group/plan.md in the
group with three lines of plan points". **I judged it passed on that basis.**

Then I looked at the group's shared drive — **there was no plan.md in it**.

The file had been written into **the previous group**. The root cause was in `sandboxFor`:

```js
await symlink(shared, link, 'dir').catch(e => { if (e.code !== 'EEXIST') throw e })
//                                                    ↑ skipped if the symlink exists, so it kept pointing at the previous group
```

Work an Agent did in group A landed in group B's shared drive — **a cross-group data leak**, and
completely invisible at the conversation level: the command succeeded, `ls` really did show the file
(in the wrong directory), and the Agent faithfully reported what it saw.
**Nobody was lying; only the symlink was lying.**

**Rule: any verification of "have an Agent do something" must look at the artifact of that thing.**
Does the file exist, where is it, is the content right. "Done" in a conversation is only its belief,
not a fact.

(The fix is to `unlink` then `symlink` every time; don't skip with `catch(EEXIST)`.)

## 2.15 Three pitfalls with Chinese names (all only showed up on the real machine)

The product's main use case is Agents with Chinese names, and the three default Agents happen to all
have English names (Chief of Staff / Researcher / Operator) — **so none of the following surfaces
until you add a Chinese name**.

1. **The `@name` regex must not use `\b`.** `\b` decides word boundaries by `[A-Za-z0-9_]`; Chinese
   characters aren't `\w`, so after "@小林" there is no word boundary at all → **it never matches**.
   Symptom: the Chief clearly said "@小林 please write the README", yet the group chat just stopped —
   it looks like "he didn't want to hand off", but it's the regex. (Try longer names first, otherwise
   "小林二" gets grabbed by "小林".)
2. **A Chinese name can't produce a slug**: `'小林'.replace(/[^a-z0-9]+/g,'-')` → empty → validation
   fails, and the UI reports "id may only use lowercase letters and digits". The id is an internal
   identifier (directory name, container name); what people see is the name — if one can't be
   generated, just generate one automatically; don't bother the user with it.
3. **Chinese in screenshots shows as boxes**: the server's headless chromium has no Chinese fonts
   (installing `fonts-wqy-zenhei` didn't take effect either; `fc-list :lang=zh` is 0).
   The user's own browser is fine. **Don't treat this as a product bug to fix.**

## 2.16 Actually used once: four Agents built a working tool from scratch (2026-09-05)

The boss: "send each of them a message separately, then talk in the group, and have them collaborate
to build a micro product" (「给它们每个人都单独发送消息 然后再在群里说话 让他们协作做一个微型产品出来」).

**It got built, and I tested that it works**: `jsonfmt.py` (2033 bytes, stdlib only) + `README.md`.

The collaboration chain (no human intervention; I only sent two group messages):

```
Chief pins the scope "single file, no dependencies, deliverable today" → @Researcher
Researcher inventories the environment (python3/curl/git/jq present, no node/pip), gives 3 candidates with risk assessment → @Chief
Chief picks the JSON formatter + writes the spec (input/output/errors/exit codes) → @Operator
Operator implements + writes 16 acceptance assertions himself, 15 pass, 1 false failure (he recognised it was a test-writing issue) → @Chief
(second round) Chief → @小林 → 小林 reads --help before writing the README, and even measured that argparse argument errors exit with code 2
```

**A few observations worth noting:**

- **The Operator reported failure honestly**: "there's no `apply_patch` in the environment, so the
  first write failed and the file wasn't created. I switched to the workspace write tool to produce the
  same content" — the persona line "if you didn't do it, say so" really worked.
- **小林 read the code before writing docs**: "I'll check the script's help text and error handling
  first, then write the README from its actual behaviour, to avoid documenting unsupported usage". The
  exit-code section he wrote matches the script's behaviour line by line.
- **The Chief never did hands-on work himself**, only broke down work, wrote specs and reviewed —
  even though he had the same permissions as everyone else. The division of duties holds via the
  persona, without confiscating tools.

Measured output (run by me, not reported by them):

```
$ printf '{"名字":"小林","tags":[1,true,null]}' | python3 jsonfmt.py
{ "名字": "小林", ... }              ← Chinese not escaped
$ printf '{"a":1,}' | python3 jsonfmt.py
jsonfmt: stdin:1:7: invalid JSON: Illegal trailing comma (character 6)   exit=1
```

## 2.17 The UI redone after Grok Bot (2026-09-05, the boss sent a screenshot)

The boss sent a screenshot of Grok Bot's UI to learn from. Counting the differences, **the most
important one: its conversation list doesn't separate "group chats / DMs"; everything is mixed and
sorted by recent activity** — that's what an IM looks like. I had split them into two blocks by type,
throwing away the most important information: "what were we just talking about".

What we copied:

| Detail | Why it's worth copying |
| --- | --- |
| Conversation list **mixed** (groups and DMs sorted together by time) | People look for "that conversation just now", not "a group" |
| A **role pill** after the name (`Daily Assistant` `Emailer` `Chief`) | You see what the person does at a glance without reading the second line |
| Group avatar = **member avatars stacked + "+N"** | You know who's in the group without clicking in |
| **Last message + time** on each row | That's the reason a conversation list exists |
| Right panel **Members + Add Member** | Group membership management belongs in the group, not elsewhere |
| **@name in messages rendered as a pill with avatar** | Handoffs are visible events in the conversation |
| Identifiers as **red inline code** | Technical conversations are full of slugs and field names |
| Avatar at the **bottom left** of the bubble, name **above** the bubble | In long conversations the eye doesn't have to jump back and forth |
| Bots get **human names** (Smith / Sam / Danny) | The difference between "coworker" and "tool" starts with the name |

**One backend change for this**: DM history had to be persisted (`workspace/dm/<id>.json`).
The conversation list shows "what was said last", and DM history used to live only in memory — one
restart and the whole list was empty.

**What we didn't copy**: the `Marketplace` at the bottom (skill market; we didn't have the concept of
skills yet), `Routines` in the right panel (scheduled tasks, not done yet), voice input. Shared memory
is our own thing that Grok Bot doesn't have; it moved to the lower half of the right panel.

## 2.18 Made into a product: PostgreSQL + one-command container deployment + custom upstreams (2026-09-16)

The boss: "make it a real product, with its own postgresql, containerized deployment — anyway,
something others can deploy with one command using podman/docker, and you can also customize the model
upstream; customize provider name/url/model/context (manual/auto)" (「做成一个真的产品 有自己的
postgresql 容器化部署 反正被人能够一键用 podman/docker 部署的 还可以自定义上游的模型 自定义 provider
name/url/model/上下文（手动/自动）」).

### 2.18.1 All state goes into the database; files are demoted to seeds

Before this, state was scattered in five places: Agents in two ymls under `bots/<id>/`, DMs in
`workspace/dm/*.json`, groups in `workspace/groups/<id>/{group,log}.json`, memory in `MEMORY.md`,
upstreams in `.env`. Fine for a single-machine script, not for something others will deploy — no
transactions, backups mean remembering five paths, and deleting a container scatters the data.

Now there are only the five tables in `web/db.mjs`: `agents` / `groups` / `messages` /
`settings` / `providers`. Two non-obvious decisions:

- **DMs and group chats share one `messages` table** (`scope` + `scope_id`). With two tables,
  "sort the conversation list by recent activity" would need two queries and a merge, and that's the
  backbone of this UI. Now it's one `distinct on (scope, scope_id) … order by id desc`.
- **`bots/` and the old `workspace/*.json` are imported only once, when the database is empty**. After
  that they're history, and editing them has no effect whatsoever — this must be stated flatly in the
  README, or the next person will edit the files and wonder why the UI didn't change.

**The upgrade path has actually been walked**: when `start.sh` finds `./workspace` has content and
`./data/workspace` is empty, it `cp -a`s the whole thing over, then the first start imports it
(measured: 4 Agents, 2 groups, 22 messages).

### 2.18.2 ⚠️ The left side of a sibling container's `-v` is a host path, not our own path

The service itself runs in a container, and the Agents' containers are **sibling containers** it
starts. In `docker run -v A:B`, A is interpreted by the host's daemon — write it as our in-container
`/app/workspace` and the Agent gets mounted on an **empty directory**, with no error at all.

Hence `WORKSPACE_HOST_PATH`, which `start.sh` writes as an absolute path.

**The second layer is sneakier**: containers are long-lived, and this path changes (upgrades, moving the
repo, changing compose). A container mounted on an old path **looks completely normal** — commands
succeed, `ls` shows the files — only the artifacts land in a directory nobody looks at. Hit on the spot
on the real machine: after the new version came up, `ma-agent-chief` was still mounted on
`Multi-Agent/workspace/`, while the UI read `Multi-Agent/data/workspace/`.

**This is the same shape as 2.14's "the symlink kept pointing at the previous group".**
Now `ensureContainer`, every time before reusing a container, inspects the mount source of `/work` and
compares; if it doesn't match it rebuilds (old files stay where they were).

One more thing slipped in: **nobody created the group directories any more**. Once group info moved
into the database, `workspace/groups/<gid>/` was no longer created as a side effect of `saveGroup`, so
the symlink inside the container pointed at a non-existent path and `cp report.md group/` simply
failed — and the failure only showed up in some Agent's tool output. `ensureContainer` now creates it.

### 2.18.3 Upstreams: if `/models` can't tell you, say you don't know; don't guess quietly

`providers` table + "⚙ Model upstreams" at the bottom left. Two sources for the context window:

1. **Auto** — ask the upstream's `/models` (OpenRouter / vLLM / ollama / most relays answer)
2. Can't ask → infer from the model name (the `KNOWN` table in `web/model.mjs`)
3. Still unknown → **return null and have the UI say "couldn't detect, please enter it manually"**

**The UI must mark whether this number was asked or guessed** (`ctx_source`). A silently wrong window
makes long conversations suddenly start returning 400 one day, and nobody knows why.

"Test connection" really calls the upstream once. The button paid for itself on day one: during
acceptance the whole 66hxhx `gpt-5.6-sol` channel was down, and four tests found that `gpt-5.5` worked —
each failure gave a different reason (overloaded / model_not_found / 429 / 502) rather than one
"doesn't work".

On 2026-09-17 the default switched to **`gpt-6-astra`** (the boss named it): tool calling works, one
round with tools takes about 97 seconds, the slowest single call 88 seconds.
66hxhx's `/models` **doesn't report its context window** and the name isn't in the inference table, so
it currently runs on the 128k fallback with `ctx_source` saying "manual entry recommended" — **don't
invent a number in the KNOWN table before finding the real window**.
It has Codex habits: it tries `apply_patch` first and switches to `write_file` itself after it fails.

**`fitContext` replaced "keep the last 40 messages".** 40 short messages waste 90% of the window; 40
messages with one 12000-character bash output in them overflow outright — and overflow shows up as an
upstream 400, which looks like "the model is broken". Trimming happens **before every model call**, not
just once at entry: tool output inflates the context within the same round. `node web/model.mjs` is its
self-test.

### 2.18.4 ⚠️ An upstream can return 200 first and then report an error [inside the stream]

The first conversation on the real machine: `start` → `end`, not a single character in between, no
error. It turned out the upstream returned:

```
data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"error":{"message":"Our servers are currently overloaded..."}}
```

`callModel` used to look only at `choices[0].delta`, and this `error` frame was completely ignored —
so a failed call showed up as "the Agent didn't say a word", with nothing in the log.
(The parent CLAUDE.md §13.1 records the same thing; over there it's handled at the gateway layer.)

Now two rules: **an `error` frame in the stream throws directly**; **no text at all and no tool calls
is also treated as a failure** (some upstreams don't even report the error).

**Retries must back off.** Measured during a group relay: the first person reliably succeeded and the
second reliably failed — not random; the two calls were too close together and got rate-limited, and an
immediate retry guarantees hitting it again. Now it's three tries at `[0, 2s, 6s]`.

### 2.18.5 Deployment

```
./start.sh          # generates .env (random DB password + access token) → compose up --build
docker-compose.yml  # db(postgres:17-alpine) + app
Dockerfile          # node:24-slim + a client extracted from docker:28-cli
```

A few things learned the hard way:

- **The worker image builds itself.** When `ensureImage` finds `multi-agent-worker:1` missing, it reads
  `deploy/agent.Dockerfile` and feeds it to `docker build -t X -`. Otherwise the first line of the
  deployment docs would have to be "first build an image yourself", which is exactly the step most
  easily skipped, and skipping it only **errors on the first conversation**. The Dockerfile isn't
  copied a second time into code.
- **Don't write `.env` keys with `sed -i "s-…-…-"`.** The repo is called `Multi-Agent`; there's a hyphen
  in the path, and you get `unknown option to 's'` on the spot. Switched to "grep -v to delete the line
  + append", so values with `/ - & #` are all fine.
- **`grep -q X && return` exits the script under `set -e`** (the fourth time for the rule in 2.9.5).
  Always write `if`.
- **By default it's only published on `127.0.0.1`** (`BIND_ADDR`). The service also has its own gate:
  **listening externally + no ACCESS_TOKEN = refuse to start** — that combination can only be a
  misconfiguration.
- podman: when `start.sh` recognises it, it points `DOCKER_SOCK` at podman's socket; the docker client
  in the image speaks the same API, no second copy of the code.

### 2.18.6 Verified / not verified

Verified (real machine): one-command deployment from zero to usable, old-data import, DM + tool
execution **with the artifact checked on the host**, messages landing in PG, conversation list previews,
group shared drive visible both ways (chief writes → host → operator reads), connection tests for four
upstreams, all three branches of context detection, the action rows of all three dialogs within the
viewport, zero frontend pageerrors.

**Group relay was verified too** (after the upstream recovered from saturation):
`user @Operator → chief breaks down work → @Operator → operator writes group/ok.txt in [his own
container] → reports to chief`. **The criterion is the artifact, not the conversation**: `ok.txt`
contains `449935512d8f`, the operator container's hostname; the chief's is `e376af1f9a1b`.

**Two deployments side by side were verified too**: `COMPOSE_PROJECT_NAME=mafresh` + `WEB_PORT=8090` +
`AGENT_PREFIX=fresh`, a brand-new clone with zero config came up (4 Agents seeded from bots/, 0
upstreams → the UI pops up the config directly), without interfering with the original.
**Change one of the three variables less and they collide.**

**Not verified**: the podman path (this machine only has docker). In code it's the same client
speaking the same API, but the socket path and rootless permissions haven't been run on a real machine.

### 2.18.7 Three upstream protocols (2026-09-18)

The boss: "inside the client you need to be able to customize the upstream and the model, and it has to
support the three endpoints chat completion/responses/messages" (「客户端内部是需要可以自定义上游还有
model 的 以及要支持 chat completion/responses/messages 三个口」).

`providers.protocol` (`chat` / `responses` / `messages`); all translation lives in `web/protocols.mjs`.
**Inside the server, history is always in Chat Completions shape**, translated only at the moment of
calling the upstream, and the result is normalised to `{content, calls}` — the agent loop, fitContext
and the stored records don't know there are three protocols.

Anthropic's constraints are stricter than Chat's; translation has to do four things (all covered by the
self-test `node web/protocols.mjs`): system goes separately; tool results are `tool_result` blocks in a
**user** message; **consecutive messages with the same role must be merged** (several user messages in a
row are normal in group chats); **the first message must be user** (after fitContext trims from the
front, the start may be assistant, which is a straight 400). Authentication sends only `x-api-key`, and
the `/models` probe must switch to that header too.

For Responses, tool arguments are taken from the complete `arguments` in `response.output_item.done` —
some relays don't send `function_call_arguments.delta`. The three protocols each have a different shape
for "an error inside the stream after 200" (`{error}` / `{type:'error',error}` /
`{type:'error',message}` / `response.failed`); all must throw.

**Verified (real machine, one full round with tools)**: Responses = 66hxhx `gpt-5.5`, Messages = muskapi
`claude-haiku-4-5`; both had the Operator run a command in his own container, read the result back and
then answer (the hostname was the operator container's). 66hxhx's `gpt-6-astra` over Responses didn't
reply within 60 seconds the first time, then worked later (the boss switched the default upstream to
Responses; on the afternoon of 2026-09-18 both DMs and group chats were fine) — **relay endpoints come
and go; don't conclude anything from one failure**. That's what the UI's "Test connection" is for.

**The deployment is now open to the internet**: `BIND_ADDR=0.0.0.0`, `http://216.195.192.61:8080`,
plaintext HTTP, `ACCESS_TOKEN` is the only door, and `AGENT_TOOLS=on` — having the token = having a
container shell.

## 2.19 Flutter desktop client (2026-09-18)

The boss: "how about also writing it in flutter, that way you can build a lossless client too" and
"win+mac, no login needed, I plan to open-source this, you can also take a look at my cirraya agent"
(「要不还用个 flutter 写 这样还可以无损作出客户端」「win+mac 的 不需要做登陆啊 这个我打算开源 你也可以参照一下我的 cirraya agent」).

The reference was **`/root/cirraya/Temrinal`** (the boss's own Flutter + C++ SSH client). The most
valuable part of its CLAUDE.md is "how to verify on Linux" — **this machine can really build, run and
screenshot a Flutter desktop app**, so this round wasn't "wrote Dart that looks right"; it actually
connected to the server and sent messages.

### 2.19.1 Shape: the client is a [view], not a second product

- **The web UI stays as it is.** Flutter Web would mean adding a build stage with the Flutter SDK to
  Docker (several GB), downloading a multi-MB rendering engine on first load, and canvas rendering makes
  selecting/copying and in-browser find worse — while a chat UI is mostly reading text and copying code.
  The value of the self-hosting route is exactly "one HTML file, one JS file, no build".
- **No login.** The boss said explicitly he doesn't want it. The server only has one shared token
  anyway, so "logging in" = entering an address. Settings store a single JSON file `{baseUrl, token}`.
- **Zero third-party dependencies.** There's no local data to manage (it's all in the server's PG), so
  HTTP uses `dart:io`, state uses `ChangeNotifier`, settings use `File`.
  Pulling in riverpod / http / path_provider would be adding answers to a problem that doesn't exist.

### 2.19.2 ⚠️ Two places where tests lie (both actually fooled us)

**1. `enterText(prefix)` isn't typing; it's a whole replacement.**

On the real machine, typing the server address one character at a time with xdotool produced
`http://127.0.0.1:8080A3LxeQ9xwKlTJCE` — the token stuck onto the end of the address. The root cause was
rewriting its own controller in `onChanged`: the moment `?k=` was typed the box was replaced with just
the host, and each later character was appended to **the rewritten** value. **Pasting is a single
onChanged, so pasting looks completely normal**, which is exactly how it survived.

The fix is to not parse in onChanged, and instead parse once at the moment the button is pressed.
But the first version of the regression test used `enterText(link.substring(0, i))` — replacing the
whole value each time, starting from the original prefix each time, **passing on both old and new
versions**. It must be written as "read the control's current value and append one character" to
reproduce the bug.

**Verified that it distinguishes old from new**: with the old code put back, the test fails with
`Expected: 'http://127.0.0.1:8080' / Actual: 'http://127.0.0.1:8080A3Lx…'`.

**2. Widget tests run on the Android target by default** (recorded in Temrinal §5.1, copied here).
This app ships on Windows and macOS, so the harness must set
`AppTheme.dark().copyWith(platform: TargetPlatform.macOS)`.

**3. Compiling on your own machine doesn't mean what's in the repo compiles.** After pushing, the boss
cloned it and got a wall of "cannot find lib/data/*.dart" — the `data/` line in the root `.gitignore`
(meant for the deployment data directory) **matches data directories at any depth**, and ignored the
four source files in `app/lib/data/` too. The local 22 tests were all green because the files were on
disk. It's now written `/data/` (anchored to the root only), and **acceptance is always run in a fresh
clone**: `flutter analyze && flutter test`. Another macOS pitfall of the same kind: the sandbox needs
`com.apple.security.network.client` to reach the network, `flutter create` doesn't grant it by default,
and it can't be verified on Linux.

**3 (continued). HttpClient's `idleTimeout` isn't a streaming timeout.** I originally thought it would
cut off a streaming reply and set it to 10 minutes — in fact it only governs how long **idle**
connections stay in the pool. Node closes idle keep-alive after 5 seconds by default, so when you
clicked "Save" on the Mac the request went out on a socket the server had already closed:
`HttpException: Connection closed before full header was received`, and Unhandled at that
(`req.close()`'s exception wasn't caught). Now the client uses 3 seconds and the server
`keepAliveTimeout` 65 seconds, and this kind of error is resent once (the request never reached the
server, so resending is safe); `test/api_test.dart` pins it with a fake server that hangs up after
reading the request, which reproduces the original error on the old code.

### 2.19.3 Fixed along the way: an ordering bug the web UI had too

The first time real conversations were viewed in the client: **the answer bubble sat above the tool
cards**, while the real order is execute first, then answer — it read as giving the conclusion before
going to check.

Two layers of cause, the same on both sides (`web/app.js` and `state/workbench.dart`):

1. The bubble was created on the `start` event, and what often arrives right after `start` is a tool
   call.
   → Now it's **created on the first `delta`** (bonus: a round that says nothing no longer leaves an
   empty bubble).
2. A round can be "say something → run a command → say something more", and the later text was still
   appended to the **same** bubble, so the two passages merged into one sitting above the command.
   → Now **the current bubble is closed as soon as a tool appears**; later text starts a new one.

After the fix the real transcript reads: `Running uname -a to check the current system and kernel
info.` → [tool card `uname -a` → Linux 449935512d8f … exit 0] → `uname -a output: …`.
That's what a coworker doing work looks like.

### 2.19.3.1 Creating Agents / groups + the right panel (2026-09-18)

The boss: "can't create any AGENT or group, and the right panel can't be opened either"
(「无法创建任何 AGENT 和群组 还有右框也无法打开」).

- The `+` next to the left panel's search box: New Agent / New group; "Edit Agent / Edit group" at the
  top of the right panel to change, delete, disband. Same endpoints as the web UI (`/api/bots`,
  `/api/groups`); code in `features/workbench/editors.dart`
- **Root cause of the right panel not opening**: when the window was narrower than 1180 the right panel
  simply wasn't rendered, so pressing the toggle did nothing — and **a new macOS window defaults to
  800×600**, so on a Mac it was always narrow. Now in narrow windows the right panel slides out as an
  endDrawer; and `MainFlutterWindow.swift` sets the default window to 1320×840 (minimum 900×560)
- In headless verification, **xdotool must resize the toplevel window** (the one with a WM_CLASS in
  `xwininfo -root -tree`); what `xdotool search --name` returns is the inner view, and resizing it has
  no effect

### 2.19.4 How to verify on Linux

(The Temrinal way)

```bash
apt install clang cmake ninja-build pkg-config libgtk-3-dev xvfb imagemagick fonts-noto-cjk
cd app && flutter build linux --debug
Xvfb :99 -screen 0 1440x900x24 &
DISPLAY=:99 ./build/linux/x64/debug/bundle/multi_agent &
DISPLAY=:99 import -window root /tmp/shot.png
```

**`xdotool type` scrambles Chinese** — measured: "的第一行给我看，一句话就行" became
"第一给看句话行" (the characters get dropped and reordered), and the log shows a string of
`hardware_keyboard.dart` `data.physical != 0 && data.logical != 0` assertions. **That's xdotool's
synthetic keys having no key codes, not an app bug; don't try to fix it.** Drive the UI in English.

### 2.19.5 Verified / not verified

**Verified (real machine, not reasoning)**: `flutter analyze` clean, all 22 tests pass, the Linux build
built and ran, entering the address connected to the real server, the left panel read the 7 real
conversations (stacked group avatars + `+1`), opening a conversation read the history from PG, **sent a
message from the client and got a full reply** (streaming text + tool card + exit code + retry notice +
left panel preview refresh).

**Not verified**:
- **Never compiled on Windows or macOS** (this machine is Linux). The platform directories are standard
  scaffolding generated by `flutter create`, and the Dart side has no native code at all, so the risk is
  low — but "low" isn't "verified". **The boss needs to build once each on Mac and Win.**
- macOS signing and notarization (needs an Apple developer account).

### 2.19.6 Not done yet

- **The token is stored in plain text in JSON.** Moving it into Keychain / Credential Manager needs a
  native branch for each.
- Phones aren't an "adaptation": the 308px sidebar and three columns are desktop assumptions;
  navigation needs to be redone.

## 2.20 Full review (2026-09-18)

The boss: "in the server settings, clicking Cancel does nothing. Please check every part again and make
sure everything works with no bugs" (「服务器设置的 取消 点击了没用 请你再次检查所有的部分 确保能正常使用无BUG」).

Approach: two sub-agents read the client and the server respectively to find bugs (report only, no
changes), while I clicked through every screen of the Linux build and checked each step against the
server. **The problems the two paths found barely overlap** — reading code found concurrency and
validation issues; clicking the UI found things like "Cancel does nothing" and "the text you sent comes
back into the input box", which only appear when really typing.

**The points most worth remembering:**

- **"Which conversation is current" must be decided with an incrementing counter, not by id.** Switching
  away mid-stream or clicking two conversations quickly lets late-arriving history or replies paint
  into the new conversation. The client's `Workbench._shown` and the web's `shown` are the same
  pattern; `test/workbench_test.dart` pins it with a fake server that streams slowly.
  **The first version of the test was green on the old code too**: after switching away only the second
  half of the same bubble arrived, and the old code modified an object no longer in the list. It only
  reproduces when **new** entries (tool cards, new bubbles) arrive after switching away
- **Enter-to-send must wait one frame before reading the input box.** The key event can arrive before
  the text update of the last character: one character short is sent, and that character's update then
  writes the whole sentence back into the cleared input box. **Enter must pass through while an input
  method is composing** (`composing.isValid`), otherwise a Chinese user pressing Enter to commit text
  sends half-typed pinyin — hence `Focus.onKeyEvent` rather than `CallbackShortcuts` (the latter swallows
  that Enter). **The composing case can't be verified headless** (xdotool has no input method)
- **The same Agent does only one thing at a time** (`withAgent`): the `/work/group` symlink is shared by
  the whole container; while he's running tools in group A and it's his turn in group B, the symlink is
  repointed to B, and group A's artifacts land in group B's shared drive (the concurrent version of 2.14)
- **Abort when the client disconnects** (`res.on('close')` + an AbortController passed all the way down
  to fetch): otherwise closing the page lets the group relay run all the way through, 6 people × 12
  steps. Measured: after disconnecting, no replies were stored for 90 seconds
- **When tools are off (`AGENT_TOOLS` defaults to off), no container is started**, and the persona
  doesn't say "you have your own machine"
- **Every write endpoint validates**, errors are 400 + one sentence (bad JSON, empty name, duplicate
  name, the reserved name "User" (用户), colour not #RRGGBB, group members that aren't real Agents or
  fewer than two, a misspelled protocol). **Renaming updates the speaker in group logs** — group logs
  identify people by name; without the update, what he said in the past would become "said by someone
  else"
- **All client network errors are turned into `ApiException` at one exit, `Api._send/_json`** (TLS
  handshake failure, malformed address, response not JSON / wrong shape); pages catch only that one
  type. A streaming reply gives up after 5 minutes without activity, otherwise `busy` gets stuck and no
  conversation can send messages
- On retry, drop the half bubble that the failed attempt already streamed (otherwise the same text
  shows twice while the database only has the retried copy)

### 2.20.0 The group lead (2026-09-19)

The boss asked "in a group chat, how is it decided which AGENT coordinates the whole thing"
(「群聊是怎么确定让哪一个 AGENT 作为整个统筹的」) — the answer used to be **there was no such concept**:
when nobody was @-mentioned, whoever sorted first spoke first (Chief of Staff's order is 0), and he
broke down the work only because his persona said so. Now `groups.lead`:

- Who takes it first: **whoever the user @-mentioned → the lead → the first by order** (`converse`).
  After that, relay by @ as before
- Written in the prompts: the lead is told "when nobody is named, you speak first, break down the work,
  @ people, track progress, and summarise at the end"; everyone else is told "when you're done / stuck /
  don't know who should take it, @ the lead". If only the lead's side said it, the others wouldn't know
  whom to report to
- The lead must be a group member (400); removing him from the members, or deleting that Agent, clears
  the lead automatically (it never points at someone not in the group)
- UI: chosen in the create/edit group dialog (only from the checked members); the right panel marks
  "Lead" next to the member's name

### 2.20.1 Memory per conversation + @ autocomplete (2026-09-18)

The boss: "when you type @ there should be avatars, autocomplete like that. And when I switch back to a
DM, why does the bottom right still say 'Shared memory'? And drop the '# 共同记忆' header, just edit the
actual content" (「@ 的时候要有头像显示 自动补全这样的 以及切换回私聊了 右下角怎么还是『共同记忆』
以及『# 共同记忆』这个标头就不要了 直接编辑实质性内容」).

- **Memory is no longer one global blob**: `memory:agent:<id>` and `memory:group:<gid>` in `settings`,
  endpoints `GET/PUT /api/memory/(agent|group)/<id>`. In a DM the right panel edits this Agent's own
  memory (which he also carries when speaking in groups); in a group it edits the group memory. This is
  what 2.12's "everyone has independent memory, groups share it" means. The old global `memory` is
  copied into every Agent by `splitGlobalMemory` at startup and deleted, and the leading "# 共同记忆"
  ("# Shared memory") header is removed (it was a template, not content). Deleting an Agent / group
  deletes its memory too
- **@ autocomplete only appears in groups** (@-mentioning anyone in a DM is meaningless), with avatar
  and title; ↑↓ to select, Enter / Tab to insert, Esc to close
- ⚠️ Flutter: **when conditionally inserting a popup above an input box, the input box must have a key**.
  Without one its index in the Column changes, the element is rebuilt and focus is lost — the symptom is
  that everything typed after `@` disappears while the popup still shows

### 2.20.2 Import/export chat history + per-Agent upstream and model (2026-09-19)

The boss: "also support importing and exporting chat history / also support setting provider and model
per agent" (「还要支持导入导出聊天记录 / 还支持每个agent单独设置provider和model」).

- **Export/import**: `GET /api/export/(dm|group)/<id>`, `POST /api/import/(dm|group)/<id>` `{doc, replace}`.
  File format `{format:'multi-agent-chat', version:1, kind, id, name, exported_at, messages:[{role, speaker, content, at}]}`;
  **`at` is an ISO string and is kept as-is on import** (the first version exported milliseconds and
  imported with `Date.parse`, so every timestamp became now()).
  The whole batch is one transaction; appended messages go after the existing ones (history is ordered
  by id, not time). A wrong format is 400 and writes nothing.
  The web UI asks two confirms: the first "OK" appends, the second "OK" replaces, cancelling both
  cancels — each OK does only what its sentence says.
- **Per-Agent upstream**: `agents.provider_id` (empty = use the default upstream) + `agents.model`
  (**required**, see 2.20.3).
  **Everyone's upstream is resolved at once before the SSE stream opens**, otherwise a group relay only
  discovers at the third person that his upstream was deleted.
  **An upstream still in use by an Agent can't be deleted** (409, naming who uses it) — otherwise that
  Agent would quietly fall back to the default upstream.
  Verified on the real machine: the default upstream was gpt-6-astra; after giving one Agent muskapi's
  claude-haiku it called itself Claude.
- **The client broke "zero dependencies" once: `file_selector`** (Flutter's official native open/save
  dialogs). Writing a native dialog for each of three platforms isn't worth it.
  macOS needs `com.apple.security.files.user-selected.read-write` (added to both entitlements files);
  can't be verified on Linux.
- In the client's Agent editor, the upstream dropdown **must not use the saved id as its initial value
  before the upstream list has loaded** (it asserts if the value isn't among the items), so it carries a
  `ValueKey(_providers.length)` and rebuilds once the list arrives. If the saved upstream has been
  deleted, it falls back to "Default upstream".
- Headless verification: under Xvfb the GTK file dialog really does pop up; **typing a path into its
  location bar with `xdotool type` gets eaten by autocompletion**, so double-click the file in the list
  instead.

### 2.20.3 Upstreams don't carry a model; the Agent picks its own model (2026-09-19)

The boss: "a model upstream shouldn't include a model; the model is chosen by yourself (provide a
dropdown)" (「模型上游不应该带model model是要自己选择的（提供下拉框）」).

- **An upstream only governs where to connect, the key, the protocol and the context strategy**. The
  `providers.model` column is still there, only as a source for old data: at startup `fillAgentModels()`
  copies the old model of the upstream an Agent uses into Agents that haven't chosen one (idempotent);
  new upstreams write an empty string
- **The model dropdown's data comes from `POST /api/providers/models`** (`{id}`, empty = default
  upstream; also accepts unsaved form fields), returning `{models, suggested}`. `suggested` = models
  already used by some Agent on this upstream — preselected when creating, rather than the alphabetically
  first one (which is often a model this endpoint can't use, e.g. `codex-auto-review`, `agnes-2.5-pro`).
  **When the upstream doesn't answer /models, fall back to a manual input box**, otherwise Agents on that
  upstream couldn't pick a model at all
- When switching upstreams, the old model name isn't carried over (it very likely doesn't belong to the
  new upstream); switching back to the original upstream restores it. A saved model that isn't in the
  list is still shown, marked "no longer listed by the upstream"
- **The context window is detected per (upstream, model) at conversation time** (`contextFor`;
  successful results cached for an hour, fallback values not cached); if the upstream is set to
  "manual", every model on it uses that number. The upstream form's "Probe" button is gone — there's no
  model to probe
- **Which model "Test connection" tries**: the one the caller gives → the one chosen by an Agent using
  this upstream → the one old data recorded on the upstream → the first in the list.
  Using only the list's first, muskapi returned 400 (its first is `agnes-2.5-pro`, which it doesn't
  allow), which looks like the upstream is broken
- Agents seeded from `bots/` have no model; the first conversation reports "no model chosen yet — go
  pick one in Edit Agent"
- The three buttons "Save / Export history / Import" in the client's right panel are **filled** buttons;
  they used to sit in two adjacent Rows and looked like one bar. Now one `Wrap(spacing: 8)`, with the
  status text on its own line

### 2.20.4 Reasoning effort per agent (2026-09-20)

The boss: besides its own upstream and model, each agent gets a **reasoning effort**. `agents.effort`:
empty (send nothing at all, what every model got before) / `low` / `medium` / `high`. **Three levels on
purpose** — every provider spells this differently, and putting their vocabularies in the UI would mean
editing it whenever one of them moves.

- Translated per protocol in `protocols.mjs`, beside the other protocol differences: chat →
  `reasoning_effort`, responses → `reasoning: {effort}`, messages → **extended thinking**
  `thinking: {type:'enabled', budget_tokens}` (low/medium/high = 1024/4096/8192).
  **Anthropic's budget must stay strictly below `max_tokens`, so max_tokens grows with it**
  (8192 + budget) — one shared ceiling would let the thinking eat the answer. Thinking also rules out
  `temperature` / `top_p` / `top_k` and a forced `tool_choice`; this file sends none of them, and the
  self-test pins that.
- ⚠️ **An upstream that rejects the parameter must not cost the agent its turn.** On a 4xx whose body
  blames it (`blamesEffort`), `callUpstream` retries once without it and remembers the (upstream, model)
  pair for the life of the process, logging one `[effort] …` line so a person can see why the setting
  does nothing. Safe to retry there — a non-2xx means not one byte has reached `onDelta` yet, so this
  never touches `runAgent`'s own backoff/image-drop retries. A model that merely **ignores** the field
  is fine and needs nothing.
- The memory is per process, so a restart tries again — which is what you want after fixing an upstream.
- **A platform default too** (2026-09-20), settings key `model.default_effort`, in the upstreams
  dialog beside the daily cap and the approval mode. An agent's own value wins; **its empty means
  "follow the platform", and the platform's own empty means send nothing** — so an untouched
  deployment behaves exactly as before. It is resolved in `providerFor`, one place, so every caller
  (DM, group relay, scheduled task) gets it without knowing about it.
- ⚠️ `POST /api/bots` used to destructure a fixed field list and drop anything new at creation —
  `effort` and `daily_cap_micro` could only be set by PATCH. Fixed by spreading what `checkAgent`
  returned; **add a field to the editor and it now arrives, but only because nothing hand-copies
  the list any more — don't reintroduce one.**

Verified against the real deployment with a throwaway fake upstream that recorded the request bodies:
all three protocols sent the right shape (messages: `budget_tokens 4096` with `max_tokens 12288`), and
under a fake 400 the turn still completed (retried bare) and the next turn never sent it again.

## 2.20.5 Tool calls stay in the transcript (2026-09-20)

Reopening a conversation used to show only the final text: which commands ran left with the stream, so
"what did it actually do" could only be answered while you were watching.

- **A tool call is a `messages` row**, `role = 'tool'`, content `{name, args, output}` as JSON. Not a new
  table: the conversation list sorts by recent activity in one query, and a second table would make that
  a merge again (2.18.1's reason, still the reason).
- **`recent()` hides tool rows unless asked** (`{tools:true}`). The model builds its own tool messages
  inside a turn; feeding these back hands it a second, malformed copy of its own work. Only the two
  history endpoints ask for them — the model path, export and the conversation previews don't.
- **Written where the card is emitted** (`runAgent`, the `done` phase), so all three callers — DM, group
  first speaker, group relay — get it from one line, and the ordering is free: tools land between the
  question and the answer because that's when they happen.
- **Cut to the same length the live stream sends** (`TOOL_TRACE`, 400). More on reload than while
  watching would be its own small lie. Screenshots are still never stored.
- Both frontends build the card label from `name` + `args` in one place now (`toolLabel` /
  `_label`), so a reloaded card reads exactly like a live one. A card from history is never `running`.

An existing database needs the check constraint relaxed, not just the column: `create table if not
exists` won't touch it, so the migration drops and re-adds `messages_role_check`.

Verified on the live deployment: asked the Operator to run `uname -r`, reloaded `/api/dm/operator` — the
tool row is there between question and answer with its output; the conversation preview and the export
still show only text; a follow-up turn ("what command did you just run?") answered correctly, so the
model context is unchanged. In the browser the reloaded card renders above the answer, zero console
errors. `app/test/workbench_test.dart` pins the client mapping (green on new code, throws on old).

## 2.21 Scheduled tasks (2026-09-19)

The boss: "scheduled tasks, a skill library, browser operation and so on — we definitely need all of
these" (「定时任务 技能库 浏览器操作等等这些肯定都要啊」), and chose option A (build on our own loop,
don't switch to dsh), in the order scheduled tasks → browser → skill library.

**dsh's `schedule` is no use**: it hangs off a single session, disappears when the session ends, and has
a 5-minute minimum. We need something attached to an Agent / group that survives restarts.

- **When it fires = someone sent a message in that conversation.** Sending a message from the UI and
  scheduled tasks both go through `converse()` (server.mjs); two implementations would eventually diverge.
  The message sent is prefixed with a line like "〔Scheduled task "name" sent automatically; nobody is
  watching live. Write up the result clearly when done.〕", so the Agent knows nobody is watching live
  and the result must be complete. For a group task, if you want someone specific to take it first, @
  him in the prompt
- Table `routines`; three frequencies `interval` (≥5 minutes) / `daily` (HH:MM + weekdays, empty = every
  day) / `once` (disables itself after running).
  **The next-run computation is in `web/schedule.mjs` and uses the task's own IANA time zone, not the
  server's**; the DST switch hour gets two corrections; `node web/schedule.mjs` is the self-test
  (including two New York DST cases)
- The scheduler ticks every 20 seconds (`tickRoutines`). **Write next_run_at first, then start running**
  — the other way round, a process dying halfway would rerun it; runs missed during downtime are caught up
  only once after startup. The same task never overlaps itself (`routineRunning`, single process, in
  memory)
- **Automatically paused after 5 consecutive failures**, with the reason in `last_error`; re-enabling
  resets the failure count. After a run, **re-read the row before writing the status** — someone may
  have edited it during those minutes
- "Run once now" doesn't change next_run_at (it mustn't move tomorrow's 9am run); clicking again while
  it's running returns 409
- Deleting an Agent / group deletes its tasks too
- **The UI checks every 15 seconds** (the web's `setInterval`, the client's `Workbench.poll`): left panel
  previews, task status, and it repaints the history when the current conversation has new messages.
  **It doesn't touch anything while you're sending (busy)** — a streaming reply is being drawn on screen
  and a repaint would wipe the tool cards. `test/workbench_test.dart` pins both
- The client can't get an IANA time zone (Dart doesn't have it): macOS/Linux read the link target of
  `/etc/localtime`, Windows falls back to `Etc/GMT±N` (an hour off after a DST switch). Editing an
  existing task keeps its own time zone
- The client's weekday FilterChips need `showCheckmark: false`: the checkmark widens them, wraps the
  whole row, and moves the buttons below

**Not done yet**: event triggers (Grok Bot has "a message arrives in some channel", "a GitHub event");
letting Agents create tasks themselves (think it through first: one injection could make it run every 5
minutes and spend money); a per-task spending cap.

## 2.22 Browser (2026-09-19)

**dsh has no browser** (its `web` only does search and fetching pages). Approach: one chromium + one
long-running daemon inside each Agent's container.

- **Image `multi-agent-worker:2`** (`deploy/agent.Dockerfile`): the distro's `chromium` + `pip install
  playwright` (only as a driver; no `playwright install`, which downloads from its own CDN) +
  `fonts-noto-cjk` (without it, Chinese in screenshots is all boxes).
  **The image grew from 237 MB to 1.18 GB**: chromium 374 MB, playwright's node driver 132 MB, fonts 93 MB
- **The daemon `deploy/browserd.py` isn't in the image**: it's pushed into the container before each
  browser use (`BROWSERD_UP`), and if the content changed the old one is killed and restarted. Changing
  it doesn't need an image rebuild. It only listens on 127.0.0.1:9230 inside the container; the server
  reaches it via `docker exec ... curl`. Single-threaded (Playwright's sync API can't cross threads).
  **It's long-running because page state lives in the browser process**; the login state lands in
  `/work/.browser`, so it survives container rebuilds
- **Don't kill the old one with `pkill -f browserd`** (the script's own command line contains that word,
  2.9.5); use a pid file
- **When the image changes, old containers must be rebuilt**: `ensureContainer` now also compares
  `{{.Config.Image}}`, and if it doesn't match deletes and restarts (`/work` is on the host and isn't
  lost; what's lost is whatever he apt-installed himself)
- One `browser` tool, actions open / read / click / type / press / scroll / back / screenshot / eval.
  **`read` numbers the clickable and fillable elements, and click / type use the number** — CSS selectors
  are what the model most easily makes up, while the number is something it just saw with its own eyes.
  `type`'s `text` is the content to type; the element is located only by index / selector
- **Screenshots really go into the model**: internal messages have an extra `images` (data URLs), and
  `protocols.mjs` translates per protocol (chat's image_url array / responses' input_image / messages'
  base64 image block), with three cases in the self-test. Chat's tool message only takes text, so the
  screenshot follows in a user message; **only the latest one is kept per round** (the whole history is
  resent every step, and ten old images cost money every step). Images are never stored in the database
- **Models that don't accept images**: when a request with an image is rejected with a 4xx, the image is
  removed and later screenshots become a text notice, and the round continues (`dropImages` +
  `ctx.noImages`). Verified with a fake upstream (400 on seeing image_url)
- Screenshots are also sent to the UI with the `tool` event and shown directly in the tool card on web
  and client (only in this stream; gone when the conversation is reopened)
- Verified (real machine): gpt-6-astra read a random number and the heading colour from a screenshot
  (not from read, so the criterion is trustworthy); read → type #1 → click #2 → read computed the right
  result on a local form

### 2.22.1 A person watching the Agent's browser and taking over (2026-09-19)

The boss: "the client can also directly show the AGENT's browser, and you can help operate it; show it
in the right panel as a live thumbnail, click it and it takes over the whole app window, and then you
can go back to the original app view" (「客户端里也可以直接显示出AGENT的浏览器 也可以协助操作 显示在右侧缩略实时 点击过后就是占据整个软件的界面
然后也可以回到原始的软件界面」), followed by "and ideally streaming output first" (「最好还要支持流式输出优先」).

- **"Browser" in the right panel**: a DM shows this Agent's; a group lists only the members with a browser
  open. Clicking = full screen (in the client a new route, on the web an overlay), with an address bar,
  back and reload; **wherever you click on the picture gets clicked in his browser** (`click_xy`, scaled
  to 1280×800), wheel scrolls, and a row below types (`type_raw`, into the current focus) plus
  Enter/Tab/⌫/Esc. Back returns to the original view.
  **The person and the Agent use the same browser**: once the person logs in, he can carry on using it;
  the tool description was also changed to "when you hit a login/CAPTCHA, ask the user to open your
  browser on the right and take over"
- **Streaming first**: the picture is Chromium's own screencast (CDP `Page.startScreencast`, frames only
  when the page changes), pushed by the daemon as MJPEG (multipart/x-mixed-replace), and the server's
  `GET /api/browser/:id/stream` relays it as-is. The web's `<img>` plays it natively; the client splits
  frames by content-length in `lib/data/mjpeg.dart` (tested, including "the image happens to contain
  --frame"). **Only if the stream can't connect does it fall back to polling screenshots** (`/shot`), and
  during polling it keeps retrying the stream
- **So the daemon became asyncio** (one stream stays open while clicks also need handling — a
  single-threaded blocking one can't do it); actions are still serialised under one lock. When nobody is
  watching the screencast is stopped (every frame costs encoding)
- **Watching doesn't start a browser**: `/stream` and `/shot` return 204 when he has no browser open;
  only a real human action (`/act`) starts one
- **Doesn't take the withAgent lock**: a person must be able to watch while the Agent is working
- ⚠️ **Killing the `docker exec` client doesn't kill the curl inside the container**: nobody reads its
  output, and once heartbeats fill the pipe it hangs forever, while the daemon keeps encoding frames for
  it (two were found lingering). Now the in-container pid is written to a file when the stream starts,
  and when the viewer leaves it's killed with `docker exec kill`
- ⚠️ **While Chrome plays MJPEG, the `<img>`'s naturalWidth stays 0**, so it can't be used to tell whether
  there's a picture; only onerror can
- Models often fill unused parameters with 0 (`"index":0`); numbering starts at 1, and 0 is treated as
  not given

### 2.22.2 Direct operation (2026-09-19)

The boss: "can it work like operating the browser directly, rather than these screenshots and a
separate input box" (「能不能做到像直接操作浏览器一样 而不是这样截图和单独的输入框」). The picture was
already a stream; what was missing was input: one HTTP request per action (no hover, no dragging), and
typing needed a separate input box. Now:

- **One WebSocket input channel** `/api/browser/:id/input`: mouse move (the client coalesces every 30 ms) /
  down / up (with button, count for double-click) / wheel, keys keydown / keyup, typed text as text.
  **Node's stdlib has no WebSocket server**, so server.mjs has a hand-written handshake + masked frame
  decoding + close/ping (`server.on('upgrade')`, authenticated like HTTP via ?k= / cookie).
  Events go through a server-side allowlist (`cleanInput`), then through an always-open
  `docker exec -i ... bash -c 'exec 3<>/dev/tcp/127.0.0.1/9231; exec cat >&3'` into the daemon's second
  port (one JSON per line, `Browser.input`), not queued behind the Agent's action lock
- **Closing the connection must send a close frame first** (`0x88 0x00`); disconnecting directly shows
  the client "connection error"
- **Keyboard**: click on the picture and focus lands on an invisible input box — **input methods only
  type into real input boxes**, so Chinese relies on it; typed characters are sent as `text`
  (`insert_text`), non-character keys (Enter/arrows/Backspace/Tab/Esc) and Ctrl/⌘ + letter are sent as
  keys, with ⌘ mapped to Control (his browser is on Linux). **These keys aren't intercepted while an
  input method is composing**; at that time they belong to the input method
- ⚠️ **In Flutter, clearing a hidden input box on every character received makes characters repeat**
  (when typing fast: `typed--directlly`): the platform's input state still holds the old text and sends
  it again. Now only the newly added part is sent, and it's cleared after 0.8 seconds without typing.
  The web's textarea doesn't have this problem
- ⚠️ **The same FocusNode can't be attached to two widgets**: the outer Focus that receives keys uses its
  own node (`canRequestFocus:false`); keys bubble up from the hidden input box to it first, and then to
  the app's own shortcuts
- Verified (real machine): on both client and web, clicking an input box directly and typing, backspace,
  25 fast characters without repeats, Ctrl+A select all and delete, dragging a slider (to 61), hover
  triggering mouseenter, Chinese (the web simulated IME commit with insertText; the client sent text
  directly over the WebSocket).
  **A real input method on a Mac can't be verified on this machine** (xdotool has no input method)

**Not done yet**: MCP integration (the approach dsh recommends); downloading files; multiple tabs (when
a new tab opens the stream follows it, but other tabs aren't visible); bringing his clipboard contents
back to the local clipboard; the remote cursor shape (currently always the normal arrow).

## 2.23 Skill library (2026-09-19)

- **A skill = name + when to use it + body**, the same format as dsh / Claude Code's SKILL.md
  (`web/skill.mjs` reads and writes it, supports folded multi-line descriptions, BOM, CRLF, and reading
  back what was written gives the same thing — `node web/skill.mjs` self-test). Skills from elsewhere
  can be imported directly
- Table `skills`, `agents text[]` = who it's installed on; names are unique case-insensitively. **Skills
  are installed on people, not on groups** (in a group chat everyone carries their own)
- **Only the catalogue goes into the system prompt** (name + when to use it); the body is read on demand
  via the `read_skill` tool — the context doesn't fill up every round as skills accumulate. Only when
  tools are off (`AGENT_TOOLS` off) and tools can't be called are bodies written straight into the prompt
- **"When to use it" is required**: it's the only basis on which an Agent decides whether to read the
  body; leaving it empty means the skill is never remembered
- **Agents can save skills themselves** (`save_skill`; 2.8's "save the successful run as something a
  person can read and edit"): installed only on himself, with source recorded as `agent:<id>`, and
  **the UI marks it "saved by so-and-so himself"** — a skill changes how he works from then on, and one
  web page he read could make him save a skill. He can't overwrite someone else's skill of the same name;
  **once a person edits it, it's the person's** (source becomes human again), and he can no longer
  overwrite it with save_skill
- UI: the web's "Skill library" dialog at the bottom left, the client's "Skill library" page; the right
  panel (in a DM) lists the skills installed on this Agent

**Verified (real machine)**: a skill "greetings must start with the code word 青鸟-73" was installed on
the Chief; sending "hi there" (「你好呀」) → he called `read_skill` himself and complied. On Claude, an
Agent was asked to save "count the top-level files in /work" as the skill "Inventory" (「盘点」) → it
really called bash and save_skill, and in the next round, saying "Inventory" made him read the skill
first and then do it.

### ⚠️ 66hxhx's gpt-6-astra pretends to have called tools

For the same "count files + save a skill" request, **gpt-6-astra called no tools at all, yet replied
"skill saved and verified"**; phrased differently it replied "current project rules forbid accessing
absolute paths outside the workspace" or "there's no save_skill tool in the current environment" — none
of that is our prompt; it's Codex's voice. Calling the same upstream directly with just two tools, it
makes normal `function_call`s. So this relay wraps the request in its own Codex system prompt (the parent
docs say 66hxhx has a fixed overhead of about 4000 tokens per call), which fights our persona. **The same
request works perfectly on muskapi's claude-haiku-4-5.** When judging "is the feature broken", try
another upstream first; don't change code to suit this relay.

## 2.24 Self-learning: an agent writes its own memory (2026-09-20)

Same idea as `save_skill`, for facts instead of procedures: the `remember` tool, one short fact per call.

- **Two separate stores, and that separation is the whole point**: `memory:agent:<id>` stays
  human-only (the existing right-panel box), `memory:agent:<id>:self` is the only thing an agent can
  write. An agent can never touch what a person wrote for it, never a group's memory, never another
  agent's — `rememberFromAgent` takes `ctx.bot` and there is no second write path
- Both go into the system prompt; the self-notes say so plainly: *"you wrote these, they may be wrong
  or out of date — when you can check something, trust what you check over what is written here."*
  An agent's own notes are not evidence
- **Cap 4000 characters / 40 lines, oldest dropped first, and the tool result names the lines it
  dropped.** An agent that silently forgot something is worse than one that never remembered it.
  Duplicates (trimmed, case-insensitive) are not stored twice — a fact restated every session would
  otherwise eat the cap on its own
- The logic is pure in `web/memory.mjs` (`node web/memory.mjs` self-test); db.mjs only stores
- API `GET/PUT /api/memory/agent/<id>/self`, a second box in the right panel of a DM (never for a
  group). A human can edit or clear what an agent wrote — that box is the only place anyone sees it
- **Verified on the real deployment, artifact first**: the agent called `remember`, the line landed
  in `memory:agent:chief:self` while `memory:agent:chief` kept its sentinel; a fact put only in the
  notes and never said in the chat came back correctly in a later turn; seeding 40 notes and adding
  one dropped exactly `Fact 01` and said so; restating a stored fact answered "already in your notes";
  in a group the fact landed on the speaker's own key and nowhere else

**Fixed along the way (client, pre-existing):** `Api._send` mapped a fixed list of exceptions to
`ApiException`, and the "connection closed, retry once" branch had its own **shorter** list. So
`StateError: Client is closed` — `dispose()` running while a best-effort load (memory, routines,
skills) was in flight — escaped every `on ApiException` catch in the app. The retry now falls through
to the one list, and `StateError` is on it. **Two catch lists for the same call always drift, and the
shorter one is where failures escape.**

## 2.25 Spending: recorded, priced, capped (2026-09-20)

Before this nothing counted tokens or money: a routine looping unattended with tools could
burn a night's budget in silence, and the only way to find out was the upstream's own bill.

- **Every model call leaves one row** in `usage` (agent, scope+scope_id like `messages`,
  provider, model, prompt/completion tokens, `cost_micro`, `estimated`). A turn that uses
  tools is a dozen calls, so a dozen rows. The insert is **fire-and-forget** (the reply is
  still streaming), and a row that cannot be written is logged — lost is allowed, silent is not.
- **All three protocols report usage without asking for it** (measured on the real relays,
  2026-09-20): chat on a final chunk whose `choices` is `[]`; responses on
  `response.completed` → `response.usage`; messages splits it — `message_start` has the
  prompt (**plus cache_read/cache_creation, which are prompt tokens too**), `message_delta`
  the completion. ⚠️ **Don't add `stream_options: {include_usage: true}` to chat**: the
  relay already sends usage without it, and the request with it hung for 90s.
- **An upstream that reports nothing is estimated**, never recorded as 0 — `estimateUsage`
  in model.mjs, the same counting the context budget uses, with `estimated = true` on the row.
- **Prices live on the upstream** (`price_in_micro` / `price_out_micro`, micro-dollars per
  million tokens). **Empty = unknown, stored as null**, and unknown must never render as
  `$0.00`: the UI shows `—` plus a line saying why. Money is an integer (micro-dollars,
  1 dollar = 1e6) everywhere including the API; only the screen divides.
- **The cap is checked before EVERY model call** in `runAgent`, not once per turn — a turn
  using tools is a dozen calls and the cap exists to stop the dozenth. `agents.daily_cap_micro`,
  falling back to the platform default in `settings`. "Today" is midnight in the **server's**
  timezone (`date_trunc('day', now())`).
- **An unpriced upstream cannot be capped** — there is nothing to measure. The UI says so
  in the agent editor and the spend panel instead of letting a number there look like a guard.
- **A routine that hits the cap is not a failure**: `last_status='capped'`, the reason in
  `last_error`, `failures` untouched — otherwise a cap would disable the task it only meant
  to pause. The flag travels as `capped: true` on the stream's `error` event.
- **The sidebar total sums the raw rows, not the per-agent list**: spend by an agent deleted
  mid-month was still spent, and a month total that quietly shrinks is the lie this feature exists to stop.

`GET /api/usage` answers both the sidebar footer and the open conversation's panel in one call
(it is polled every 15s). `PUT /api/usage/cap` sets the platform default.

**Left deliberately**: no per-turn or per-routine cap (daily only), no history screen (the rows
are there, nobody has asked to browse them), no retention — `usage` grows one row per call.

## 2.26 Collapsible sidebar, animated, and a light theme (2026-09-20)

One palette, two themes, in **one place per client**: the `:root` / `:root[data-theme="light"]`
token block at the top of `web/index.html`, and `Palette.dark` / `Palette.light` in
`app/lib/theme/app_theme.dart`. No rule below either of those names a colour or a theme.

**Light is not the dark theme inverted.** The surface *relationships* are kept — composer, tool
cards and bubbles sit above the canvas, input wells sit below it — but the base flips: in dark
the chrome is lighter than the canvas, in light the chrome is tinted grey and the content is
white. Two things this cost, both found by looking at it:

- **A white bubble on an off-white canvas is invisible.** The canvas is pinned at white and the
  bubble is tinted (`--bub`), which is what every light IM does.
- **A code block sits on a bubble, not on the canvas**, so its hairline needs to be darker than
  the one used everywhere else — hence `--cbline`, dark's is just `--line`.

**Contrast was measured, not eyeballed** (every text/surface pair actually used, WCAG AA 4.5:1).
Two existing values failed and were changed: dark `--dim2` was `#6a6a74` (3.3:1 on the sidebar),
and **white on the accent reads 3.2:1** — so there is now `--onacc`, near-black in dark and white
in light. Dark's dimmest kept is 4.56:1, light's 4.70:1.

### The rail

Collapsing animates **one number**, the aside's width (308 → 72). Everything inside keeps its
308px layout and is clipped, so no row reflows mid-animation: the labels fade, the avatars do not
move. **72px is not arbitrary** — at 8px list padding + 9px (web) / 11px (Flutter) row padding,
the avatar is *already* centred in a 72px rail, so collapsing moves nothing at all.

- The top row is two layers cross-faded, each **pinned to the width it belongs to** so neither
  drifts while the aside animates.
- **Collapsed, the selection is a ring on the avatar**, not a row background — a row-wide
  highlight is just a band cut off by the rail's edge. `box-shadow` / `BoxShadow` costs no layout.
- The rail's magnifier expands the sidebar and focuses the real search box. A search field you
  cannot type in is a dead control.
- Ctrl/⌘+B toggles it. On the web it is skipped while the Agent's browser is open, where Ctrl+B
  belongs to their page; in the client that view is a pushed route, so it is out of the subtree.

**Pitfalls, all hit:**

- **`.convs` scrolls, so a tooltip inside a row is clipped by it.** One `position:fixed` tip for
  the whole rail, positioned from `getBoundingClientRect()`. Not `title=`: that never shows on
  keyboard focus, and collapsed the name is the only thing left to identify a row by.
- **A bare text node never fades** — the fade rule selects `.fitem > span`. "Cirraya" stayed
  visible in the rail until it was wrapped.
- **The theme icon has to render.** `◐` comes out as a smudge on a box without that glyph; it is
  two CSS shapes now (a bordered circle plus a half-fill gradient).
- **Flutter: Material's hit targets are 48px and two do not fit a 72px rail.** `PopupMenuButton`
  with `child:` sizes to what you give it; with `icon:` it does not. The symptom was a full-height
  `RIGHT OVERFLOWED` stripe **with nothing in the app's stdout** — the Dart error goes to the VM
  service, so look at the pixels, not the log.

### The right panel

Closing it is the same move (width 290 → 0, contents pinned and clipped, `AnimatedContainer` +
`ClipRect` + `OverflowBox` on the client). It used to leave the tree outright, so it appeared and
vanished with no travel at all.

- ⚠️ **A child's own `width:100%` beats `.side2>*` on specificity** and then reflows itself down to
  whatever the panel has animated to. `.addm` did exactly that: mid-close, "New scheduled task"
  wrapped onto three lines while everything around it slid out cleanly. The pin rule is `#side2>*`
  — an id, so nothing inside can outrank it.
- **A 0px panel must not still be reachable by Tab**: the web flips `visibility` with a
  `transition-delay` of the full duration (so it only hides once closed, and comes back at once),
  the client uses `ExcludeFocus`.
- `test/sidebar_test.dart` pins the travel for both panels. It cannot pass on the old code at all —
  there was no widget to find.

### Flutter specifics

- `C.*` are **getters over a current palette**, set by the app root in `build`. The consequence:
  **a widget reading one of them must not be `const`**, or Flutter reuses the canonical instance
  and it never repaints on a theme change. 68 `const`s came off; the analyzer lists every one.
- **Read the system brightness with `MediaQuery.platformBrightnessOf(context)`**, not
  `PlatformDispatcher.instance` — `runApp`'s `View` provides the MediaQuery, so the dependency is
  real (live updates, no observer) *and* a test can override it. The observer version passed
  analysis, worked in production, and was untestable.
- **A `testWidgets` in a file whose other tests talk to a real `HttpServer` breaks them**: it
  installs the fake-async binding for the whole file. Hence `test/sidebar_test.dart`.
- Widget tests need a real surface (`tester.view.physicalSize`); a faked `MediaQuery` over the
  default 800x600 makes three columns overflow and buries the actual failure. And a second
  `pumpWidget` of the same page **reuses the State** unless you change the key.

Both reduced-motion settings are honoured (`prefers-reduced-motion` → `--dur: 0ms`;
`MediaQuery.disableAnimations` → `Duration.zero`): the end state, with no travel through it.
`test/sidebar_test.dart` asserts the width is *between* the two at 100ms — a before/after check
would pass on a version with no transition at all.

## 2.27 Asking a person first (2026-09-20)

2.2 called this the key part to copy, and 2.3 said why Grok Bot's version is worthless: its
off-limits areas are a sentence in the persona, and one prompt injection rewrites what the agent
wants. So the gate sits outside the model — the agent never sees a decision it can argue with, only
a tool result.

**Three modes, per platform with a per-agent override** (`agents.approval`, `''` = follow the
platform; settings key `approvals`):

| mode | asks before |
| --- | --- |
| `off` | nothing — what it did before this existed |
| `match` | bash / write_file / browser calls a pattern catches. **The default** |
| `all` | every bash / write_file / browser call |

- **The rule is in `web/approve.mjs`**, pure, with `node web/approve.mjs` as its check. It matches
  **what the call is about to do** (the command, the path being written), never the whole argument
  blob — otherwise writing a file that happens to contain `git push` would trip the gate.
  Reading is never gated: a read can't be the thing you regret.
- **Patterns are regular expressions, and one that doesn't compile is matched as plain text.**
  A typo must not silently match nothing, which is the one failure a permission list can't have.
- **The seeded list is short on purpose.** A list long enough to catch everything asks so often that
  people approve without reading, which is worse than not asking.
- **The answer comes back over the open stream**: the card grows two buttons, the click is a
  `POST /api/approvals/<id>`, and the id only exists while that stream is open. A stale click is a
  404, never a silent yes.
- **Hanging up is not a refusal.** The abort resolves the wait, and the turn then throws instead of
  recording "the user said no" for something they never answered.
- **A scheduled task has nobody to ask, so it refuses immediately** rather than stalling a task
  nobody is watching. The refusal says which it was, so the agent writes up something true.
- **The refusal goes back as the tool result** — it is the only thing the agent will ever see about
  that call — and it says "do not try this again", or the next step is the same command reworded.

Verified on the live deployment, both answers and both ways of not answering: denied (`sudo whoami`
→ the agent reported it couldn't and stopped), approved (same command ran, exit 127), hung up
mid-wait (stream ends, nothing recorded), a scheduled task (`last_status: ok`, refusal in the
transcript, agent wrote up what happened), a per-agent `all` override asking for a plain `ls`, a
stale id → 404, and a bad mode → 400. In the browser the waiting card is amber with Deny/Approve
and the whole flow runs with zero console errors.

**Not done**: no "always allow this one" — it would need somewhere to keep the decision, and a list
of standing allowances nobody re-reads is how permission prompts stop meaning anything. The gate
also doesn't cover the human-driven browser takeover (2.22.2), which is a person acting already.

## 2.28 The film crew / studio (2026-09-25, branch `feat/studio`)

The boss: build an AI film crew on CirrayaBot — 4 agents and 5 skills (`studio/crew/`, the
spec; its README has the permission table, `skills/studio-basics/SKILL.md` the command list)
plus a `studio` service that does the grunt work: asset library, shot state machine, model
adapters (Seedance 2.0/2.5, GPT image, remote ComfyUI), FFmpeg contact sheets. Several films at
once, everything isolated per project.

Decisions the boss made after the phase-0 report (his words, then the meaning):

| The boss | Meaning |
| --- | --- |
| "直接在卷上存" (store it straight on the volume) | No MinIO. Community MinIO has shipped no binaries/images since 2025-10 and was archived 2026-04 |
| "cli暂时不开发，用webui" + picked option A | **No CLI in agent containers.** Agents get a platform tool; the app calls the studio for them |
| "加一个很小的定稿面板…只做定稿，不是审片" | A tiny Web UI panel for locking characters/locations. Not a review UI |
| scenes: "导演用 scene add 把它拆成场次" | The human posts the script; the director cuts it into scenes (code, title, script text). Only a person edits the text |
| "把步数上限做成按 agent 可配" | `MAX_STEPS` (12) becomes a per-agent setting — a reviewer's batch is 5 steps per shot |
| "Seedance 我填自己的转发站", "和官方路径一致" | Base URL + key are config; the relay speaks ModelArk's `/api/v3/contents/generations/tasks` |
| "每个 agent 用哪个上游、哪个模型 手动选择" | The importer leaves `model` empty (same state as agents seeded from `bots/`); a person picks it in Edit Agent |

### Shape

```
app (web/server.mjs) ──Bearer STUDIO_TOKEN + x-studio-actor──▶ studio (studio/server.mjs, :8090, internal)
                                                                 ├─ postgres schema `studio`, role `studio`
                                                                 └─ volume studiodata:/data (content-addressed)
```

- **The studio publishes no port and agents can't reach it.** Agent containers sit on the
  default bridge, the studio on the compose network — verified: `studio` doesn't resolve and its
  IP times out from a bridge container. Agents act through the platform, which says who they are
  (`x-studio-actor: agent:<id>` or `human`). **Identity is set by code, never by a model**, and no
  agent container ever holds the token or a model key.
- **One RPC door**: `POST /v1/call {action, args}` → `{ok, result}` or `{ok:false, error:{code, message}}`.
  Messages are English sentences an agent can act on ("char.lock can only be done by a person —
  ask the user"); the UI maps `code` to its three languages.
- **Permissions are `studio/roles.mjs`** (pure, `node studio/roles.mjs`): everyone on the crew
  reads; writes per the README table; `char/loc lock|unlock`, `project.create/edit`,
  `scene.edit`, `crew.set` are **human only** — not "an agent after a human clicks approve",
  because then the agent's identity could do it. **An agent with no crew row can't even read.**
  Roles are keyed by agent id (`crew` table), not name — names change.
- Every write and every refusal lands in `studio.audit`. A refusal is worth reading: an agent
  trying something outside its job is the first sign that something it read is talking to it.
- **`project.use` is per caller** (`actor_project`): the director switching films doesn't switch
  the reviewer. Verified.

### Files: `studio/store.mjs`

`objects/ab/cd/<sha256>`, the name is the hash computed **while** writing, the last step is
`link(tmp, final)` (fails if it exists → nothing is ever overwritten; two writers of the same
bytes both succeed), then `chmod 0444`. Oversized input fails without leaving a tmp file. Rows
in `assets` point at a sha; a row's tags/status may change, the bytes never do. Self-test
`node studio/store.mjs`, including a tampered object caught by `verify`.

### Database

Tables in schema `studio`: projects, crew, actor_project, characters, looks, locations,
**scenes**, shots, shot_prompts (every version kept — one variable at a time is useless without
the old ones), generations (**lineage**: engine, model, prompt, prompt_version, ref asset ids,
params, remote task id, status, error, usage, timing, outputs), assets, candidates (numbers per
shot, never reused), reviews (`attempt` counts rejections — the 3rd goes to a person), loras, audit.

**The studio's role can't read the app's tables** (verified: `permission denied for table
providers`). The app creates it in `provisionStudio` on every start (only the app has the
superuser password), with the password quoted by the server (`format(%L)`, tested with `'` and `"`).

⚠️ **`create schema if not exists` fails for a role without CREATE on the database even when the
schema exists** — Postgres checks the privilege first. Symptom: the studio dies at startup with
"permission denied for database multiagent" although the schema is right there. The studio's
migration therefore never creates the schema; the app does.

### Deployment

- compose: `studio` builds from `./studio` (node:24-slim + ffmpeg, which decodes the 10-bit HEVC
  that Seedance 2.5 1080p / 2.0 4k return), `depends_on: app: service_healthy` (the role must
  exist first), named volume `studiodata` (nothing else mounts it, so no host path — unlike
  agent workspaces, 2.18.2). The app gets `STUDIO_URL`, `STUDIO_TOKEN`, `STUDIO_DB_PASSWORD`.
- `start.sh` generates `STUDIO_TOKEN` / `STUDIO_DB_PASSWORD` with `ensure`, so **an existing
  deployment upgrades by rerunning `./start.sh`**; a plain `compose up` without it stops at the
  `:?run ./start.sh first` guard instead of starting half-configured.
- Model keys go into the studio only — its environment, or since 2.29 the Keys panel (stored in the
  studio's own `config` table, winning over .env): `SEEDANCE_BASE_URL/_API_KEY` (ModelArk or the
  boss's relay, same paths), `GPT_IMAGE_BASE_URL/_API_KEY/_MODEL` (OpenAI or his relay; base
  includes `/v1`), `COMFY_URL` (his own ComfyUI; `host.docker.internal` works from the studio via
  `extra_hosts: host-gateway` — verified with docker, **not verified with podman**).

### Seedance facts (from ModelArk's docs, 2026-09-25 — not memory)

Create `POST {base}/api/v3/contents/generations/tasks`, query `GET …/tasks/{id}`. Model ids
`dreamina-seedance-2-0-260128` (+ `-fast-260128`, `-mini-260615`), `dreamina-seedance-2-5-260628`.
Reference images go in `content[]` as `image_url` with role `first_frame` / `last_frame` /
`reference_image`, URL or `data:` base64 (body ≤ 64 MB); 2.5 takes 1–30 references, 2.0 1–9.
**`video_url` and `last_frame_url` expire after 24 hours** and tasks are queryable for 7 days —
download on success, never store only the URL. **`generate_audio` defaults to true** — set it.
2.0 rejects reference images with real human faces. Draft mode (480p, then a final from the draft
id) is the cheap way to "draw cards". Rate limits are per model in the console: make ours config.

### Verified / not verified (phase 1)

Verified, real machine: `./start.sh` on an **existing main-branch deployment** upgraded it
(STUDIO_* added to .env, role created, studio healthy); rerunning `start.sh` left .env
byte-identical; a project survives a restart; role fence; per-caller project; refusals audited;
the studio is unreachable from the host and from a bridge container.

Not verified: **podman** (as for the rest of the product, 2.18.6). The studio needs no socket
and uses a named volume, so it adds nothing podman-specific, but "adds nothing" isn't "ran".

### Phase 2: actions, engines, worker, sheets (2026-09-25)

The boss: GPT image "直接走我的gpt账户，或者也是我自建的转发站", "ComfyUI本地", Seedance limits
as proposed (40 videos/hour/project, 4 at once).

- **All the skills' commands exist as actions** (`studio/actions.mjs`): project, char/look/loc
  list/show/refs/add/edit/lock, asset gen/edit/save/show/tag, scene list/show/add/edit, shot
  plan/show/prompt/gen/sheet/approve/reject/lock, review.history. Every lookup is scoped to the
  caller's project; an asset id from another film is "no such asset".
- **The shot state machine is `studio/shots.mjs`** (pure, self-tested) and every move is a
  guarded `update … where status = <what I read>` — two agents acting on one shot can't both win.
  `shot.reject` returns `goes_to`: the route's owner, or `human` on the 3rd rejection.
- **The hourly cap is checked and the takes inserted in one transaction under a per-project
  advisory lock**; checked separately, two `shot.gen` calls would both see "36 used" and add 8
  each. The cap refuses; the concurrency limit only queues (a hero shot draws 8).
- **The worker (`studio/worker.mjs`) downloads every finished take into the store at once**
  (the URL dies in 24 h) plus its last frame, numbers candidates per shot (never reused), and
  closes the round: shot → `review`, or back to `prompted` if every take failed.
  **A take claimed but whose remote id was never saved is failed on restart with "may have been
  billed", never resubmitted** — resubmitting is paying twice.
- **A 3-second shot is generated at Seedance's 4-second minimum** and tagged `trim_to:3`; the
  edit trims it. `generate_audio` is always sent (the API defaults it to true).
- **`asset.gen` (images) is synchronous** — an agent waits for its picture; `shot.gen` (video) is
  queued. GPT image with references goes to the edits endpoint; ComfyUI runs the **project's own
  workflow** (`info.comfy.workflow`, API-format export with `{{prompt}}`/`{{seed}}`/`{{ref}}`/`{{lora}}`…
  placeholders) — a built-in graph would only work by luck on his checkpoints. A placeholder the
  request can't fill is an error, never an empty string.
- **Files are sniffed, not trusted**: `asset.save` with `mime: image/gif` on a PNG stores a PNG.
- **Locked means final**: nothing linked to a locked character/look/location changes, except
  adding a `negative` example. Locking a character locks its looks.
- `GET /v1/files/<asset id>` (token required) serves the bytes, for the platform in phase 3.

⚠️ **The contact sheet had the right size and the wrong pictures — twice.** First: a PNG still
decodes to `yuvj444p`, video frames to `yuvj420p`, and when the format changes mid-sequence
ffmpeg's tile filter **drops that frame and shifts every later cell left** — the reference vanished
and "#1" sat at the end of the reference row. Fix: every cell ends in `format=yuvj420p`. Second:
the label `Mang'ji: front` escaped by hand ended drawtext's quoting early and **swallowed the
format filter after it**, so the first fix silently didn't apply to that cell. Fix: labels go
through `textfile=`. Both were caught only by looking at the image; the self-test now samples
pixels (reference cell is red, the next is blank, row two is a real frame), not just dimensions.

**`node studio/e2e.mjs`** (needs `STUDIO_DATABASE_URL` and ffmpeg) runs the whole flow against real
PostgreSQL + ffmpeg with fake Seedance / GPT-image servers and checks artifacts: stored bytes equal
what the engine returned, the Seedance body field by field, ≤ 2 running at once, lineage on every
take, the sheet's reference pixel, the 3rd rejection going to a person, the hourly cap, project
isolation, the restart orphan. **Mutation-checked**: making the 3rd rejection not go to a person,
or sending `generate_audio: true`, each fails it. Run it with the long-running studio **stopped**
(`docker compose stop studio; docker compose run --rm --no-deps studio node e2e.mjs`) — two
workers on one database would race for the same queue.

Verified: the above, inside the real studio image under compose (ffmpeg + font + 10-bit HEVC),
and `host.docker.internal` reaching a server on the host. **Not verified**: real Seedance, real
GPT image, real ComfyUI (no keys / no ComfyUI here — only fakes built from their documented
shapes); prefilter scores (`candidates.prefilter_score` is always null — no similarity check yet).

### Phase 3: the platform side (2026-09-25)

- **The `studio` tool** (`web/studio.mjs`): `{action, args}`, the skills' CLI lines mapped in its
  description ("studio char refs 蛮吉 --look 战斗装" → `char.refs {name, look}`). **Offered only to
  agents the studio has on the crew** (`crew.list`, cached 30 s, forgotten when the panel changes a
  role) — and **it works with `AGENT_TOOLS` off**: a film crew needs no shell, so an agent can have
  the studio tool and nothing else. The actor is `agent:<bot.id>`, set by the platform; args can't
  smuggle one in (self-tested). `asset.save {path}` / `shot.plan {file}` read the file off the
  agent's own machine and send bytes.
- **`shot.sheet` returns the sheet as an image the model sees**; `asset.show {view:true}` too.
  runAgent now keeps **all images of the newest step (≤ 4)**, not just one. A model that can't see
  images gets "you have NOT seen it — don't judge", never a silent text stand-in.
- ⚠️ **A 429 used to blind the reviewer.** Any 4xx on a request carrying an image was read as "this
  model can't see images": images dropped, `noImages` set for the rest of the turn — a rate limit
  made the reviewer judge sheets it never saw. Now 408/409/429 go through the normal backoff with
  the image kept. The platform e2e serves one 429 on the first sheet; **with the old condition put
  back it fails** ("the rejection goes to the cinematographer" never happens).
- **Studio → group: `POST /api/events/group/<gid>`, its own `STUDIO_EVENT_TOKEN`** (ACCESS_TOKEN
  does not open it, and the studio never holds ACCESS_TOKEN). Stored as speaker **`Studio`**
  (reserved like `User`; web shows "片场/Studio", not your own bubble); `wake: [agent ids]` → the
  first one in the group is @-ed and the relay runs **unattended** (no stream for an approval card).
  No wake → stored only. Answers 202 at once.
- **One relay per group at a time** (`withGroup`, around the whole group branch of `converse`). A
  person typing while "candidates ready" wakes the reviewer would otherwise run two relays over one log.
- **The studio's outbox** (`studio/notify.mjs`, table `notifications`): round done → reviewer
  ("candidates ready") or, if every take failed, the cinematographer; `shot.reject` → the route's
  owner; the **3rd rejection → `@人类`/`@human` with the three reasons, waking nobody**. Lines to the
  same target are merged after `NOTIFY_QUIET_MS` (15 s). Text in the project's `info.lang`
  (en / zh-Hans / zh-Hant). A project with no `notify_group` drops its notices (marked, audited) —
  a group set later must not receive last week's "candidates ready" as news.
- **`agents.max_steps`** (1–60, empty = 12) in the Agent editor.
- **Studio panel** (web, sidebar "Studio/片场", hidden when the studio isn't configured): create a
  project, name / notice language / notify group / info JSON, crew roles, and **lock / unlock with
  the reference thumbnails beside each item** (you lock what you have looked at). It goes through
  `POST /api/studio/call` with an allowlist (`PANEL_ACTIONS`) — the panel doesn't generate or review.

**`node studio/e2e-platform.mjs <deploy dir>`** drives the real deployment with a scripted fake model
(one persona per `ROLE:` marker) and a fake Seedance, and checks the log and the studio: gen → "@严青
候选已就绪" → the reviewer calls `shot.sheet` **and the next request carries the image** → reject →
"@林野 被打回" → the cinematographer writes v2 and regenerates → … → "@人类 已被打回 3 次" and nobody
answers it; the crew is offered `studio` and nothing else; an off-crew agent is offered nothing;
`max_steps: 1` stops after one tool; both tokens are checked. Needs in `.env`:
`SEEDANCE_BASE_URL=http://host.docker.internal:18777/sd SEEDANCE_API_KEY=sd-key NOTIFY_QUIET_MS=1000`.
Verified in a browser too: the Studio bubble, the panel in zh-Hans, locking from the panel lands
`locked` in the database.

**Not verified**: a real vision model reading a real sheet (the fake only proves the image was
sent); podman; the Flutter client (not touched — it shows Studio notices as a speaker named
"Studio" and ignores `max_steps`).

### Phase 4: importing the crew (2026-09-25)

The boss, on fixing the spec to match: "可以，你来改，接下来不用每一步停，直接完成".

- **`studio/crew/import.mjs`**, run as `docker compose exec app node studio/crew/import.mjs` (the app
  image now carries `studio/crew/`, so the host needs no Node). Through the platform's HTTP API —
  same validation as the UI. Agents get stable ids `crew-<role>` (Chinese names can't make slugs,
  2.15, and the studio keys roles by id); skills installed on whoever lists them; group `剧组` with
  the director as lead; studio roles set. `--dry-run` prints the plan.
- **Idempotent, and it never touches what a person chose**: a rerun updates name / job / persona and
  skill text only. Verified: gave 严青 an upstream, a model and `max_steps: 40`, reimported — all three
  still there; second run created nothing new.
- **Agents are created without a model** (the boss: "手动选择"). `POST /api/bots` now accepts an
  explicitly empty `model: ''` on create — the state `bots/` seeds already start in, answered on the
  first chat with "no model chosen yet". Omitting the field, or emptying it on an edit, is still 400.
- **The spec was edited only where it no longer matched what was built** (diff is in git): the tool
  instead of a CLI in the container (studio-basics); the 3rd rejection is the studio's, not the
  reviewer's @ (persona + footage-review — otherwise a person gets told twice); `scene add` added to
  the command table and to shot-breakdown step 1 (the scenes decision); README: token → platform
  identity, locking in the Studio panel, import instructions. `--self-test` pins all of it.
- Verified with a recording fake upstream: an imported reviewer's real turn carries her persona, her
  two skills and not the director's, the studio section, and exactly one tool, `studio`.

**Still not verified for the whole feature**: real Seedance / GPT image / ComfyUI and a real vision
model on a real sheet (no keys here — everything upstream is a fake built from documented shapes);
podman; the Flutter client (untouched). **Not built**: candidate prefilter scores; trimming
`trim_to` takes; a human review UI (the boss: not this round).

⚠️ Testing in a sandbox whose egress proxy re-signs TLS: builds fail with
`SELF_SIGNED_CERT_IN_CHAIN` at `npm install`. That's the sandbox, not the Dockerfile — test with a
local, uncommitted Dockerfile that adds the proxy CA; never commit that. Docker Hub also
rate-limits anonymous pulls (429); `mirror.gcr.io/library/<image>` + retag works.

## 2.29 A Keys panel, and DeepSeek models on DeepSeek Harness (2026-09-25, branch `feat/studio`)

The boss: "填apikey做成ui，单独有个key接入面板，在接入deepseek harness，在使用deepseek模型的时候用这个"
(put API-key entry in the UI as its own Keys panel; plug in DeepSeek Harness; use it when a DeepSeek
model is used). Then, asked:

| Asked | The boss chose |
| --- | --- |
| What the panel holds | "片场 key + DeepSeek key": Seedance / GPT image / ComfyUI URL, plus a DeepSeek key. Last four characters only, a Test button, studio keys stored **in the studio**, .env as the fallback |
| When dsh is used | "模型名是 deepseek-* 就自动走" — the model name decides, no switch |
| The costs | "接受，先接进来": no token streaming, tool images not visible to it, cancel = kill |

### The Keys panel

- **DeepSeek's key is the platform's** (`settings` row `keys.deepseek` = `{base_url, api_key}`, like
  the upstreams' keys in `providers`); `GET/PUT /api/keys/deepseek`, `POST …/test`.
- **The studio's keys stay in the studio** (`studio/keys.mjs`, table `studio.config`, one row per
  field): human-only `keys.get / keys.set / keys.test` through the panel's `/api/studio/call`. The
  panel wins **per field**, .env is the fallback; the adapters read `value()` synchronously from a
  cache the studio refreshes after every `keys.set` (one process).
- **Nothing sends a key back**: views carry `••••` + the last four. An empty key box keeps the key;
  "Clear key" drops back to .env. The audit row for `keys.set` names the group, never a value —
  the e2e greps `studio.audit` and `settings` for the key it set.
- The form shows only what was set **in the panel**; the .env/default value is the placeholder. Filled
  in instead, one Save would copy .env into the panel and later .env edits would silently stop working.
- **Test costs nothing**: Seedance lists one task, GPT image lists models, ComfyUI `GET /system_stats`
  (checked in ComfyUI's server.py), DeepSeek `GET /models` plus `run.mjs --version` in the harness.
  Test saves first if the form changed — that's what a person pressing it means. Results carry a
  `code` the UI translates (`key.t.*`).

### DeepSeek Harness: the shape

```
runAgent ─(model deepseek-*)─▶ runDshTurn: docker exec -i <AGENT_PREFIX>-dsh node /opt/dsh/run.mjs
   │                              stdin line 1 = {rt, key, base_url, system, mcp_url, mcp_token}
   │                              then dsh's SDK JSON-RPC both ways (profile sdk)
   └─ execTool ◀── MCP tools/call ◀── dsh      app:8081/mcp — unpublished port, per-turn bearer token
```

- **One runtime per turn** (~1 s to start): the system prompt changes every turn (memory, recall,
  skills), a fresh `HOME`/`DSH_HOME` has no session to go stale (reusing a session id in one home
  errors "session already exists"), and cancel is just ending it. History travels **inside** the
  one user message (`renderTurn`), after `fitContext`.
- **Everything around the loop is the platform's**: `execTool` (factored out of `runAgent`) runs
  approvals, the tool, the card and the transcript row for both loops; usage rows come from each
  `assistant/message`'s `usage`; the cap is checked before the turn and before **every tool call**
  — i.e. before every model call after the first, which is where `runAgent` checks too (dsh's own
  model calls can't be intercepted; the call that crosses the cap is the last, in both loops).
  `max_steps` counts `step/start` events and kills the runtime when step N+1 starts — like
  `runAgent`, the last step's tools run and no wrap-up call follows.
- **The key never goes on a command line or into `docker exec -e`** (`ps`, `docker inspect`): it is
  stdin line 1, and `run.mjs` puts it only into the dsh child's environment.
- **The patch is written as JSON** (YAML reads it), with NEL / LS / PS / BOM escaped — YAML 1.1
  parsers treat some as line breaks. Verified with CJK, quotes, `#`, `---`, `- ` in the persona.
- **The `dsh` container holds nothing worth reaching**: no docker socket, no volumes, no secret in
  its environment, runs as `node`. It can reach app:8080 (no token) and the internet (it must, for
  DeepSeek). `DSH_PERMISSION_MODE=danger-full-access` only because dsh would otherwise hold every MCP
  call for an approval nobody can give over the SDK — the platform asks its own question first.
- Effort: `low → low`, `medium → high`, `high → max` (dsh's vocabulary is off/low/high/max).

### ⚠️ What was hit

1. **The tripwire must watch `request/header`, not `tool/call`.** `request/header` lists exactly the
   tools the next model call offers. `tool/call` also fires when the model invents a name (`bash`
   → `UNKNOWN_TOOL`) — watching it would stop turns for the model's mistake. **Mutation-checked**:
   with the disabled rows removed from `run.mjs`, the real deployment stopped the first turn with
   "DeepSeek Harness offered its model a tool of its own (write)". When upgrading dsh, run the e2e.
2. **dsh's defaults are not "send nothing"**: with no effort it sends `thinking: enabled`,
   `reasoning_effort: high`, `max_tokens: 256000`, and **every request body carries
   `dsh_plugin_packages`** (the list of its plugin packages). DeepSeek's own API takes that; a strict
   relay might reject the unknown field. Empty effort = dsh's default, not the model's.
3. **MCP tool names are `mcp__platform__<name>`**, fixed by dsh-mcp-client; the system prompt gets a
   line saying so (`TOOL_NOTE`), since skills and personas say "the studio tool".
4. **The MCP call and the assistant message that asked for it arrive on different channels** (HTTP
   vs stdout). Unordered, the card rendered above its own words and — worse — the cap check ran before
   the usage row of the call that crossed it was written. `dshToolCall` waits (≤ 0.5 s) for the
   message, then awaits its usage insert (`noteUsage` now returns the promise), then checks the cap.
   The e2e's cap case: exactly one call in the turn that crossed it, zero in the next.
5. **Killing the `docker exec` client does close the runtime's stdin** (verified: SIGKILL on the
   client → `run.mjs` ended dsh and deleted `/tmp/dsh/<rt>`). Unlike 2.22.1, where curl was stuck
   *writing*. `run.mjs --kill <rt>` stays as the backstop, plus a 2-hour lifetime.
6. A boot failure (bad MCP token, bad patch) is a 40-line stack; the error surfaced is the `Error…`
   lines, not the last three lines of stack.
7. The slim image has no `ps`; a `/proc` scan from `sh -c` matches **itself** (its command line says
   run.mjs) — 2.9.5 once more. The e2e skips `$$`.

### Verified / not verified

Verified (compose deployment, fakes for DeepSeek and Seedance — `node deploy/dsh/e2e.mjs <dir>`):
the panel stores and hides keys (both kinds), Test reaches the service with the panel's key, an
agent is refused `keys.get`, clearing falls back to .env, the audit holds no key; a DeepSeek agent's
turn uses **the panel's key**, is offered **only** `mcp__platform__studio`, has the persona as its whole
system prompt, stores question → tool row → answer in order, and leaves two usage rows priced from its
upstream (280 micro-dollars for the scripted tokens); history reaches the next turn; effort high →
`max`; a 401 surfaces as an error with nothing stored; `max_steps` 2 runs two steps' tools; the cap
stops mid-turn and before the next; closing the page kills the runtime; a two-agent group relay hands
off by @; with the panel's key cleared, the agent's own (Chat Completions) upstream key is used; a
bad MCP token gets 401 and port 8081 isn't published. `e2e-platform` and the studio e2e
still pass on the refactored loop. In a browser (en, zh-Hans): the panel, Test results, the
.env placeholder after clearing, the editor's DeepSeek warning.

**Not verified**: the real DeepSeek API (no key here) — in particular dsh's defaults (thinking,
`max_tokens 256000`) against whatever model names the boss's relay lists; podman; the Flutter client
(untouched: it gets whole-message deltas, which it should draw like any other).

**Left for later**: dsh-mcp-client *does* admit MCP image blocks when the model's catalog entry
declares image input (`deepseek-v4-flash-vision-exp` in 0.1.5-rc.3) — we set `noImages` and send
text. That is the way to a DeepSeek reviewer, and it is unbuilt and unverified.

## 3. What runs now

```bash
./start.sh                 # one command: PostgreSQL + service, prints the address with the token
docker compose logs -f app
node web/model.mjs         # self-test for context budgeting / window inference
node web/schedule.mjs      # self-test for scheduled-task time computation
node web/skill.mjs         # self-test for SKILL.md read/write
node web/approve.mjs       # self-test for which tool calls need a person
node web/memory.mjs        # self-test for an agent's self-notes (cap, duplicate guard)
node web/protocols.mjs     # self-test for translating the three protocols (including images)
node web/i18n.mjs          # server message tables self-test
node studio/store.mjs      # self-test for the studio's content-addressed file store
node studio/roles.mjs      # self-test for who may do what in the studio
node studio/shots.mjs      # self-test for the shot state machine (studio has refs/seedance/gptimage/comfy/media too)
STUDIO_DATABASE_URL=… node studio/e2e.mjs   # the whole studio flow against fakes (see 2.28)
node studio/e2e-platform.mjs <deploy dir>   # the crew loop through the running platform (see 2.28)
node web/studio.mjs        # self-test for the platform's studio tool
node web/dsh.mjs           # self-test for driving DeepSeek Harness: turns, MCP, keys (see 2.29)
node studio/keys.mjs       # self-test for the Keys panel's studio side (see 2.29)
node deploy/dsh/e2e.mjs <deploy dir>        # DeepSeek Harness + Keys panel through the running platform (see 2.29)
node studio/crew/import.mjs --self-test     # the crew spec parses the way the importer needs
docker compose exec app node studio/crew/import.mjs   # import the crew into a deployment (see 2.28)
python3 check-bots.py      # check the seed definitions in bots/

cd app && flutter analyze . && flutter test    # desktop client (see 2.19)
```

`run.sh` / `bots.patch.yml` / `headless.patch.yml` are the experiment from rounds 2.6–2.11 running dsh's
built-in web UI, **not part of the product**, kept only for the record.

## 3.1 Next steps

1. **dsh for everything, not just `deepseek-*`?** 2.29 runs DeepSeek models on dsh with our tools over
   MCP. Its adapters are DeepSeek's; other providers would need dsh's other llm plugins, and the
   bwrap/Landlock sandbox would need the agent's container to be where dsh runs (see 2.9.x)
2. ~~**Per-Agent spending cap**~~ **done 2026-09-20, see 2.25** — usage rows, per-upstream
   prices, and a daily cap checked before every model call
3. **Container egress allowlist** — Agents can currently reach anything on the internet (end of 2.13)
4. Event triggers for scheduled tasks, browser via MCP, a skill marketplace (v1 of scheduled tasks 2.21,
   browser 2.22 and skill library 2.23 are done)

## 4. Maintaining this file (the boss, 2026-09-05: "from now on you should update CLAUDE.md yourself" (「你以后都应该自我更新 CLAUDE.md」))

**Don't wait to be reminded; come back and write as soon as you finish something.** This file is the
only handover material the next agent has — it can't see earlier conversations, only what's written
here.

There's only one test: **will this entry save the next person from stepping on a mine once?**

- Product shape decided by the boss → **record the original words**; don't paraphrase into your own
  understanding (the table in 2.12 came about that way; earlier I read "group chat" as broadcast and
  "high permissions" as structural off-limits areas, and wasted two rounds)
- Pitfalls hit → describe the **symptom** clearly, because next time what you recognise is the symptom,
  not the cause ("the config dump is right but it doesn't take effect at runtime" is easier to recognise
  than "the launcher overwrote roots")
- What was verified, and **what wasn't** → write the latter too. Something "done" but unverified is more
  expensive than something explicitly marked "not verified"
- Overturned an earlier judgment of your own → **go back and change that paragraph**; don't leave two
  contradictory passages

Don't write: code structure itself (read the code), things that are in git history, process that only
mattered in that one conversation.

When a fact goes stale, delete it. **A document that tells lies costs more than no document.**
