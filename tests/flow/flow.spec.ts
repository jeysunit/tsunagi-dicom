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
// 2. 流れ：dicom-test-generator（DTG）の CLI で架空の患者を Orthanc へ送る → tsunagi-dicom の受信一覧に出る →
//    tsunagi-dicom の「送信」で storescp へ送る → storescp に同じ StudyInstanceUID・SOPInstanceUID の画像が同じ数だけ届く。
// 3. 予約から：ris-emulator の CLI で予約を作る → DTG がワークリスト（MWL）を取得し、その予約で撮って Orthanc へ送る →
//    tsunagi-dicom の検査の一覧に、予約の StudyInstanceUID・受付番号・患者 ID で出る。
// 4. HL7：DTG で緊急の患者を撮る → ris-emulator の pir send（A40）を HL7 の受け口が受ける → 同じ StudyInstanceUID の検査が
//    1 件だけ、正式な患者 ID で一覧に出る。
// 5. 照合（PIR）：DTG で緊急の患者を撮る（MPPS だけが ris-emulator に残る）→ ris-emulator の reconcile list に出る →
//    reconcile run で正式な患者と予約を結ぶ（A40・ORM を受け口が受ける）→ 同じ StudyInstanceUID の検査が 1 件だけ、
//    正式な患者 ID・氏名・受付番号で一覧に出て、ris-emulator の予約は同じ StudyInstanceUID の完了になる。
// 6. 照合の後の追加撮影（IHE PIR の Case 6）：5 と同じ照合の後、DTG で同じ検査に仮の患者情報のまま追加で撮って送る →
//    受け口の見回し（60 秒ごと）が、追加の画像も正式な患者・受付番号に書き換え、同じ StudyInstanceUID の検査 1 件にまとまる。
// 7. 取消の ORM（RAD-13 の CA）：5 と同じ照合の後、ris-emulator の pir send --kind orm --order-control CA を受け口が受ける →
//    検査と画像は残り、受付番号だけが外れる。
// 前の試験の結果に依らないが、順に流す（管理者のパスワードは 2 で変え、3 はそのパスワードでログインする）。

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const root = process.cwd();
const composeFile = path.join(root, "docker/dev/compose.yaml");
const secretsDir = path.resolve(process.env.TSUNAGI_DEV_SECRETS_DIR ?? path.join(root, "docker/dev/secrets"));
/** docker/dev/orthanc/site.json に登録した送信先（storescp） */
const SCP = { id: "dev-scp", aet: "DEV_SCP" };
/** docker/dev/dtg/app_config.yaml の dicom-test-generator（DTG）の AE タイトル（ris-emulator の CT の予約の予定の AE タイトルと同じ） */
const DTG_AET = "DTG_CT01";
const dicomPort = process.env.ORTHANC_DICOM_PORT ?? "4242";
const viewerPort = process.env.DEV_VIEWER_PORT ?? "18042";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await run("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`docker ${args.slice(0, 3).join(" ")} が失敗した: ${e.stderr?.trim() || e.message}`, { cause: error });
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

/** 試験だけのパスワードに変えた後の、管理者のパスワード（次の試験は、これでログインする） */
let adminPassword: string | null = null;

/**
 * 管理者でログインする。最初は、up.sh が作った secret のファイルのパスワードでログインし、試験だけのパスワードに変える。
 * 変えた後は、変えたパスワードでログインする
 */
async function loginAsInitialAdmin(page: Page) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "ログイン" });
  await form.getByLabel("ユーザーID").fill("admin");
  if (adminPassword) {
    await form.getByLabel("パスワード").fill(adminPassword);
    await form.getByRole("button", { name: "ログイン" }).click();
    await expect(page).toHaveURL(/\/$/);
    return;
  }
  const initial = readFileSync(path.join(secretsDir, "initial_admin_password.txt"), "utf8").replace(/\r?\n$/, "");
  const changed = `Flow-${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}-9k`;
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${changed}`);
  await form.getByLabel("パスワード").fill(initial);
  await form.getByRole("button", { name: "ログイン" }).click();
  await expect(page).toHaveURL(/\/login\/password$/);
  const change = page.getByRole("form", { name: "パスワードの変更" });
  await change.locator('input[name="newPassword"]').fill(changed);
  await change.locator('input[name="confirm"]').fill(changed);
  await change.getByRole("button", { name: "変更" }).click();
  await expect(page).toHaveURL(/\/$/);
  adminPassword = changed;
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
  const ris = await inspect(await containerId("ris"));
  expect(ris.Config.Image).toBe(`${project}-ris:local`);
  expect((await inspect(await containerId("dtg"))).Config.Image).toBe(`${project}-dtg:local`);
  expect((await inspect(await containerId("storescp"))).Config.Image).toBe(dcmtkImage);
  expect(tsunagi.Config.Image).toBe(process.env.TSUNAGI_IMAGE || `${project}-tsunagi:local`);

  // ris-emulator：ホストへは Web 画面（8081）だけを 127.0.0.1 に出し、MWL（11112）は出さない。
  // 入るのは dicom と、HL7 の受け口だけと共有する hl7 のネットワーク
  expect(ris.HostConfig.PortBindings).toEqual({ "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: process.env.DEV_RIS_WEB_PORT ?? "18081" }] });
  expect(Object.keys(ris.NetworkSettings.Networks).sort()).toEqual([net("dicom"), net("hl7")].sort());

  // HL7 の受け口：ホストにポートを出さず、hl7 と backend だけに入る（docs/spec.md の 3.5「HL7 による患者情報の更新」）
  const hl7Receiver = await inspect(await containerId("hl7-receiver"));
  expect(hl7Receiver.Config.Image).toBe(`${project}-hl7-receiver:local`);
  expect(Object.keys(hl7Receiver.HostConfig.PortBindings ?? {})).toEqual([]);
  expect(Object.keys(hl7Receiver.NetworkSettings.Networks).sort()).toEqual([net("backend"), net("hl7")].sort());
  // hl7 のネットワークには ris-emulator と受け口だけ
  const [hl7Net] = JSON.parse(await docker(["network", "inspect", net("hl7")])) as { Containers: Record<string, unknown> }[];
  expect(Object.keys(hl7Net!.Containers).sort()).toEqual([ris.Id, hl7Receiver.Id].sort());

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
  // backend は internal で、入っているのは tsunagi-dicom と Orthanc と、開発の一式だけの HL7 の受け口（BFF へ渡すため）
  const [backend] = JSON.parse(await docker(["network", "inspect", net("backend")])) as {
    Internal: boolean;
    Containers: Record<string, unknown>;
  }[];
  expect(backend!.Internal).toBe(true);
  const viewerProxy = await inspect(await containerId("viewer-proxy"));
  expect(Object.keys(backend!.Containers).sort()).toEqual([orthanc.Id, tsunagi.Id, hl7Receiver.Id, viewerProxy.Id].sort());

  // ビューアの入口（viewer-proxy）：ホストの 127.0.0.1 の 8080 だけを出し、backend（Orthanc へ）と web（ホストへ）に入る
  expect(viewerProxy.Config.Image).toBe(`${project}-viewer-proxy:local`);
  expect(viewerProxy.HostConfig.PortBindings).toEqual({ "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: viewerPort }] });
  expect(Object.keys(viewerProxy.NetworkSettings.Networks).sort()).toEqual([net("backend"), net("web")].sort());
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

test("1b ビューア：入口は読み取り専用で、Orthanc の OHIF と Stone の画面が認証つきで届く", async () => {
  const base = `http://127.0.0.1:${viewerPort}`;
  const password = readFileSync(path.join(secretsDir, "backend_password.txt"), "utf8").replace(/\r?\n$/, "");
  const basic = `Basic ${Buffer.from(`tsunagi:${password}`).toString("base64")}`;
  const get = (url: string, headers: Record<string, string> = {}) => fetch(`${base}${url}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });

  // 認証なしは Orthanc が断る（入口は資格情報を持たない）
  expect((await get("/ohif/app-config.js")).status).toBe(401);
  expect((await get("/dicom-web/studies")).status).toBe(401);
  // 認証つきなら、OHIF の設定と画面、Stone の画面が返る（tsunagi-dicom の「開く」が開く形：/ohif/viewer と /stone-webviewer/index.html）
  expect((await get("/ohif/app-config.js", { authorization: basic })).status).toBe(200);
  expect((await get("/ohif/viewer", { authorization: basic })).status).toBe(200);
  expect((await get("/stone-webviewer/index.html", { authorization: basic })).status).toBe(200);
  expect((await get("/dicom-web/studies", { authorization: basic })).status).toBeLessThan(300);
  // 書き込みの方法は、認証つきでも Orthanc に届かず 405
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${base}/instances`, { method, headers: { authorization: basic }, body: method === "DELETE" ? undefined : "x", signal: AbortSignal.timeout(10_000) });
    expect(res.status, `${method} が通った`).toBe(405);
  }
});

test("2 流れ：dicom-test-generator → Orthanc → tsunagi-dicom の受信一覧 → tsunagi-dicom の送信 → storescp", async ({ page, browser }) => {
  // 架空の患者（患者 ID は試験ごとに変える）
  const patientId = `DEVFLOW${randomBytes(4).toString("hex").toUpperCase()}`;
  const out = await compose(
    ["exec", "-T", "dtg", "python", "-m", "app.cli", "exam", "--emergency", "--patient-id", patientId, "--patient-name", "FLOW^TEST", "-s", "2", "-i", "2,3", "--send", "--json"],
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
  expect(item).toMatchObject({ remoteAet: DTG_AET, receivedInstances: sent.length });
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

  // 「開く」：BFF が OHIF の URL（入口の /ohif/viewer?StudyInstanceUIDs=）へ移す。その URL を OHIF で開くと、
  // OHIF が DICOMweb（入口の /dicom-web）からこの検査を取って、画像を描く
  const opened = await page.request.get(`/api/viewers/open?${new URLSearchParams({ study: uid, viewer: "ohif" })}`, {
    maxRedirects: 0,
    headers: { "sec-fetch-site": "same-origin" },
  });
  expect(opened.status()).toBe(302);
  const viewerUrl = opened.headers()["location"]!;
  expect(viewerUrl).toBe(`http://127.0.0.1:${viewerPort}/ohif/viewer?StudyInstanceUIDs=${uid}`);
  const viewerContext = await browser.newContext({ httpCredentials: { username: "tsunagi", password: readFileSync(path.join(secretsDir, "backend_password.txt"), "utf8").replace(/\r?\n$/, "") } });
  try {
    const viewerPage = await viewerContext.newPage();
    const studyLoaded = viewerPage.waitForResponse((r) => r.url().includes(`/dicom-web/studies`) && r.url().includes(uid) && r.status() === 200, { timeout: 90_000 });
    await viewerPage.goto(viewerUrl);
    await studyLoaded;
    await expect(viewerPage.locator("canvas").first()).toBeVisible({ timeout: 90_000 });
  } finally {
    await viewerContext.close();
  }

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

  // 監査の記録の先頭の控え：配る compose の形で、コンテナのログと別のボリュームのファイル（AUDIT_ANCHOR_FILE）に書き出し、
  // /api/audit/verify がファイルの控えと照らし合わせる
  const verify = (await (await page.request.get("/api/audit/verify")).json()) as {
    ok: boolean;
    legacy: number;
    anchors: { status: string; checked: number };
  };
  expect(verify).toMatchObject({ ok: true, legacy: 0, anchors: { status: "checked" } });
  expect(verify.anchors.checked).toBeGreaterThanOrEqual(1);
  expect(await compose(["logs", "--no-color", "tsunagi"])).toContain("tsunagi-dicom: audit-anchor ");
  const anchorFile = await compose(["exec", "-T", "tsunagi", "sh", "-c", "wc -l < /audit-anchors/audit-anchors.jsonl"]);
  expect(Number(anchorFile.trim())).toBeGreaterThanOrEqual(1);

  // CI の記録に残す数（名前と数だけ）
  console.log(
    `[flow] DTG が作った画像 ${exam.files.length}・DTG から Orthanc へ送れた画像 ${sent.length}・` +
      `tsunagi-dicom の受信一覧の画像 ${item.receivedInstances}（送り元 ${item.remoteAet}）・storescp に届いた画像 ${received.length}`,
  );
});

test("3 予約から：ris-emulator で予約を作る → DTG がワークリストを取得して撮る → Orthanc に届き、tsunagi-dicom の一覧に予約の値で出る", async ({ page }) => {
  // ris-emulator の CLI で、今日の CT の予約を 1 件作る（架空の患者。予定の AE タイトルは DTG の DTG_CT01）
  const [order] = JSON.parse(await compose(["exec", "-T", "ris", "python", "-m", "app.cli", "create", "CT=1", "--json"])) as {
    accession_number: string;
    study_instance_uid: string;
    patient: { patient_id: string };
    scheduled_station_ae_title: string;
  }[];
  expect(order).toBeDefined();
  expect(order!.scheduled_station_ae_title).toBe(DTG_AET);

  // DTG がワークリスト（ris-emulator の MWL。C-FIND）を引く。予約が、同じ受付番号・StudyInstanceUID・患者 ID で返る
  const query = JSON.parse(
    await compose(["exec", "-T", "dtg", "python", "-m", "app.cli", "worklist", "query", "--accession", order!.accession_number, "--json"]),
  ) as { worklist: string; items: { key: string; accession_number: string; study_instance_uid: string; patient_id: string; modality: string }[] };
  expect(query.worklist).toBe("RIS_EMU");
  expect(query.items).toHaveLength(1);
  const wl = query.items[0]!;
  expect(wl).toMatchObject({
    accession_number: order!.accession_number,
    study_instance_uid: order!.study_instance_uid,
    patient_id: order!.patient.patient_id,
    modality: "CT",
  });

  // その予約で撮って、Orthanc へ送る
  const exam = JSON.parse(
    await compose(["exec", "-T", "dtg", "python", "-m", "app.cli", "exam", "--from-worklist", wl.key, "-s", "1", "-i", "2", "--send", "--json"], 300_000),
  ) as { study_instance_uid: string; files: string[]; send: { status: string; destination: string } };
  expect(exam.study_instance_uid).toBe(order!.study_instance_uid);
  expect(exam.files).toHaveLength(2);
  expect(exam.send).toMatchObject({ status: "sent", destination: "ORTHANC" });

  // tsunagi-dicom の検査の一覧（受付番号で絞る）に、予約の StudyInstanceUID・受付番号・患者 ID の検査が出る
  await loginAsInitialAdmin(page);
  type StudyList = { studies: { studyInstanceUid: string; accessionNumber?: string; patientId?: string }[] };
  const list = await waitFor(
    "検査の一覧に出る",
    async () => (await (await page.request.get(`/api/studies?${new URLSearchParams({ accession: order!.accession_number })}`)).json()) as StudyList,
    (body) => body.studies.some((s) => s.studyInstanceUid === order!.study_instance_uid),
  );
  const study = list.studies.find((s) => s.studyInstanceUid === order!.study_instance_uid)!;
  expect(study).toMatchObject({ accessionNumber: order!.accession_number, patientId: order!.patient.patient_id });

  // CI の記録に残す数（名前と数だけ）
  console.log(`[flow] 予約から：ワークリストの件数 ${query.items.length}・DTG が作った画像 ${exam.files.length}・一覧に出た検査 1`);
});

test("4 HL7：緊急の患者で撮る → ris-emulator の pir send（A40）→ 受け口 → 同じ UID のまま正式な患者 ID で一覧に出る", async ({ page }) => {
  // 試験ごとに別の架空の患者 ID にする（前の流れの結果に依らない）
  const suffix = Date.now().toString().slice(-8);
  const priorId = `ER${suffix}`;
  const patientId = `PF${suffix}`;
  const exam = JSON.parse(
    await compose(
      ["exec", "-T", "dtg", "python", "-m", "app.cli", "exam", "--emergency", "--patient-id", priorId, "--patient-name", "FLOW^EMERGENCY",
        "-s", "1", "-i", "2", "--send", "--json"],
      300_000,
    ),
  ) as { study_instance_uid: string; files: string[]; send: { status: string } };
  expect(exam.send).toMatchObject({ status: "sent" });

  await loginAsInitialAdmin(page);
  type StudyList = { studies: { studyInstanceUid: string; patientId?: string }[] };
  const listed = async () => (await (await page.request.get("/api/studies")).json()) as StudyList;
  await waitFor("緊急の検査が一覧に出る", listed, (body) => body.studies.some((s) => s.studyInstanceUid === exam.study_instance_uid));

  // ris-emulator から受け口（hl7-receiver）へ A40 を送る。受理（AA）なら終了コード 0
  await compose(
    ["exec", "-T", "ris", "python", "-m", "app.cli", "pir", "send", "--host", "hl7-receiver", "--kind", "a40",
      "--patient-id", patientId, "--prior-patient-id", priorId, "--name", "FLOW^MERGE=流れ^太郎=ナガレ^タロウ"],
    120_000,
  );

  // 同じ StudyInstanceUID の検査が 1 件だけ、正式な患者 ID で出る（元の患者 ID の検査は残らない）
  const after = await waitFor("正式な患者 ID で出る", listed, (body) =>
    body.studies.some((s) => s.studyInstanceUid === exam.study_instance_uid && s.patientId === patientId),
  );
  const same = after.studies.filter((s) => s.studyInstanceUid === exam.study_instance_uid);
  expect(same).toHaveLength(1);
  expect(after.studies.some((s) => s.patientId === priorId)).toBe(false);

  console.log(`[flow] HL7：A40 で統合した検査 1・画像 ${exam.files.length}`);
});

test("5 照合：緊急の患者で撮る → ris-emulator の未照合に出る → 照合（A40・ORM）→ 同じ UID のまま、正式な患者・受付番号で一覧に出る", async ({ page }) => {
  const suffix = Date.now().toString().slice(-8);
  const priorId = `EP${suffix}`;
  const patientId = `PR${suffix}`;
  const ris = (...args: string[]) => compose(["exec", "-T", "ris", "python", "-m", "app.cli", ...args], 120_000);

  // 緊急の患者（予約なし）で撮って送る。DTG は MPPS（予約の項目が空）を ris-emulator に送る
  const exam = JSON.parse(
    await compose(
      ["exec", "-T", "dtg", "python", "-m", "app.cli", "exam", "--emergency", "--patient-id", priorId, "--patient-name", "FLOW^UNKNOWN",
        "-s", "1", "-i", "2", "--send", "--json"],
      300_000,
    ),
  ) as { study_instance_uid: string; files: string[]; send: { status: string } };
  expect(exam.send).toMatchObject({ status: "sent" });

  await loginAsInitialAdmin(page);
  type StudyList = {
    studies: { studyInstanceUid: string; patientId?: string; patientName?: string; patientBirthDate?: string; patientSex?: string; accessionNumber?: string; instanceCount?: number }[];
  };
  const listed = async () => (await (await page.request.get("/api/studies")).json()) as StudyList;
  await waitFor("緊急の検査が一覧に出る", listed, (body) => body.studies.some((s) => s.studyInstanceUid === exam.study_instance_uid));

  // 画像ごとの SeriesInstanceUID と SOPInstanceUID の組（DICOMweb の WADO-RS の中継の metadata）。照合の前後で変わらないことを確かめる
  const instanceUids = async () => {
    const res = await page.request.get(`/api/dicom-web/studies/${exam.study_instance_uid}/metadata`, { headers: { accept: "application/dicom+json" } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, { Value?: string[] }>[];
    return body.map((i) => `${i["0020000E"]?.Value?.[0]}/${i["00080018"]?.Value?.[0]}`).sort();
  };
  const before = await instanceUids();
  expect(before).toHaveLength(exam.files.length);

  // ris-emulator の未照合に、仮の患者 ID と撮影の StudyInstanceUID で出る（予約どおりでない撮影の MPPS）
  type Unreconciled = { sop_instance_uid: string; status: string; patient_id: string; study_instance_uid: string; modality: string; problem: string };
  const unreconciled = await waitFor(
    "未照合に出る",
    async () => JSON.parse(await ris("reconcile", "list", "--json")) as Unreconciled[],
    (items) => items.some((i) => i.patient_id === priorId),
  );
  const item = unreconciled.find((i) => i.patient_id === priorId)!;
  expect(item).toMatchObject({ study_instance_uid: exam.study_instance_uid, status: "COMPLETED", modality: "CT", problem: "" });

  // 正式な患者で照合する。ADT^A40 と ORM^O01 を受け口が受け、どちらも受理（AA）される（受理されなければ終了コードが 0 でなく、ここで失敗する）
  const result = JSON.parse(
    await ris("reconcile", "run", item.sop_instance_uid, "--patient-id", patientId, "--name", "FLOW^PIR=流れ^照合=ナガレ^ショウゴウ",
      "--birth-date", "19980312", "--sex", "M", "--json"),
  ) as { accession_number: string; deliveries: { message_type: string; outcome: string }[] };
  expect(result.deliveries.map((d) => [d.message_type, d.outcome])).toEqual([
    ["ADT^A40", "accepted"],
    ["ORM^O01", "accepted"],
  ]);
  const accession = result.accession_number;

  // 同じ StudyInstanceUID の検査が 1 件だけ、正式な患者 ID・生年月日・性別・受付番号で出る。元の患者 ID の検査は残らない。画像の数は変わらない
  const after = await waitFor("正式な患者・受付番号で出る", listed, (body) =>
    body.studies.some((s) => s.studyInstanceUid === exam.study_instance_uid && s.patientId === patientId && s.accessionNumber === accession),
  );
  const same = after.studies.filter((s) => s.studyInstanceUid === exam.study_instance_uid);
  expect(same).toHaveLength(1);
  expect(same[0]).toMatchObject({ patientId, patientBirthDate: "19980312", patientSex: "M", accessionNumber: accession, instanceCount: exam.files.length });
  expect(same[0]!.patientName).toContain("流れ");
  expect(await instanceUids()).toEqual(before);
  expect(after.studies.some((s) => s.patientId === priorId)).toBe(false);

  // ris-emulator の予約は、撮影の StudyInstanceUID で、撮影が完了しているので完了になる。照合済みは未照合から外れる
  const orders = JSON.parse(await ris("list", "--json")) as { accession_number: string; study_instance_uid: string; status: string }[];
  expect(orders.find((o) => o.accession_number === accession)).toMatchObject({ study_instance_uid: exam.study_instance_uid, status: "completed" });
  const rest = JSON.parse(await ris("reconcile", "list", "--json")) as Unreconciled[];
  expect(rest.some((i) => i.sop_instance_uid === item.sop_instance_uid)).toBe(false);

  console.log(`[flow] 照合：A40・ORM を受理 2・照合した検査 1・画像 ${exam.files.length}`);
});

type FlowStudy = {
  studyInstanceUid: string;
  patientId?: string;
  accessionNumber?: string;
  instanceCount?: number;
};

/**
 * 5 と同じ流れで、緊急の患者（仮の患者 ID）の検査を撮って送り、ris-emulator で正式な患者に照合する（A40・ORM が受理されるまで）。
 * 6・7 が、この後の動きを確かめる出発点にする。ログインは済ませておく
 */
async function emergencyReconciled(page: Page, prefix: string) {
  const suffix = Date.now().toString().slice(-8);
  const priorId = `${prefix}${suffix}`;
  const patientId = `PR${prefix}${suffix}`;
  const priorName = "FLOW^UNKNOWN";
  const ris = (...args: string[]) => compose(["exec", "-T", "ris", "python", "-m", "app.cli", ...args], 120_000);
  const dtg = (...args: string[]) => compose(["exec", "-T", "dtg", "python", "-m", "app.cli", ...args], 300_000);

  const exam = JSON.parse(
    await dtg("exam", "--emergency", "--patient-id", priorId, "--patient-name", priorName, "-s", "1", "-i", "2", "--send", "--json"),
  ) as { study_instance_uid: string; files: string[]; send: { status: string } };
  expect(exam.send).toMatchObject({ status: "sent" });

  const listed = async () => ((await (await page.request.get("/api/studies")).json()) as { studies: FlowStudy[] }).studies;
  await waitFor("緊急の検査が一覧に出る", listed, (studies) => studies.some((s) => s.studyInstanceUid === exam.study_instance_uid));

  const unreconciled = await waitFor(
    "未照合に出る",
    async () => JSON.parse(await ris("reconcile", "list", "--json")) as { sop_instance_uid: string; patient_id: string }[],
    (items) => items.some((i) => i.patient_id === priorId),
  );
  const item = unreconciled.find((i) => i.patient_id === priorId)!;
  const result = JSON.parse(
    await ris("reconcile", "run", item.sop_instance_uid, "--patient-id", patientId, "--name", "FLOW^PIR=流れ^照合=ナガレ^ショウゴウ",
      "--birth-date", "19980312", "--sex", "M", "--json"),
  ) as { accession_number: string; deliveries: { message_type: string; outcome: string }[] };
  expect(result.deliveries.map((d) => [d.message_type, d.outcome])).toEqual([
    ["ADT^A40", "accepted"],
    ["ORM^O01", "accepted"],
  ]);
  const accession = result.accession_number;
  await waitFor("正式な患者・受付番号で出る", listed, (studies) =>
    studies.some((s) => s.studyInstanceUid === exam.study_instance_uid && s.patientId === patientId && s.accessionNumber === accession),
  );
  return { uid: exam.study_instance_uid, priorId, priorName, patientId, accession, imageCount: exam.files.length, ris, dtg, listed };
}

test("6 照合の後の追加撮影：仮の患者情報で追加で撮って送る → 見回しが書き換え、同じ UID の検査 1 件に正式な患者・受付番号でまとまる", async ({ page }) => {
  await loginAsInitialAdmin(page);
  const flow = await emergencyReconciled(page, "EA");

  // 照合の後に、同じ検査（同じ StudyInstanceUID）へ、仮の患者 ID・氏名のまま追加で撮って Orthanc へ送る（新しいシリーズ）
  const added = JSON.parse(
    await flow.dtg("exam", "--emergency", "--append", "--study-uid", flow.uid, "--patient-id", flow.priorId, "--patient-name", flow.priorName,
      "-s", "1", "-i", "2", "--send", "--json"),
  ) as { study_instance_uid: string; files: string[]; send: { status: string } };
  expect(added.study_instance_uid).toBe(flow.uid);
  expect(added.send).toMatchObject({ status: "sent" });
  const total = flow.imageCount + added.files.length;

  // 受け口の見回し（60 秒ごと）が、届き終えた（Orthanc の IsStable）追加の画像を、正式な患者・受付番号の検査にまとめる。
  // 待つのは、見回しの間隔と、画像が安定するまでの時間
  const after = await waitFor(
    "追加の画像が正式な患者・受付番号の検査にまとまる",
    flow.listed,
    (studies) => {
      const same = studies.filter((s) => s.studyInstanceUid === flow.uid);
      return same.length === 1 && same[0]!.patientId === flow.patientId && same[0]!.instanceCount === total;
    },
    240_000,
  );
  const same = after.filter((s) => s.studyInstanceUid === flow.uid);
  expect(same).toHaveLength(1);
  expect(same[0]).toMatchObject({ patientId: flow.patientId, accessionNumber: flow.accession, instanceCount: total });
  expect(after.some((s) => s.patientId === flow.priorId)).toBe(false);

  console.log(`[flow] 追加撮影：画像 ${flow.imageCount} + ${added.files.length} が正式な患者の検査 1 にまとまった`);
});

test("7 取消の ORM：照合の後に ORM の CA を送る → 検査と画像は残り、受付番号だけが外れる", async ({ page }) => {
  await loginAsInitialAdmin(page);
  const flow = await emergencyReconciled(page, "EC");
  const before = (await flow.listed()).filter((s) => s.studyInstanceUid === flow.uid);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ patientId: flow.patientId, accessionNumber: flow.accession, instanceCount: flow.imageCount });

  // ris-emulator から、照合で作った予約の取消（ORC-1 = CA）を受け口へ送る。受理（AA）なら終了コードは 0
  const cancel = () => flow.ris("pir", "send", "--host", "hl7-receiver", "--kind", "orm", "--accession", flow.accession, "--order-control", "CA");
  expect(await cancel()).toContain("受理されました");

  // 検査も画像も消さず、受付番号だけが外れる。患者は変わらない
  const after = await waitFor(
    "受付番号が外れる",
    async () => (await flow.listed()).filter((s) => s.studyInstanceUid === flow.uid),
    (studies) => studies.length === 1 && !studies[0]!.accessionNumber,
  );
  expect(after[0]).toMatchObject({ patientId: flow.patientId, instanceCount: flow.imageCount });

  // 受付番号がすでに空の検査への CA は、何も変えずに受理される（同じ取消の送り直し）
  expect(await cancel()).toContain("受理されました");
  const again = (await flow.listed()).filter((s) => s.studyInstanceUid === flow.uid);
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ patientId: flow.patientId, instanceCount: flow.imageCount });
  expect(again[0]!.accessionNumber ?? "").toBe("");

  console.log(`[flow] 取消：ORM の CA を受理 2・検査 1 の受付番号が外れた・画像 ${flow.imageCount}`);
});
