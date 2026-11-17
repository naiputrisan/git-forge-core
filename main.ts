// Entry point: the wire between this program and the trial environment.
//
// The arrangement is asymmetric. The env sits at a fixed origin of its own
// and the entry must never claim that address; instead the entry asks the
// kernel for any free port, tells the env which port it got, and then stays
// alive — answering whatever the env sends — until the env declares the
// trial finished. Only at that point may the process shut down.
//
// The conversation, in order:
//
//   - Where the env lives arrives in MAKEFUN_ENV_URL. If that variable is
//     missing or blank there is no trial to join, so the process writes a
//     complaint to stderr and exits 1 without starting anything.
//   - The HTTP app built by app.ts is started on port 0, which lets the
//     kernel pick the port; the pick is read back off the bound server.
//   - The port is announced with POST /register carrying {"port": N}. The
//     env identifies the caller by the connection the request arrived on,
//     so the first announcement is the one that sticks: a 200 confirms it
//     and a 409 means an earlier registration already won — both end the
//     announcing. A 400 or a 405 says the request itself broke the
//     contract, which is fatal. Anything else (a refused connection, a
//     timeout, an unexpected status) is read as "the env is still waking
//     up" and the announcement is tried again after a pause.
//   - GET /done is polled for the rest of the process's life. While the
//     trial runs the answer is {"done": false}; the process keeps asking,
//     with pauses that double from 250 ms up to a 2 s ceiling, until the
//     answer is {"done": true}. A failed poll is just another "not yet".
//   - Once done is confirmed the server is closed and the process exits 0.
//
// The module depends on app.ts and nothing else: no third-party package,
// no Node built-in, no model call.

import { createApp } from './app.ts';

/** Milliseconds one env request may run before that attempt is abandoned. */
const ENV_REQUEST_LIMIT_MS = 30_000;

/** Retry pauses start at the floor and double per failure up to the ceiling. */
const PAUSE_FLOOR_MS = 250;
const PAUSE_CEILING_MS = 2_000;

/** The env's origin with trailing slashes stripped; '' when the variable is unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/** Promise-flavoured setTimeout, for the pauses between retries. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The pause to use after one more failure: double the previous one, but
 * never beyond the ceiling. From the floor this yields 250, 500, 1000,
 * 2000, 2000, …
 */
function growPause(current: number): number {
  return Math.min(PAUSE_CEILING_MS, current * 2);
}

/** How a single register attempt turned out, so the retry loop stays readable. */
type RegisterOutcome = 'accepted' | 'retry';

/**
 * Make one POST /register attempt and report whether it settled the matter.
 * Contract-level rejections (400, 405) are thrown instead of reported: no
 * amount of retrying repairs a malformed announcement.
 */
async function tryRegisterOnce(origin: string, port: number): Promise<RegisterOutcome> {
  let response: Response;
  try {
    response = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(ENV_REQUEST_LIMIT_MS),
    });
  } catch {
    // Nothing answered at all — the env may not be listening yet.
    return 'retry';
  }
  if (response.status === 200 || response.status === 409) return 'accepted';
  if (response.status === 400 || response.status === 405) {
    const detail = await response.text();
    throw new Error(`register answered HTTP ${response.status}: ${detail}`);
  }
  return 'retry';
}

/** Announce the bound port, retrying transient failures until the env accepts it. */
async function announcePort(origin: string, port: number): Promise<void> {
  let wait = PAUSE_FLOOR_MS;
  for (;;) {
    const outcome = await tryRegisterOnce(origin, port);
    if (outcome === 'accepted') return;
    await pause(wait);
    wait = growPause(wait);
  }
}

/** Ask the env once whether the trial is over; any hiccup counts as "not yet". */
async function askIfDone(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/done`, {
      signal: AbortSignal.timeout(ENV_REQUEST_LIMIT_MS),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { done?: unknown };
    return payload.done === true;
  } catch {
    return false;
  }
}

/** Poll the env until it confirms the trial is over; this never returns early. */
async function waitUntilDone(origin: string): Promise<void> {
  let wait = PAUSE_FLOOR_MS;
  while (!(await askIfDone(origin))) {
    await pause(wait);
    wait = growPause(wait);
  }
}

/** Start the app on a kernel-chosen port; resolves with the server and its port. */
async function startServing(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, () => {
      resolveStart();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: bound.port };
}

/** The whole life of the process: join the env, serve, and leave when told. */
async function runLifecycle(): Promise<void> {
  const origin = envOrigin();
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }

  const { server, port } = await startServing();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(origin, port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone(origin);
  server.close();
  process.stdout.write('[entry] done\n');
}

runLifecycle().then(
  () => {
    process.exit(0);
  },
  (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write(`[entry] ${message}\n`);
    process.exit(1);
  },
);
