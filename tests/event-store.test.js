import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventStore } from '../src/event-store.js';

test('event store replays and atomically compacts state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-store-'));
  const apply = (state, event) => { state.values.push(event.data.value); };
  try {
    const first = new EventStore(root, { snapshotEvery: 2, durability: 'sync' });
    await first.open({ values: [] }, apply);
    await first.append('value', { value: 'a' }, apply);
    await first.append('value', { value: 'b' }, apply);
    assert.deepEqual(first.state.values, ['a', 'b']);
    assert.notEqual((await readFile(join(root, 'snapshot.json'), 'utf8')).length, 0);
    await first.append('value', { value: 'c' }, apply);
    await first.close();

    const second = new EventStore(root, { snapshotEvery: 2 });
    await second.open({ values: [] }, apply);
    assert.deepEqual(second.state.values, ['a', 'b', 'c']);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
