import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { SdrErrorCode } from '../types.js';

export interface SdrError { code: SdrErrorCode; message: string }

export interface RunOptions {
  onLine?: (line: string) => void;
  onStderr?: (line: string) => void;
  onError?: (err: SdrError) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

const KILL_GRACE_MS = 3000;

/** Maps typical librtlsdr / rtl_433 stderr lines to user-facing errors. */
export function classifyStderr(line: string): SdrError | null {
  if (/usb_claim_interface error|Resource busy|LIBUSB_ERROR_BUSY|Device or resource busy/i.test(line)) {
    return { code: 'busy', message: 'El dongle està ocupat per un altre programa (usb_claim_interface). Tanca SDR++/GQRX/CubicSDR i torna-ho a provar.' };
  }
  if (/No supported devices found|No supported tuner found|Failed to open rtlsdr device/i.test(line)) {
    return { code: 'missing', message: 'No es detecta cap RTL-SDR. Comprova el cable USB i el hub.' };
  }
  if (/usb_open error|LIBUSB_ERROR_ACCESS|Permission denied/i.test(line)) {
    return { code: 'unknown', message: `Error USB: ${line.trim()}` };
  }
  return null;
}

/** All rtl_* child processes currently alive, so shutdown can reap them. */
const live = new Set<ChildProcess>();

export class SdrProcess {
  readonly child: ChildProcess;
  readonly bin: string;
  private exited = false;
  private exitPromise: Promise<void>;

  constructor(bin: string, args: string[], opts: RunOptions) {
    this.bin = bin;
    this.child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(this.child);

    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        live.delete(this.child);
        opts.onExit?.(code, signal);
        resolve();
      });
    });

    this.child.on('error', (e: NodeJS.ErrnoException) => {
      this.exited = true;
      live.delete(this.child);
      if (e.code === 'ENOENT') {
        opts.onError?.({ code: 'tool-missing', message: `No trobo "${bin}". Instal·la'l: brew install librtlsdr rtl_433` });
      } else {
        opts.onError?.({ code: 'unknown', message: e.message });
      }
    });

    if (this.child.stdout && opts.onLine) {
      readline.createInterface({ input: this.child.stdout }).on('line', opts.onLine);
    }
    if (this.child.stderr) {
      readline.createInterface({ input: this.child.stderr }).on('line', (l) => {
        opts.onStderr?.(l);
        const err = classifyStderr(l);
        if (err) opts.onError?.(err);
      });
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** SIGINT, then SIGKILL after 3 s. Resolves once the process has exited and released the USB device. */
  async stop(): Promise<void> {
    if (this.exited) return;
    this.child.kill('SIGINT');
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    await this.exitPromise;
    clearTimeout(timer);
    // Give libusb a moment to release the interface before another tool claims it.
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Synchronous best-effort reap used on fatal shutdown paths. */
export function killAllSync(): void {
  for (const c of live) {
    try { c.kill('SIGINT'); } catch { /* ignore */ }
  }
  for (const c of live) {
    try { c.kill('SIGKILL'); } catch { /* ignore */ }
  }
  live.clear();
}

export async function stopAll(): Promise<void> {
  const procs = [...live];
  for (const c of procs) {
    try { c.kill('SIGINT'); } catch { /* ignore */ }
  }
  await Promise.race([
    Promise.all(procs.map((c) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode ? r() : c.once('exit', () => r()))))),
    new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS)),
  ]);
  for (const c of procs) {
    if (c.exitCode === null && !c.signalCode) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  live.clear();
}
