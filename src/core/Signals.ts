/**
 * A tiny typed publish/subscribe bus.
 *
 * Systems talk to each other through this instead of holding references to one
 * another, which is what keeps `Progression` from ever having to know that a
 * HUD exists. Handlers are stored per event in insertion order, and `emit`
 * iterates a copy so a handler may safely unsubscribe itself mid-dispatch.
 */
export type Handler<T> = (payload: T) => void;

export class Signal<T = void> {
  private readonly handlers = new Set<Handler<T>>();

  /** Subscribe; returns a disposer. */
  on(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribe for exactly one dispatch. */
  once(handler: Handler<T>): () => void {
    const off = this.on((payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(handler: Handler<T>): void {
    this.handlers.delete(handler);
  }

  emit(payload: T): void {
    if (this.handlers.size === 0) return;
    for (const handler of [...this.handlers]) handler(payload);
  }

  clear(): void {
    this.handlers.clear();
  }

  get size(): number {
    return this.handlers.size;
  }
}
