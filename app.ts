// The forge's HTTP surface: the health probe, the GitHub REST v3 API, the git smart-HTTP
// endpoints (protocol v2 upload-pack, v0 receive-pack), and the mounts for GraphQL
// (/api/graphql, graphql.ts) and MCP (/mcp, mcp.ts). One in-memory Forge (store.ts) backs
// every surface, so state is shared across all of them.
//
// Wire rules the suite checks: every reply is JSON (never HTML) with a non-empty
// X-GitHub-Request-Id; an error body is {"message": string}; a request without the trial's
// bearer token is 401; a repository under any owner but the token's login is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  Repo,
  DomainError,
  VIEWER,
  branchTip,
  commitFile,
  createBranch,
  createIssue,
  createPull,
  addComment,
  deleteFile,
  identView,
  mergePull,
  pullFiles,
  readPath,
  resolveCommit,
  type Issue,
  type Pull,
  type Comment,
} from './store.ts';
import {
  ZERO_OID,
  decodePktLines,
  parseCommit,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(6, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A request's JSON body: {} when empty, a 400 DomainError when it does not parse. */
function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new DomainError(400, 'Problems parsing JSON');
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// JSON views

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(repo.createdAtSec * 1000).toISOString(),
    updated_at: new Date(repo.createdAtSec * 1000).toISOString(),
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, description: null };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: userJson(),
    comments: issue.comments.length,
    created_at: forge.iso(issue.createdAtSec),
    updated_at: forge.iso(issue.updatedAtSec),
  };
}

function commentJson(forge: Forge, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: forge.iso(comment.createdAtSec),
    updated_at: forge.iso(comment.createdAtSec),
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : new Date(pull.mergedAtSec * 1000).toISOString(),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: new Date(pull.createdAtSec * 1000).toISOString(),
    updated_at: new Date(pull.updatedAtSec * 1000).toISOString(),
  };
}

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const view = parseCommit(repo.git.get(oid)!.data);
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: identView(forge, view.author),
      committer: identView(forge, view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPage = Number(url.searchParams.get('per_page') ?? '30');
  const page = Number(url.searchParams.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(Math.floor(perPage), 100) : 30,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

/** Slice `items` to the page and build the Link header value for it ('' when there is one page). */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[], page: Page): { slice: T[]; link: string } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
  const links: string[] = [];
  if (start + page.perPage < items.length) {
    links.push(`<${base}?per_page=${page.perPage}&page=${page.page + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${page.perPage}&page=${Math.ceil(items.length / page.perPage)}>; rel="last"`);
  }
  if (page.page > 1) {
    links.push(`<${base}?per_page=${page.perPage}&page=${page.page - 1}>; rel="prev"`);
    links.push(`<${base}?per_page=${page.perPage}&page=1>; rel="first"`);
  }
  return { slice, link: links.join(', ') };
}

// ---------------------------------------------------------------------------------------------
// REST v3

async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = await readBody(req);
  const rest = segments.slice(2); // after api/v3

  if (rest.length === 0) {
    if (method !== 'GET') throw new DomainError(404, 'Not Found');
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw new DomainError(404, 'Not Found');
    sendJson(res, 200, { installed_version: '3.19.0', verifiable_password_authentication: false });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw new DomainError(404, 'Not Found');
    sendJson(res, 200, userJson());
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const body = jsonBody(raw);
      const name = str(body.name);
      if (name === undefined || name === '') throw new DomainError(422, 'Repository creation failed: name is required');
      const repo = forge.createRepo(name, {
        description: str(body.description) ?? '',
        private: bool(body.private) ?? false,
        defaultBranch: str(body.default_branch),
      });
      if (body.auto_init === true) {
        commitFile(forge, repo, { path: 'README.md', content: Buffer.from(`# ${repo.name}\n`, 'utf8'), message: 'Initial commit' });
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const page = pageOf(url);
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      const { slice, link } = paginate(req, url, all, page);
      sendJson(res, 200, slice, link === '' ? {} : { link });
      return;
    }
    throw new DomainError(404, 'Not Found');
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const name = rest[2]!;
    if (owner !== VIEWER.login) throw new DomainError(404, 'Not Found');
    const tail = rest.slice(3);
    await handleRepo(forge, req, res, method, raw, url, name, tail);
    return;
  }
  throw new DomainError(404, 'Not Found');
}

async function handleRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  raw: Buffer,
  url: URL,
  name: string,
  tail: string[],
): Promise<void> {
  if (tail.length === 0) {
    const repo = forge.repo(name);
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(raw);
      const description = str(body.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = bool(body.private);
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.repos.delete(name);
      sendJson(res, 204, undefined);
      return;
    }
    throw new DomainError(404, 'Not Found');
  }
  const repo = forge.repo(name);

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.git.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = branchTip(repo, branch);
      if (sha === undefined) throw new DomainError(404, 'Branch not found');
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const start = resolveCommit(repo, url.searchParams.get('sha') ?? repo.git.headRef);
      const commits: Record<string, unknown>[] = [];
      if (start !== undefined) {
        const seen = new Set<string>();
        const walk = (oid: string): void => {
          if (seen.has(oid)) return;
          seen.add(oid);
          const object = repo.git.get(oid);
          if (object === undefined || object.type !== 'commit') return;
          commits.push(commitJson(forge, repo, oid));
          for (const parent of parseCommit(object.data).parents) walk(parent);
        };
        walk(start);
      }
      const page = pageOf(url);
      const { slice, link } = paginate(req, url, commits, page);
      sendJson(res, 200, slice, link === '' ? {} : { link });
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = tail[1]!.toLowerCase();
      const object = repo.git.get(oid);
      if (object === undefined || object.type !== 'commit') throw new DomainError(404, 'Not Found');
      sendJson(res, 200, commitJson(forge, repo, oid));
      return;
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const found = readPath(repo, path, url.searchParams.get('ref') ?? undefined);
      if (found.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: found.blobOid,
          size: found.data.length,
          encoding: 'base64',
          content: found.data.toString('base64'),
        });
        return;
      }
      sendJson(
        res,
        200,
        found.entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? (repo.git.get(entry.oid)?.data.length ?? 0) : 0,
        })),
      );
      return;
    }
    if (method === 'PUT') {
      const body = jsonBody(raw);
      const content = str(body.content);
      if (content === undefined) throw new DomainError(422, 'content is required');
      const bytes = Buffer.from(content, 'base64');
      const result = commitFile(forge, repo, {
        path,
        content: bytes,
        message: str(body.message) ?? 'Update file',
        branch: str(body.branch),
        sha: str(body.sha),
      });
      sendJson(res, result.created ? 201 : 200, {
        content: {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobOid,
          size: bytes.length,
          encoding: 'base64',
        },
        commit: { sha: result.commitOid },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = jsonBody(raw);
      const result = deleteFile(forge, repo, {
        path,
        message: str(body.message) ?? 'Delete file',
        branch: str(body.branch),
        sha: str(body.sha),
      });
      sendJson(res, 200, { content: null, commit: { sha: result.commitOid } });
      return;
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'git' && (tail[1] === 'refs' || tail[1] === 'ref')) {
    if (tail.length === 2 && tail[1] === 'refs' && method === 'POST') {
      const body = jsonBody(raw);
      const ref = str(body.ref) ?? '';
      const sha = (str(body.sha) ?? '').toLowerCase();
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) throw new DomainError(422, 'Invalid ref or sha');
      if (repo.git.refs.has(ref)) throw new DomainError(422, 'Reference already exists');
      if (!repo.git.has(sha)) throw new DomainError(422, 'Invalid sha');
      if (ref.startsWith('refs/heads/')) createBranch(repo, ref.slice('refs/heads/'.length), sha);
      else repo.git.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: '', object: { sha, type: repo.git.get(sha)!.type, url: '' } });
      return;
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.git.refs.get(ref);
      if (sha === undefined) throw new DomainError(404, 'Not Found');
      sendJson(res, 200, { ref, node_id: '', object: { sha, type: repo.git.get(sha)?.type ?? 'commit', url: '' } });
      return;
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'POST') {
      const body = jsonBody(raw);
      const labelName = str(body.name);
      if (labelName === undefined || labelName === '') throw new DomainError(422, 'name is required');
      if (repo.labels.has(labelName)) throw new DomainError(422, 'Validation Failed: label already exists');
      const color = (str(body.color) ?? 'ededed').replace(/^#/, '');
      repo.labels.set(labelName, { name: labelName, color });
      sendJson(res, 201, labelJson(labelName, color));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label.name, label.color)));
      return;
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'POST') {
      const body = jsonBody(raw);
      const title = str(body.title);
      if (title === undefined) throw new DomainError(422, 'title is required');
      const labels = Array.isArray(body.labels)
        ? body.labels
            .map((entry) => (typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name) ?? ''))
            .filter((entry) => entry !== '')
        : [];
      const issue = createIssue(forge, repo, { title, body: str(body.body) ?? '', labels });
      sendJson(res, 201, issueJson(forge, repo, issue));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const { slice, link } = paginate(req, url, list.map((issue) => issueJson(forge, repo, issue)), page);
      sendJson(res, 200, slice, link === '' ? {} : { link });
      return;
    }
    if (tail.length >= 2) {
      const number = Number(tail[1]);
      if (tail.length === 2 && method === 'GET') {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new DomainError(404, 'Not Found');
        sendJson(res, 200, issueJson(forge, repo, issue));
        return;
      }
      if (tail.length === 2 && method === 'PATCH') {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new DomainError(404, 'Not Found');
        const body = jsonBody(raw);
        const state = str(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = str(body.title);
        if (title !== undefined) issue.title = title;
        const text = str(body.body);
        if (text !== undefined) issue.body = text;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.map((entry) => (typeof entry === 'string' ? entry : '')).filter((entry) => entry !== '');
          for (const label of labels) if (!repo.labels.has(label)) throw new DomainError(422, `Label ${JSON.stringify(label)} does not exist`);
          issue.labels = labels;
        }
        issue.updatedAtSec = forge.nowSec();
        sendJson(res, 200, issueJson(forge, repo, issue));
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const thread = repo.thread(number);
        if (thread === undefined) throw new DomainError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, thread.comments.map((comment) => commentJson(forge, comment)));
          return;
        }
        if (method === 'POST') {
          const body = jsonBody(raw);
          const text = str(body.body);
          if (text === undefined) throw new DomainError(422, 'body is required');
          const comment = addComment(forge, thread, text);
          sendJson(res, 201, commentJson(forge, comment));
          return;
        }
      }
      throw new DomainError(404, 'Not Found');
    }
    throw new DomainError(404, 'Not Found');
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'POST') {
      const body = jsonBody(raw);
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (title === undefined || head === undefined || base === undefined) throw new DomainError(422, 'title, head and base are required');
      const pull = createPull(forge, repo, { title, body: str(body.body) ?? '', head, base });
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const { slice, link } = paginate(req, url, list.map((pull) => pullJson(repo, pull)), page);
      sendJson(res, 200, slice, link === '' ? {} : { link });
      return;
    }
    if (tail.length >= 2) {
      const number = Number(tail[1]);
      const pull = repo.pulls.get(number);
      if (tail.length === 2 && method === 'GET') {
        if (pull === undefined) throw new DomainError(404, 'Not Found');
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) throw new DomainError(404, 'Not Found');
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) throw new DomainError(404, 'Not Found');
        const body = jsonBody(raw);
        const sha = mergePull(forge, repo, pull, str(body.merge_method) ?? 'squash');
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      throw new DomainError(404, 'Not Found');
    }
    throw new DomainError(404, 'Not Found');
  }

  throw new DomainError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP

const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta agent=coreforge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=coreforge/1.0';

/** The v0 ref advertisement (also receive-pack's only form), HEAD first, refs sorted. */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const git = repo.git;
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `${UPLOAD_CAPS} symref=HEAD:${git.headRef}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const headOid = git.refs.get(git.headRef);
  const names = [...git.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
    parts.push(pktFlush);
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (headOid !== undefined) line(headOid, 'HEAD');
  for (const name of names) {
    const oid = git.refs.get(name)!;
    line(oid, name);
    const object = git.get(oid);
    if (object !== undefined && object.type === 'tag') {
      parts.push(pktLine(`${git.peel(oid)} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=coreforge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush,
  ]);
}

/** The refs an ls-refs answers: HEAD (when it passes the prefixes) then each matching ref. */
function lsRefsReply(repo: Repo, args: string[]): Buffer {
  const git = repo.git;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = git.refs.get(git.headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${git.headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${git.headRef}` : ''}\n`));
    }
  }
  for (const name of [...git.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = git.refs.get(name)!;
    let suffix = '';
    const object = git.get(oid);
    if (peel && object !== undefined && object.type === 'tag') suffix = ` peeled:${git.peel(oid)}`;
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** Wrap pack bytes in sideband band-1 packets of at most the pkt-line maximum. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // one byte of the 65516 payload maximum is the band marker itself
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

/** A v2 fetch: acknowledgments, shallow-info, then the packfile in sideband frames. */
function fetchV2Reply(repo: Repo, args: string[]): Buffer {
  const git = repo.git;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowHeld: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowHeld.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  const parts: Buffer[] = [];
  if (!done) {
    // A negotiation round. With a common base, `ready` ends negotiation and the packfile
    // follows in this same response; with none, a bare NAK invites more haves (or `done`).
    // Once the client sends `done`, no acknowledgments section may appear at all.
    const common = haves.filter((have) => git.has(have));
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
      parts.push(pktDelim);
      parts.push(pktFlush);
      return Buffer.concat(parts);
    }
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim);
  }
  const set = git.fetchSet(wants, haves, shallowHeld, depth);
  if (set.shallow.length > 0 || set.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of set.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of set.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  const objects = set.objects.map((oid) => ({ oid, type: git.get(oid)!.type, data: git.get(oid)!.data }));
  const pack = writePack(objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** A v0 fetch: one NAK/ACK line, then the pack (sideband-framed when the client asked). */
function fetchV0Reply(repo: Repo, lines: string[]): Buffer {
  const git = repo.git;
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let sideband = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const fields = line.slice(5).trim().split(' ');
      wants.push(fields[0]!);
      if (fields.slice(1).join(' ').includes('side-band')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const set = git.fetchSet(wants, haves, [], depth);
  const objects = set.objects.map((oid) => ({ oid, type: git.get(oid)!.type, data: git.get(oid)!.data }));
  const pack = writePack(objects);
  const common = haves.filter((have) => git.has(have));
  const parts: Buffer[] = [pktLine(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n')];
  if (sideband) parts.push(...sidebandPackets(pack));
  else parts.push(pack);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, raw: Buffer, res: ServerResponse): void {
  const { packets } = decodePktLines(raw);
  const lines = packets.filter((packet): packet is Buffer => Buffer.isBuffer(packet)).map((packet) => packet.toString('utf8').replace(/\n$/, ''));
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine !== undefined) {
    const command = commandLine.slice('command='.length);
    const delimIndex = packets.findIndex((packet) => packet === 'delim');
    const argPackets = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
    const args = argPackets.filter((packet): packet is Buffer => Buffer.isBuffer(packet)).map((packet) => packet.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') {
      sendRaw(res, 200, lsRefsReply(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      sendRaw(res, 200, fetchV2Reply(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    sendRaw(res, 400, Buffer.from(`unknown command ${command}\n`), 'text/plain');
    return;
  }
  if (lines.some((line) => line.startsWith('want '))) {
    sendRaw(res, 200, fetchV0Reply(repo, lines), 'application/x-git-upload-pack-result');
    return;
  }
  sendRaw(res, 400, Buffer.from('expected a pkt-line request\n'), 'text/plain');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** A receive-pack push: unpack the pack into the store, then apply the ref updates that may move. */
async function handleReceivePack(repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  const git = repo.git;
  const { packets, rest } = decodePktLines(raw);
  const lines = packets.filter((packet): packet is Buffer => Buffer.isBuffer(packet)).map((packet) => packet.toString('utf8').replace(/\n$/, ''));
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const [index, line] of lines.entries()) {
    const nul = line.indexOf('\0');
    const text = nul === -1 ? line : line.slice(0, nul);
    if (index === 0 && nul !== -1) capabilities = line.slice(nul + 1);
    const fields = text.split(' ');
    if (fields.length !== 3) continue;
    commands.push({ oldOid: fields[0]!.toLowerCase(), newOid: fields[1]!.toLowerCase(), ref: fields[2]! });
  }
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = await readPack(rest, (oid) => git.get(oid));
      for (const [oid, object] of objects) if (!git.objects.has(oid)) git.objects.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const refuse = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      refuse('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      refuse('invalid ref');
      continue;
    }
    const current = git.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      refuse('reference already exists');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      git.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = git.get(command.newOid);
    if (target === undefined) {
      refuse('invalid object');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = git.peel(command.oldOid);
      const newCommit = git.peel(command.newOid);
      if (git.commitOf(oldCommit) !== undefined && git.commitOf(newCommit) !== undefined && !git.isAncestor(oldCommit, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    git.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (!capabilities.includes('report-status')) {
    sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const report: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(pktFlush);
  const reportBytes = Buffer.concat(report);
  if (capabilities.includes('side-band-64k')) {
    sendRaw(res, 200, Buffer.concat([...sidebandPackets(reportBytes), pktFlush]), 'application/x-git-receive-pack-result');
    return;
  }
  sendRaw(res, 200, reportBytes, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname
          .split('/')
          .filter((segment) => segment !== '')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
        const method = req.method ?? 'GET';

        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) throw new DomainError(401, 'Requires authentication');
          await handleRest(forge, req, res, segments, url);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') throw new DomainError(404, 'Not Found');
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const reply = handleGraphQL(forge, raw);
          sendJson(res, reply.status, reply.body);
          return;
        }

        if (segments[0] === 'mcp' && segments.length === 1) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const reply = await handleMcp(forge, req.method ?? 'POST', await readBody(req));
          if (reply !== null) sendJson(res, reply.status, reply.body);
          else {
            res.writeHead(202, { 'x-github-request-id': nextRequestId() });
            res.end();
          }
          return;
        }

        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          if (!authorized(req)) throw new DomainError(401, 'Requires authentication');
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const repo = owner === VIEWER.login ? forge.repos.get(repoName) : undefined;
          if (repo === undefined) throw new DomainError(404, 'Not Found');
          const tail = segments.slice(2);
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new DomainError(400, 'Unknown service');
            const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
            sendRaw(res, 200, v2 ? v2Advertisement() : v0Advertisement(repo, service), `application/x-${service}-advertisement`);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
            handleUploadPack(repo, await readBody(req), res);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
            await handleReceivePack(repo, await readBody(req), res);
            return;
          }
          throw new DomainError(404, 'Not Found');
        }

        throw new DomainError(404, 'Not Found');
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof DomainError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          process.stderr.write(`[entry] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      }
    })();
  });
}
