import { describe, expect, it } from "vitest";
import {
  destinations,
  matchesSent,
  pageSlice,
  sentLimitNotice,
  sentStatusNote,
  sentStudyHref,
  SENT_STATUS_LABELS,
  statusCounts,
} from "@/lib/client/sent-list";
import type { SentView } from "@/lib/fields";

// 送信一覧の画面の計算：読んだ範囲の中の絞り込み・状態の件数・ページ送り・文言（docs/spec.md の 3.4・2.2）。

const row = (destination: string, status: SentView["status"], patientId: string, patientName = "", patientKana = ""): SentView => ({
  requestId: `${destination}-${patientId}`,
  destination,
  status,
  study: { patientId, patientName, patientKana, studyInstanceUid: "1.2.3" },
});

describe("送信一覧の画面の計算", () => {
  const items = [row("dtg", "sent", "P1", "試験 太郎", "シケン タロウ"), row("teaching", "failed", "P2"), row("dtg", "unknown", "P3")];

  it("送信先と、患者ID・氏名（漢字・かな）で絞る", () => {
    expect(items.filter((i) => matchesSent(i, { destination: "dtg", text: "" })).map((i) => i.study.patientId)).toEqual(["P1", "P3"]);
    expect(items.filter((i) => matchesSent(i, { destination: "", text: "しけん" })).map((i) => i.study.patientId)).toEqual(["P1"]);
    expect(items.filter((i) => matchesSent(i, { destination: "", text: "p2" })).map((i) => i.study.patientId)).toEqual(["P2"]);
  });

  it("状態ごとの件数（すべてを含む）と、送信先の選択肢（選んでいるものは残す）", () => {
    expect(statusCounts(items)).toEqual({ all: 3, pending: 0, running: 0, sent: 1, failed: 1, unknown: 1 });
    expect(destinations(items, "")).toEqual(["dtg", "teaching"]);
    expect(destinations(items, "archive")).toEqual(["archive", "dtg", "teaching"]);
  });

  it("ページ送り：範囲の外のページは近いページに寄せ、何件目かを返す", () => {
    const list = Array.from({ length: 143 }, (_, i) => i);
    expect(pageSlice(list, 1, 50)).toMatchObject({ page: 1, pages: 3, first: 1, last: 50 });
    expect(pageSlice(list, 3, 50)).toMatchObject({ page: 3, first: 101, last: 143 });
    expect(pageSlice(list, 9, 50).page).toBe(3);
    expect(pageSlice([], 1, 50)).toMatchObject({ page: 1, pages: 1, first: 0, last: 0, rows: [] });
  });

  it("状態の語は用語集の語。失敗と結果不明には、札の隣に なぜか と次にすること を出す", () => {
    expect(Object.values(SENT_STATUS_LABELS)).toEqual(["送信待ち", "送信中", "送信完了", "送信失敗", "結果不明"]);
    expect(sentStatusNote(items[0]!)).toBe("");
    expect(sentStatusNote(items[1]!)).toContain("teaching の接続確認をしてから");
    const unknown = sentStatusNote(items[2]!);
    expect(unknown).toMatch(/^届いたか分かりません。dtg に/);
    expect(unknown).not.toMatch(/送信完了|送信失敗/);
  });

  it("上限の知らせと、検査一覧で表示の移り先", () => {
    expect(sentLimitNotice(1000)).toBe("送信ジョブが 1,000 件を超えたため、新しい 1,000 件だけを出しています。期間を狭めてください。");
    expect(sentStudyHref(items[0]!)).toBe("/?q=P1&studyUid=1.2.3");
    expect(sentStudyHref({ study: {} })).toBeNull();
  });
});
