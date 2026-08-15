import { randomUUID } from 'node:crypto';

import { event } from './shared.js';

export class MockAdapter {
  constructor(options = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  async open(profile, options = {}) {
    const nativeSessionId = options.nativeSessionId ?? `mock-${randomUUID()}`;
    const onEvent = options.onEvent;
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: true },
      prompt: async (text) => {
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        onEvent?.(event('assistant_delta', { text: `mock: ${text}` }));
        return { text: `mock: ${text}`, nativeSessionId };
      },
      close: async () => undefined,
    };
  }
}
