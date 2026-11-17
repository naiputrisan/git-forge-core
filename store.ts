// The forge's domain: one tenant (the token's owner), their repositories, and every operation
// the three surfaces share — contents commits, branches, labels, issues, comments and pull
// requests with squash merges over a three-way tree merge. REST (app.ts), GraphQL
// (graphql.ts) and MCP (mcp.ts) all call into here, so an object created on one surface is
// the same object on the others, with the same ids.
//
// Determinism: nothing here reads the wall clock. A logical clock starts at
// MAKEFUN_TRIAL_NOW when the trial provides one and advances one second per stamp, so two
// runs of the same request sequence stamp identically.

import { RepoGit, buildCommit, parseCommit, type GitObjectType } from './git.ts';

/** The login the trial's bearer token names. The suite's scenario fixes this identity. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** An error a surface can answer directly: an HTTP status and a GitHub-shaped message. */
export class DomainError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TRIAL_NOW = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1000);
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
  return 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one
})();

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAtSec: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAtSec: number;
  updatedAtSec: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  createdAtSec: number;
  updatedAtSec: number;
  comments: Comment[];
}

/** One repository: its metadata, its git store, and its issues/pulls (one shared numbering). */
export class Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAtSec: number;
  readonly git: RepoGit;
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  private nextNumber = 1;

  constructor(
    id: number,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
    createdAtSec: number,
  ) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAtSec = createdAtSec;
    this.git = new RepoGit(defaultBranch);
  }

  get fullName(): string {
    return `${VIEWER.login}/${this.name}`;
  }

  takeNumber(): number {
    const number = this.nextNumber;
    this.nextNumber += 1;
    return number;
  }

  /** The issue or pull request carrying `number` (the two share one sequence, as on GitHub). */
  thread(number: number): Issue | Pull | undefined {
    return this.issues.get(number) ?? this.pulls.get(number);
  }
}

/** The whole forge: the viewer's repositories plus the id sequences and the logical clock. */
export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private pullSeq = 0;
  private clock = TRIAL_NOW;

  /** The next logical timestamp, in epoch seconds; every call advances the clock one second. */
  nowSec(): number {
    const value = this.clock;
    this.clock += 1;
    return value;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** The git identity line REST-side commits carry: the viewer, at a logical time. */
  ident(sec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
  }

  createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      throw new DomainError(422, `Repository creation failed: the name ${JSON.stringify(name)} is not a valid repository name`);
    }
    if (this.repos.has(name)) throw new DomainError(422, 'Repository already exists');
    this.repoSeq += 1;
    const repo = new Repo(
      this.repoSeq,
      name,
      options.description ?? '',
      options.private ?? false,
      options.defaultBranch !== undefined && options.defaultBranch !== '' ? options.defaultBranch : 'main',
      this.nowSec(),
    );
    this.repos.set(name, repo);
    return repo;
  }

  repo(name: string): Repo {
    const repo = this.repos.get(name);
    if (repo === undefined) throw new DomainError(404, 'Not Found');
    return repo;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

// ---------------------------------------------------------------------------------------------
// git-side operations the surfaces share

/** Resolve a branch name, a full ref or an object id to a commit oid, or undefined. */
export function resolveCommit(repo: Repo, ref: string): string | undefined {
  const git = repo.git;
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = git.refs.get(candidate);
    if (oid !== undefined) return git.peel(oid);
  }
  if (/^[0-9a-f]{40}$/.test(ref) && git.has(ref)) return git.peel(ref);
  return undefined;
}

/** The current tip of a branch (full ref name), or undefined while the branch is unborn. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.git.refs.get(`refs/heads/${branch}`);
}

/** Create a branch at a commit; the ref must be new and the target a commit. */
export function createBranch(repo: Repo, branch: string, sha: string): void {
  const git = repo.git;
  const ref = `refs/heads/${branch}`;
  if (git.refs.has(ref)) throw new DomainError(422, 'Reference already exists');
  const target = git.has(sha) ? git.peel(sha) : undefined;
  if (target === undefined || git.commitOf(target) === undefined) {
    throw new DomainError(422, 'Invalid sha: not a commit');
  }
  git.refs.set(ref, target);
}

export interface CommitResult {
  commitOid: string;
  blobOid: string;
  /** True when the file did not exist on the branch before this commit. */
  created: boolean;
}

/**
 * Commit one file's bytes on a branch (the contents API's write). A branch that does not
 * exist yet is created from the default branch's tip; the default branch itself may be
 * unborn, which makes this the repository's root commit. Updating an existing file needs
 * its current blob id as `sha`: a mismatch is a 409, a missing one a 422.
 */
export function commitFile(
  forge: Forge,
  repo: Repo,
  options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): CommitResult {
  const git = repo.git;
  const branch = options.branch !== undefined && options.branch !== '' ? options.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  let tip = git.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = git.refs.get(git.headRef);
  }
  const baseTree = tip === undefined ? git.put('tree', Buffer.alloc(0)) : git.treeOfCommit(tip);
  if (baseTree === null) throw new DomainError(422, 'the branch tip is not a commit');
  const files = git.flattenTree(baseTree!);
  const existing = files.get(options.path);
  if (existing !== undefined) {
    if (options.sha === undefined) throw new DomainError(422, `"sha" wasn't supplied`);
    if (options.sha.toLowerCase() !== existing.oid) {
      throw new DomainError(409, `${options.path} is at ${existing.oid}, but the supplied sha is ${options.sha}`);
    }
  } else if (options.sha !== undefined) {
    throw new DomainError(404, 'Not Found');
  }
  const blobOid = git.put('blob', options.content);
  files.set(options.path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const tree = git.buildTreeFromFiles(files);
  const stamp = forge.nowSec();
  const ident = forge.ident(stamp);
  const commitOid = git.put(
    'commit',
    buildCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      author: ident,
      committer: ident,
      message: options.message,
    }),
  );
  git.refs.set(ref, commitOid);
  return { commitOid, blobOid, created: existing === undefined };
}

/** Remove one file with a commit (the contents API's delete); the blob id must be current. */
export function deleteFile(
  forge: Forge,
  repo: Repo,
  options: { path: string; message: string; branch?: string; sha?: string },
): { commitOid: string } {
  const git = repo.git;
  const branch = options.branch !== undefined && options.branch !== '' ? options.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = git.refs.get(ref);
  if (tip === undefined) throw new DomainError(404, 'Not Found');
  const baseTree = git.treeOfCommit(tip);
  if (baseTree === null) throw new DomainError(422, 'the branch tip is not a commit');
  const files = git.flattenTree(baseTree);
  const existing = files.get(options.path);
  if (existing === undefined) throw new DomainError(404, 'Not Found');
  if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid) {
    throw new DomainError(409, `${options.path} is at ${existing.oid}, but the supplied sha is ${options.sha}`);
  }
  files.delete(options.path);
  const tree = git.buildTreeFromFiles(files);
  const stamp = forge.nowSec();
  const ident = forge.ident(stamp);
  const commitOid = git.put('commit', buildCommit({ tree, parents: [tip], author: ident, committer: ident, message: options.message }));
  git.refs.set(ref, commitOid);
  return { commitOid };
}

/** One file or directory read against a ref (branch name, full ref or sha; default branch when unset). */
export function readPath(
  repo: Repo,
  path: string,
  ref?: string,
): { kind: 'file'; blobOid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> } {
  const commit = resolveCommit(repo, ref ?? repo.defaultBranch);
  if (commit === undefined) throw new DomainError(404, 'Not Found');
  const tree = repo.git.treeOfCommit(commit);
  if (tree === null) throw new DomainError(404, 'Not Found');
  if (path === '') {
    const entries = repo.git.dirEntries(tree, '');
    if (entries === undefined) throw new DomainError(404, 'Not Found');
    return { kind: 'dir', entries };
  }
  const blobOid = repo.git.blobAtPath(tree, path);
  if (blobOid !== undefined) {
    const object = repo.git.get(blobOid);
    if (object === undefined) throw new DomainError(404, 'Not Found');
    return { kind: 'file', blobOid, data: object.data };
  }
  const entries = repo.git.dirEntries(tree, path);
  if (entries !== undefined) return { kind: 'dir', entries };
  throw new DomainError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues and pull requests

export function createIssue(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; labels?: readonly string[] },
): Issue {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new DomainError(422, `Label ${JSON.stringify(label)} does not exist`);
  }
  const stamp = forge.nowSec();
  const issue: Issue = {
    id: forge.nextIssueId(),
    number: repo.takeNumber(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    createdAtSec: stamp,
    updatedAtSec: stamp,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(forge: Forge, thread: Issue | Pull, body: string): Comment {
  const comment: Comment = { id: forge.nextCommentId(), body, createdAtSec: forge.nowSec() };
  thread.comments.push(comment);
  return comment;
}

/** The branch a pull-request head/base string names ('owner:branch' and 'refs/heads/x' included). */
export function branchNameOf(value: string): string {
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.lastIndexOf(':');
  if (colon > 0) name = name.slice(colon + 1);
  return name;
}

export function createPull(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull {
  const head = branchNameOf(input.head);
  const base = branchNameOf(input.base);
  if (branchTip(repo, head) === undefined) throw new DomainError(422, `Head ref ${JSON.stringify(input.head)} does not exist`);
  if (branchTip(repo, base) === undefined) throw new DomainError(422, `Base ref ${JSON.stringify(input.base)} does not exist`);
  if (head === base) throw new DomainError(422, 'Head and base must differ');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new DomainError(422, 'A pull request already exists for this head and base');
    }
  }
  const stamp = forge.nowSec();
  const pull: Pull = {
    id: forge.nextPullId(),
    number: repo.takeNumber(),
    title: input.title,
    body: input.body ?? '',
    headRef: head,
    baseRef: base,
    state: 'open',
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    createdAtSec: stamp,
    updatedAtSec: stamp,
    comments: [],
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

interface TreeMerge {
  conflict: boolean;
  files: Map<string, { oid: string; mode: string }>;
}

/** A file-level three-way merge of the head tree into the base tree, over their merge base. */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): TreeMerge {
  const git = repo.git;
  const base = git.mergeBase(baseTip, headTip);
  if (base === null) return { conflict: true, files: new Map() };
  const baseTree = git.treeOfCommit(baseTip);
  const headTree = git.treeOfCommit(headTip);
  const mergeTree = git.treeOfCommit(base);
  if (baseTree === null || headTree === null || mergeTree === null) return { conflict: true, files: new Map() };
  const baseFiles = git.flattenTree(baseTree);
  const headFiles = git.flattenTree(headTree);
  const ancestorFiles = git.flattenTree(mergeTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inAncestor = ancestorFiles.get(path);
    let winner: { oid: string; mode: string } | undefined;
    if (inBase?.oid === inHead?.oid) winner = inBase;
    else if (inAncestor?.oid === inBase?.oid) winner = inHead;
    else if (inAncestor?.oid === inHead?.oid) winner = inBase;
    else return { conflict: true, files: new Map() };
    if (winner !== undefined) merged.set(path, winner);
  }
  return { conflict: false, files: merged };
}

/** Whether a pull request would merge cleanly right now: 'MERGEABLE' or 'CONFLICTING'. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  if (repo.git.mergeBase(baseTip, headTip) === null) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Merge a pull request into its base branch: squash (one commit, the merged tree, the base
 * tip as its only parent) or a true merge commit. A conflict is a 405, as is a pull that is
 * not open. Answers the merge commit's sha.
 */
export function mergePull(forge: Forge, repo: Repo, pull: Pull, method: string): string {
  if (pull.state !== 'open') throw new DomainError(405, 'Pull Request is not mergeable');
  const git = repo.git;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) throw new DomainError(405, 'Pull Request is not mergeable');
  if (repo.git.mergeBase(baseTip, headTip) === null) throw new DomainError(405, 'Pull Request is not mergeable');
  const merge = threeWayMerge(repo, baseTip, headTip);
  if (merge.conflict) throw new DomainError(405, 'Pull Request is not mergeable');
  const tree = git.buildTreeFromFiles(merge.files);
  const stamp = forge.nowSec();
  const ident = forge.ident(stamp);
  let commitOid: string;
  if (method === 'merge') {
    commitOid = git.put(
      'commit',
      buildCommit({
        tree,
        parents: [baseTip, headTip],
        author: ident,
        committer: ident,
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      }),
    );
  } else {
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    commitOid = git.put(
      'commit',
      buildCommit({
        tree,
        parents: [baseTip],
        author: ident,
        committer: ident,
        message: `${pull.title} (#${pull.number})${body}`,
      }),
    );
  }
  git.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = stamp;
  pull.updatedAtSec = stamp;
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// diffs

/** Line counts between two texts: a longest-common-subsequence diff for small files. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i]![j] = oldLines[i] === newLines[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const common = table[0]![0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: its head tree against the merge base's tree. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const git = repo.git;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const mergeBase = git.mergeBase(baseTip, headTip) ?? baseTip;
  const fromTree = git.treeOfCommit(mergeBase);
  const toTree = git.treeOfCommit(headTip);
  if (fromTree === null || toTree === null) return [];
  const from = git.flattenTree(fromTree);
  const to = git.flattenTree(toTree);
  const changes: FileChange[] = [];
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before === undefined ? '' : (git.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (git.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Parse a git identity line into the REST author shape. */
export function identView(forge: Forge, ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: forge.iso(TRIAL_NOW) };
  return { name: match[1]!, email: match[2]!, date: forge.iso(Number(match[3])) };
}

export { parseCommit };
export type { GitObjectType };
