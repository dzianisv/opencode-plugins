// counter.ts

/**
 * Counter class that provides a simple counter with increment and getCount methods.
 */
export class Counter {
  // Private field to store the count value
  private count: number;

  /**
   * Constructor to initialize the counter value (default is 0).
   */
  constructor(initialCount: number = 0) {
    this.count = initialCount;
  }

  /**
   * Method to increment the counter value by 1.
   */
  public increment(): void {
    this.count += 1;
  }

  /**
   * Method to retrieve the current counter value.
   */
  public getCount(): number {
    return this.count;
  }
}