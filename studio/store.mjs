// The studio's file store: plain files on a volume, addressed by their sha256.
//
// Why not MinIO: its community edition stopped shipping binaries and images in October 2025
// and the repository was archived in April 2026 — "one-command deploy" can't depend on an
// image nobody publishes. We don't need S3 anyway: one service reads and writes these files.
//
//   <root>/objects/ab/cd/abcd…(64 hex)   the bytes, never rewritten
//   <root>/tmp/                          half-written files; renamed into place when complete
//
// Immutability is enforced by how a file gets in, not by trusting callers:
//   - the name IS the hash of the content, computed while writing, so a file can't claim to
//     be something it isn't;
//   - the final step is link(tmp, final), which fails if the name exists — two writers of the
//     same bytes both succeed, and nothing ever overwrites an existing object;
//   - objects are chmod 0444.
// Same bytes = same object: re-saving an image is free, and lineage can point at it safely.
//
// Self-test: node studio/store.mjs
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, link, unlink, chmod, stat, rm, readFile, mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'

export const isSha = s => /^[0-9a-f]{64}$/.test(String(s ?? ''))

export function createStore(root) {
  const objPath = sha => {
    if (!isSha(sha)) throw new Error(`not a sha256: ${sha}`)
    return join(root, 'objects', sha.slice(0, 2), sha.slice(2, 4), sha)
  }

  /**
   * Store a stream (or Buffer). Returns {sha256, bytes, created}.
   * `created` = false when the same bytes were already there.
   * `maxBytes` stops a runaway download before it fills the volume.
   */
  async function put(input, { maxBytes = 2 * 1024 ** 3 } = {}) {
    await mkdir(join(root, 'tmp'), { recursive: true })
    const tmp = join(root, 'tmp', randomUUID())
    const hash = createHash('sha256')
    let bytes = 0
    const count = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length
        if (bytes > maxBytes) return cb(new Error(`file is larger than ${maxBytes} bytes`))
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    const src = Buffer.isBuffer(input) || input instanceof Uint8Array ? Readable.from([Buffer.from(input)]) : input
    try {
      await pipeline(src, count, createWriteStream(tmp, { flags: 'wx' }))
      const sha256 = hash.digest('hex')
      const final = objPath(sha256)
      await mkdir(dirname(final), { recursive: true })
      let created = true
      try { await link(tmp, final) }
      catch (e) { if (e.code !== 'EEXIST') throw e; created = false }
      if (created) await chmod(final, 0o444)
      return { sha256, bytes, created }
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  const has = sha => isSha(sha) ? stat(objPath(sha)).then(s => s.isFile(), () => false) : Promise.resolve(false)
  const open = sha => createReadStream(objPath(sha))
  const read = sha => readFile(objPath(sha))

  /** Re-hash an object. A mismatch means the disk (or someone with root) changed it. */
  async function verify(sha) {
    const h = createHash('sha256')
    await pipeline(open(sha), new Transform({ transform(c, _e, cb) { h.update(c); cb() } }))
    return h.digest('hex') === sha
  }

  return { root, put, has, open, read, verify, path: objPath }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const dir = await mkdtemp(join(tmpdir(), 'studio-store-'))
  const s = createStore(dir)
  try {
    const hello = Buffer.from('hello studio')
    const want = createHash('sha256').update(hello).digest('hex')

    const r1 = await s.put(hello)
    a.equal(r1.sha256, want, 'the name is the content hash')
    a.equal(r1.bytes, hello.length)
    a.equal(r1.created, true)
    a.equal(await s.has(want), true)
    a.deepEqual(await s.read(want), hello)

    // Same bytes again: no second copy, no rewrite, still fine for the caller.
    const r2 = await s.put(Readable.from([Buffer.from('hello '), Buffer.from('studio')]))
    a.equal(r2.sha256, want, 'streams hash the same as buffers')
    a.equal(r2.created, false, 'an existing object is never rewritten')

    // Objects are read-only on disk.
    a.equal((await stat(s.path(want))).mode & 0o777, 0o444)

    // A tampered object is caught by verify. (root can still write a 0444 file — that is
    // exactly the case verify exists for.)
    a.equal(await s.verify(want), true)
    await chmod(s.path(want), 0o644)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(s.path(want), 'tampered')
    a.equal(await s.verify(want), false)

    // Oversized input fails and leaves nothing behind — not in objects/, not in tmp/.
    await a.rejects(s.put(Buffer.alloc(2048), { maxBytes: 1024 }), /larger than/)
    const { readdir } = await import('node:fs/promises')
    a.deepEqual(await readdir(join(dir, 'tmp')), [], 'no half-written file left in tmp/')

    // Anything that isn't a sha256 is refused before it becomes a path.
    a.throws(() => s.path('../../etc/passwd'), /not a sha256/)
    a.equal(await s.has('x'.repeat(64)), false)

    console.log('store.mjs: all checks passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
