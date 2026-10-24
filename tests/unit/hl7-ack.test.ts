import { afterEach, expect, it, vi } from "vitest";
import { buildAck } from "@/lib/hl7/ack";

afterEach(() => {
  vi.useRealTimers();
});

it("ACK の MSH-7 は固定日時のローカル時刻をオフセットなしで返す", () => {
  const date = new Date("2026-10-24T12:16:55Z");
  vi.useFakeTimers();
  vi.setSystemTime(date);
  const expected = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("");
  expect(buildAck("AA", "ok").split("|")[6]).toBe(expected);
});
