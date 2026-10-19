import { orthancUrl, orthancUser } from "./env";

// 試験から Orthanc の REST を直に読む（BFF の答えを、Orthanc の側の事実と照らすため）。資格情報は試験だけの値。

function authorization(): string {
  const { username, password } = orthancUser();
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export async function orthanc(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<Response> {
  return fetch(`${orthancUrl}/${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: authorization(), ...(init.contentType ? { "content-type": init.contentType } : {}) },
    body: init.body,
    signal: AbortSignal.timeout(30_000),
  });
}

export async function orthancJson<T = unknown>(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<T> {
  const res = await orthanc(path, init);
  if (!res.ok) throw new Error(`Orthanc ${init.method ?? "GET"} /${path} の答えが ${res.status}`);
  return (await res.json()) as T;
}

/** StudyInstanceUID から Orthanc の中の検査の ID（無ければ空） */
export async function lookupStudy(studyInstanceUid: string): Promise<string[]> {
  const found = await orthancJson<{ Type: string; ID: string }[]>("tools/lookup", {
    method: "POST",
    body: studyInstanceUid,
    contentType: "text/plain",
  });
  return found.filter((r) => r.Type === "Study").map((r) => r.ID);
}

export interface OrthancJob {
  ID: string;
  Type: string;
  State: string;
  ErrorCode: number;
  ErrorDescription: string;
  ErrorDetails?: string;
  CreationTime: string;
  CompletionTime?: string;
  Progress: number;
  Content?: Record<string, unknown>;
}

export const listJobs = () => orthancJson<OrthancJob[]>("jobs?expand");

/** 決めた時間の中で、条件が満たされるまで読み直す */
export async function waitFor<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch {
      // 読めないときは次の回に読み直す
    }
    if (Date.now() > until) throw new Error(`${what} を待ちきれなかった（最後の値：${JSON.stringify(last)?.slice(0, 500)}）`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
