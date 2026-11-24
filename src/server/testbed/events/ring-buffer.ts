/**
 * Fixed-capacity buffer that drops the oldest item when full
 * (`TESTBED_EVENT_BUFFER`, docs/testbed/events.md §1).
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    if (this.size < this.capacity) {
      this.items[(this.start + this.size) % this.capacity] = item;
      this.size += 1;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.size; i += 1) {
      out.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return out;
  }
}
