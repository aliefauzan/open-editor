// Starts the engine host in a utilityProcess, talks to it over a MessagePort, restarts it when it
// crashes (app spec "Error handling"); the renderer then shows a banner and reloads the project.
import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron';
import { createClient, type Client, type PortLike } from '../engine-host/rpc.ts';
import { appError, type EventName, type Method } from '../shared/api.ts';

export interface HostRoots {
  projectsDir: string;
  stylesDirs: string[];
}

export interface HostOptions {
  entry: string;
  init: { builtinStyles: string };
  onEvent: (name: EventName, payload: unknown) => void;
  onRestart: (info: { code: number; restarts: number }) => void;
  log: (line: string) => void;
}

/** More than this many crashes within a minute stops the restarts. */
const MAX_RESTARTS_PER_MIN = 5;

export class EngineHost {
  private child: UtilityProcess | null = null;
  private client: Client | null = null;
  private readyP: Promise<HostRoots> | null = null;
  private stopping = false;
  private crashes: number[] = [];
  restarts = 0;
  roots: HostRoots | null = null;

  constructor(private readonly opts: HostOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<HostRoots> {
    const child = utilityProcess.fork(this.opts.entry, [], {
      serviceName: 'Vox Studio Engine',
      stdio: 'pipe',
    });
    child.stdout?.on('data', (d: Buffer) => this.opts.log(`[engine] ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => this.opts.log(`[engine] ${String(d).trimEnd()}`));
    const { port1, port2 } = new MessageChannelMain();
    const port = port1 as unknown as PortLike;
    this.child = child;
    this.client = createClient(port, this.opts.onEvent);
    this.readyP = new Promise<HostRoots>((resolve, reject) => {
      port.on('message', (m: unknown) => {
        const ready = (m as { data?: { ready?: HostRoots } }).data?.ready;
        if (ready) {
          this.roots = { projectsDir: ready.projectsDir, stylesDirs: ready.stylesDirs };
          resolve(this.roots);
        }
      });
      child.once('exit', (code) => reject(new Error(`engine host exited (${code}) before ready`)));
    });
    this.readyP.catch(() => {});
    child.postMessage(this.opts.init, [port2]);
    child.once('exit', (code) => this.onExit(child, code));
    return this.readyP;
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (child !== this.child) return;
    this.client?.close(appError('HOST_UNAVAILABLE', `The engine stopped (exit ${code})`));
    this.client = null;
    this.child = null;
    if (this.stopping) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > MAX_RESTARTS_PER_MIN) {
      this.opts.log(`engine host crashed ${this.crashes.length} times in a minute; not restarting`);
      return;
    }
    this.restarts++;
    this.opts.log(`engine host exited (${code}); restart ${this.restarts}`);
    this.start().then(
      () => this.opts.onRestart({ code, restarts: this.restarts }),
      (e: unknown) => this.opts.log(`engine host restart failed: ${String(e)}`),
    );
  }

  async call(method: Method, args: unknown[]): Promise<unknown> {
    if (this.readyP) await this.readyP.catch(() => {});
    if (!this.client) throw appError('HOST_UNAVAILABLE', 'The engine is not running');
    return this.client.call(method, args);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }
}
