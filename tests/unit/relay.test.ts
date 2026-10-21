import { describe, expect, it } from "vitest";
import type { AuditFields } from "@/lib/auth/session";
import { BackendError, type RelayRequest } from "@/lib/backend/types";
import { can, ROLES } from "@/lib/auth/roles";
import { withoutAcceptParam } from "@/lib/backend/relay-path";
import {
  relayWadoRs,
  RELAY_FORBIDDEN_MESSAGE,
  RELAY_MIXED_ACCEPT_MESSAGE,
  RELAY_NO_ACCEPT_MESSAGE,
  RELAY_NOT_WADO_MESSAGE,
  RELAY_READ_ONLY_MESSAGE,
  type RelayDeps,
} from "@/lib/relay";

// BFF の中継（/api/dicom-web/...）：WADO-RS の読み取りだけを通し、通したものも断ったものも記録に残す。

const STUDY = "1.2.826.0.1.3680043.8.498.10";
const SERIES = "1.2.826.0.1.3680043.8.498.11";
const INSTANCE = "1.2.826.0.1.3680043.8.498.12";

/** 起きた順（中継と記録）を控える偽の部品 */
function fakes(
  respond: (req: RelayRequest) => Promise<Response> = async () => new Response("pixels", { status: 200 }),
  allowed = true,
) {
  const events: string[] = [];
  const records: AuditFields[] = [];
  const relayed: RelayRequest[] = [];
  const deps: RelayDeps = {
    allowed,
    backend: {
      async relayDicomweb(req) {
        events.push("relay");
        relayed.push(req);
        return respond(req);
      },
    },
    async record(fields) {
      events.push(`record:${fields.action}:${fields.outcome}`);
      records.push(fields);
    },
  };
  return { deps, events, records, relayed };
}

const input = (segments: string[], method = "GET") => ({ method, segments, search: "", accept: null });

describe("中継", () => {
  it("WADO-RS の読み取りを通し、画像サーバーの答えが出てから、検査の UID と結果つきで記録する", async () => {
    const f = fakes();
    const segments = ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1"];
    const res = await relayWadoRs(input(segments), f.deps);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pixels");
    expect(f.events).toEqual(["relay", "record:retrieve:success"]);
    expect(f.relayed[0]!.target.path).toBe(segments.join("/"));
    expect(f.records[0]).toMatchObject({
      action: "retrieve",
      outcome: "success",
      studyInstanceUid: STUDY,
      detail: { method: "GET", path: segments.join("/"), seriesInstanceUid: SERIES, sopInstanceUid: INSTANCE, status: 200 },
    });
  });

  it("検査の単位の取得（studies/{uid}）も、検査の UID つきで記録する", async () => {
    const f = fakes();
    await relayWadoRs(input(["studies", STUDY]), f.deps);
    expect(f.records[0]).toMatchObject({ action: "retrieve", studyInstanceUid: STUDY, detail: { path: `studies/${STUDY}` } });
  });

  it("HEAD も読み取りとして通す", async () => {
    const f = fakes();
    expect((await relayWadoRs(input(["studies", STUDY, "metadata"], "head"), f.deps)).status).toBe(200);
    expect(f.relayed[0]!.method).toBe("HEAD");
  });

  it("画像サーバーが失敗を返したら、failed と状態の番号を記録する", async () => {
    const f = fakes(async () => new Response(null, { status: 404 }));
    const res = await relayWadoRs(input(["studies", STUDY, "metadata"]), f.deps);
    expect(res.status).toBe(404);
    expect(f.records[0]).toMatchObject({ outcome: "failed", detail: { status: 404 } });
  });

  it("画像サーバーにつながらなかったら、failed を記録してから失敗を返す", async () => {
    const f = fakes(async () => {
      throw new BackendError("画像サーバーにつながらない");
    });
    await expect(relayWadoRs(input(["studies", STUDY]), f.deps)).rejects.toThrow("画像サーバーにつながらない");
    expect(f.events).toEqual(["relay", "record:retrieve:failed"]);
    expect(f.records[0]).toMatchObject({ studyInstanceUid: STUDY, detail: { status: 502 } });
  });

  it("記録に失敗したら、画像を渡さない（記録の無い取得を作らない）", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const deps: RelayDeps = {
      allowed: true,
      backend: { relayDicomweb: async () => new Response(body, { status: 200 }) },
      record: async () => {
        throw new Error("database is locked");
      },
    };
    await expect(relayWadoRs(input(["studies", STUDY]), deps)).rejects.toThrow("database is locked");
    expect(cancelled).toBe(true);
  });

  it("検索（QIDO-RS）は中継しない：404 で断り、断ったことを記録する", async () => {
    for (const segments of [["studies"], ["studies", STUDY, "series"], ["studies", STUDY, "series", SERIES, "instances"]]) {
      const f = fakes();
      const res = await relayWadoRs(input(segments), f.deps);
      expect(res.status, segments.join("/")).toBe(404);
      expect((await res.json()).error).toBe(RELAY_NOT_WADO_MESSAGE);
      expect(f.events).toEqual(["record:retrieve:denied"]);
      expect(f.records[0]).toMatchObject({ detail: { path: segments.join("/"), reason: "not-wado-rs" } });
    }
  });

  it("書き込み（POST・PUT・PATCH・DELETE）は道が無い：いつも 405 で断り、画像サーバーへ渡さず、断ったことを記録する", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      const f = fakes();
      const res = await relayWadoRs(input(["studies"], method), f.deps);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect((await res.json()).error).toBe(RELAY_READ_ONLY_MESSAGE);
      expect(f.relayed).toHaveLength(0);
      expect(f.records).toEqual([
        { action: "write", outcome: "denied", detail: { method: method.toUpperCase(), path: "studies", reason: "relay-read-only" } },
      ]);
    }
  });

  it("使えない字の path は 400（画像サーバーへ渡さず、断ったことを記録する）", async () => {
    for (const segments of [["studies", ".."], ["studies", "a/b"], ["studies", "%2e%2e"], []]) {
      const f = fakes();
      await expect(relayWadoRs(input(segments), f.deps)).rejects.toMatchObject({ status: 400 });
      expect(f.relayed).toHaveLength(0);
      expect(f.records).toEqual([
        { action: "retrieve", outcome: "denied", detail: { method: "GET", path: segments.join("/"), reason: "bad-path" } },
      ]);
    }
  });

  it("役割に画像の取得が割り当てられていなければ 403（画像サーバーへ渡さず、断ったことを記録する）", async () => {
    const f = fakes(undefined, false);
    const res = await relayWadoRs(input(["studies", STUDY, "metadata"]), f.deps);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(RELAY_FORBIDDEN_MESSAGE);
    expect(f.relayed).toHaveLength(0);
    expect(f.records).toEqual([
      { action: "retrieve", outcome: "denied", detail: { method: "GET", path: `studies/${STUDY}/metadata`, reason: "forbidden" } },
    ]);
  });

  it("権限が無くても、書き込みは 405 のまま（道が無いことを先に返す）", async () => {
    const f = fakes(undefined, false);
    expect((await relayWadoRs(input(["studies"], "POST"), f.deps)).status).toBe(405);
    expect(f.records[0]).toMatchObject({ action: "write", outcome: "denied" });
  });

  it("既定の4つの役割は、どれも画像を取れる（段 1b の割り当て）", () => {
    for (const role of ROLES) expect(can(role, "image.retrieve"), role).toBe(true);
  });

  it("記録に残す path の長さを切る", async () => {
    const f = fakes();
    await relayWadoRs(input(["x".repeat(2000)]), f.deps);
    expect((f.records[0]!.detail as { path: string }).path).toHaveLength(512);
  });
});

describe("中継の Accept（PS3.18 8.7.5）", () => {
  const thumbnail = ["studies", STUDY, "series", SERIES, "thumbnail"];
  const rendered = ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "rendered"];
  const withAccept = (segments: readonly string[], accept: string | null) => ({ method: "GET", segments: [...segments], search: "", accept });

  it("Accept の無い thumbnail・rendered の要求は 406。画像サーバーへ渡さず、断ったことを記録する", async () => {
    for (const segments of [thumbnail, rendered]) {
      for (const accept of [null, "", "  "]) {
        const f = fakes();
        const res = await relayWadoRs(withAccept(segments, accept), f.deps);
        expect(res.status).toBe(406);
        expect(await res.json()).toEqual({ error: RELAY_NO_ACCEPT_MESSAGE });
        expect(f.relayed).toHaveLength(0);
        expect(f.records[0]).toMatchObject({
          action: "retrieve",
          outcome: "denied",
          studyInstanceUid: STUDY,
          detail: { path: segments.join("/"), status: 406, reason: "no-accept" },
        });
      }
    }
  });

  it("DICOM の型と画像などの型が混じった Accept は 400（画像サーバーへ渡さない）", async () => {
    const mixed: [readonly string[], string][] = [
      [thumbnail, "image/jpeg, application/dicom"],
      [rendered, 'image/png, multipart/related; type="application/octet-stream"'],
      [["studies", STUDY, "metadata"], "application/dicom+json, image/*"],
    ];
    for (const [segments, accept] of mixed) {
      const f = fakes();
      const res = await relayWadoRs(withAccept(segments, accept), f.deps);
      expect(res.status, accept).toBe(400);
      expect(await res.json()).toEqual({ error: RELAY_MIXED_ACCEPT_MESSAGE });
      expect(f.relayed).toHaveLength(0);
      expect(f.records[0]).toMatchObject({ outcome: "denied", detail: { status: 400, reason: "mixed-accept" } });
    }
  });

  it("規格に合う Accept は通す（ブラウザの <img> の Accept・q=0 で外した型・ビューアの取得・Accept の無い metadata）", async () => {
    const ok: [readonly string[], string | null][] = [
      [thumbnail, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"],
      [rendered, "image/jpeg, application/dicom;q=0"],
      [["studies", STUDY, "metadata"], "application/dicom+json"],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1"], 'multipart/related; type="application/octet-stream"; transfer-syntax=*'],
      [["studies", STUDY, "metadata"], null],
    ];
    for (const [segments, accept] of ok) {
      const f = fakes();
      expect((await relayWadoRs(withAccept(segments, accept), f.deps)).status, String(accept)).toBe(200);
      expect(f.relayed).toHaveLength(1);
    }
  });
});

describe("中継の query の accept（PS3.18 8.3.3.1）", () => {
  it("query の accept は画像サーバーへ渡さない（ほかの query は残す）", () => {
    expect(withoutAcceptParam("?accept=image/png")).toBe("");
    expect(withoutAcceptParam("?quality=80&accept=image%2Fpng&viewport=64,64")).toBe("?quality=80&viewport=64,64");
    expect(withoutAcceptParam("?%61ccept=image/png&x=1")).toBe("?x=1");
    // 名前は大文字と小文字を区別する（accept-name は %s"accept"）
    expect(withoutAcceptParam("?Accept=image/png")).toBe("?Accept=image/png");
    expect(withoutAcceptParam("?quality=80")).toBe("?quality=80");
    expect(withoutAcceptParam("")).toBe("");
  });
});
