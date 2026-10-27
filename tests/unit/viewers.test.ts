import { describe, expect, it } from "vitest";
import { modalityGroupOf, primaryGroup, studyInGroup } from "@/lib/modalities";
import { availableViewers, resolveDefaultViewer, viewerUrl } from "@/lib/viewers";

// ビューアの選び分け（docs/spec.md の 3.2）。

const ALL = {
  ohifUrl: "https://viewer.example.org/ohif/",
  stoneUrl: "https://viewer.example.org/stone",
  volviewUrl: "https://viewer.example.org/volview",
  weasisEnabled: true,
  publicDicomwebUrl: "https://pacs.example.org/dicom-web",
};
const UID = "1.2.826.0.1.3680043.8.498.1";

describe("出すビューア", () => {
  it("URL が設定されたものだけ。Weasis は段 4 の後なので出さない", () => {
    expect(availableViewers(ALL).map((v) => v.id)).toEqual(["ohif", "stone", "volview", "dicomweb"]);
    expect(availableViewers({ weasisEnabled: true })).toEqual([]);
    expect(availableViewers({ stoneUrl: ALL.stoneUrl, weasisEnabled: false }).map((v) => v.id)).toEqual(["stone"]);
  });

  it("DICOMweb の URL は開かずにコピーする", () => {
    expect(availableViewers(ALL).find((v) => v.id === "dicomweb")?.kind).toBe("copy");
  });
});

describe("開く URL", () => {
  it("ビューアごとの形", () => {
    const relay = "https://tsunagi.example.org/api/dicom-web";
    expect(viewerUrl("ohif", ALL, UID, relay)).toBe(`https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${UID}`);
    expect(viewerUrl("stone", ALL, UID, relay)).toBe(`https://viewer.example.org/stone/index.html?study=${UID}`);
    expect(viewerUrl("volview", ALL, UID, relay)).toBe(
      `https://viewer.example.org/volview/?urls=${encodeURIComponent(`[${relay}/studies/${UID}]`)}`,
    );
    expect(viewerUrl("dicomweb", ALL, UID, relay)).toBe(`https://pacs.example.org/dicom-web/studies/${UID}`);
  });

  it("OHIF は Orthanc の plugin の根（/ohif）に、OHIF の検査を開く道 /viewer を 1 回だけ足す", () => {
    // Orthanc の OHIF の plugin の根は /ohif/（RouterBasename）、OHIF の検査を開く道は /viewer?StudyInstanceUIDs=
    const url = viewerUrl("ohif", { ohifUrl: "https://pacs.example.org/ohif", weasisEnabled: false }, UID, "");
    expect(url).toBe(`https://pacs.example.org/ohif/viewer?StudyInstanceUIDs=${UID}`);
    expect(new URL(url ?? "").pathname).toBe("/ohif/viewer");
  });

  it("設定に無いビューアは null", () => {
    expect(viewerUrl("ohif", { weasisEnabled: false }, UID, "")).toBeNull();
  });
});

describe("既定のビューア（検査ごとの覚え → モダリティの既定 → 最初のもの）", () => {
  const viewers = availableViewers(ALL);
  it("覚えがあれば覚え", () => {
    expect(resolveDefaultViewer("volview", "ohif", viewers)).toBe("volview");
  });
  it("覚えが無ければモダリティの既定", () => {
    expect(resolveDefaultViewer(null, "stone", viewers)).toBe("stone");
  });
  it("覚え・既定のビューアが設定に無ければ、出せる最初のビューア（コピーのものは使わない）", () => {
    const only = availableViewers({ stoneUrl: ALL.stoneUrl, publicDicomwebUrl: ALL.publicDicomwebUrl, weasisEnabled: false });
    expect(resolveDefaultViewer("volview", "ohif", only)).toBe("stone");
    expect(resolveDefaultViewer("dicomweb", null, availableViewers({ publicDicomwebUrl: ALL.publicDicomwebUrl, weasisEnabled: false }))).toBeNull();
  });
  it("知らない値は使わない", () => {
    expect(resolveDefaultViewer("javascript:alert(1)", null, viewers)).toBe("ohif");
  });
});

describe("検査の主なモダリティ", () => {
  it("SR・DOC より画像の群を先にする", () => {
    expect(primaryGroup(["SR", "CT"])).toBe("CT");
    expect(primaryGroup(["DX"])).toBe("CR/DX");
    expect(primaryGroup(["SR"])).toBe("SR");
    expect(primaryGroup(["XA"])).toBeNull();
  });

  it("文書の群（DOC）は Modality の DOC だけ。OT（Other）は文書とは限らないので、どの群にも入れない（PS3.3 C.7.3.1.1.1）", () => {
    expect(modalityGroupOf("DOC")).toBe("DOC");
    expect(modalityGroupOf("OT")).toBeNull();
    expect(studyInGroup(["OT"], "DOC")).toBe(false);
    expect(primaryGroup(["OT", "DOC"])).toBe("DOC");
  });
});
