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
  const k = new KnownStates(a);
  return { a, k };
}

describe("KnownStates", () => {
  it("compares in memory: no database read, a write only on a difference", async () => {
    const { a, k } = await setup();
    await a.setState("dev.online", { val: true, ack: true });
    await a.setState("dev.paused", { val: false, ack: true });
    await k.load();
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    await k.put("dev.paused", { val: false, ack: true });
    expect(a.stateWrites).toBe(0);
    await k.put(`${NS}.dev.online`, { val: false, ack: true });
    await k.put("dev.online", { val: false, ack: true });
    expect(a.stateWrites).toBe(1);
    expect(a.changedChecks).toBe(0);
  });

  it("writes again when only ack or quality differ", async () => {
    const { a, k } = await setup();
    await a.setState("dev.online", { val: true, ack: false });
    await k.load();
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    await k.put("dev.online", { val: true, ack: true, q: 0x02 });
    expect(a.stateWrites).toBe(2);
  });

  it("writes a state it never saw", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.put("dev.paused", { val: false, ack: true });
    await k.put("dev.paused", { val: false, ack: true });
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

  it("writes the program's value again after someone else wrote the state (a lost command is corrected)", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.put("dev.paused", { val: false, ack: true });
    await a.setState("dev.paused", { val: true, ack: false });
    k.forget(`${NS}.dev.paused`);
    await k.put("dev.paused", { val: false, ack: true });
    expect(a.states.get(`${NS}.dev.paused`)).toMatchObject({ val: false, ack: true });
  });

  it("writes every value again once its object was deleted — js-controller deleted the value too", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.put("dev.online", { val: true, ack: true });
    await k.put("dev.paused", { val: false, ack: true });
    await k.put("devx.online", { val: true, ack: true });
    await a.delObject("dev", { recursive: true });
    k.remove("dev", { recursive: true });
    a.stateWrites = 0;
    await k.put("dev.online", { val: true, ack: true });
    await k.put("dev.paused", { val: false, ack: true });
    await k.put("devx.online", { val: true, ack: true });
    expect(a.stateWrites).toBe(2);
  });

  it("forgets only the object itself without recursive", async () => {
    const { a, k } = await setup();
    await k.load();
    await k.put("dev", { val: 1, ack: true });
    await k.put("dev.online", { val: true, ack: true });
    k.remove(`${NS}.dev`, { recursive: false });
    a.stateWrites = 0;
    await k.put("dev", { val: 1, ack: true });
    await k.put("dev.online", { val: true, ack: true });
    expect(a.stateWrites).toBe(1);
  });
});
