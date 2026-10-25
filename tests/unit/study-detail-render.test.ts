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

function render(allValues: boolean, study: Partial<StudyDetailData["study"]> = {}, can: Partial<ScreenInfo["can"]> = {}): string {
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
    can: { rememberViewer: true, allValues, send: false, reconcile: false, export: false, delete: false, ...can },
  };
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(StudyDetailPanel, { row: { studyInstanceUid: STUDY }, screen, onChanged: () => undefined }),
    ),
  );
}

describe("操作の 1 行（docs/design-system/components.md の「ボタン」）", () => {
  const all = { send: true, export: true, delete: true };

  it("左から、主の「開く」・送信・エクスポート、削除は右端に離す。操作は同じ 1 つの group に入る", () => {
    const html = render(true, {}, all);
    const group = html.slice(html.indexOf('aria-label="検査の操作"'));
    const at = (id: string) => group.indexOf(`data-testid="${id}"`);
    expect(at("open-default")).toBeGreaterThan(-1);
    expect(at("open-default")).toBeLessThan(at("send-open"));
    expect(at("send-open")).toBeLessThan(at("export-zip"));
    expect(at("export-zip")).toBeLessThan(at("delete-open"));
    // 削除は、ほかの操作から間をあけて右端に離す（ml-auto）
    expect(html).toMatch(/<button[^>]*class="[^"]*\bml-auto\b[^"]*"[^>]*data-testid="delete-open"/);
    // 「開く」は 1 つだけ。一覧の行の外（詳細）の「開く」が主
    expect(html.match(/data-testid="open-default"/g)).toHaveLength(1);
  });

  it("PACS の操作の権限が無い役割でも、「開く」は操作の行に出る", () => {
    const html = render(true);
    const group = html.slice(html.indexOf('aria-label="検査の操作"'));
    expect(group).toContain('data-testid="open-default"');
    expect(group).not.toContain('data-testid="send-open"');
    expect(group).not.toContain('data-testid="delete-open"');
  });
});

describe("サムネイルを押せるか（権限）", () => {
  it("dicom.all_values のある役割：サムネイルはボタン（aria-expanded）。下の「UID」「DICOM タグ」のボタンは無く、検査の UID は見出しにある", () => {
    const html = render(true);
    expect(html).toContain('data-testid="series-open"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="series-open"/);
    // 期待の変更（#57）：下のボタンをやめ、StudyInstanceUID を見出しの 3 行目に出す
    expect(html).not.toContain('data-testid="detail-tags-toggle"');
    expect(html).not.toContain('data-testid="detail-uid-toggle"');
    expect(html).toContain('data-testid="study-uid"');
    // 検査のタグは、Study UID の横のボタン（開け閉め）から見る
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="study-tags-open"/);
  });

  it("dicom.all_values の無い役割：サムネイルはボタンにせず、絵と文字だけ。「DICOM タグ」も無い", () => {
    const html = render(false);
    expect(html).toContain('data-testid="series-item"');
    expect(html).toContain("Chest Axial 5mm");
    expect(html).not.toContain('data-testid="series-open"');
    expect(html).not.toContain('data-testid="detail-tags-toggle"');
    expect(html).not.toContain('data-testid="study-tags-open"');
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
    // 期待の変更：前は値の無い項目（この検査ではモダリティ・検査名）を出さなかった。いまは項目名を残して「—」を出す
    expect(labels).toEqual(["患者ID", "生年月日・性別", "受付番号", "検査日時", "モダリティ・検査名"]);
    expect(banner).toMatch(/モダリティ・検査名<\/dt><dd[^>]*>—<\/dd>/);
    expect(banner).toContain("1960/07/15（65歳） 女");
    expect(banner).not.toContain("試験 医師");
    expect(banner).not.toContain("昭和");
  });

  const INFO_LABELS = ["英字氏名", "生年月日（和暦）", "紹介医", "Study ID", "シリーズ / 画像"];
  const infoOf = (html: string) => {
    const start = html.lastIndexOf("<dl", html.indexOf('data-testid="detail-info"'));
    return html.slice(start, html.indexOf("</dl>", start));
  };

  it("バナーに足さない値は、タブに隠さず、バナーの下の「検査の情報」に 3 列で並べる。並びは バナー → 検査の情報 → Study UID → 操作の行", () => {
    const withInfo = render(true, full);
    expect(withInfo).not.toContain('role="tablist"');
    const info = infoOf(withInfo);
    expect(info).toContain("grid-cols-3");
    expect([...info.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1])).toEqual(INFO_LABELS);
    expect(info).toContain("試験 医師");
    expect(info).toContain("1960/07/15（昭和35年）");
    expect(info).toContain("1 / 4");
    const at = (s: string) => withInfo.indexOf(s);
    expect(at('aria-label="患者"')).toBeLessThan(at('data-testid="detail-info"'));
    expect(at('data-testid="detail-info"')).toBeLessThan(at('data-testid="study-uid"'));
    expect(at('data-testid="study-uid"')).toBeLessThan(at('aria-label="検査の操作"'));
  });

  // 期待の変更：前は「出す値が無いときは、区画ごと出さない」だった。いまは値の無い項目も「—」で場所を残す
  it("「検査の情報」は、値が 1 つも無くても同じ項目を同じ位置に出し、値は「—」", () => {
    const info = infoOf(render(true));
    expect([...info.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1])).toEqual(INFO_LABELS);
    expect(info.match(/>—</g)).toHaveLength(INFO_LABELS.length);
  });

  // 期待の変更：前は、受付番号が項目ごと返らない（許可の一覧に無い）ときは項目を出さなかった。いまはそのときも「受付番号 —」で場所を残す
  it("受付番号が空でも、項目ごと返らないときも、「受付番号 —」を出す", () => {
    const empty = render(true, { accessionNumber: "" });
    expect(empty).toMatch(/<dt[^>]*>受付番号<\/dt><dd[^>]*>—<\/dd>/);
    expect(render(true)).toMatch(/<dt[^>]*>受付番号<\/dt><dd[^>]*>—<\/dd>/);
  });

  it("患者バナーは区画の上に固定する（スクロールしても誰の検査かが残る）。一覧の右の詳細は 2 行の形", () => {
    const html = render(true, full);
    expect(html).toMatch(/<div class="sticky top-0 [^"]*" data-testid="detail-banner"><section aria-label="患者"/);
    expect(html).toContain('data-layout="r2"');
  });
});
