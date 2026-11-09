import { describe, expect, it } from "vitest";
import { PaperBroker } from "../server/paper";

// file="" disables persistence so tests leave no data/ artefacts
const make = () => {
  const b = new PaperBroker(10, "");
  b.onPrices({ BTC: 100_000 });
  return b;
};

describe("paper broker", () => {
  it("opens with fees, marks to market and closes back to cash", async () => {
    const b = make();
    await b.open({ coin: "BTC", side: "long", size: 0.0003, leverage: 5 });
    let s = await b.snapshot();
    expect(s.positions).toHaveLength(1);
    expect(s.equity).toBeLessThan(10);
    b.onPrices({ BTC: 101_000 });
    s = await b.snapshot();
    expect(s.positions[0].unrealizedPnl).toBeGreaterThan(0);
    await b.close("BTC", "test");
    s = await b.snapshot();
    expect(s.positions).toHaveLength(0);
    expect(b.closedTrades()[0].pnl).toBeGreaterThan(0);
  });

  it("rejects orders beyond available margin", async () => {
    const b = make();
    await expect(b.open({ coin: "BTC", side: "long", size: 0.01, leverage: 5 })).rejects.toThrow(/margin/);
  });

  it("triggers the stop loss and records a negative trade", async () => {
    const b = make();
    await b.open({ coin: "BTC", side: "short", size: 0.0003, leverage: 5, stopPx: 101_000, takePx: 95_000 });
    b.onPrices({ BTC: 101_500 });
    const s = await b.snapshot();
    expect(s.positions).toHaveLength(0);
    expect(b.closedTrades()[0].exitReason).toBe("stop");
    expect(b.closedTrades()[0].pnl).toBeLessThan(0);
  });

  it("fills resting limit orders when price crosses", async () => {
    const b = make();
    await b.open({ coin: "BTC", side: "long", size: 0.0002, leverage: 3, limitPx: 99_000 });
    expect((await b.snapshot()).orders).toHaveLength(1);
    b.onPrices({ BTC: 98_900 });
    const s = await b.snapshot();
    expect(s.orders).toHaveLength(0);
    expect(s.positions[0].entryPx).toBe(99_000);
  });
});
