import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { detailKey, StudyDetailPanel, type StudyDetailData } from "@/components/studies/study-detail";

// 詳細のパネルのサムネイル（docs/spec.md の 3.1）：すべての DICOM の値を見る権限（dicom.all_values）のある役割だけ、
// サムネイルを押せる形（ボタン）にする。既定の役割はどちらもこの権限を持つので、e2e では権限の無い画面を作れない。
// ここで、詳細を取り終えた状態のパネルをサーバーの側で描いて確かめる。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const SERIES = "1.2.826.0.1.3680043.8.498.1";

function render(allValues: boolean, study: Partial<StudyDetailData["study"]> = {}): string {
  const client = new QueryClient();
  const data: StudyDetailData = {
    study: { studyInstanceUid: STUDY, patientName: "試験 髙子", ...study },
    series: [{ seriesInstanceUid: SERIES, seriesNumber: "1", seriesDescription: "Chest Axial 5mm", modality: "CT", instanceCount: 4 }],
  };
  // 取り終えた詳細（取得の時刻を先にして、描くときに取り直しの途中の形にしない）
  client.setQueryData(detailKey(STUDY), data, { updatedAt: Date.now() + 60_000 });
  const screen: ScreenInfo = {
    viewers: [],
    timeZone: "Asia/Tokyo",
    can: { rememberViewer: true, allValues, send: false, reconcile: false, export: false, delete: false },
  };
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(StudyDetailPanel, { row: { studyInstanceUid: STUDY }, screen, onChanged: () => undefined }),
    ),
  );
}

describe("サムネイルを押せるか（権限）", () => {
  it("dicom.all_values のある役割：サムネイルはボタン（aria-pressed）。下の「UID」「DICOM タグ」のボタンは無く、検査の UID は見出しにある", () => {
    const html = render(true);
    expect(html).toContain('data-testid="series-open"');
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-testid="series-open"/);
    // 期待の変更（#57）：下のボタンをやめ、StudyInstanceUID を見出しの 3 行目に出す
    expect(html).not.toContain('data-testid="detail-tags-toggle"');
    expect(html).not.toContain('data-testid="detail-uid-toggle"');
    expect(html).toContain('data-testid="study-uid"');
  });

  it("dicom.all_values の無い役割：サムネイルはボタンにせず、絵と文字だけ。「DICOM タグ」も無い", () => {
    const html = render(false);
    expect(html).toContain('data-testid="series-item"');
    expect(html).toContain("Chest Axial 5mm");
    expect(html).not.toContain('data-testid="series-open"');
    expect(html).not.toContain('data-testid="detail-tags-toggle"');
    // シリーズの並びの中に、押せる物が無い
    const strip = html.slice(html.indexOf('data-testid="series-row"'));
    expect(strip.slice(0, strip.indexOf("</ul>"))).not.toContain("<button");
  });
});

describe("見出し（患者バナー）と「検査の情報」", () => {
  const full = {
    patientKana: "しけん たかこ",
    patientId: "JP-TEST-0004",
    patientBirthDate: "19600715",
    patientSex: "F",
    studyDate: "20260410",
    accessionNumber: "ACC-4",
    referringPhysicianName: "試験 医師",
    studyId: "S1",
    seriesCount: 1,
    instanceCount: 4,
  };

  it("バナーに、氏名・かな・患者ID・生年月日と年齢・性別・受付番号・検査日時を、この順で出す。和暦・紹介医はバナーに足さない", () => {
    const html = render(true, full);
    const banner = html.slice(html.indexOf('aria-label="患者"'), html.indexOf("</section>", html.indexOf('aria-label="患者"')));
    expect(banner).toContain("試験 髙子");
    expect(banner).toContain("しけん たかこ");
    const labels = [...banner.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]);
    expect(labels).toEqual(["患者ID", "生年月日・性別", "受付番号", "検査日時"]);
    expect(banner).toContain("1960/07/15（65歳） 女");
    expect(banner).not.toContain("試験 医師");
    expect(banner).not.toContain("昭和");
  });

  it("バナーに足さない値は「検査の情報」のタブに置く。出す値が無いときは、タブを出さずシリーズだけにする", () => {
    const withInfo = render(true, full);
    expect(withInfo).toContain('role="tablist"');
    const info = withInfo.slice(withInfo.indexOf('data-testid="detail-info"'));
    expect(info).toContain("試験 医師");
    expect(info).toContain("1960/07/15（昭和35年）");
    expect(info).toContain("1 / 4");
    expect(render(true)).not.toContain('role="tablist"');
  });

  it("受付番号が空でも、項目ごと返らない（許可の一覧に無い）ときを除き、「受付番号 —」を出す", () => {
    const empty = render(true, { accessionNumber: "" });
    expect(empty).toMatch(/<dt[^>]*>受付番号<\/dt><dd[^>]*>—<\/dd>/);
    expect(render(true)).not.toContain("受付番号");
  });
});
