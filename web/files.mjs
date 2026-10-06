// Attachments: what a file is, what it may be served as, where an agent may send one from.
// Pure, so the rules can be checked without a server:   node web/files.mjs
//
// Both sides send files. The person attaches them to a message; the agent gets the images and the
// text itself in that turn, and every file also lands in its inbox (/work/inbox, or the group drive's
// inbox) for its tools. An agent sends one back with send_file, from its own /work or the drive of
// the group it is talking in. Everything is stored once by the server and previewed from there.

import { posix } from 'node:path'

export const MB = 1024 * 1024

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf',
  md: 'text/markdown', markdown: 'text/markdown',
  txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain', ini: 'text/plain',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  py: 'text/x-python', go: 'text/plain', rs: 'text/plain', java: 'text/plain', kt: 'text/plain',
  c: 'text/plain', h: 'text/plain', cpp: 'text/plain', cc: 'text/plain', hpp: 'text/plain', cs: 'text/plain',
  rb: 'text/plain', php: 'text/plain', swift: 'text/plain', dart: 'text/plain', sh: 'text/x-shellscript',
  sql: 'text/plain', diff: 'text/plain', patch: 'text/plain', env: 'text/plain', conf: 'text/plain',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const extOf = name => (/\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1] ?? '').toLowerCase()

/** The type to record. What the browser says wins unless it says nothing useful; the extension decides then. */
export function mimeOf(name, given = '') {
  const g = String(given ?? '').split(';')[0].trim().toLowerCase()
  if (g && g !== 'application/octet-stream' && /^[a-z]+\/[\w.+-]+$/.test(g)) return g
  return EXT_MIME[extOf(name)] ?? 'application/octet-stream'
}

const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
  'application/toml', 'application/x-sh'])

/** What a client draws: image / video / audio / pdf / markdown / text / other. */
export function kindOf(mime, name = '') {
  const m = String(mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'
  if (m === 'text/markdown' || ['md', 'markdown'].includes(extOf(name))) return 'markdown'
  if (m.startsWith('text/') || TEXT_MIMES.has(m)) return 'text'
  return 'other'
}

/**
 * What the bytes are served as when shown in place. Anything a browser would run — HTML, scripts,
 * XML — goes out as plain text: an agent can be talked into sending a page, and on our origin it
 * would hold the person's session. The response also carries a sandbox CSP (servedHeaders).
 */
export function servedType(mime, name = '') {
  const kind = kindOf(mime, name)
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') return String(mime).toLowerCase()
  if (kind === 'text' || kind === 'markdown') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

/** RFC 5987, so a Chinese file name downloads under its own name. */
export const contentDisposition = (name, download) =>
  `${download ? 'attachment' : 'inline'}; filename="${String(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

/** The headers every file response carries. PDF is left out of the sandbox: Chrome won't render one under it. */
export function servedHeaders(file, download = false) {
  const type = download ? 'application/octet-stream' : servedType(file.mime, file.name)
  return {
    'content-type': type,
    'content-disposition': contentDisposition(file.name, download),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=86400',
    ...type === 'application/pdf' ? {} : { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" },
  }
}

/** A name that is only a name: no directories, no control characters, not empty, not too long. */
export function safeName(name) {
  let n = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!n || n === '.' || n === '..') n = 'file'
  if (n.length > 120) {
    const ext = extOf(n)
    n = n.slice(0, 120 - (ext ? ext.length + 1 : 0)) + (ext ? '.' + ext : '')
  }
  return n
}

/** `report.pdf`, then `report (2).pdf`… — never overwrite something already in the inbox. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`
}

export const sizeText = n => n < 1024 ? `${n} B` : n < MB ? `${(n / 1024).toFixed(1)} KB` : `${(n / MB).toFixed(1)} MB`

// ---------- what the model is given ----------
export const VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const VISION_MAX = 5 * MB          // per image
export const VISION_COUNT = 4             // per turn: every step resends the whole history, so images cost every step
export const INLINE_TEXT_MAX = 20_000     // characters of one text file put straight into the message
export const INLINE_TEXT_TOTAL = 60_000

/** One line per file, always: the model learns the file exists and where its tools can find it. */
export const attachmentNote = f =>
  `[Attached: ${f.name} (${f.mime}, ${sizeText(Number(f.size) || 0)})${f.path ? ` — saved at ${f.path}` : ''}]`

// ---------- where send_file may read ----------
/**
 * The path an agent asked to send, as an absolute path in its container — or a reason it can't be
 * sent. Only its own desk (/work) and the drive of the group it's talking in: from a DM nothing under
 * /groups, and never another group's drive, which would hand one group's files to another. Relative
 * paths are relative to /work. This is the readable refusal; the container re-checks after following
 * links (SEND_SCRIPT in server.mjs), since a link inside /work can point anywhere.
 */
export function sendablePath(path, { groupId = null } = {}) {
  const p = String(path ?? '').trim()
  if (!p) return 'give the path of the file'
  const abs = posix.normalize(p.startsWith('/') ? p : `/work/${p}`)
  if (abs === '/work' || abs === '/work/') return 'that is a directory, not a file'
  if (abs.startsWith('/work/')) return { path: abs }
  if (groupId && abs.startsWith(`/groups/${groupId}/`)) return { path: abs }
  return groupId
    ? `only files in /work or this group's drive (/groups/${groupId}) can be sent`
    : 'only files in /work can be sent'
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (await import('node:assert/strict')).default
  a.equal(mimeOf('a.PNG'), 'image/png')
  a.equal(mimeOf('a.png', 'application/octet-stream'), 'image/png', 'a useless browser type gives way to the extension')
  a.equal(mimeOf('notes', 'text/plain; charset=utf-8'), 'text/plain')
  a.equal(mimeOf('x.bin'), 'application/octet-stream')
  a.equal(kindOf('text/markdown'), 'markdown')
  a.equal(kindOf('text/plain', 'README.md'), 'markdown')
  a.equal(kindOf('application/json'), 'text')
  a.equal(kindOf('application/pdf'), 'pdf')
  a.equal(kindOf('video/mp4'), 'video')
  a.equal(kindOf('application/zip'), 'other')
  // nothing that runs goes out as itself
  a.equal(servedType('text/html', 'x.html'), 'text/plain; charset=utf-8')
  a.equal(servedType('text/javascript'), 'text/plain; charset=utf-8')
  a.equal(servedType('application/x-msdownload'), 'application/octet-stream')
  a.equal(servedType('image/svg+xml'), 'image/svg+xml')
  a.match(servedHeaders({ name: 'x.svg', mime: 'image/svg+xml' })['content-security-policy'], /^sandbox/)
  a.equal(servedHeaders({ name: 'x.pdf', mime: 'application/pdf' })['content-security-policy'], undefined)
  a.equal(servedHeaders({ name: 'x.pdf', mime: 'application/pdf' }, true)['content-type'], 'application/octet-stream')
  a.match(contentDisposition('报告 "v2".pdf', true), /^attachment; filename="__ _v2_.pdf"; filename\*=UTF-8''%E6%8A%A5/)
  a.equal(safeName('../../etc/passwd'), 'passwd')
  a.equal(safeName('C:\\Users\\me\\a.txt'), 'a.txt')
  a.equal(safeName('..'), 'file')
  a.equal(safeName('x'.repeat(200) + '.pdf').length, 120)
  a.ok(safeName('x'.repeat(200) + '.pdf').endsWith('.pdf'))
  a.equal(uniqueName('a.pdf', new Set(['a.pdf', 'a (2).pdf'])), 'a (3).pdf')
  a.equal(uniqueName('Makefile', new Set(['Makefile'])), 'Makefile (2)')
  a.equal(attachmentNote({ name: 'a.pdf', mime: 'application/pdf', size: 2 * MB, path: '/work/inbox/a.pdf' }),
    '[Attached: a.pdf (application/pdf, 2.0 MB) — saved at /work/inbox/a.pdf]')

  a.deepEqual(sendablePath('report.md'), { path: '/work/report.md' })
  a.deepEqual(sendablePath('/work/out/a.png'), { path: '/work/out/a.png' })
  a.match(sendablePath('/work/../etc/passwd'), /only files in \/work/)
  a.match(sendablePath('../../x'), /only files in \/work/)
  a.match(sendablePath('/work'), /directory/)
  a.match(sendablePath('/groups/g1/a.txt'), /only files in \/work can/, 'no group drive from a DM')
  a.deepEqual(sendablePath('/groups/g1/a.txt', { groupId: 'g1' }), { path: '/groups/g1/a.txt' })
  a.match(sendablePath('/groups/g2/a.txt', { groupId: 'g1' }), /this group's drive/, 'never another group')
  a.match(sendablePath('/groups/g1/../g2/a', { groupId: 'g1' }), /this group's drive/)

  console.log('files: all checks pass')
}
