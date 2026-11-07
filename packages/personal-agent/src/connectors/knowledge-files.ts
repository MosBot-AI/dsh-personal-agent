import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
type Koffi = typeof import('koffi').default
type DirectoryEntry = { name: string; kind: 'directory' | 'file' }

function platformOperations() {
  const mac = process.platform === 'darwin'
  if ((!mac && process.platform !== 'linux') || !['arm64', 'x64'].includes(process.arch)) return undefined
  try {
    const ffi = require('koffi') as Koffi
    const libc = ffi.load(null)
    const openAt = libc.func('int openat(int, const char *, int)') as (parent: number, name: string, flags: number) => number
    const fdopendir = libc.func('void *fdopendir(int)') as (fd: number) => unknown
    const readdirName = mac && process.arch === 'x64' ? 'readdir$INODE64' : 'readdir'
    const next = libc.func(readdirName, 'void *', ['void *']) as (dir: unknown) => unknown
    const closedir = libc.func('int closedir(void *)') as (dir: unknown) => number
    const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY
      | (mac ? 0x1000000 : 0x80000) // O_CLOEXEC is not exposed by Node.
    // Darwin inode64 and the supported Linux ABIs both put reclen at offset 16.
    const nameOffset = mac ? 21 : 19
    const typeOffset = nameOffset - 1
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

    function open(parent: number, name: string, directory: boolean): number | undefined {
      const fd = openAt(parent, name, openFlags | (directory ? constants.O_DIRECTORY : 0))
      return fd < 0 ? undefined : fd
    }

    function entries(fd: number, limit: number): { items: DirectoryEntry[]; examined: number; limited: boolean } | undefined {
      const copy = open(fd, '.', true)
      if (copy === undefined) return undefined
      const dir = fdopendir(copy)
      if (!dir) { closeSync(copy); return undefined }
      const items: DirectoryEntry[] = []
      let examined = 0
      try {
        while (examined < limit) {
          ffi.errno(0)
          const entry = next(dir)
          if (!entry) return ffi.errno() === 0 ? { items, examined, limited: false } : undefined
          examined++
          const header = Buffer.from(ffi.view(entry, nameOffset))
          const size = header.readUInt16LE(16)
          const type = header[typeOffset]
          if (size <= nameOffset || size > 4096) return undefined
          if (type !== 4 && type !== 8) continue // DT_DIR and DT_REG
          const buffer = Buffer.from(ffi.view(entry, size))
          const end = buffer.indexOf(0, nameOffset)
          if (end < 0) return undefined
          try {
            const name = decoder.decode(buffer.subarray(nameOffset, end))
            if (name.length && !name.startsWith('.') && !/[\\/\p{Cc}]/u.test(name)) {
              items.push({ name, kind: type === 4 ? 'directory' : 'file' })
            }
          } catch { /* Filenames must round-trip through the UTF-8 RPC. */ }
        }
        return { items, examined, limited: true }
      } finally { closedir(dir) }
    }

    return { open, entries }
  } catch { return undefined }
}

let loaded = false
let operations: ReturnType<typeof platformOperations>
export function knowledgeFileOperations() {
  if (!loaded) {
    operations = platformOperations()
    loaded = true
  }
  return operations
}

export type KnowledgeFiles = NonNullable<ReturnType<typeof knowledgeFileOperations>>

export function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}` }

export function directoryStat(fd: number): BigIntStats | undefined {
  const stat = fstatSync(fd, { bigint: true })
  return stat.isDirectory() && (stat.mode & 0o444n) !== 0n && (stat.mode & 0o111n) !== 0n ? stat : undefined
}

/** Open each component with a directory descriptor and O_NOFOLLOW. */
export function openKnowledgeRoot(files: KnowledgeFiles, directory: string): number | undefined {
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const name of directory.slice(1).split('/')) {
      const next = files.open(fd, name, true)
      if (next === undefined) return undefined
      closeSync(fd)
      fd = next
    }
    const root = fd
    fd = -1
    return root
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export function fileStamp(fd: number, device: bigint, maxBytes: number): { stamp: string; size: number } | undefined {
  const stat = fstatSync(fd, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== device || (stat.mode & 0o444n) === 0n
    || stat.size > BigInt(maxBytes)) return undefined
  return { stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':'), size: Number(stat.size) }
}

export function readKnowledgeFile(fd: number, device: bigint, maxBytes: number): { stamp: string; bytes: Buffer } | undefined {
  const before = fileStamp(fd, device, maxBytes)
  if (!before) return undefined
  const bytes = Buffer.alloc(before.size + 1)
  let length = 0
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, length)
    if (!count) break
    length += count
  }
  return length === before.size && fileStamp(fd, device, maxBytes)?.stamp === before.stamp
    ? { stamp: before.stamp, bytes: bytes.subarray(0, length) } : undefined
}
