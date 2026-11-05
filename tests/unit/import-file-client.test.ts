import { describe, expect, it } from "vitest";
import {
  ALREADY_NOTE,
  checkedOutcomeOf,
  importFile,
  outcomeOf,
  reasonOf,
  UNKNOWN_REASON,
  UNREACHABLE_REASON,
} from "@/lib/client/import-file";

// インポートの画面が 1 件ずつ送る働き（docs/spec.md の 3.5「取り込み」）：送る要求の形と、BFF の答えを部品の結果
// （成功・失敗・結果不明）に写す規則。結果不明を成功・失敗に数えない（成功とも失敗とも書かない）。

const BATCH = { id: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", index: 2, total: 5 };
const REQ = "0b7d9c1e-2f3a-4b5c-9d6e-1f2a3b4c5d6e";

type Call = { url: string; init?: RequestInit };

/** 決めた答えを順に返す fetch。null は通信の切れ（投げる） */
function fakeFetch(answers: Array<{ status: number; body: unknown } | null>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (a === undefined) throw new Error("想定より多く呼んだ");
    if (a === null) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("答えを結果に写す", () => {
  it("stored は成功、already は成功と 1 句、unknown は確かめが要る（null）、ほかは失敗で誤りの最初の 1 文", () => {
    expect(outcomeOf({ status: 200, data: { outcome: "stored" } })).toEqual({ ok: true });
    expect(outcomeOf({ status: 200, data: { outcome: "already" } })).toEqual({ ok: true, note: ALREADY_NOTE });
    expect(outcomeOf({ status: 202, data: { outcome: "unknown", error: "インポートの結果を確認できません。状態を確認してください" } })).toBeNull();
    // 保存した値が違い、入れた画像を消せなかった（502）も結果不明
    expect(outcomeOf({ status: 502, data: { outcome: "unknown", error: "x" } })).toBeNull();
    expect(
      outcomeOf({
        status: 409,
        data: { error: "同じ画像または検査がもう画像サーバーにあります。取り込み直しはできません（値を直すときは患者情報修正を使ってください）" },
      }),
    ).toEqual({ ok: false, reason: "同じ画像または検査がもう画像サーバーにあります" });
    expect(outcomeOf({ status: 413, data: { error: "ファイルが大きすぎます（上限 256 MB）" } })).toEqual({ ok: false, reason: "ファイルが大きすぎます（上限 256 MB）" });
    expect(outcomeOf({ status: 400, data: { error: "DICOM のファイルではありません" } })).toEqual({ ok: false, reason: "DICOM のファイルではありません" });
    // 文の無い誤り・200 でも stored／already でないもの（前の同じ要求の失敗）は失敗
    expect(outcomeOf({ status: 500, data: {} })).toEqual({ ok: false, reason: "インポートできませんでした" });
    expect(outcomeOf({ status: 200, data: { outcome: "failed" } })).toEqual({ ok: false, reason: "インポートできませんでした" });
    // 2xx でない stored は信じない
    expect(outcomeOf({ status: 409, data: { outcome: "stored" } })).toEqual({ ok: false, reason: "インポートできませんでした" });
  });

  it("確かめの答え：stored は成功、failed は失敗、none は届かなかったときだけ失敗、ほかは結果不明", () => {
    expect(checkedOutcomeOf({ status: 200, data: { outcome: "stored" } }, "reached")).toEqual({ ok: true });
    expect(checkedOutcomeOf({ status: 200, data: { outcome: "failed", error: "保存した値が違います。取り込んだ画像を消しました" } }, "reached")).toEqual({
      ok: false,
      reason: "保存した値が違います",
    });
    expect(checkedOutcomeOf({ status: 200, data: { outcome: "none" } }, "unreachable")).toEqual({ ok: false, reason: UNREACHABLE_REASON });
    expect(checkedOutcomeOf({ status: 200, data: { outcome: "none" } }, "reached")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(checkedOutcomeOf({ status: 202, data: { outcome: "unknown" } }, "reached", "インポートの結果を確認できません。状態を確認してください")).toEqual({
      ok: false,
      unknown: true,
      reason: "インポートの結果を確認できません",
    });
    // 確かめも読めない：届いたなら結果不明、届かなかったなら失敗
    expect(checkedOutcomeOf(null, "reached")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(checkedOutcomeOf({ status: 500, data: {} }, "reached")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(checkedOutcomeOf(null, "unreachable")).toEqual({ ok: false, reason: UNREACHABLE_REASON });
  });

  it("理由の 1 句：最初の「。」まで。文でなければ代わりの句", () => {
    expect(reasonOf("一つ目。二つ目。", "x")).toBe("一つ目");
    expect(reasonOf("", "x")).toBe("x");
    expect(reasonOf(42, "x")).toBe("x");
  });
});

describe("1 件を送る", () => {
  it("本文はファイルのバイトのまま。要求の ID・組・CSRF の token を頭に付け、同じ頁の cookie で送る", async () => {
    const { fetcher, calls } = fakeFetch([{ status: 200, body: { outcome: "stored" } }]);
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    await expect(importFile(file, BATCH, "csrf-1", fetcher, () => REQ)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/import");
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: file, credentials: "same-origin" });
    expect(calls[0]!.init!.headers).toEqual({
      "content-type": "application/dicom",
      "x-request-id": REQ,
      "x-import-batch": BATCH.id,
      "x-import-index": "2",
      "x-import-total": "5",
      "x-csrf-token": "csrf-1",
    });
  });

  it("CSRF の token が無い（検証モード）ときは頭に付けない", async () => {
    const { fetcher, calls } = fakeFetch([{ status: 200, body: { outcome: "stored" } }]);
    await importFile(new Blob([]), BATCH, undefined, fetcher, () => REQ);
    expect(calls[0]!.init!.headers).not.toHaveProperty("x-csrf-token");
  });

  it("答えが分からなければ、同じ要求の ID で状態を 1 回確かめ、その答えで決める", async () => {
    const { fetcher, calls } = fakeFetch([
      { status: 202, body: { outcome: "unknown", error: "インポートの結果を確認できません。状態を確認してください" } },
      { status: 200, body: { outcome: "stored", reconciled: true } },
    ]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toEqual({ ok: true });
    expect(calls[1]!.url).toBe(`/api/import?requestId=${REQ}`);
    expect(calls[1]!.init?.method).toBeUndefined();
  });

  it("確かめても分からなければ結果不明（成功とも失敗とも数えない）", async () => {
    const { fetcher } = fakeFetch([
      { status: 202, body: { outcome: "unknown", error: "インポートの結果を確認できません。状態を確認してください" } },
      { status: 202, body: { outcome: "unknown", repeated: true } },
    ]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toEqual({
      ok: false,
      unknown: true,
      reason: "インポートの結果を確認できません",
    });
  });

  it("送っている間に切れた：記録が無ければ失敗、記録があれば確かめの答え、確かめも切れたら失敗", async () => {
    const none = fakeFetch([null, { status: 200, body: { requestId: REQ, outcome: "none" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", none.fetcher, () => REQ)).resolves.toEqual({ ok: false, reason: UNREACHABLE_REASON });
    const stored = fakeFetch([null, { status: 200, body: { outcome: "stored" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", stored.fetcher, () => REQ)).resolves.toEqual({ ok: true });
    const unknown = fakeFetch([null, { status: 202, body: { outcome: "unknown" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", unknown.fetcher, () => REQ)).resolves.toMatchObject({ ok: false, unknown: true });
    const both = fakeFetch([null, null]);
    await expect(importFile(new Blob([]), BATCH, "t", both.fetcher, () => REQ)).resolves.toEqual({ ok: false, reason: UNREACHABLE_REASON });
  });

  it("答えが届いた後に確かめが切れたら結果不明", async () => {
    const { fetcher } = fakeFetch([{ status: 202, body: { outcome: "unknown" } }, null]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toMatchObject({ ok: false, unknown: true });
  });
});
