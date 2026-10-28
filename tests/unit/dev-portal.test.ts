import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORTS, portalLinks, renderPortal } from "../../docker/dev/portal/page";

// 開発の一式の入口のページ（docker/dev/portal）：リンクの先のポートが、compose の公開のポートと食い違わない。

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const devCompose = read("docker/dev/compose.yaml");
const deployCompose = read("deploy/compose.yaml");

// compose の「"127.0.0.1:${変数:-既定}:コンテナのポート"」から、変数と既定を取る
const published = (compose: string, variable: string) =>
  new RegExp(`"[^"]*\\$\\{${variable}:-(\\d+)\\}:\\d+"`).exec(compose)?.[1];
const portalEnv = (name: string) => new RegExp(`${name}: \\$\\{(\\w+):-(\\d+)\\}`).exec(devCompose)?.slice(1, 3);

describe("入口のページのリンク", () => {
  it("リンクは3つで、tsunagi-dicom・DTG・ris-emulator の順", () => {
    const links = portalLinks(DEFAULT_PORTS);
    expect(links.map((l) => l.name)).toEqual(["tsunagi-dicom", "DICOM テストジェネレーター", "RIS エミュレーター"]);
    const html = renderPortal(DEFAULT_PORTS);
    expect(html.match(/<a /g)).toHaveLength(3);
    for (const l of links) expect(html).toContain(`<a href="${l.href}">${l.name}</a>`);
  });

  it("既定のポートは compose の公開のポートの既定と同じ", () => {
    expect(published(deployCompose, "TSUNAGI_HTTP_PORT")).toBe(String(DEFAULT_PORTS.tsunagi));
    expect(published(devCompose, "DEV_DTG_WEB_PORT")).toBe(String(DEFAULT_PORTS.dtg));
    expect(published(devCompose, "DEV_RIS_WEB_PORT")).toBe(String(DEFAULT_PORTS.ris));
  });

  it("portal サービスは公開のポートと同じ変数と既定をページへ渡す", () => {
    expect(portalEnv("PORTAL_TSUNAGI_PORT")).toEqual(["TSUNAGI_HTTP_PORT", String(DEFAULT_PORTS.tsunagi)]);
    expect(portalEnv("PORTAL_DTG_PORT")).toEqual(["DEV_DTG_WEB_PORT", String(DEFAULT_PORTS.dtg)]);
    expect(portalEnv("PORTAL_RIS_PORT")).toEqual(["DEV_RIS_WEB_PORT", String(DEFAULT_PORTS.ris)]);
  });

  it("portal 自身は 127.0.0.1 の DEV_PORTAL_PORT（既定 80）だけに出す", () => {
    expect(devCompose).toContain('"127.0.0.1:${DEV_PORTAL_PORT:-80}:8080"');
  });

  it("ポートを替えるとリンクも替わる", () => {
    const html = renderPortal({ tsunagi: 3100, dtg: 18180, ris: 18181 });
    expect(html).toContain('href="http://127.0.0.1:3100/"');
    expect(html).toContain('href="http://127.0.0.1:18180/"');
    expect(html).toContain('href="http://127.0.0.1:18181/"');
  });

  it("外の CSS・フォント・スクリプトを読まない", () => {
    const html = renderPortal(DEFAULT_PORTS);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).toContain('href="/tokens.css"');
  });
});
