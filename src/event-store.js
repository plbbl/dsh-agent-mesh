import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { MeshError } from './errors.js';
import { SerialQueue } from './serial-queue.js';

const STORE_VERSION = 1;

function defaultRoot() {
  return join(homedir(), '.dsh', 'agent-mesh');
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export class EventStore {
  constructor(root = defaultRoot(), options = {}) {
    this.root = root;
    this.logPath = join(root, 'events.jsonl');
    this.snapshotPath = join(root, 'snapshot.json');
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? 128);
    this.durability = options.durability ?? 'batch';
    this.queue = new SerialQueue();
    this.handle = undefined;
    this.state = undefined;
    this.seq = 0;
    this.sinceSnapshot = 0;
    this.opened = false;
  }

  async open(initialState, applyEvent) {
    if (this.opened) return this.state;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const snapshot = await readJsonIfPresent(this.snapshotPath);
    this.state = snapshot?.state ?? structuredClone(initialState);
    this.seq = Number(snapshot?.seq ?? 0);

    let log = '';
    try {
      log = await readFile(this.logPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A process can die during the final write. Earlier complete records remain valid.
        continue;
      }
      if (!Number.isSafeInteger(event?.seq) || event.seq <= this.seq) continue;
      applyEvent(this.state, event);
      this.seq = event.seq;
    }

    this.handle = await open(this.logPath, 'a+');
    await chmod(this.logPath, 0o600);
    this.opened = true;
    return this.state;
  }

  async append(type, data, applyEvent) {
    if (!this.opened) throw new MeshError('STORE_NOT_OPEN', 'The event store is not open.');
    return this.queue.run(async () => {
      const event = {
        v: STORE_VERSION,
        seq: this.seq + 1,
        ts: Date.now(),
        type,
        data,
      };
      const line = `${JSON.stringify(event)}\n`;
      await this.handle.write(line, undefined, 'utf8');
      if (this.durability === 'sync') await this.handle.sync();
      this.seq = event.seq;
      applyEvent(this.state, event);
      this.sinceSnapshot += 1;
      if (this.sinceSnapshot >= this.snapshotEvery) await this.#snapshotLocked();
      return event;
    });
  }

  async snapshot() {
    if (!this.opened) return;
    return this.queue.run(() => this.#snapshotLocked());
  }

  async #snapshotLocked() {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      seq: this.seq,
      state: this.state,
    });
    const temporary = `${this.snapshotPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.snapshotPath);
    await this.handle.truncate(0);
    if (this.durability === 'sync') await this.handle.sync();
    this.sinceSnapshot = 0;
  }

  async close() {
    if (!this.opened) return;
    await this.queue.idle();
    await this.snapshot();
    await this.queue.idle();
    await this.handle.close();
    this.opened = false;
  }
}

export { defaultRoot as defaultStoreRoot };
