import { describe, expect, it } from "vitest";
import { RESOLVE_UNREACHABLE_MESSAGE } from "@/lib/import/picker-model";
import {
  ALREADY_NOTE,
  checkedOutcomeOf,
  importFile,
  outcomeOf,
  reasonOf,
  RESOLVE_FAILED_MESSAGE,
  resolveImport,
  UNKNOWN_REASON,
  UNREACHABLE_REASON,
} from "@/lib/client/import-file";

// インポートの画面が 1 件ずつ送る働き（docs/spec.md の 3.5「取り込み」）：送る要求の形と、BFF の答えを部品の結果
// （成功・失敗・結果不明）にコピーする規則。結果不明を成功・失敗に数えない（成功とも失敗とも書かない）。

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
    // 結果不明の理由は、BFF の文によらずいつも同じ 1 句（行ごとに語を変えない。UX のレビューの指摘）
    expect(checkedOutcomeOf({ status: 202, data: { outcome: "unknown", error: "インポートの結果を確認できません。状態を確認してください" } }, "reached")).toEqual({
      ok: false,
      unknown: true,
      reason: UNKNOWN_REASON,
    });
    // 確認も読めない：送った要求が届いたかも分からないので、どちらも結果不明（失敗と言い切らない）
    expect(checkedOutcomeOf(null, "reached")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(checkedOutcomeOf({ status: 500, data: {} }, "reached")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(checkedOutcomeOf(null, "unreachable")).toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
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
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
  });

  it("ログインが切れた（401）・画面がロックされた（423）ときは、検査一覧などと同じ扱いを呼ぶ（送った 1 件は失敗）", async () => {
    for (const status of [401, 423]) {
      const seen: number[] = [];
      const { fetcher, calls } = fakeFetch([{ status, body: { error: "ログインしてください" } }]);
      await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ, (s) => seen.push(s))).resolves.toEqual({ ok: false, reason: "ログインしてください" });
      expect(seen).toEqual([status]);
      expect(calls).toHaveLength(1);
    }
    // 確認（GET）で切れたときも呼ぶ。結果は結果不明
    const seen: number[] = [];
    const { fetcher } = fakeFetch([{ status: 202, body: { outcome: "unknown" } }, { status: 401, body: { error: "x" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ, (s) => seen.push(s))).resolves.toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
    expect(seen).toEqual([401]);
    // ほかの誤りでは呼ばない
    const other: number[] = [];
    const conflict = fakeFetch([{ status: 409, body: { error: "x" } }]);
    await importFile(new Blob([]), BATCH, "t", conflict.fetcher, () => REQ, (s) => other.push(s));
    expect(other).toEqual([]);
  });

  it("送っている間に切れた：記録が無ければ失敗、記録があれば確かめの答え、確かめも切れたら結果不明", async () => {
    const none = fakeFetch([null, { status: 200, body: { requestId: REQ, outcome: "none" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", none.fetcher, () => REQ)).resolves.toEqual({ ok: false, reason: UNREACHABLE_REASON });
    const stored = fakeFetch([null, { status: 200, body: { outcome: "stored" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", stored.fetcher, () => REQ)).resolves.toEqual({ ok: true });
    const unknown = fakeFetch([null, { status: 202, body: { outcome: "unknown" } }]);
    await expect(importFile(new Blob([]), BATCH, "t", unknown.fetcher, () => REQ)).resolves.toMatchObject({ ok: false, unknown: true });
    const both = fakeFetch([null, null]);
    await expect(importFile(new Blob([]), BATCH, "t", both.fetcher, () => REQ)).resolves.toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON });
  });

  it("答えの本文を読み切れない（途中で切れた・JSON でない）ときは失敗と決めず、状態を確かめる", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? new Response("{\"outcome\":\"sto", { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ outcome: "stored" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["/api/import", `/api/import?requestId=${REQ}`]);
    // 確認の本文も読めなければ結果不明（成功とも失敗とも数えない）
    const broken = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(importFile(new Blob([]), BATCH, "t", broken, () => REQ)).resolves.toMatchObject({ ok: false, unknown: true });
  });

  it("答えが届いた後に確かめが切れたら結果不明", async () => {
    const { fetcher } = fakeFetch([{ status: 202, body: { outcome: "unknown" } }, null]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toMatchObject({ ok: false, unknown: true });
  });
});

describe("結果不明の行の名指し（管理者が確認して記録するため）", () => {
  const UID = "1.2.826.0.1.3680043.8.498.1";
  const target = { requestId: REQ, studyInstanceUid: UID };

  it("送った答えの検査の UID と要求の ID を、結果不明の行に持たせる", async () => {
    const { fetcher } = fakeFetch([
      { status: 202, body: { outcome: "unknown", studyInstanceUid: UID } },
      { status: 202, body: { outcome: "unknown", repeated: true } },
    ]);
    await expect(importFile(new Blob([]), BATCH, "t", fetcher, () => REQ)).resolves.toEqual({ ok: false, unknown: true, reason: UNKNOWN_REASON, resolve: target });
  });

  it("状態の確かめの答えにある UID も使う。確かめが切れても、送った答えの UID で持たせる", async () => {
    const checked = fakeFetch([{ status: 202, body: { outcome: "unknown" } }, { status: 202, body: { outcome: "unknown", studyInstanceUid: UID } }]);
    await expect(importFile(new Blob([]), BATCH, "t", checked.fetcher, () => REQ)).resolves.toMatchObject({ unknown: true, resolve: target });
    const cut = fakeFetch([{ status: 202, body: { outcome: "unknown", studyInstanceUid: UID } }, null]);
    await expect(importFile(new Blob([]), BATCH, "t", cut.fetcher, () => REQ)).resolves.toMatchObject({ unknown: true, resolve: target });
  });

  it("UID が分からない結果不明（BFF に届いたか分からない）は名指しを持たない。成功にも持たせない", async () => {
    const lost = fakeFetch([{ status: 202, body: { outcome: "unknown" } }, { status: 200, body: { outcome: "none" } }]);
    expect(await importFile(new Blob([]), BATCH, "t", lost.fetcher, () => REQ)).not.toHaveProperty("resolve");
    const stored = fakeFetch([{ status: 200, body: { outcome: "stored", studyInstanceUid: UID } }]);
    expect(await importFile(new Blob([]), BATCH, "t", stored.fetcher, () => REQ)).toEqual({ ok: true });
    // UID が文字列でなければ使わない
    const odd = fakeFetch([{ status: 202, body: { outcome: "unknown", studyInstanceUid: 5 } }, { status: 202, body: { outcome: "unknown" } }]);
    expect(await importFile(new Blob([]), BATCH, "t", odd.fetcher, () => REQ)).not.toHaveProperty("resolve");
  });
});

describe("結果不明を確認して記録する（POST /api/studies/{uid}/import/resolve）", () => {
  const target = { requestId: REQ, studyInstanceUid: "1.2.826.0.1.3680043.8.498.1" };

  it("検査の UID を道に、要求の ID・結果・確認内容を本文に、CSRF の token を頭に付けて送る。成功したら ok", async () => {
    const { fetcher, calls } = fakeFetch([{ status: 200, body: { requestId: REQ, outcome: "stored", instancePresent: true } }]);
    await expect(resolveImport(target, "success", "画像サーバーで画像を確認", "csrf-1", fetcher)).resolves.toEqual({ ok: true });
    expect(calls[0]!.url).toBe("/api/studies/1.2.826.0.1.3680043.8.498.1/import/resolve");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(calls[0]!.init!.headers).toEqual({ "content-type": "application/json", "x-csrf-token": "csrf-1" });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ requestId: REQ, outcome: "success", note: "画像サーバーで画像を確認" });
    const { fetcher: f2, calls: c2 } = fakeFetch([{ status: 200, body: { outcome: "failed" } }]);
    await resolveImport(target, "failed", "画像が無い", undefined, f2);
    expect(c2[0]!.init!.headers).not.toHaveProperty("x-csrf-token");
    expect(JSON.parse(String(c2[0]!.init!.body))).toMatchObject({ outcome: "failed" });
  });

  it("断られたら BFF の誤りの文をそのまま返す。文が無ければ代わりの文。通信が切れたら接続できなかった文", async () => {
    const refused = fakeFetch([{ status: 409, body: { error: "画像サーバーにこの画像が見つかりません。成功として記録できません" } }]);
    await expect(resolveImport(target, "success", "x", "t", refused.fetcher)).resolves.toEqual({
      ok: false,
      message: "画像サーバーにこの画像が見つかりません。成功として記録できません",
    });
    const bare = fakeFetch([{ status: 500, body: {} }]);
    await expect(resolveImport(target, "failed", "x", "t", bare.fetcher)).resolves.toEqual({ ok: false, message: RESOLVE_FAILED_MESSAGE });
    const cut = fakeFetch([null]);
    await expect(resolveImport(target, "failed", "x", "t", cut.fetcher)).resolves.toEqual({ ok: false, message: RESOLVE_UNREACHABLE_MESSAGE });
  });

  it("ログインが切れた（401）・画面がロックされた（423）ときは、検査一覧などと同じ扱いを呼ぶ", async () => {
    for (const status of [401, 423]) {
      const seen: number[] = [];
      const { fetcher } = fakeFetch([{ status, body: { error: "ログインしてください" } }]);
      await expect(resolveImport(target, "failed", "x", "t", fetcher, (s) => seen.push(s))).resolves.toEqual({ ok: false, message: "ログインしてください" });
      expect(seen).toEqual([status]);
    }
  });
});
