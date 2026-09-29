import { FakeAdapter } from "../../../test/helpers/fake-adapter";
import { KnownStates } from "./states";

const NS = "dl-manager.0";

async function setup(): Promise<{ a: FakeAdapter; k: KnownStates }> {
  const a = new FakeAdapter(NS);
  await a.extendObject("dev.online", {
    type: "state",
    common: { name: "o", role: "indicator.reachable", write: false },
  });
  await a.extendObject("dev.paused", { type: "state", common: { name: "p", role: "switch", write: true } });
  const k = new KnownStates(a, id => a.objects.get(id)?.common.write === false);
  return { a, k };
}

describe("KnownStates", () => {
  it("compares a read-only state in memory: no database read, a write only on a difference", async () => {
    const { a, k } = await setup();
    await a.setState("dev.online", { val: true, ack: true });
    await k.load();
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    expect(a.stateWrites).toBe(0);
    await k.put(`${NS}.dev.online`, { val: false, ack: true });
    await k.put("dev.online", { val: false, ack: true });
    expect(a.stateWrites).toBe(1);
    expect(a.changedChecks).toBe(0);
  });

  it("writes a read-only state again when only ack or quality differ", async () => {
    const { a, k } = await setup();
    await a.setState("dev.online", { val: true, ack: false });
    await k.load();
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    await k.put("dev.online", { val: true, ack: true, q: 0x02 });
    expect(a.stateWrites).toBe(2);
  });

  it("leaves a writable state to the database compare", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.put("dev.paused", { val: false, ack: true });
    await k.put("dev.paused", { val: false, ack: true });
    expect(a.changedChecks).toBe(2);
    expect(a.stateWrites).toBe(1);
  });

  it("knows what an unconditional write stored", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.set("dev.online", { val: true, ack: true });
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    expect(a.stateWrites).toBe(0);
  });
});
