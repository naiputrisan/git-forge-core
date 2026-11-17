// The git engine: object model, packfiles and the ref store, in-process on node:crypto and
// node:zlib only. The trial pod has no git binary, so everything the smart-HTTP surface serves
// is computed here: SHA-1 object ids, loose-object bytes, pack version 2 read/write (including
// OFS/REF delta resolution for packs a real git client sends), reachability, merge bases and
// the fetch/push set arithmetic the protocol handlers in app.ts drive.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` followed by the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing

export const PKT_MAX_PAYLOAD = 65520 - 4;

/** One data packet: 4 hex length digits (payload + 4) then the payload itself. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload of ${data.length} bytes is too large`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');

/** The packets of a complete buffer, decoded; stops at the first byte that is not a packet. */
export function decodePktLines(bytes: Buffer): { packets: Array<Buffer | 'flush' | 'delim'>; rest: Buffer } {
  const packets: Array<Buffer | 'flush' | 'delim'> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push('flush');
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: by name, with directories compared as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank === -1 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const view = { object: '', type: '', tag: '' };
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// packfiles

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version 2 pack holding every given object whole (no deltas), with its SHA-1 trailer. */
export function writePack(objects: ReadonlyArray<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta buffer to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset |= delta[offset++] << (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) copySize |= delta[offset++] << (8 * bit);
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  offset: number;
}

/** Inflate the deflate stream starting at `offset`; `next` is the offset just past its end. */
function inflateAt(pack: Buffer, offset: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), next: offset + stream.bytesWritten }));
    stream.end(pack.subarray(offset));
  });
}

/**
 * Read a pack into whole objects. `externalBase` resolves REF_DELTA bases the pack does not
 * carry (a thin pack against the store), by object id.
 */
export async function readPack(
  pack: Buffer,
  externalBase: (oid: string) => GitObject | undefined,
): Promise<Map<string, GitObject>> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: a negative offset back to the base entry, in git's offset encoding.
      let back = pack[offset];
      offset += 1;
      let baseBack = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        baseBack = ((baseBack + 1) << 7) | (back & 0x7f);
      }
      const inflated = await inflateAt(pack, offset);
      entries.push({ type: 'ofs-delta', data: inflated.data, baseOffset: start - baseBack, offset: start });
      offset = inflated.next;
    } else if (code === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = await inflateAt(pack, offset);
      entries.push({ type: 'ref-delta', data: inflated.data, baseOid, offset: start });
      offset = inflated.next;
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`pack object type code ${code}`);
      const inflated = await inflateAt(pack, offset);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      entries.push({ type, data: inflated.data, offset: start });
      offset = inflated.next;
    }
  }
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const wholeByOid = new Map<string, GitObject>();
  for (const entry of entries) {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      wholeByOid.set(hashObject(entry.type, entry.data!), { type: entry.type, data: entry.data! });
    }
  }
  const resolved = new Map<string, GitObject>();
  const resolve = (entry: PackEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { type: entry.type, data: entry.data! };
    }
    let base: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      base = resolve(baseEntry);
    } else {
      const found = wholeByOid.get(entry.baseOid!) ?? externalBase(entry.baseOid!);
      if (found === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      base = found;
    }
    return { type: base.type, data: applyDelta(base.data, entry.data!) };
  };
  for (const entry of entries) {
    const object = resolve(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// one repository's object store and refs

/** A repository's git side: every object it holds, its refs, and where HEAD points. */
export class RepoGit {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  /** The branch HEAD names (a full ref, e.g. refs/heads/main); unborn until that ref exists. */
  headRef: string;

  constructor(defaultBranch: string) {
    this.headRef = `refs/heads/${defaultBranch}`;
  }

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  commitOf(oid: string): CommitView | undefined {
    const object = this.objects.get(oid);
    return object !== undefined && object.type === 'commit' ? parseCommit(object.data) : undefined;
  }

  /** Peel a tag chain to the object it ultimately names (a commit, for a tag of a commit). */
  peel(oid: string): string {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /**
   * Every object reachable from `tips`. When `stopCommits` names commits, those commits are
   * included but their parents are not walked (a shallow client's held boundary).
   */
  reachable(tips: Iterable<string>, stopCommits?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        if (stopCommits === undefined || !stopCommits.has(oid)) stack.push(...view.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view !== undefined) stack.push(...view.parents);
    }
    return false;
  }

  /** A best common ancestor of two commits, or null when their histories share nothing. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const view = this.commitOf(oid);
      if (view !== undefined) stack.push(...view.parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (ancestorsOfA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view !== undefined) queue.push(...view.parents);
    }
    return null;
  }

  /**
   * The object set a fetch answers: what `wants` reach (with `depth` counting commit
   * generations from the wants when given), minus what `haves` already reach, the haves'
   * closure stopping at the client's shallow boundary. Also answers the shallow boundary the
   * fetch leaves: commits included whose parents were cut by the depth, and held boundary
   * commits the deepen now covers.
   */
  fetchSet(
    wants: readonly string[],
    haves: readonly string[],
    shallowHeld: readonly string[],
    depth: number | null,
  ): { objects: string[]; shallow: string[]; unshallow: string[] } {
    const held = new Set(shallowHeld);
    const exclude = this.reachable(haves, held);
    const include = new Set<string>();
    const boundary = new Set<string>();
    if (depth === null) {
      for (const oid of this.reachable(wants)) include.add(oid);
    } else {
      // Walk commit generations from the wants; trees and blobs of an included commit come
      // whole, tags peel without spending a generation.
      const commits = new Set<string>();
      let frontier: string[] = [];
      for (const want of wants) {
        const peeled = this.peel(want);
        if (want !== peeled) include.add(want);
        if (this.commitOf(peeled) !== undefined) frontier.push(peeled);
      }
      for (let generation = 1; generation <= depth && frontier.length > 0; generation += 1) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (commits.has(oid)) continue;
          commits.add(oid);
          const view = this.commitOf(oid)!;
          for (const parent of view.parents) {
            if (generation === depth) boundary.add(oid);
            else next.push(parent);
          }
        }
        frontier = next;
      }
      for (const oid of commits) {
        include.add(oid);
        const view = this.commitOf(oid)!;
        for (const inner of this.reachable([view.tree])) include.add(inner);
      }
    }
    const objects = [...include].filter((oid) => !exclude.has(oid) && this.objects.has(oid));
    const unshallow = [...held].filter((oid) => {
      const view = this.commitOf(oid);
      return view !== undefined && view.parents.some((parent) => include.has(parent)) && !boundary.has(oid);
    });
    return { objects, shallow: [...boundary].filter((oid) => include.has(oid) || !exclude.has(oid)), unshallow };
  }

  /** The files of a tree, flattened to path -> {oid, mode}; empty map for a missing tree. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** The tree of a commit (or of a tag pointing at one). */
  treeOfCommit(commitOid: string): string | null {
    const view = this.commitOf(this.peel(commitOid));
    return view === undefined ? null : view.tree;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob oid at `path` in a tree, or undefined when the path is absent or a directory. */
  blobAtPath(treeOid: string, path: string): string | undefined {
    return this.flattenTree(treeOid).get(path)?.oid;
  }

  /** The entries directly inside the directory `path` ('' for the root) of a tree. */
  dirEntries(treeOid: string, path: string): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> | undefined {
    let current = treeOid;
    if (path !== '') {
      for (const segment of path.split('/')) {
        const object = this.objects.get(current);
        if (object === undefined || object.type !== 'tree') return undefined;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return undefined;
        current = entry.oid;
      }
    }
    const object = this.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      oid: entry.oid,
    }));
  }
}
