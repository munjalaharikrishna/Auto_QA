import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** A small zip writer, so a generated project can be downloaded as one file without another dependency. */

export interface ZipEntry {
  /** Forward slashes, relative, no leading slash. */
  name: string;
  data: Buffer;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 2020-01-01: the zip format needs a time, and a fixed one makes the same files give the same download.
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(dosTime, 12);
    head.writeUInt16LE(dosDate, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Folders that are rebuilt on demand, and files that must never leave the machine (passwords live in `.env`). */
const SKIP_DIRS = new Set(['node_modules', 'test-results', 'playwright-report', '.git']);
const SKIP_FILES = new Set(['.env']);

/** Every file under `dir` as zip entries named relative to it. */
export async function zipEntriesOf(dir: string, prefix = ''): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await zipEntriesOf(path.join(dir, e.name), name)));
    } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
      out.push({ name, data: await readFile(path.join(dir, e.name)) });
    }
  }
  return out;
}
