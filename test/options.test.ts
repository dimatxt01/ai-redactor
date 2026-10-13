import { describe, expect, it } from "vitest";
import { normalizeOptions } from "@/lib/options";
import { bleepIntervals } from "@/lib/pii/detect";

describe("job options fail safe", () => {
  it("fills every default when TR sends none", () => {
    expect(normalizeOptions({})).toEqual({
      bleep_pad_ms: 250, pitch_shift_customer: false, redact_health: true,
      clips: { enabled: true, max_per_call: 6, min_s: 20, max_s: 240 },
      coaching: { enabled: true, rubric: "fe_v1" }, customer_channel: 0,
    });
    expect(normalizeOptions(null).bleep_pad_ms).toBe(250);
  });

  it("clamps the pad and the clip count, keeps explicit choices", () => {
    const o = normalizeOptions({ bleep_pad_ms: 5000, pitch_shift_customer: true, redact_health: false, clips: { enabled: false, max_per_call: 40 } }, 1);
    expect(o.bleep_pad_ms).toBe(300);
    expect(o.pitch_shift_customer).toBe(true);
    expect(o.redact_health).toBe(false);
    expect(o.clips).toMatchObject({ enabled: false, max_per_call: 6 });
    expect(o.customer_channel).toBe(1);
    expect(normalizeOptions({ bleep_pad_ms: "x" }).bleep_pad_ms).toBe(250);
  });

  it("a missing pad still bleeps (regression: NaN intervals bleeped nothing)", () => {
    const span = { start_ms: 1000, end_ms: 1500 };
    const b = bleepIntervals([span as never], normalizeOptions({}).bleep_pad_ms, 10_000);
    expect(b.length).toBe(1);
    expect(b[0].start_ms).toBeLessThan(1000);
    expect(b[0].end_ms).toBeGreaterThan(1500);
  });
});
