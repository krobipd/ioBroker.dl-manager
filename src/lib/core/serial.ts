/** Runs tasks one after the other: a task starts when the one before has settled, whatever its result. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * @param task the work, started when every task queued before has settled
   * @returns the task's own result
   */
  public run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** @returns when every task queued so far has settled */
  public async idle(): Promise<void> {
    await this.tail;
  }
}
