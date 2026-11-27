/**
 * Zip files, the plain kind (no Zip64), with Node built-ins only: reading one (the central directory, an entry's
 * bytes), writing one (an artifact folder's archive, a type package), and unpacking one that may come from anyone
 * into a folder, with every rule checked before a byte is written. Shared by the type server (`archive`, imports),
 * frame-host (`/__open-artifact/archive`) and the daemon (`types pack`, `types install`, `import`, the archives of
 * static types), so one archive shape and one set of path rules hold everywhere.
 *
 * The archive of an artifact folder holds one folder, named as the artifact folder is, with what makes the artifact:
 * `project/` (or `db/`), `_blobs/`, `comments.json`, `history/` and `.artifact.json`. Left out is what belongs to this
 * computer or to nobody: the agent channel (`_agent/`: inbox, waiting, view context), dot files (a server's state and
 * log, share links, temp files of atomic writes), `node_modules`, `.git` and the OS's `.DS_Store` / `Thumbs.db`.
 * Symbolic links are not followed. At most 65 535 files and 4 GiB, checked before the first byte goes out. Names are
 * UTF-8 (flag bit 11), Unix permissions ride in the external attributes, and each file is deflated unless it is a
 * format that is compressed already or deflate would not shrink it.
 */

import { randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw as deflateRawCallback, inflateRaw as inflateRawCallback, inflateRawSync } from 'node:zlib';

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** A file that is not a zip (`not_zip`), or a zip whose parts do not hold together (`damaged`). */
export class ZipError extends Error {
  readonly code: 'not_zip' | 'damaged';

  constructor(code: 'not_zip' | 'damaged', message: string) {
    super(message);
    this.code = code;
  }
}

/** One entry of the central directory, as the zip states it (sizes and attributes may lie). */
export interface ZipEntry {
  /** The name, decoded as UTF-8. */
  name: string;
  /** "Version made by": the high byte is the host system (3 = Unix, 0 = MS-DOS). */
  madeBy: number;
  /** General purpose flags (bit 0: encrypted, bit 6: strong encryption, bit 11: UTF-8 names). */
  flags: number;
  /** 0 stored, 8 deflated. */
  method: number;
  crc: number;
  /** Bytes in the zip. */
  packedSize: number;
  /** Bytes once unpacked, as declared. */
  size: number;
  /** External attributes; on a Unix host the high 16 bits are the file's `st_mode`. */
  externalAttributes: number;
  /** Offset of the entry's local header. */
  localOffset: number;
}

/** The end of central directory record: where the directory starts and how many entries it claims. */
export interface ZipDirectory {
  entries: ZipEntry[];
  /** Entries the end record claims (may be more than were readable). */
  declared: number;
  /** Offset of the central directory, which is where the entries' data must end. */
  directoryOffset: number;
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The central directory. Reading stops at the first record that is not one (the end record's count is in
 * `declared`, so a strict caller can see a short directory). Throws `not_zip` when there is no end record.
 */
export function zipEntries(bytes: Uint8Array): ZipDirectory {
  const zip = view(bytes);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== END_SIGNATURE) end--;
  if (end < 0) throw new ZipError('not_zip', 'This file is not a zip: it has no end of central directory record.');
  const declared = zip.readUInt16LE(end + 10);
  const directoryOffset = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < declared && at + 46 <= zip.length && zip.readUInt32LE(at) === CENTRAL_SIGNATURE; index++) {
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      madeBy: zip.readUInt16LE(at + 4),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      crc: zip.readUInt32LE(at + 16),
      packedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      externalAttributes: zip.readUInt32LE(at + 38),
      localOffset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { entries, declared, directoryOffset };
}

/** Where an entry's packed data sits, read from its local header: the data and the name the local header gives. Throws `damaged` when the local header is missing. */
export function entryBytes(bytes: Uint8Array, entry: ZipEntry): { data: Buffer; start: number; localName: string; localMethod: number; localFlags: number } {
  const zip = view(bytes);
  const local = entry.localOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new ZipError('damaged', `The zip is damaged: the data of ${entry.name} is missing.`);
  const nameLength = zip.readUInt16LE(local + 26);
  const start = local + 30 + nameLength + zip.readUInt16LE(local + 28);
  return {
    data: zip.subarray(start, start + entry.packedSize),
    start,
    localName: zip.toString('utf8', local + 30, local + 30 + nameLength),
    localMethod: zip.readUInt16LE(local + 8),
    localFlags: zip.readUInt16LE(local + 6),
  };
}

const inflateRaw = promisify(inflateRawCallback);

/**
 * An entry's bytes, unpacked: stored data is copied, anything else is inflated, never past `maxBytes`
 * (zlib refuses with a `RangeError` when the data would grow past it).
 */
export async function unpackEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  const { data } = entryBytes(bytes, entry);
  return entry.method === 0 ? Buffer.from(data) : inflateRaw(data, { maxOutputLength: Math.max(1, maxBytes) });
}

/** {@link unpackEntry}, synchronously. */
export function unpackEntrySync(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Buffer {
  const { data } = entryBytes(bytes, entry);
  return entry.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
}

/**
 * Every name of the zip with a reader of its bytes, unpacked on demand and never past `maxEntryBytes`. A name given
 * twice keeps its last entry. Throws `not_zip`; a reader throws `damaged` when its entry's data is missing.
 */
export function readZip(bytes: Uint8Array, maxEntryBytes: number): Map<string, () => Buffer> {
  const entries = new Map<string, () => Buffer>();
  for (const entry of zipEntries(bytes).entries) entries.set(entry.name, () => unpackEntrySync(bytes, entry, maxEntryBytes));
  return entries;
}

/* -------------------------------------------------------------------------- */
/* An artifact folder's archive                                               */
/* -------------------------------------------------------------------------- */

/** Hidden paths carrying portable artifact data, relative to the archive root. */
const KEPT_DOT_FILES = new Set(['.artifact.json', '.gitignore', 'doc/.sessions.json', 'doc/.people.json', 'doc/tabs/.deleted']);
/** Never in the zip, at any depth. */
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules']);
/** Never in the zip, at the folder's top. */
const LOCAL_DIRS = new Set(['_agent']);
/** An atomic write's temp file. */
const isTemp = (name: string): boolean => name.endsWith('.tmp') || name.startsWith('.tmp-');

/**
 * Whether the archive carries `name`, found at `path` (its path under the artifact folder, forward slashes) in the
 * folder `parent` (`''` at the top). A path is in the archive when every step down to it is.
 */
function keepsStep(parent: string, name: string, path: string): boolean {
  if (JUNK.has(name) || isTemp(name)) return false;
  if (name.startsWith('.') && !KEPT_DOT_FILES.has(path)) return false;
  return !(parent === '' && LOCAL_DIRS.has(name));
}

/**
 * Whether a path under the artifact folder (forward slashes, no leading slash) is one {@link archiveEntries} would
 * put in the zip, by name alone. The export and the import share it, so what one leaves out the other refuses.
 */
export function archiveKeeps(path: string): boolean {
  const steps = path.split('/');
  let parent = '';
  for (const name of steps) {
    const inner = parent ? `${parent}/${name}` : name;
    if (!keepsStep(parent, name, inner)) return false;
    parent = inner;
  }
  return true;
}

/** Formats that are compressed already: stored as they are. */
const STORED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.woff', '.woff2', '.zip', '.gz', '.br', '.zst', '.7z']);

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/** One file of the zip. */
export interface ArchiveEntry {
  /** The path inside the zip: `<folder>/<path under root>`, with forward slashes. */
  name: string;
  file: string;
  size: number;
  mode: number;
  mtime: Date;
}

/** A folder over plain zip's limits. */
export class ArchiveTooLarge extends Error {
  readonly code = 'TOO_LARGE';
}

/** The files to zip, sorted by path. `skip`: absolute paths to leave out too (the zip itself, written inside the folder). */
export async function archiveEntries(root: string, skip: string[] = []): Promise<ArchiveEntry[]> {
  const top = resolve(root);
  const folder = basename(top) || 'artifact';
  const skipped = new Set(skip.map((file) => resolve(file)));
  const entries: ArchiveEntry[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (rel && (error as NodeJS.ErrnoException).code === 'ENOENT') return; // removed meanwhile
      throw error;
    }
    for (const dirent of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = dirent.name;
      const inner = rel ? `${rel}/${name}` : name;
      if (!keepsStep(rel, name, inner)) continue;
      const file = join(dir, name);
      if (skipped.has(file)) continue;
      if (dirent.isDirectory()) await walk(file, inner);
      else if (dirent.isFile()) {
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) entries.push({ name: `${folder}/${inner}`, file, size: info.size, mode: info.mode & 0o777, mtime: info.mtime });
      }
    }
  };
  await walk(top, '');
  if (entries.length > MAX_ENTRIES) throw new ArchiveTooLarge(`The folder holds ${entries.length} files, more than a zip holds (${MAX_ENTRIES}); copy the folder itself instead.`);
  const bound = entries.reduce((sum, entry) => sum + entry.size + 2 * (46 + Buffer.byteLength(entry.name)), 22);
  if (bound > MAX_BYTES) throw new ArchiveTooLarge(`The folder holds ${(bound / 2 ** 30).toFixed(1)} GiB, more than a zip holds (4 GiB); copy the folder itself instead.`);
  return entries;
}

/* -------------------------------------------------------------------------- */
/* The zip format                                                             */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of bytes. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, local time; the format starts in 1980 and ends in 2107. */
function dosTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const deflateRaw = promisify(deflateRawCallback);
const UTF8 = 1 << 11;

/**
 * Writes the zip of `entries` through `write`, one file at a time: its local
 * header and data, then the central directory. A file gone since the listing
 * is left out. Resolves with the number of bytes written.
 */
export async function writeZip(entries: ArchiveEntry[], write: (chunk: Buffer) => Promise<void>): Promise<{ bytes: number; files: number }> {
  const central: Buffer[] = [];
  let offset = 0;
  let files = 0;
  const put = async (chunk: Buffer): Promise<void> => {
    await write(chunk);
    offset += chunk.length;
  };
  for (const entry of entries) {
    let data: Buffer;
    try {
      data = await readFile(entry.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (data.length > 0 && !STORED.has(extname(entry.name).toLowerCase())) {
      const deflated = await deflateRaw(data);
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    if (offset + body.length > MAX_BYTES) throw new ArchiveTooLarge('The folder grew past what a zip holds (4 GiB) while it was being zipped.');
    const name = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attributes: 0
    header.writeUInt32LE(((0o100000 | (entry.mode || 0o644) | 0o600) << 16) >>> 0, 38); // a regular file, its permissions
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    await put(Buffer.concat([local, name]));
    await put(body);
    files++;
  }
  const start = offset;
  const directory = Buffer.concat(central);
  await put(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(start, 16);
  await put(end);
  return { bytes: offset, files };
}

/* -------------------------------------------------------------------------- */
/* Where it goes                                                              */
/* -------------------------------------------------------------------------- */

/** `<folder>-<yyyy-mm-dd>.zip`: a day's backup beside the last one, not over it. */
export function archiveFileName(root: string, now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${basename(resolve(root)) || 'artifact'}-${day}.zip`;
}

/**
 * Writes the folder's zip to `out` (through a temp file beside it, so a
 * failure leaves no half zip). `out` may be inside the folder: it is never
 * zipped into itself.
 */
export async function writeArchive(root: string, out: string): Promise<{ file: string; files: number; bytes: number }> {
  const file = resolve(out);
  const entries = await archiveEntries(root, [file]);
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  const handle = await open(temp, 'w');
  let result: { bytes: number; files: number };
  try {
    result = await writeZip(entries, async (chunk) => {
      await handle.write(chunk);
    });
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
  await rename(temp, file);
  return { file, ...result };
}

/** `attachment` with the file's name: plain ASCII in `filename`, the real name in `filename*`. */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Answers `GET|HEAD /__open-artifact/archive`: the folder's zip, streamed as
 * it is written (no length: each file is deflated on the way). `HEAD` lists
 * the files only, so a folder over plain zip's limits answers 413 before
 * anything is zipped. A connection that closes stops the zipping.
 */
export async function sendArchive(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const method = req.method ?? 'GET';
  req.resume();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  let entries: ArchiveEntry[];
  try {
    entries = await archiveEntries(root);
  } catch (error) {
    if (error instanceof ArchiveTooLarge) {
      const body = JSON.stringify({ code: 'too_large', message: error.message });
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(method === 'HEAD' ? undefined : body);
      return;
    }
    throw error;
  }
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': attachmentHeader(archiveFileName(root)), 'cache-control': 'no-store' });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  let closed = false;
  res.on('close', () => (closed = true));
  try {
    await writeZip(entries, (chunk) => {
      if (closed || res.destroyed) return Promise.reject(new Error('The connection closed.'));
      if (res.write(chunk)) return Promise.resolve();
      return new Promise<void>((done, fail) => {
        const onDrain = (): void => {
          res.off('close', onClose);
          done();
        };
        const onClose = (): void => {
          res.off('drain', onDrain);
          fail(new Error('The connection closed.'));
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
      });
    });
    res.end();
  } catch {
    // Headers are out: the only way to say it failed is to cut the download short.
    res.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* Unpacking a zip from anyone                                                */
/* -------------------------------------------------------------------------- */

/** Why a zip is refused: `invalid` (its shape or a name, 400) or `too_large` (a limit, 413). */
export class ZipRefusal extends Error {
  readonly code: 'invalid' | 'too_large';
  readonly status: 400 | 413;

  constructor(code: 'invalid' | 'too_large', message: string) {
    super(message);
    this.code = code;
    this.status = code === 'too_large' ? 413 : 400;
  }
}

/** What {@link checkZip} takes from a zip. */
export interface ZipRules {
  /** What the zip is, in messages: `a type package`. */
  noun: string;
  /** Files, at most; the directory's declared count is checked before it is walked. */
  maxFiles: number;
  /** Unpacked bytes of all files together, at most. */
  maxBytes: number;
  /** Unpacked bytes of one file, at most. */
  maxFileBytes: number;
  /** Folder entries (`name/`) are taken and skipped; otherwise one is refused. */
  folders?: boolean;
}

/** One file of a checked zip: its path under the top folder and the permissions it is written with. */
export interface CheckedZipFile {
  entry: ZipEntry;
  path: string;
  mode: number;
}

const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY = 0x10;
/** Flag bits of an encrypted entry: encrypted, strong encryption, masked local header. */
const ENCRYPTED = (1 << 0) | (1 << 6) | (1 << 13);
/** `wx`, and never through a symbolic link. */
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/** How a name compares on a disk that ignores case and Unicode normalization. */
export const foldedName = (path: string): string => path.normalize('NFC').toLowerCase();

/**
 * Every entry of a zip checked, before a byte is unpacked: no encryption, stored or deflated only; plain files (and,
 * with `folders`, folder entries) only, so no symbolic link or device (by the Unix mode in the external attributes);
 * no NUL, backslash, absolute path, `..`, empty or `.` step; all under one top folder; no name twice once case and
 * Unicode normalization are ignored, and no name both a file and a folder; local headers that match the directory;
 * and the declared sizes within `rules` (which {@link unpackZip} holds them to while inflating). Throws
 * {@link ZipRefusal}.
 */
export function checkZip(bytes: Uint8Array, rules: ZipRules): { top: string; files: CheckedZipFile[] } {
  const refuse = (message: string): ZipRefusal => new ZipRefusal('invalid', message);
  const tooLarge = (message: string): ZipRefusal => new ZipRefusal('too_large', message);
  let directory: ZipDirectory;
  try {
    directory = zipEntries(bytes);
  } catch (error) {
    if (error instanceof ZipError) throw refuse('This file is not a zip.');
    throw error;
  }
  if (directory.declared > rules.maxFiles * 2 + 1000) throw tooLarge(`${rules.noun} holds ${directory.declared} entries, more than it may (${rules.maxFiles} files).`);
  if (directory.entries.length !== directory.declared) throw refuse('The zip is damaged: its central directory is short.');
  if (directory.declared === 0) throw refuse(`${rules.noun} is empty.`);
  const files: CheckedZipFile[] = [];
  const seen = new Set<string>();
  const folders = new Set<string>();
  let top: string | undefined;
  let declared = 0;
  for (const entry of directory.entries) {
    const name = entry.name;
    const shown = JSON.stringify(name);
    if (entry.flags & ENCRYPTED) throw refuse(`${shown} is encrypted; ${rules.noun} never is.`);
    if (entry.method !== 0 && entry.method !== 8) throw refuse(`${shown} is packed with method ${entry.method}; only stored and deflated files are read.`);
    if (name.includes('\0') || name.includes('\\')) throw refuse(`${shown} has a backslash or a NUL in its name.`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw refuse(`${shown} is an absolute path.`);
    const mode = entry.externalAttributes >>> 16;
    const unix = entry.madeBy >>> 8 === UNIX_HOST;
    const kind = unix ? mode & S_IFMT : 0;
    const folder = name.endsWith('/') || (entry.externalAttributes & DOS_DIRECTORY) !== 0 || kind === S_IFDIR;
    if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) throw refuse(`${shown} is a symbolic link or a device; ${rules.noun} holds plain files only.`);
    if (folder && !rules.folders) throw refuse(`${shown} is a folder entry; ${rules.noun} holds files only.`);
    const steps = name.replace(/\/$/, '').split('/');
    if (steps.some((step) => step === '..')) throw refuse(`${shown} climbs out of its folder (..).`);
    if (steps.some((step) => step === '' || step === '.')) throw refuse(`${shown} has an empty or "." step in its path.`);
    if (top === undefined) top = steps[0]!;
    else if (steps[0] !== top) throw refuse(`${rules.noun} holds more than one top folder (${JSON.stringify(top)} and ${JSON.stringify(steps[0])}); it holds one.`);
    if (folder) {
      if (entry.size !== 0) throw refuse(`The zip is damaged: the folder ${shown} has data.`);
      const key = foldedName(steps.slice(1).join('/'));
      if (key) folders.add(key);
      continue;
    }
    if (steps.length < 2) throw refuse(`${shown} is at the top of the zip; ${rules.noun} holds one folder.`);
    const path = steps.slice(1).join('/');
    const key = foldedName(path);
    if (seen.has(key)) throw refuse(`${shown} is in ${rules.noun} twice (names that differ only in case or Unicode form count as the same).`);
    seen.add(key);
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join('/'));
    if (seen.size > rules.maxFiles) throw tooLarge(`${rules.noun} holds more than ${rules.maxFiles} files.`);
    if (entry.size > rules.maxFileBytes) throw tooLarge(`${path} unpacks to ${entry.size} bytes, more than ${rules.maxFileBytes}.`);
    declared += entry.size;
    if (declared > rules.maxBytes) throw tooLarge(`${rules.noun} unpacks to more than ${rules.maxBytes} bytes.`);
    const local = entryBytes(bytes, entry);
    if (local.start + entry.packedSize > directory.directoryOffset || directory.directoryOffset > bytes.byteLength) throw refuse(`The zip is damaged: the data of ${path} runs past its end.`);
    if (local.localName !== entry.name || local.localMethod !== entry.method || local.localFlags & ENCRYPTED) throw refuse(`The zip is damaged: the local header of ${path} does not match its directory entry.`);
    if (entry.method === 0 && entry.packedSize !== entry.size) throw refuse(`The zip is damaged: ${path} is stored but its sizes differ.`);
    files.push({ entry, path, mode: ((unix ? mode : 0o644) & 0o755) | 0o600 });
  }
  for (const key of seen) if (folders.has(key)) throw refuse(`${key} is in ${rules.noun} both as a file and as a folder.`);
  if (top === undefined) throw refuse(`${rules.noun} is empty.`);
  return { top, files };
}

/** One checked file's bytes: inflated never past its declared size, which must be its real size, with its CRC holding. */
export async function unpackZipFile(bytes: Uint8Array, item: CheckedZipFile): Promise<Buffer> {
  let data: Buffer;
  try {
    data = await unpackEntry(bytes, item.entry, item.entry.size);
  } catch (error) {
    if (error instanceof RangeError) throw new ZipRefusal('too_large', `${item.path} unpacks to more than the ${item.entry.size} bytes it declares.`);
    if (error instanceof ZipError) throw new ZipRefusal('invalid', error.message);
    throw new ZipRefusal('invalid', `The zip is damaged: ${item.path} cannot be unpacked.`);
  }
  if (data.length !== item.entry.size) throw new ZipRefusal('invalid', `The zip is damaged: ${item.path} unpacks to ${data.length} bytes, not the ${item.entry.size} it declares.`);
  if (crc32(data) !== item.entry.crc) throw new ZipRefusal('invalid', `The zip is damaged: ${item.path} fails its CRC check.`);
  return data;
}

/** Writes a new file, refusing one that exists and never following a symbolic link. */
export async function writeNewFile(file: string, data: Uint8Array, mode = 0o644): Promise<void> {
  const handle = await open(file, WRITE_NEW, mode);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Unpacks a checked zip into a new temporary folder beside `dest` (named `.<dest>.<random>.unpack`, so a type root's
 * scan skips it), counting the bytes actually inflated against `maxBytes`, and returns that folder. The caller checks
 * what was unpacked and renames it into place; on a failure here the temporary folder is removed.
 */
export async function unpackZip(bytes: Uint8Array, files: readonly CheckedZipFile[], dest: string, maxBytes: number): Promise<{ temp: string; files: number; bytes: number }> {
  const target = resolve(dest);
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.unpack`);
  await mkdir(temp);
  try {
    let total = 0;
    for (const item of files) {
      const data = await unpackZipFile(bytes, item);
      total += data.length;
      if (total > maxBytes) throw new ZipRefusal('too_large', `It unpacks to more than ${maxBytes} bytes.`);
      const file = resolve(temp, ...item.path.split('/'));
      if (!file.startsWith(temp + sep)) throw new ZipRefusal('invalid', `${item.path} would land outside its folder.`);
      await mkdir(dirname(file), { recursive: true });
      await writeNewFile(file, data, item.mode);
    }
    return { temp, files: files.length, bytes: total };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') throw new ZipRefusal('invalid', "The zip's paths collide with one another.");
    throw error;
  }
}

/** Moves a checked, unpacked folder into place; refuses when `dest` exists by then. */
export async function moveIntoPlace(temp: string, dest: string): Promise<void> {
  if (await lstat(dest).then(() => true, () => false)) {
    await rm(temp, { recursive: true, force: true });
    throw Object.assign(new Error(`${dest} exists already.`), { code: 'EEXIST' });
  }
  await rename(temp, dest);
}

/**
 * The zip of a folder's files as bytes (`types pack`): `entries` named `<folder>/<path>`, already chosen by the caller.
 */
export async function zipBytes(entries: ArchiveEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await writeZip(entries, async (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}
