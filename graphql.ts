// GraphQL v4 for the forge: a small self-contained parser and executor over the shared
// store. The suite's documents are fixed — viewer, repository fields and introspection
// probes, issue/pull connections with cursor paging, search, node(id:), and the
// createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations —
// so this implements exactly that grammar (operations, variables, aliases, fragments,
// enum/list/object arguments) and those types, with GitHub's error shapes: an unknown
// field is a 200 with an errors entry naming it, an unknown repository is data null.

import {
  Forge,
  Repo,
  DomainError,
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPull,
  mergePull,
  mergeableState,
  pullFiles,
  type Issue,
  type Pull,
} from './store.ts';
import { ZERO_OID } from './git.ts';

// ---------------------------------------------------------------------------------------------
// global ids: opaque, stable, typed — base64 of a typed payload, never the bare number

function gid(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

function repoGid(repo: Repo): string {
  return gid(`repository:${repo.id}`);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid(`issue:${repo.id}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid(`pullrequest:${repo.id}:${pull.number}`);
}

// ---------------------------------------------------------------------------------------------
// tokenizer + parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type SelectionNode =
  | { kind: 'field'; alias?: string; name: string; args: Record<string, ValueNode>; selectionSet?: SelectionNode[] }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  varDefaults: Record<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const text = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      tokens.push(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const rest = source.slice(i);
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name !== null) {
      tokens.push(name[0]);
      i += name[0].length;
      continue;
    }
    const number = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(rest);
    if (number !== null) {
      tokens.push(number[0]);
      i += number[0].length;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`Expected ${token}, got ${got}`);
  }

  private skipType(): void {
    // a type reference: Name, [Type], with optional trailing !
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', varDefaults: {}, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.next();
        const varDefaults: Record<string, ValueNode> = {};
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.skipType();
            if (this.peek() === '=') {
              this.next();
              varDefaults[varName] = this.parseValue();
            }
            if (this.peek() === '@') this.skipDirectives();
          }
          this.expect(')');
        }
        if (this.peek() === '@') this.skipDirectives();
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, varDefaults, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        if (this.peek() === '@') this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next();
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          if (this.peek() === '@') this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          if (this.peek() === '@') this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, ValueNode> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      if (this.peek() === '@') this.skipDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields[fieldName] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'scalar', value: JSON.parse(token) as unknown };
    if (token === 'true') return { kind: 'scalar', value: true };
    if (token === 'false') return { kind: 'scalar', value: false };
    if (token === 'null') return { kind: 'scalar', value: null };
    if (/^-?[0-9]/.test(token)) return { kind: 'scalar', value: Number(token) };
    return { kind: 'scalar', value: token }; // an enum literal
  }
}

function resolveValue(node: ValueNode | undefined, vars: Record<string, unknown>): unknown {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case 'var':
      return vars[node.name];
    case 'scalar':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// wrappers: every object value carries its GraphQL type name

interface Wrap {
  __gqlType: string;
  [key: string]: unknown;
}

function wrap(type: string, fields: Record<string, unknown>): Wrap {
  return { __gqlType: type, ...fields };
}

function userWrap(): Wrap {
  return wrap('User', { login: VIEWER.login });
}

function repoWrap(repo: Repo): Wrap {
  return wrap('Repository', { repo });
}

function issueWrap(repo: Repo, issue: Issue): Wrap {
  return wrap('Issue', { repo, issue });
}

function pullWrap(repo: Repo, pull: Pull): Wrap {
  return wrap('PullRequest', { repo, pull });
}

function cursorOf(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64');
}

function connectionWrap(itemType: string, all: Wrap[], args: Record<string, unknown>): Wrap {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : all.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const decoded = Number(Buffer.from(args.after, 'base64').toString('utf8'));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const page = all.slice(start, start + first);
  const hasNextPage = start + page.length < all.length;
  const endCursor = page.length > 0 ? cursorOf(start + page.length - 1) : null;
  return wrap(`${itemType}Connection`, {
    items: page,
    totalCount: all.length,
    pageInfo: wrap('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(start) : null,
      endCursor,
    }),
    edges: page.map((node, i) => wrap(`${itemType}Edge`, { node, cursor: cursorOf(start + i) })),
  });
}

function sortThreads<T extends { number: number; createdAtSec: number }>(items: T[], args: Record<string, unknown>): T[] {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (a.createdAtSec !== b.createdAtSec) return direction === 'ASC' ? a.createdAtSec - b.createdAtSec : b.createdAtSec - a.createdAtSec;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  return sorted;
}

// ---------------------------------------------------------------------------------------------
// introspection registry

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_REGISTRY: Record<string, TypeDef> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'repository', 'labels', 'comments', 'author', 'createdAt', 'updatedAt', 'closedAt'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
      'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'repository', 'author', 'createdAt', 'updatedAt',
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
      'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'url',
    ],
  },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function typeWrap(name: string): Wrap | null {
  const def = TYPE_REGISTRY[name];
  if (def === undefined) return null;
  return wrap('__Type', { typeName: name, def });
}

// ---------------------------------------------------------------------------------------------
// execution

interface Ctx {
  forge: Forge;
  vars: Record<string, unknown>;
  fragments: Document['fragments'];
  errors: Array<{ message: string }>;
}

function argsOf(node: { args: Record<string, ValueNode> }, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.args)) out[key] = resolveValue(value, ctx.vars);
  return out;
}

function executeSelectionSet(ctx: Ctx, typeName: string, value: Wrap | null, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(ctx, typeName, value, fragment.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, value, selection.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(ctx, typeName, value, selection.name, argsOf(selection, ctx));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (resolved === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, resolved, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, selectionSet?: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selectionSet));
  if (typeof value === 'object' && '__gqlType' in (value as Wrap)) {
    const wrapped = value as Wrap;
    if (selectionSet === undefined) return null;
    return executeSelectionSet(ctx, wrapped.__gqlType, wrapped, selectionSet);
  }
  return value;
}

function resolveField(ctx: Ctx, typeName: string, value: Wrap | null, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  switch (typeName) {
    case 'Query': {
      switch (field) {
        case 'viewer':
          return userWrap();
        case 'repository': {
          if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
          const repo = forge.repos.get(args.name);
          return repo === undefined ? null : repoWrap(repo);
        }
        case 'node': {
          if (typeof args.id !== 'string') return null;
          return nodeByGlobalId(forge, args.id);
        }
        case 'search': {
          const query = typeof args.query === 'string' ? args.query : '';
          return searchWrap(forge, query, args);
        }
        case '__type':
          return typeof args.name === 'string' ? typeWrap(args.name) : null;
        case '__schema':
          return wrap('__Schema', {});
        default:
          return undefined;
      }
    }
    case 'Mutation': {
      switch (field) {
        case 'createIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(forge, input.repositoryId);
          if (repo === null) throw new Error('Repository not found');
          const labelNames: string[] = [];
          if (Array.isArray(input.labelIds)) {
            for (const labelId of input.labelIds) {
              if (typeof labelId !== 'string') continue;
              const decoded = Buffer.from(labelId, 'base64').toString('utf8');
              const match = /^label:(\d+):(.*)$/.exec(decoded);
              if (match !== null && Number(match[1]) === repo.id && repo.labels.has(match[2]!)) labelNames.push(match[2]!);
            }
          }
          const issue = createIssue(forge, repo, {
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            labels: labelNames,
          });
          return wrap('CreateIssuePayload', { issue: issueWrap(repo, issue) });
        }
        case 'closeIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = threadByGlobalId(forge, input.issueId);
          if (found === null || 'headRef' in found.thread) throw new Error('Issue not found');
          const issue = found.thread as Issue;
          issue.state = 'closed';
          issue.updatedAtSec = forge.nowSec();
          return wrap('CloseIssuePayload', { issue: issueWrap(found.repo, issue) });
        }
        case 'createPullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(forge, input.repositoryId);
          if (repo === null) throw new Error('Repository not found');
          const pull = createPull(forge, repo, {
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            head: typeof input.headRefName === 'string' ? input.headRefName : '',
            base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
          });
          return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, pull) });
        }
        case 'mergePullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = threadByGlobalId(forge, input.pullRequestId);
          if (found === null || !('headRef' in found.thread)) throw new Error('Pull request not found');
          const pull = found.thread as Pull;
          mergePull(forge, found.repo, pull, typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH');
          return wrap('MergePullRequestPayload', { pullRequest: pullWrap(found.repo, pull) });
        }
        case 'addComment': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = threadByGlobalId(forge, input.subjectId);
          if (found === null) throw new Error('Subject not found');
          const comment = addComment(forge, found.thread, typeof input.body === 'string' ? input.body : '');
          const commentWrap = wrap('IssueComment', { repo: found.repo, comment });
          return wrap('AddCommentPayload', {
            comment: commentWrap,
            commentEdge: wrap('IssueCommentEdge', { node: commentWrap, cursor: cursorOf(0) }),
          });
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (field) {
        case 'login':
          return VIEWER.login;
        case 'id':
          return gid(`user:${VIEWER.id}`);
        case 'databaseId':
          return VIEWER.id;
        case 'name':
          return VIEWER.name;
        case 'email':
          return VIEWER.email;
        default:
          return undefined;
      }
    }
    case 'Repository': {
      const repo = value!.repo as Repo;
      switch (field) {
        case 'id':
          return repoGid(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'createdAt':
          return new Date(repo.createdAtSec * 1000).toISOString();
        case 'owner':
          return userWrap();
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return wrap('Ref', { repo, name: repo.defaultBranch, oid: tip ?? null });
        }
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueWrap(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = args.states.map((state) => String(state).toLowerCase());
            list = list.filter((issue) => wanted.includes(issue.state));
          }
          return connectionWrap('Issue', sortThreads(list, args).map((issue) => issueWrap(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : pullWrap(repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          if (Array.isArray(args.states)) {
            const wanted = args.states.map((state) => String(state));
            list = list.filter((pull) => wanted.includes(pullState(pull)));
          }
          return connectionWrap('PullRequest', sortThreads(list, args).map((pull) => pullWrap(repo, pull)), args);
        }
        default:
          return undefined;
      }
    }
    case 'Ref': {
      switch (field) {
        case 'name':
          return value!.name as string;
        case 'target':
          return typeof value!.oid === 'string' ? wrap('Commit', { oid: value!.oid }) : null;
        default:
          return undefined;
      }
    }
    case 'Commit': {
      if (field === 'oid') return value!.oid as string;
      return undefined;
    }
    case 'Issue': {
      const repo = value!.repo as Repo;
      const issue = value!.issue as Issue;
      switch (field) {
        case 'id':
          return issueGid(repo, issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'repository':
          return repoWrap(repo);
        case 'author':
          return userWrap();
        case 'createdAt':
          return forge.iso(issue.createdAtSec);
        case 'updatedAt':
          return forge.iso(issue.updatedAtSec);
        case 'labels': {
          const labels = issue.labels.map((name) => wrap('Label', { repo, name }));
          return connectionWrap('Label', labels, args);
        }
        default:
          return undefined;
      }
    }
    case 'Label': {
      const repo = value!.repo as Repo;
      switch (field) {
        case 'id':
          return gid(`label:${repo.id}:${value!.name as string}`);
        case 'name':
          return value!.name as string;
        case 'color':
          return repo.labels.get(value!.name as string)?.color ?? 'ededed';
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const repo = value!.repo as Repo;
      const pull = value!.pull as Pull;
      switch (field) {
        case 'id':
          return pullGid(repo, pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAtSec === null ? null : new Date(pull.mergedAtSec * 1000).toISOString();
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : wrap('Commit', { oid: pull.mergeCommitSha });
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return branchTip(repo, pull.headRef) ?? ZERO_OID;
        case 'baseRefOid':
          return branchTip(repo, pull.baseRef) ?? ZERO_OID;
        case 'mergeable':
          return pull.state === 'open' ? mergeableState(repo, pull) : 'UNKNOWN';
        case 'repository':
          return repoWrap(repo);
        case 'author':
          return userWrap();
        case 'createdAt':
          return new Date(pull.createdAtSec * 1000).toISOString();
        case 'updatedAt':
          return new Date(pull.updatedAtSec * 1000).toISOString();
        case 'files': {
          const files = pullFiles(repo, pull).map((file) =>
            wrap('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions }),
          );
          return connectionWrap('PullRequestChangedFile', files, args);
        }
        default:
          return undefined;
      }
    }
    case 'PullRequestChangedFile': {
      if (field === 'path' || field === 'additions' || field === 'deletions') return value![field] as unknown;
      return undefined;
    }
    case 'IssueComment': {
      const comment = value!.comment as { id: number; body: string };
      switch (field) {
        case 'id':
          return gid(`comment:${comment.id}`);
        case 'body':
          return comment.body;
        case 'author':
          return userWrap();
        default:
          return undefined;
      }
    }
    case 'PageInfo': {
      if (field === 'hasNextPage' || field === 'hasPreviousPage' || field === 'startCursor' || field === 'endCursor') return value![field] as unknown;
      return undefined;
    }
    case '__Type': {
      const def = value!.def as TypeDef;
      switch (field) {
        case 'name':
          return value!.typeName as string;
        case 'kind':
          return def.kind;
        case 'fields':
          return (def.fields ?? []).map((name) =>
            wrap('__Field', { fieldName: name }),
          );
        case 'enumValues':
          return (def.enumValues ?? []).map((name) => wrap('__EnumValue', { enumName: name }));
        case 'possibleTypes':
          return [];
        default:
          return undefined;
      }
    }
    case '__Field': {
      if (field === 'name') return value!.fieldName as string;
      if (field === 'args') return [];
      if (field === 'type') return wrap('__TypeRef', {});
      return undefined;
    }
    case '__TypeRef': {
      if (field === 'name') return 'String';
      if (field === 'kind') return 'SCALAR';
      if (field === 'ofType') return null;
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return value!.enumName as string;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case '__Schema': {
      if (field === 'queryType') return wrap('__Type', { typeName: 'Query', def: TYPE_REGISTRY.Query ?? { kind: 'OBJECT', fields: [] } });
      if (field === 'mutationType') return wrap('__Type', { typeName: 'Mutation', def: { kind: 'OBJECT', fields: [] } });
      if (field === 'types') return Object.keys(TYPE_REGISTRY).map((name) => typeWrap(name));
      return undefined;
    }
    default:
      break;
  }
  // connections and payloads resolve generically from their stored fields
  if (value !== null && (typeName.endsWith('Connection') || typeName.endsWith('Payload') || typeName.endsWith('Edge'))) {
    if (field === 'nodes' && Array.isArray(value.items)) return value.items;
    if (field === 'edges' && Array.isArray(value.edges)) return value.edges;
    if (field === 'pageInfo') return value.pageInfo as unknown;
    if (field === 'totalCount') return value.totalCount as unknown;
    if (field === 'issueCount' && typeof value.issueCount === 'number') return value.issueCount;
    if (field === 'node' && 'node' in value) return value.node as unknown;
    if (field === 'cursor' && 'cursor' in value) return value.cursor as unknown;
    if (field in value && field !== '__gqlType') return value[field] as unknown;
  }
  return undefined;
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function searchWrap(forge: Forge, query: string, args: Record<string, unknown>): Wrap {
  let repoName: string | undefined;
  let state: string | undefined;
  for (const token of query.split(/\s+/)) {
    if (token.startsWith('repo:')) {
      const parts = token.slice('repo:'.length).split('/');
      if (parts.length === 2 && parts[0] === VIEWER.login) repoName = parts[1];
    } else if (token === 'is:open') state = 'open';
    else if (token === 'is:closed') state = 'closed';
  }
  let issues: Wrap[] = [];
  if (repoName !== undefined) {
    const repo = forge.repos.get(repoName);
    if (repo !== undefined) {
      let list = [...repo.issues.values()];
      if (state !== undefined) list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      issues = list.map((issue) => issueWrap(repo, issue));
    }
  }
  const connection = connectionWrap('SearchResultItem', issues, args);
  connection.issueCount = issues.length;
  return connection;
}

function decodeGlobalId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  try {
    return Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const match = /^repository:(\d+)$/.exec(decoded);
  if (match === null) return null;
  for (const repo of forge.repos.values()) if (repo.id === Number(match[1])) return repo;
  return null;
}

function threadByGlobalId(forge: Forge, id: unknown): { repo: Repo; thread: Issue | Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const issueMatch = /^issue:(\d+):(\d+)$/.exec(decoded);
  if (issueMatch !== null) {
    for (const repo of forge.repos.values()) {
      if (repo.id !== Number(issueMatch[1])) continue;
      const issue = repo.issues.get(Number(issueMatch[2]));
      return issue === undefined ? null : { repo, thread: issue };
    }
    return null;
  }
  const pullMatch = /^pullrequest:(\d+):(\d+)$/.exec(decoded);
  if (pullMatch !== null) {
    for (const repo of forge.repos.values()) {
      if (repo.id !== Number(pullMatch[1])) continue;
      const pull = repo.pulls.get(Number(pullMatch[2]));
      return pull === undefined ? null : { repo, thread: pull };
    }
  }
  return null;
}

function nodeByGlobalId(forge: Forge, id: string): Wrap | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.startsWith('repository:')) {
    const repo = repoByGlobalId(forge, id);
    return repo === null ? null : repoWrap(repo);
  }
  if (decoded.startsWith('user:')) return userWrap();
  const thread = threadByGlobalId(forge, id);
  if (thread !== null) {
    return 'headRef' in thread.thread ? pullWrap(thread.repo, thread.thread as Pull) : issueWrap(thread.repo, thread.thread as Issue);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// entry point

/** Run one GraphQL request body (an object, or an array for batched operations). */
export function handleGraphQL(forge: Forge, raw: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => runOne(forge, entry)) };
  }
  return { status: 200, body: runOne(forge, parsed) };
}

function runOne(forge: Forge, entry: unknown): Record<string, unknown> {
  const request = (entry ?? {}) as Record<string, unknown>;
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, fallback] of Object.entries(operation.varDefaults)) {
    if (vars[name] === undefined) vars[name] = resolveValue(fallback, vars);
  }
  const ctx: Ctx = { forge, vars, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelectionSet(ctx, rootType, wrap(rootType, {}), operation.selectionSet);
    const body: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) body.errors = ctx.errors;
    return body;
  } catch (err) {
    if (err instanceof DomainError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
