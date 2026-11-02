/**
 * Prozessinterner, schlüsselbasierter Mutex. Serialisiert konkurrierende
 * Interaktionen (z. B. Doppelklicks) auf dasselbe Objekt. Die Datenbank sichert
 * zusätzlich über bedingte Updates und eindeutige Constraints ab.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Wie run(), bricht aber sofort ab, wenn der Schlüssel bereits belegt ist. */
  async tryRun<T>(key: string, fn: () => Promise<T> | T): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.tails.has(key)) return { ran: false };
    const value = await this.run(key, fn);
    return { ran: true, value };
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
