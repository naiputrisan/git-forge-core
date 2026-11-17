// The MCP endpoint: JSON-RPC 2.0 at POST /mcp, in both wire eras — the modern
// server/discover handshake (protocol 2026-07-28) and the legacy initialize. The tools are
// thin wrappers over the same store the REST API uses, so an issue created over MCP is the
// issue REST reads back, with the same ids. tools/list is built once as a constant: two
// calls must answer byte-identically.

import {
  Forge,
  Repo,
  DomainError,
  VIEWER,
  createIssue,
  createPull,
  mergePull,
  type Issue,
  type Pull,
} from './store.ts';

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing changes from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
  },
];

/** The tools/list result, serialized once: identical bytes on every call. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
});

const SERVER_INFO = { name: 'coreforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcReply {
  status: number;
  body: Record<string, unknown>;
}

function result(id: unknown, value: unknown): RpcReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: VIEWER.login, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef },
    base: { ref: pull.baseRef },
    html_url: `/${repo.fullName}/pull/${pull.number}`,
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) throw new RpcFailure(-32602, `Unknown tool: ${name}`);
  for (const key of def.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new RpcFailure(-32602, `Missing required argument: ${key}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(stringArg(args, 'name')!, {
          description: stringArg(args, 'description') ?? '',
          private: typeof args.private === 'boolean' ? args.private : false,
        });
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(ownedRepo(forge, args)));
      }
      case 'create_issue': {
        const repo = ownedRepo(forge, args);
        const issue = createIssue(forge, repo, {
          title: stringArg(args, 'title')!,
          body: stringArg(args, 'body') ?? '',
          labels: [],
        });
        return toolResult(issueJson(issue));
      }
      case 'list_issues': {
        const repo = ownedRepo(forge, args);
        const state = stringArg(args, 'state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => b.number - a.number);
        return toolResult(list.map(issueJson));
      }
      case 'create_pull_request': {
        const repo = ownedRepo(forge, args);
        const pull = createPull(forge, repo, {
          title: stringArg(args, 'title')!,
          body: stringArg(args, 'body') ?? '',
          head: stringArg(args, 'head')!,
          base: stringArg(args, 'base')!,
        });
        return toolResult(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = ownedRepo(forge, args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolError(`Pull request ${number} not found`);
        const sha = mergePull(forge, repo, pull, 'squash');
        return toolResult({ ...pullJson(repo, pull), sha, merged: true, message: 'Pull Request successfully merged' });
      }
      default:
        throw new RpcFailure(-32602, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    throw err;
  }
}

function ownedRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  if (owner !== VIEWER.login || name === undefined) throw new DomainError(404, 'Not Found');
  return forge.repo(name);
}

class RpcFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Handle one MCP request body. Returns null when the body held only notifications
 * (the caller answers 202 Accepted with no body), otherwise the JSON-RPC reply.
 */
export async function handleMcp(forge: Forge, method: string, raw: Buffer): Promise<RpcReply | null> {
  if (method === 'GET' || method === 'DELETE') {
    return { status: 200, body: { jsonrpc: '2.0', id: null, result: {} } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const replies: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const reply = dispatch(forge, message);
    if (reply !== null) replies.push(reply.body);
  }
  if (replies.length === 0) return null;
  return { status: 200, body: (Array.isArray(parsed) ? (replies as unknown as Record<string, unknown>) : replies[0]!) };
}

function dispatch(forge: Forge, message: unknown): RpcReply | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32600, 'Invalid Request');
  const request = message as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'server/discover':
        return result(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
        });
      case 'initialize': {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        return result(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18',
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, JSON.parse(TOOLS_LIST_JSON) as unknown);
      case 'tools/call': {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        return result(id, callTool(forge, name, args));
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcFailure) return rpcError(id, err.code, err.message);
    if (err instanceof DomainError) return rpcError(id, -32602, err.message);
    return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}
