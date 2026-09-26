// What an agent's container is allowed to see and do. Pure: the arguments and scripts are
// built here, server.mjs runs them. `node web/sandbox.mjs` is the self-test.
//
// The boundary, in one place:
//   /work             ← workspace/agents/<id>      its own desk
//   /groups/<gid>     ← workspace/groups/<gid>     ONE mount per group it belongs to — a group it
//                                                  isn't in does not exist inside its container
//   network           ← a bridge of our own with inter-container traffic off, so agents can't reach
//                       each other (the host and the internet still can be reached)
//   privileges        ← root inside, but with a short capability list and no-new-privileges
//
// A group marked shared_machine (weak isolation, CLAUDE.md 2.31) gets ONE machine for its members:
// its /work is that group's drive, and it mounts no other group — the same rules, a different desk.
//
// Mounting the whole workspace/groups directory (what this replaced) let every agent read,
// change and delete every group's files, including groups it had been removed from.
import { join } from 'node:path'

// Bump when the rules below change: containers made under older rules are recreated on their next turn.
export const SANDBOX_VERSION = '2'

// What apt, dpkg, a dev server on :80 and the rest of an ordinary root shell need. Not NET_RAW
// (raw packets: ARP spoofing on the bridge), not MKNOD, not AUDIT_WRITE, not SYS_CHROOT.
export const CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETUID', 'SETGID', 'NET_BIND_SERVICE']

/** The groups an agent belongs to, as a stable label value. */
export const groupsLabel = ids => [...new Set(ids)].sort().join(',')

/**
 * `docker run` arguments for one agent's container — or, with `desk` = 'groups/<gid>' and no
 * groups, for a shared group machine whose desk is the group's drive.
 */
export function runArgs({ name, image, hostWork, botId, groups, network, memory = '2g', cpus = '2', desk = join('agents', botId) }) {
  const mounts = [...new Set(groups)].sort().flatMap(g => ['-v', `${join(hostWork, 'groups', g)}:/groups/${g}`])
  return ['run', '-d', '--name', name,
    '--label', `ma.sandbox=${SANDBOX_VERSION}`,
    '--label', `ma.groups=${groupsLabel(groups)}`,
    '--network', network,
    '--cap-drop', 'ALL', ...CAPS.flatMap(c => ['--cap-add', c]),
    '--security-opt', 'no-new-privileges',
    '--memory', memory, '--cpus', cpus, '--pids-limit', '512',
    '-v', `${join(hostWork, desk)}:/work`,
    ...mounts,
    '-w', '/work', image, 'sleep', 'infinity']
}

// One line from `docker inspect -f INSPECT_FORMAT`. Fields separated by '|'; a missing label
// comes back as '' or '<no value>' depending on the engine.
export const INSPECT_FORMAT = '{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels "ma.sandbox"}}|' +
  '{{index .Config.Labels "ma.groups"}}|{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}'

/** Read an inspect line and decide: reuse the container, start it, or throw it away and make a new one. */
export function decide(line, want) {
  const clean = v => (v === '<no value>' ? '' : v ?? '')
  const [running, image, version, groups, work] = String(line ?? '').trim().split('|').map(clean)
  if (!running) return { action: 'create' }                      // no container at all
  const why = work !== want.work ? `mounted on ${work || '(nothing)'}, wanted ${want.work}`
    : image !== want.image ? `on image ${image}, wanted ${want.image}`
    : version !== SANDBOX_VERSION ? `made under sandbox rules v${version || 1}, now v${SANDBOX_VERSION}`
    : groups !== want.groups ? `sees groups [${groups}], should see [${want.groups}]`
    : ''
  if (why) return { action: 'recreate', why }
  return { action: running === 'true' ? 'reuse' : 'start' }
}

// read_file / write_file resolve the path inside the container first. A name inside a group drive
// must stay inside /groups once symlinks are followed: every container calls its own desk /work,
// so a link planted in a shared drive ("report.md -> /work/.ssh/id_ed25519") would otherwise make
// the reader open or overwrite ITS OWN file. The bash tool is not guarded; this is for the file tools.
export const PATH_GUARD =
  'l=$(realpath -m -s -- "$1") && p=$(realpath -m -- "$1") || exit 2\n' +
  'case "$l/" in /work/group/*|/groups/*) case "$p/" in /groups/*) ;; ' +
  '*) echo "refused: $1 is a link out of the group drive (to $p)" >&2; exit 3;; esac;; esac\n'

export const READ_SCRIPT = PATH_GUARD + 'exec cat -- "$p"'
export const WRITE_SCRIPT = PATH_GUARD + 'mkdir -p -- "$(dirname -- "$p")" && cat > "$p"'

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const args = runArgs({ name: 'ma-agent-x', image: 'img:2', hostWork: '/h/ws', botId: 'x',
    groups: ['g2', 'g1', 'g1'], network: 'ma-agents' })
  const vols = args.flatMap((v, i) => (args[i - 1] === '-v' ? [v] : []))
  a.deepEqual(vols, ['/h/ws/agents/x:/work', '/h/ws/groups/g1:/groups/g1', '/h/ws/groups/g2:/groups/g2'])
  a.ok(!vols.includes('/h/ws/groups:/groups'), 'the whole groups directory is never mounted')
  a.ok(args.includes('ma.groups=g1,g2'))
  a.equal(args[args.indexOf('--cap-drop') + 1], 'ALL')
  a.ok(!args.includes('NET_RAW'))
  a.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges')
  a.equal(args[args.indexOf('--network') + 1], 'ma-agents')
  a.ok(!runArgs({ name: 'n', image: 'i', hostWork: '/h', botId: 'x', groups: [], network: 'n' }).some(v => v.includes(':/groups')),
    'an agent in no group gets no group mount')

  // A shared group machine: the group's drive is its desk, and no other group is mounted
  const shared = runArgs({ name: 'ma-group-g1', image: 'img:2', hostWork: '/h/ws', groups: [], network: 'ma-agents', desk: 'groups/g1' })
  a.deepEqual(shared.flatMap((v, i) => (shared[i - 1] === '-v' ? [v] : [])), ['/h/ws/groups/g1:/work'])
  a.equal(shared[shared.indexOf('--cap-drop') + 1], 'ALL')
  a.equal(shared[shared.indexOf('--network') + 1], 'ma-agents')

  const want = { work: '/h/ws/agents/x', image: 'img:2', groups: 'g1,g2' }
  const ok = `true|img:2|${SANDBOX_VERSION}|g1,g2|/h/ws/agents/x`
  a.deepEqual(decide(ok, want), { action: 'reuse' })
  a.deepEqual(decide(ok.replace('true', 'false'), want), { action: 'start' })
  a.equal(decide('', want).action, 'create')
  a.equal(decide(`true|img:2|${SANDBOX_VERSION}|g1|/h/ws/agents/x`, want).action, 'recreate', 'removed from g2')
  a.equal(decide(`true|img:2|${SANDBOX_VERSION}|g1,g2,g3|/h/ws/agents/x`, want).action, 'recreate', 'added to g3')
  a.equal(decide('true|img:2|<no value>|<no value>|/h/ws/agents/x', want).action, 'recreate', 'an old container')
  a.equal(decide(`true|img:1|${SANDBOX_VERSION}|g1,g2|/h/ws/agents/x`, want).action, 'recreate')
  a.equal(decide(`true|img:2|${SANDBOX_VERSION}|g1,g2|/old/agents/x`, want).action, 'recreate')

  // The path guard, run for real against a fake container layout: /work and /groups become
  // directories under a temp root, and the paths the scripts see are rewritten onto it.
  const root = mkdtempSync(join(tmpdir(), 'sandbox-'))
  const W = join(root, 'work'), G = join(root, 'groups')
  mkdirSync(join(G, 'g1'), { recursive: true }); mkdirSync(W)
  writeFileSync(join(W, 'secret'), 'mine')
  writeFileSync(join(G, 'g1', 'plan.md'), 'plan')
  symlinkSync(join(G, 'g1'), join(W, 'group'))
  symlinkSync(join(W, 'secret'), join(G, 'g1', 'report.md'))       // planted by a group-mate
  mkdirSync(join(G, 'g1', 'sub')); symlinkSync(join(G, 'g1', 'plan.md'), join(G, 'g1', 'sub', 'alias'))
  const onRoot = s => s.replaceAll('/work', W).replaceAll('/groups', G)
  const run = (script, path, input) => spawnSync('bash', ['-c', onRoot(script), '_', path],
    { cwd: W, input: input ?? '', encoding: 'utf8' })

  a.equal(run(READ_SCRIPT, 'group/plan.md').stdout, 'plan')
  a.equal(run(READ_SCRIPT, 'group/sub/alias').stdout, 'plan', 'a link that stays inside the drive is fine')
  a.equal(run(READ_SCRIPT, 'secret').stdout, 'mine', 'its own desk is untouched')
  let r = run(READ_SCRIPT, 'group/report.md')
  a.equal(r.status, 3); a.match(r.stderr, /refused/); a.equal(r.stdout, '')
  r = run(READ_SCRIPT, join(G, 'g1', 'report.md'))
  a.equal(r.status, 3, 'the same link reached by its /groups path')
  r = run(WRITE_SCRIPT, 'group/report.md', 'overwritten')
  a.equal(r.status, 3); a.equal(readFileSync(join(W, 'secret'), 'utf8'), 'mine', 'the planted link did not overwrite the desk')
  a.equal(run(WRITE_SCRIPT, 'group/new/dir/out.txt', 'hello').status, 0)
  a.equal(readFileSync(join(G, 'g1', 'new', 'dir', 'out.txt'), 'utf8'), 'hello')
  a.equal(run(WRITE_SCRIPT, 'notes.txt', 'x').status, 0)
  rmSync(root, { recursive: true, force: true })
  console.log('sandbox.mjs self-test passed')
}
