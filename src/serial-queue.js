export class SerialQueue {
  #tail = Promise.resolve();
  #pending = 0;

  get pending() {
    return this.#pending;
  }

  run(task) {
    this.#pending += 1;
    const result = this.#tail.then(task, task);
    this.#tail = result
      .catch(() => undefined)
      .finally(() => {
        this.#pending -= 1;
      });
    return result;
  }

  idle() {
    return this.#tail;
  }
}
