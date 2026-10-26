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
    throw new Error(`docker compose ${args.join(" ")} が失敗した: ${e.stderr?.trim() || e.message}`, { cause: error });
  }
}

/** 試験の画像の組（.e2e/itest/dumps/<組>）を、DCMTK の storescu で Orthanc へ送る */
export async function storescuToOrthanc(batch: string): Promise<void> {
  await compose(["run", "--rm", "--no-deps", "scu", "send-dumps", batch, ITEST.scuAet, ITEST.orthancAet, "orthanc", "4242"], {
    timeoutMs: 180_000,
  });
}

export interface FindAnswer {
  characterSet: string | null;
  patientName: string | null;
  studyDescription: string | null;
}

/**
 * Orthanc へ C-FIND（検査の単位。患者 ID で絞る）を送り、答えの 1 件目の文字の集合・氏名・検査名を返す（文字の集合の測定用）。
 * queryCharset を省くと、問い合わせの SpecificCharacterSet は空（全部に合う）
 */
export async function findscuStudy(patientId: string, queryCharset = ""): Promise<FindAnswer> {
  const dump = await compose(
    ["run", "--rm", "--no-deps", "scu", "find-study", ITEST.scuAet, ITEST.orthancAet, "orthanc", "4242", patientId, ...(queryCharset ? [queryCharset] : [])],
    { timeoutMs: 60_000 },
  );
  // dcmdump の行：`(0010,0010) PN [値]   # …`。値が無いときは `(no value available)`
  const read = (tag: string) => {
    const m = new RegExp(`^\\(${tag}\\) \\w\\w (?:\\[(.*)\\]|\\(no value available\\))\\s+#`, "m").exec(dump);
    return m ? (m[1] ?? "") : null;
  };
  return { characterSet: read("0008,0005"), patientName: read("0010,0010"), studyDescription: read("0008,1030") };
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
