import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

// 開発用の compose（docker/dev/compose.yaml）の流れの試験（docs/round-trip-test.md）。
// node tests/flow/run.mjs から流す（docker/dev/up.sh で一式を立ててから）。
//
// 1. 配る compose の形：Orthanc の REST（8042）がホストに出ていない。tsunagi-dicom と Orthanc だけが内部ネットワーク
//    （internal: true）に入り、Orthanc はそれと DICOM のネットワークのほかに入らない。DICOM（4242）はホストから届く。
//    Orthanc の守り：REST は認証なしでも、イメージの既定の利用者（orthanc:orthanc）でも 401。登録していない AE タイトルからの
//    C-STORE は断る（DicomAlwaysAllowStore: false）。起動の確かめが DICOM につながず、ログに「invalid AET」が出ない。
// 2. 流れ：dicom-test-generator の CLI で架空の患者を Orthanc へ送る → tsunagi-dicom の受信一覧に出る →
//    tsunagi-dicom の「送信」で storescp へ送る → storescp に同じ StudyInstanceUID・SOPInstanceUID の画像が同じ数だけ届く。
// 前の試験に依らないが、順に流す。

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const root = process.cwd();
const composeFile = path.join(root, "docker/dev/compose.yaml");
const secretsDir = path.join(root, "docker/dev/secrets");
/** docker/dev/orthanc/site.json に登録した送信先（storescp） */
const SCP = { id: "dev-scp", aet: "DEV_SCP" };
/** docker/dev/tdg/app_config.yaml の dicom-test-generator の AE タイトル */
const TDG_AET = "DTG_CT01";
const dicomPort = process.env.ORTHANC_DICOM_PORT ?? "4242";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await run("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`docker ${args.slice(0, 3).join(" ")} が失敗した: ${e.stderr?.trim() || e.message}`);
  }
}

const compose = (args: string[], timeoutMs?: number) => docker(["compose", "-f", composeFile, ...args], timeoutMs);

async function containerId(service: string): Promise<string> {
  const id = (await compose(["ps", "-q", service])).trim();
  expect(id, `${service} のコンテナが動いていない`).not.toBe("");
  return id;
}

interface Inspect {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { PortBindings: Record<string, unknown> | null };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null>; Networks: Record<string, { IPAddress: string }> };
}

const inspect = async (id: string) => (JSON.parse(await docker(["inspect", id])) as Inspect[])[0]!;

async function waitFor<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > until) throw new Error(`${what}：待ちきれなかった`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** storescp が受け取ったファイルの StudyInstanceUID と SOPInstanceUID（tests/integration/support/docker.ts と同じ読み方） */
async function storescpReceived(): Promise<{ studyInstanceUid: string; sopInstanceUid: string }[]> {
  const out = await compose([
    "exec",
    "-T",
    "storescp",
    "sh",
    "-c",
    'find /received -type f | sort | while read -r f; do printf "FILE\\n"; dcmdump -q +P 0020,000d +P 0008,0018 "$f"; done',
  ]);
  const files: { studyInstanceUid: string; sopInstanceUid: string }[] = [];
  let current: { studyInstanceUid?: string; sopInstanceUid?: string } | null = null;
  const flush = () => {
    if (current?.studyInstanceUid && current.sopInstanceUid) files.push(current as { studyInstanceUid: string; sopInstanceUid: string });
  };
  for (const line of out.split("\n")) {
    if (line === "FILE") {
      flush();
      current = {};
      continue;
    }
    const m = /^\((0020,000d|0008,0018)\) UI \[([0-9.]+)\]/.exec(line.trim());
    if (!m || !current) continue;
    if (m[1] === "0020,000d") current.studyInstanceUid = m[2];
    else current.sopInstanceUid = m[2];
  }
  flush();
  return files;
}

/** 最初の管理者（up.sh が作った secret のファイルのパスワード）でログインし、試験だけのパスワードに変える */
async function loginAsInitialAdmin(page: Page) {
  const initial = readFileSync(path.join(secretsDir, "initial_admin_password.txt"), "utf8").replace(/\r?\n$/, "");
  const changed = `Flow-${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}-9k`;
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${changed}`);
  await page.goto("/login");
  const form = page.getByRole("form", { name: "ログイン" });
  await form.getByLabel("ユーザーID").fill("admin");
  await form.getByLabel("パスワード").fill(initial);
  await form.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/login\/password$/);
  const change = page.getByRole("form", { name: "パスワードの変更" });
  await change.locator('input[name="newPassword"]').fill(changed);
  await change.locator('input[name="confirm"]').fill(changed);
  await change.getByRole("button", { name: "変更" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("1 配る compose の形：Orthanc の REST はホストに出ず、tsunagi-dicom と Orthanc だけが internal のネットワークに入る", async () => {
  const orthancId = await containerId("orthanc");
  const tsunagiId = await containerId("tsunagi");
  const orthanc = await inspect(orthancId);
  const tsunagi = await inspect(tsunagiId);
  const project = orthanc.Config.Labels["com.docker.compose.project"]!;
  const net = (name: string) => `${project}_${name}`;
  // storescp と同じ DCMTK のイメージ（名前は一式ごと。docker/dev/compose.yaml）
  const dcmtkImage = `${project}-dcmtk:local`;

  // 作るイメージの名前は一式ごと（プロジェクトの名前が入る）。ほかの一式（tsunagi-dev など）の作り直しが及ばない
  expect((await inspect(await containerId("tdg"))).Config.Image).toBe(`${project}-tdg:local`);
  expect((await inspect(await containerId("storescp"))).Config.Image).toBe(dcmtkImage);
  expect(tsunagi.Config.Image).toBe(process.env.TSUNAGI_IMAGE || `${project}-tsunagi:local`);

  // ホストへの公開：Orthanc は DICOM（4242）だけ。REST（8042）は出さない
  expect(Object.keys(orthanc.HostConfig.PortBindings ?? {})).toEqual(["4242/tcp"]);
  expect(orthanc.NetworkSettings.Ports["8042/tcp"] ?? null).toBeNull();
  expect(Object.keys(tsunagi.HostConfig.PortBindings ?? {})).toEqual(["3000/tcp"]);
  // ホストから 8042 にはつながらない
  const reached = await fetch("http://127.0.0.1:8042/system", { signal: AbortSignal.timeout(5000) }).then(
    () => true,
    () => false,
  );
  expect(reached, "ホストから Orthanc の REST（8042）に届いた").toBe(false);

  // ネットワーク：Orthanc は backend と dicom だけ、tsunagi-dicom は backend と web だけ
  expect(Object.keys(orthanc.NetworkSettings.Networks).sort()).toEqual([net("backend"), net("dicom")].sort());
  expect(Object.keys(tsunagi.NetworkSettings.Networks).sort()).toEqual([net("backend"), net("web")].sort());
  // backend は internal で、入っているのは tsunagi-dicom と Orthanc だけ
  const [backend] = JSON.parse(await docker(["network", "inspect", net("backend")])) as {
    Internal: boolean;
    Containers: Record<string, unknown>;
  }[];
  expect(backend!.Internal).toBe(true);
  expect(Object.keys(backend!.Containers).sort()).toEqual([orthanc.Id, tsunagi.Id].sort());
  // dicom のコンテナどうしの通信は、開発用の compose だけが許す（dev.env の ORTHANC_DICOM_ICC=true が届いている）
  const [dicom] = JSON.parse(await docker(["network", "inspect", net("dicom")])) as { Options: Record<string, string> }[];
  expect(dicom!.Options["com.docker.network.bridge.enable_icc"]).toBe("true");

  // Docker のホストの上からは、Orthanc のコンテナの IP アドレスで REST に届く。認証なしも、イメージの既定の利用者も 401
  const orthancIp = orthanc.NetworkSettings.Networks[net("dicom")]!.IPAddress;
  expect(orthancIp).not.toBe("");
  for (const authorization of [undefined, `Basic ${Buffer.from("orthanc:orthanc").toString("base64")}`]) {
    const res = await fetch(`http://${orthancIp}:8042/system`, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status, authorization ? "orthanc:orthanc で REST に入れた" : "認証なしで REST に入れた").toBe(401);
  }

  // ホストに公開した DICOM の口に C-ECHO が通る（Orthanc は C-ECHO を誰からでも受ける）
  await docker(["run", "--rm", "--network", "host", dcmtkImage, "echoscu", "--aetitle", "FLOW_ECHO", "--call", "ORTHANC", "127.0.0.1", dicomPort]);

  // 登録していない AE タイトル（FLOW_ECHO）からの C-STORE は断る（DicomAlwaysAllowStore: false）。架空の患者の画像を1枚作って送る
  const dump = [
    "(0008,0016) UI =SecondaryCaptureImageStorage",
    "(0008,0018) UI [1.2.826.0.1.3680043.10.999.1.1]",
    "(0010,0020) LO [FLOWREJECT]",
    "(0020,000d) UI [1.2.826.0.1.3680043.10.999.1]",
    "(0020,000e) UI [1.2.826.0.1.3680043.10.999.1.2]",
  ].join("\n");
  const storeOut = await docker([
    "run",
    "--rm",
    "--network",
    "host",
    "--entrypoint",
    "sh",
    dcmtkImage,
    "-c",
    'printf "%s\\n" "$1" > /tmp/a.dump && dump2dcm --write-xfer-little /tmp/a.dump /tmp/a.dcm && { storescu --aetitle FLOW_ECHO --call ORTHANC 127.0.0.1 "$2" /tmp/a.dcm 2>&1; echo "storescu-exit=$?"; }',
    "sh",
    dump,
    dicomPort,
  ]);
  expect(storeOut).toMatch(/storescu-exit=[1-9]/);
  const orthancLog = await compose(["logs", "--no-color", "orthanc"]);
  expect(orthancLog).toContain('Rejected Store request from remote DICOM modality with AET "FLOW_ECHO"');
  // 起動の確かめ（healthcheck）は DICOM につながない。AE タイトルの無い接続の記録が出ていない
  expect(orthancLog).not.toMatch(/invalid AET/i);
});

test("2 流れ：dicom-test-generator → Orthanc → tsunagi-dicom の受信一覧 → tsunagi-dicom の送信 → storescp", async ({ page }) => {
  // 架空の患者（患者 ID は試験ごとに変える）
  const patientId = `DEVFLOW${randomBytes(4).toString("hex").toUpperCase()}`;
  const out = await compose(
    ["exec", "-T", "tdg", "python", "-m", "app.cli", "exam", "--emergency", "--patient-id", patientId, "--patient-name", "FLOW^TEST", "-s", "2", "-i", "2,3", "--send", "--json"],
    300_000,
  );
  const exam = JSON.parse(out) as {
    study_instance_uid: string;
    files: string[];
    send: { status: string; destination: string; results: { sop_instance_uid: string; outcome: string }[] };
  };
  const uid = exam.study_instance_uid;
  const sent = exam.send.results.filter((r) => r.outcome === "success").map((r) => r.sop_instance_uid);
  expect(exam.files).toHaveLength(5);
  expect(exam.send).toMatchObject({ status: "sent", destination: "ORTHANC" });
  expect(sent).toHaveLength(exam.files.length);

  await loginAsInitialAdmin(page);

  // tsunagi-dicom の受信一覧（/api/receive-log）に、送った検査が送り元の AE タイトルと画像の数とともに出る
  type ReceiveLog = { items: { remoteAet: string | null; receivedInstances: number; study: { studyInstanceUid: string; patientId: string } }[] };
  const log = await waitFor(
    "受信一覧に出る",
    async () => (await (await page.request.get("/api/receive-log")).json()) as ReceiveLog,
    (body) => body.items.some((i) => i.study.studyInstanceUid === uid && i.receivedInstances === sent.length),
  );
  const item = log.items.find((i) => i.study.studyInstanceUid === uid)!;
  expect(item).toMatchObject({ remoteAet: TDG_AET, receivedInstances: sent.length });
  expect(item.study.patientId).toBe(patientId);

  // 検査の一覧から開き、詳細のパネルの「送信」で storescp（dev-scp）へ送る
  await page.goto("/");
  const row = page.locator(`tr[data-study-uid="${uid}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);
  await page.getByTestId("send-open").click();
  const panel = page.getByTestId("send-panel");
  await panel.getByTestId("send-modality").selectOption(SCP.id);
  await expect(panel.getByTestId("send-confirm")).toContainText(patientId);
  await panel.getByTestId("send-submit").click();
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 120_000 });
  await expect(panel.getByTestId("send-status")).toContainText(`${SCP.id}（${SCP.aet}） へ ${sent.length} 画像`);

  // storescp に、同じ StudyInstanceUID の画像が同じ数だけ、同じ SOPInstanceUID で届く
  const received = await waitFor(
    "storescp に届く",
    async () => (await storescpReceived()).filter((f) => f.studyInstanceUid === uid),
    (files) => files.length >= sent.length,
  );
  expect(received.map((f) => f.sopInstanceUid).sort()).toEqual([...sent].sort());

  // Orthanc の画像は Orthanc の volume（/var/lib/orthanc/db）に書かれている
  const stored = await compose(["exec", "-T", "orthanc", "sh", "-c", "find /var/lib/orthanc/db -type f | wc -l"]);
  expect(Number(stored.trim())).toBeGreaterThan(0);

  // CI の記録に残す数（名前と数だけ）
  console.log(
    `[flow] TDG が作った画像 ${exam.files.length}・TDG から Orthanc へ送れた画像 ${sent.length}・` +
      `tsunagi-dicom の受信一覧の画像 ${item.receivedInstances}（送り元 ${item.remoteAet}）・storescp に届いた画像 ${received.length}`,
  );
});
