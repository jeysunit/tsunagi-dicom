import { describe, expect, it } from "vitest";
import { createMockBackend } from "@/lib/backend/mock";
import { collectReceivedInPeriod, type OrthancChange, type OrthancChanges } from "@/lib/backend/orthanc-rest";
import { RECEIVE_FIELDS, ROLE_FIELD_ALLOWLIST, type FieldAllowlistMap } from "@/lib/fields";
import { RECEIVE_LIMIT, receiveLogView } from "@/lib/receive-log";
import { ReceivePeriodError, receivePeriodQuery, resolveReceivePeriod } from "@/lib/receive-period";

// 受信一覧の期間（docs/spec.md の 3.3）：期間の境（サーバーの時間帯の 0 時）、変更の記録の遡り方（止め方・上限・読めないとき）、
// 画面の API の項目（役割の許可の一覧）。

const TOKYO = "Asia/Tokyo";
const at = (iso: string) => Date.parse(iso);

describe("期間の境（resolveReceivePeriod）", () => {
  // 2026-10-26 00:30（JST）＝ 2026-10-25 15:30（UTC）
  const now = at("2026-10-25T15:30:00Z");

  it("今日・昨日・過去7日は、サーバーの時間帯（Asia/Tokyo）の 0 時を境にする（UTC の日付ではない）", () => {
    expect(resolveReceivePeriod({}, TOKYO, now)).toEqual({
      kind: "today",
      from: "2026-10-26",
      to: "2026-10-26",
      fromMs: at("2026-10-25T15:00:00Z"),
      toMs: at("2026-10-26T15:00:00Z"),
    });
    expect(resolveReceivePeriod({ period: "yesterday" }, TOKYO, now)).toMatchObject({
      from: "2026-10-25",
      to: "2026-10-25",
      fromMs: at("2026-10-24T15:00:00Z"),
      toMs: at("2026-10-25T15:00:00Z"),
    });
    expect(resolveReceivePeriod({ period: "7d" }, TOKYO, now)).toMatchObject({
      from: "2026-10-20",
      to: "2026-10-26",
      fromMs: at("2026-10-19T15:00:00Z"),
      toMs: at("2026-10-26T15:00:00Z"),
    });
  });

  it("期間を指定は、開始日の 0 時を含み、終了日の翌日の 0 時を含まない。月と年をまたいでもずれない", () => {
    expect(resolveReceivePeriod({ period: "range", from: "2026-12-31", to: "2027-01-01" }, TOKYO, now)).toMatchObject({
      fromMs: at("2026-12-30T15:00:00Z"),
      toMs: at("2027-01-01T15:00:00Z"),
    });
    expect(resolveReceivePeriod({ period: "range", from: "2028-02-29", to: "2028-02-29" }, TOKYO, now)).toMatchObject({
      toMs: at("2028-02-29T15:00:00Z"),
    });
  });

  it("夏時間のある時間帯でも、その日の 0 時を境にする", () => {
    // 2026-03-08 は America/New_York の夏時間の始まり（0 時は -05:00、翌日の 0 時は -04:00）
    expect(resolveReceivePeriod({ period: "range", from: "2026-03-08", to: "2026-03-08" }, "America/New_York", now)).toMatchObject({
      fromMs: at("2026-03-08T05:00:00Z"),
      toMs: at("2026-03-09T04:00:00Z"),
    });
  });

  it("読めない期間は ReceivePeriodError（種類・日付の形・暦に無い日・開始日が終了日より後）", () => {
    for (const q of [
      { period: "week" },
      { period: "" },
      { period: "range" },
      { period: "range", from: "2026-10-17" },
      { period: "range", from: "2026/10/17", to: "2026-10-17" },
      { period: "range", from: "2026-02-30", to: "2026-03-01" },
      { period: "range", from: "2026-10-18", to: "2026-10-17" },
    ]) {
      expect(() => resolveReceivePeriod(q, TOKYO, now), JSON.stringify(q)).toThrow(ReceivePeriodError);
    }
  });

  it("URL の問い合わせ：今日は何も付けず、期間を指定は開始日と終了日を付ける", () => {
    expect(String(receivePeriodQuery({ kind: "today", from: "2026-10-26", to: "2026-10-26" }))).toBe("");
    expect(String(receivePeriodQuery({ kind: "7d", from: "2026-10-20", to: "2026-10-26" }))).toBe("period=7d");
    expect(String(receivePeriodQuery({ kind: "range", from: "2026-10-17", to: "2026-10-18" }))).toBe("period=range&from=2026-10-17&to=2026-10-18");
  });
});

/** 変更の記録を持つ Orthanc の代わり。1 回に返す数を max で切り詰める。読んだ since を calls に残す */
function fakeChanges(changes: OrthancChange[], max = 1000) {
  const calls: number[] = [];
  const last = changes.at(-1)?.seq ?? 0;
  const fetchPage = async (since: number, limit: number): Promise<OrthancChanges> => {
    calls.push(since);
    const part = changes.filter((c) => c.seq > since).slice(0, Math.min(limit, max));
    const pageLast = part.at(-1)?.seq ?? since;
    return { changes: part, last: pageLast, done: pageLast >= last };
  };
  return { fetchPage, calls, last };
}

const id = (n: number) => `${String(n).padStart(8, "0")}-00000000-00000000-00000000-00000000`;
/** Orthanc の時刻の形（YYYYMMDDTHHMMSS。UTC） */
const orthanc = (iso: string) => iso.replace(/[-:]/g, "").replace(/\..*$/, "").replace(/Z$/, "");
const study = (seq: number, n: number, iso: string, changeType = "StableStudy"): OrthancChange => ({
  seq,
  changeType,
  resourceType: "Study",
  id: id(n),
  date: orthanc(iso),
});
const noise = (seq: number, iso: string): OrthancChange => ({ seq, changeType: "NewInstance", resourceType: "Instance", id: id(999_999), date: orthanc(iso) });
const OPTS = { block: 10, pageLimit: 1000, maxCalls: 200 };
/** 2026-10-26（JST）の 1 日 */
const DAY = { fromMs: at("2026-10-25T15:00:00Z"), toMs: at("2026-10-26T15:00:00Z") };

describe("変更の記録の遡り（collectReceivedInPeriod）", () => {
  it("新しい側から区切りごとに遡り、期間の始まりより古い出来事に当たったら止める（それより古い区切りは読まない）", async () => {
    const changes: OrthancChange[] = [];
    // 番号 1〜100：前の日の出来事。101〜130：期間の中の検査 15 件（NewStudy と StableStudy）
    for (let s = 1; s <= 100; s++) changes.push(noise(s, "2026-10-25T10:00:00Z"));
    for (let k = 0; k < 15; k++) {
      changes.push(study(101 + 2 * k, k, `2026-10-26T0${Math.floor(k / 10)}:${String(k % 10).padStart(2, "0")}:00Z`, "NewStudy"));
      changes.push(study(102 + 2 * k, k, `2026-10-26T0${Math.floor(k / 10)}:${String(k % 10).padStart(2, "0")}:30Z`));
    }
    const fake = fakeChanges(changes);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.overLimit).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.ids.map((x) => x.id)).toEqual(Array.from({ length: 15 }, (_, k) => id(14 - k)));
    // 受け取った時刻は、その検査のいちばん新しい出来事（StableStudy）
    expect(r.ids[0]!.date).toBe(orthanc("2026-10-26T01:04:30Z"));
    // 区切り (120,130]・(110,120]・(100,110]・(90,100] を読み、(90,100] の古い出来事で止まる
    expect(fake.calls).toEqual([120, 110, 100, 90]);
  });

  it("受信日時（いちばん新しい出来事）が期間の後の検査は、期間の中に古い出来事があっても入れない。期間の終わりちょうどは含まない", async () => {
    const changes = [
      study(1, 1, "2026-10-26T01:00:00Z", "NewStudy"),
      study(2, 2, "2026-10-26T02:00:00Z"),
      study(3, 1, "2026-10-26T15:00:00Z"), // 検査 1 は、期間の終わり（翌日の 0 時）ちょうどに落ち着いた
      study(4, 3, "2026-10-26T14:59:59Z"),
    ];
    const fake = fakeChanges(changes);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.ids.map((x) => x.id)).toEqual([id(3), id(2)]);
    expect(r.complete).toBe(true);
  });

  it("期間の始まりちょうどの受信は含む", async () => {
    const fake = fakeChanges([noise(1, "2026-10-25T14:59:59Z"), study(2, 1, "2026-10-25T15:00:00Z")]);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.ids.map((x) => x.id)).toEqual([id(1)]);
    expect(r.complete).toBe(true);
  });

  it("上限：ちょうど上限の数は超えていない。1 件でも多ければ、新しい上限の数だけで overLimit", async () => {
    const changes = Array.from({ length: 6 }, (_, k) => study(k + 1, k, `2026-10-26T0${k}:00:00Z`));
    const fake = fakeChanges(changes);
    const five = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 5 }, OPTS);
    expect(five.overLimit).toBe(true);
    expect(five.ids.map((x) => x.id)).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    const six = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 6 }, OPTS);
    expect(six.overLimit).toBe(false);
    expect(six.ids).toHaveLength(6);
  });

  it("1 回に返す数を切り詰める Orthanc でも、区切りの中を Last から続けて読み、抜けない", async () => {
    const changes = Array.from({ length: 30 }, (_, k) => study(k + 1, k, `2026-10-26T01:${String(k).padStart(2, "0")}:00Z`));
    const fake = fakeChanges(changes, 3);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.ids).toHaveLength(30);
    expect(r.complete).toBe(true);
  });

  it("読む回数の上限に届いたら、そこまでで complete=false（期間の古い側を読めていない）", async () => {
    const changes = [study(1, 1, "2026-10-26T00:10:00Z"), ...Array.from({ length: 60 }, (_, k) => noise(k + 2, "2026-10-26T01:00:00Z"))];
    const fake = fakeChanges(changes);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, { ...OPTS, maxCalls: 3 });
    expect(r).toEqual({ ids: [], overLimit: false, complete: false });
    expect(fake.calls).toHaveLength(3);
  });

  it("Done でないのに空の頁・Last が進まない頁が来たら、そこで止めて complete=false（同じ所を読み続けない）", async () => {
    for (const broken of [
      { changes: [], last: 0, done: false },
      { changes: [noise(5, "2026-10-26T01:00:00Z")], last: 0, done: false },
    ]) {
      const calls: number[] = [];
      const r = await collectReceivedInPeriod(
        async (since) => {
          calls.push(since);
          return broken;
        },
        20,
        { ...DAY, limit: 1000 },
        OPTS,
      );
      expect(r.complete).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("記録の初めまで遡っても期間の始まりに届かず、最初の続き番号が 1 でない（古い記録が残っていない）なら complete=false", async () => {
    const trimmed = fakeChanges([study(41, 1, "2026-10-26T01:00:00Z"), study(42, 2, "2026-10-26T02:00:00Z")]);
    const r = await collectReceivedInPeriod(trimmed.fetchPage, trimmed.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.ids).toHaveLength(2);
    expect(r.complete).toBe(false);
    const whole = fakeChanges([study(1, 1, "2026-10-26T01:00:00Z"), study(2, 2, "2026-10-26T02:00:00Z")]);
    expect((await collectReceivedInPeriod(whole.fetchPage, whole.last, { ...DAY, limit: 1000 }, OPTS)).complete).toBe(true);
    // 記録が空
    expect(await collectReceivedInPeriod(whole.fetchPage, 0, { ...DAY, limit: 1000 }, OPTS)).toEqual({ ids: [], overLimit: false, complete: true });
  });

  it("時刻の読めない出来事では止めず、その検査は入れない", async () => {
    const fake = fakeChanges([study(1, 1, "2026-10-26T01:00:00Z"), { ...study(2, 2, "2026-10-26T02:00:00Z"), date: "broken" }]);
    const r = await collectReceivedInPeriod(fake.fetchPage, fake.last, { ...DAY, limit: 1000 }, OPTS);
    expect(r.ids.map((x) => x.id)).toEqual([id(1)]);
  });
});

describe("受信一覧の画面の API の項目（役割の許可の一覧。原則 8）", () => {
  const period = { fromMs: at("2026-10-16T15:00:00Z"), toMs: at("2026-10-17T15:00:00Z") };

  it("既定の役割には、受信の項目（状態を含む）を返す。上限は 1,000 件", async () => {
    expect(RECEIVE_LIMIT).toBe(1000);
    const { items } = await receiveLogView(createMockBackend(), "general", period);
    expect(items).toHaveLength(8);
    for (const item of items) {
      const keys = Object.keys(item).filter((k) => k !== "study");
      expect(keys.every((k) => (RECEIVE_FIELDS as readonly string[]).includes(k))).toBe(true);
    }
    expect(items.map((i) => i.receiveState)).toEqual(["receiving", ...Array(7).fill("received")]);
  });

  it("許可の一覧に載っていない受信の項目（状態・送信元 AE など）は返らない", async () => {
    const map: FieldAllowlistMap = { ...ROLE_FIELD_ALLOWLIST, general: { study: ["studyInstanceUid"], series: [], receive: ["receivedAt"] } };
    const { items } = await receiveLogView(createMockBackend(), "general", period, map);
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["receivedAt", "study"]);
      expect(Object.keys(item.study)).toEqual(["studyInstanceUid"]);
    }
    expect(JSON.stringify(items)).not.toMatch(/receiving|received"|DTG_SCU|JP-TEST-/);
    // receive の無い役割には、受信の項目を何も返さない（出ない側に倒れる）
    const none: FieldAllowlistMap = { ...ROLE_FIELD_ALLOWLIST, general: { study: ["studyInstanceUid"], series: [] } };
    const bare = await receiveLogView(createMockBackend(), "general", period, none);
    expect(bare.items.every((i) => Object.keys(i).join() === "study")).toBe(true);
  });
});
