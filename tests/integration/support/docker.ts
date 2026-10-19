import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ITEST } from "./env";

// 試験の相手のコンテナ（docker/test/compose.yaml）を操作する。compose に要る環境の変数は run.mjs が渡している。

const run = promisify(execFile);

export async function compose(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await run("docker", ["compose", "-f", ITEST.composeFile, ...args], {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`docker compose ${args.join(" ")} が失敗した: ${e.stderr?.trim() || e.message}`);
  }
}

/** 試験の画像の組（.e2e/itest/dumps/<組>）を、DCMTK の storescu で Orthanc へ送る */
export async function storescuToOrthanc(batch: string): Promise<void> {
  await compose(["run", "--rm", "--no-deps", "scu", "send-dumps", batch, ITEST.scuAet, ITEST.orthancAet, "orthanc", "4242"], {
    timeoutMs: 180_000,
  });
}

export interface ReceivedFile {
  sopInstanceUid: string;
  studyInstanceUid: string;
}

/** 送り先のダミー（storescp）が受け取ったファイルの、SOPInstanceUID と StudyInstanceUID */
export async function storescpReceived(): Promise<ReceivedFile[]> {
  // dcmdump の +P は、その項目だけを出す。1 ファイルにつき 2 行（StudyInstanceUID・SOPInstanceUID の順とは限らない）
  const out = await compose([
    "exec",
    "-T",
    "storescp",
    "sh",
    "-c",
    'find /received -type f | sort | while read -r f; do printf "FILE\\n"; dcmdump -q +P 0020,000d +P 0008,0018 "$f"; done',
  ]);
  const files: ReceivedFile[] = [];
  let current: Partial<ReceivedFile> | null = null;
  const flush = () => {
    if (current?.sopInstanceUid && current.studyInstanceUid) files.push(current as ReceivedFile);
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

export const stopStorescp = () => compose(["stop", "storescp"]);
export const startStorescp = () => compose(["start", "storescp"]);
