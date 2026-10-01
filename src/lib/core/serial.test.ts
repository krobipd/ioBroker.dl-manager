import { Serial } from "./serial";

describe("Serial", () => {
  it("starts a task only when the one before has settled", async () => {
    const serial = new Serial();
    const order: string[] = [];
    let release = (): void => undefined;
    const first = serial.run(
      () =>
        new Promise<void>(resolve => {
          order.push("first starts");
          release = () => {
            order.push("first ends");
            resolve();
          };
        }),
    );
    const second = serial.run(() => {
      order.push("second starts");
      return Promise.resolve();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first starts"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
  });

  it("hands each task's result or error to its caller and goes on after an error", async () => {
    const serial = new Serial();
    const failed = serial.run(() => Promise.reject(new Error("boom")));
    const next = serial.run(() => Promise.resolve(42));
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe(42);
  });

  it("is idle once every task queued so far has settled, a failed one too", async () => {
    const serial = new Serial();
    let done = false;
    void serial
      .run(() => Promise.reject(new Error("boom")))
      .catch(() => {
        done = true;
      });
    await serial.idle();
    expect(done).toBe(true);
  });
});
