export class MiniLoadBalancer<T> {
  private cursor = 0;

  constructor(private readonly targets: T[]) {}

  next(): T {
    if (this.targets.length === 0) {
      throw new Error("No targets configured");
    }
    const target = this.targets[this.cursor % this.targets.length];
    this.cursor = (this.cursor + 1) % this.targets.length;
    return target;
  }

  size(): number {
    return this.targets.length;
  }
}
