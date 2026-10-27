import { describe, expect, it } from "vitest";
import { decideModify, decideStatus } from "@/lib/client/modify-outcome";
import type { PostResult } from "@/lib/client/post-json";

// 値の修正の画面が、BFF の答えを次の状態に読み替える規則。結果不明にしてよいのは、Orthanc を呼んだかもしれないときだけ。

const result = (status: number, data: PostResult["data"] = {}): PostResult => ({ ok: status >= 200 && status < 300, status, data });

describe("修正の要求の答え", () => {
  it("再認証が要るときは、再認証の欄へ", () => {
    expect(decideModify(result(403, { problems: ["reauth_required"] }))).toEqual({ kind: "reauth" });
  });

  it("修正できた・作れた", () => {
    expect(decideModify(result(200, { outcome: "modified", total: 2 }))).toEqual({ kind: "done", text: "修正しました（2 件の検査）" });
    expect(decideModify(result(200, { outcome: "created" }))).toMatchObject({ kind: "done" });
  });

  it("503 で outcome が無い（列が一杯で、Orthanc を呼ぶ前に断った）ときは、結果不明にせず、やり直せる誤りとして出す", () => {
    const decision = decideModify(result(503, { error: "処理が混み合っています。時間をおいて、やり直してください" }));
    expect(decision).toEqual({ kind: "error", text: "処理が混み合っています。時間をおいて、やり直してください", restart: false });
  });

  it("outcome が unknown・partial、通信の失敗（0）、202、outcome の無い 500 は結果不明", () => {
    expect(decideModify(result(202, { outcome: "unknown" }))).toMatchObject({ kind: "unknown", partial: false });
    expect(decideModify(result(200, { outcome: "partial" }))).toMatchObject({ kind: "unknown", partial: true });
    expect(decideModify(result(0, { error: "サーバーに接続できませんでした" }))).toMatchObject({ kind: "unknown" });
    expect(decideModify(result(500))).toMatchObject({ kind: "unknown" });
    // outcome を持つ 503（Orthanc を呼んだ後の答え）は結果不明のまま
    expect(decideModify(result(503, { outcome: "unknown" }))).toMatchObject({ kind: "unknown" });
  });

  it("outcome が failed の 5xx は誤り、409 は確認からやり直す", () => {
    expect(decideModify(result(502, { outcome: "failed", error: "失敗しました" }))).toMatchObject({ kind: "error", restart: false });
    expect(decideModify(result(409, { error: "検査が変わりました" }))).toMatchObject({ kind: "error", restart: true });
  });
});

describe("状態の確認の答え", () => {
  it("修正できていた", () => {
    expect(decideStatus({ outcome: "modified" })).toEqual({ kind: "done", text: "修正しました" });
    expect(decideStatus({ outcome: "created" })).toMatchObject({ kind: "done" });
  });

  it("記録が無い（none）ときは「修正されていません」にして、入力へ戻す", () => {
    expect(decideStatus({ outcome: "none" })).toEqual({ kind: "error", text: "修正されていません", restart: true });
  });

  it("failed は修正されていない。確認の画面は残す", () => {
    expect(decideStatus({ outcome: "failed" })).toEqual({ kind: "error", text: "修正されていません", restart: false });
  });

  it("unknown・partial は結果不明のまま", () => {
    expect(decideStatus({ outcome: "unknown" })).toEqual({ kind: "unknown", partial: false, note: undefined });
    expect(decideStatus({ outcome: "partial", error: "管理者に確認を依頼してください" })).toMatchObject({ kind: "unknown", partial: true });
  });
});
