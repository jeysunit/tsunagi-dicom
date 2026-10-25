import { createHash, randomUUID } from "node:crypto";
import { BackendError, BackendUnknownError, type Backend, type JobState, type PatientInstance } from "@/lib/backend/types";

/**
 * HL7 の書き換えの試験のための、画像ごとの小さな Orthanc。検査の ID は Orthanc と同じく患者 ID と
 * StudyInstanceUID から決まるので、仮の患者 ID の画像と正式な患者の画像は、同じ UID でも別の検査になる。
 * 書き換え（modify）は UID を保ち、元を残す（KeepSource: true）。同じ検査の同じ SOP の画像は上書きする
 * （OverwriteInstances）。元の画像は deleteStudyInstances で名指しで消す。
 */
export interface FakeOrthanc {
  backend: Backend;
  instances: PatientInstance[];
  /** 届き終えていない検査の ID */
  unstable: Set<string>;
  /**
   * 次の書き換えの仕事の結果（既定は Success。partial は 1 枚だけ書き換えて Success）。beforeModify は仕事が画像を
   * 読んだ後に呼ぶ（最中に届いた画像を作る）。wholeStudyDelete は、次の画像の削除で名指しに関わらず検査ごと消す
   * （画像の削除を誤る Orthanc）。beforeDelete は削除の前（ファイルの印を見る前）、duringDelete は印を見た後で消す前に
   * 呼ぶ（届き直しを作る）。changesFail は次の変更の記録の読み取りを結果不明で失敗させ、deleteFailAfter は次の削除を
   * その枚数だけ消した後に結果不明で止める（時間切れ・一部だけの削除）
   */
  next: {
    state?: JobState; partial?: boolean; beforeModify?: () => void; wholeStudyDelete?: boolean;
    beforeDelete?: () => void; duringDelete?: () => void; changesFail?: boolean; deleteFailAfter?: number;
  };
  add(instance: Partial<PatientInstance> & Pick<PatientInstance, "PatientID" | "StudyInstanceUID">): PatientInstance;
  /**
   * C-STORE で画像を受ける（deploy/orthanc/tsunagi-lock.lua と同じく、同じ StudyInstanceUID の検査のどれかに期限の
   * 切れていない付け替えの印があれば断る）。受ければ、同じ検査の同じ SOP の画像を上書きする（OverwriteInstances）
   */
  cstore(instance: Partial<PatientInstance> & Pick<PatientInstance, "PatientID" | "StudyInstanceUID">): "stored" | "refused";
  /** REST・STOW-RS で画像を受ける（印に関わらず受け、同じ検査の同じ SOP の画像を上書きする。上書きした画像に ModifiedFrom は無い） */
  restStore(instance: Partial<PatientInstance> & Pick<PatientInstance, "PatientID" | "StudyInstanceUID">): PatientInstance;
  /** 付け替えの印（検査の ID → 期限の UNIX 秒）。画像が 1 枚も無くなった検査の印は、Orthanc と同じく無いものとする */
  locks: Map<string, number>;
  /** 印を付けない（Orthanc に UserMetadata が無いときの形） */
  lockRefused: boolean;
  /** 印・書き換え・削除の順（"lock:<検査の ID>"・"unlock:…"・"modify:…"・"delete:…"） */
  events: string[];
  studyId(patientId: string, uid: string): string;
  modifyCalls: { id: string; replace: Record<string, string> }[];
  deleteCalls: { id: string; sops: string[] }[];
  /** 仕事の状態（試験が後から Success にする） */
  jobs: Map<string, JobState>;
}

export function createFakeOrthanc(): FakeOrthanc {
  const jobs = new Map<string, JobState>();
  const studyId = (patientId: string, uid: string) =>
    createHash("sha256").update(`${patientId}|${uid}`).digest("hex").slice(0, 40).match(/.{8}/g)!.join("-");
  const idOf = (i: PatientInstance) => studyId(i.PatientID, i.StudyInstanceUID);
  const triple = (i: PatientInstance) => [i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|");
  // Orthanc のファイルの印（FileUuid）。画像を足す・置き換えるたびに新しい印になる（画像の物ごとに持つ）
  const files = new WeakMap<PatientInstance, string>();
  const fileOf = (i: PatientInstance) => {
    if (!files.has(i)) files.set(i, randomUUID());
    return files.get(i)!;
  };
  // Orthanc の画像の ID（検査と UID の組で決まる）と、変更の記録（届いた画像の ID の並び。位置は並びの長さ）
  const instanceIdOf = (i: PatientInstance) => `${idOf(i)}|${triple(i)}`;
  const arrivals: string[] = [];
  // 書き換えの写しの ModifiedFrom（元の画像の ID）。画像の物ごとに持つので、上書きされた画像には無い
  const modifiedFrom = new WeakMap<PatientInstance, string>();
  const complete = (instance: Partial<PatientInstance> & Pick<PatientInstance, "PatientID" | "StudyInstanceUID">): PatientInstance => ({
    PatientName: "",
    PatientBirthDate: "",
    PatientSex: "",
    AccessionNumber: "",
    SeriesInstanceUID: `${instance.StudyInstanceUID}.1`,
    SOPInstanceUID: `${instance.StudyInstanceUID}.1.${fake.instances.length + 1}`,
    SpecificCharacterSet: "ISO_IR 192",
    ...instance
  });
  const store = (full: PatientInstance) => {
    fake.instances = fake.instances.filter(i => !(triple(i) === triple(full) && idOf(i) === idOf(full)));
    fake.instances.push(full);
    arrivals.push(instanceIdOf(full));
    return full;
  };
  const hasStudy = (id: string) => fake.instances.some(i => idOf(i) === id);
  const fake: FakeOrthanc = {
    instances: [],
    unstable: new Set(),
    next: {},
    modifyCalls: [],
    jobs,
    deleteCalls: [],
    locks: new Map(),
    lockRefused: false,
    events: [],
    studyId,
    add(instance) {
      const full = complete(instance);
      fake.instances.push(full);
      arrivals.push(instanceIdOf(full));
      return full;
    },
    cstore(instance) {
      const now = Date.now() / 1000;
      const locked = [...fake.locks].some(([id, until]) => until > now && hasStudy(id)
        && fake.instances.some(i => idOf(i) === id && i.StudyInstanceUID === instance.StudyInstanceUID));
      if (locked) {
        return "refused";
      }
      store(complete(instance));
      return "stored";
    },
    restStore(instance) {
      return store(complete(instance));
    },
    backend: undefined as unknown as Backend
  };
  const backend = {
    kind: "orthanc",
    mock: true,
    async findStudiesByPatientId(patientId: string) {
      return [...new Set(fake.instances.filter(i => i.PatientID === patientId).map(idOf))];
    },
    async studyInstanceTags(id: string) {
      const found = fake.instances.filter(i => idOf(i) === id).map(i => ({ ...i }));
      // 本物の Orthanc は、画像が 1 枚も無い検査を持たない（404。http.ts は「画像のタグを読み込めません」を投げる）
      if (!found.length) {
        throw new BackendError("画像のタグを読み込めません");
      }
      return found;
    },
    async studyIsStable(id: string) {
      return !fake.unstable.has(id);
    },
    async lookupStudyIds(uid: string) {
      return [...new Set(fake.instances.filter(i => i.StudyInstanceUID === uid).map(idOf))];
    },
    async modifyStudyKeepingUids(id: string, replace: Record<string, string>) {
      fake.modifyCalls.push({ id, replace: { ...replace } });
      fake.events.push(`modify:${id}`);
      // 仕事が書き換えるのは、仕事を作った時点の画像だけ（その後に届いた画像は残る）
      const source = fake.instances.filter(i => idOf(i) === id);
      fake.next.beforeModify?.();
      const state = fake.next.state ?? "Success";
      const changed = state === "Failure" ? [] : fake.next.partial ? source.slice(0, 1) : source;
      for (const instance of changed) {
        const updated = { ...instance, ...replace } as PatientInstance;
        // 書き換えた先の検査の同じ SOP の画像は上書きする。患者 ID が変われば先の検査は別なので、元は残る
        fake.instances = fake.instances.filter(i => !(triple(i) === triple(updated) && idOf(i) === idOf(updated)));
        fake.instances.push(updated);
        arrivals.push(instanceIdOf(updated));
        modifiedFrom.set(updated, instanceIdOf(instance));
      }
      const { wholeStudyDelete, beforeDelete, duringDelete, changesFail, deleteFailAfter } = fake.next;
      fake.next = { wholeStudyDelete, beforeDelete, duringDelete, changesFail, deleteFailAfter };
      const jobId = randomUUID();
      jobs.set(jobId, state);
      return { jobId };
    },
    async studyInstanceFiles(id: string) {
      const list = fake.instances.filter(i => idOf(i) === id);
      return {
        since: arrivals.length,
        files: Object.fromEntries(list.map(i => [triple(i), fileOf(i)])),
        ids: Object.fromEntries(list.map(i => [triple(i), instanceIdOf(i)]))
      };
    },
    async lockStudy(id: string, until: number) {
      if (fake.lockRefused || !hasStudy(id)) {
        throw new BackendError("画像サーバーが付け替えの印を断りました（404）");
      }
      fake.locks.set(id, until);
      fake.events.push(`lock:${id}`);
    },
    async unlockStudy(id: string) {
      fake.locks.delete(id);
      fake.events.push(`unlock:${id}`);
    },
    async studyInstanceOrigins(id: string) {
      return Object.fromEntries(fake.instances.filter(i => idOf(i) === id).map(i => [triple(i), modifiedFrom.get(i) ?? null]));
    },
    // http.ts と同じく、印を見て消す画像の ID を決め、1 枚ずつ、消す直前に変更の記録で届き直しを確かめてから ID で消す。
    // Orthanc と同じく、消した画像の変更の記録も消える
    async deleteStudyInstances(
      id: string, named: PatientInstance[], source: { since: number; files: Record<string, string> }, beforeEach?: () => Promise<void>,
    ) {
      const { beforeDelete, duringDelete, wholeStudyDelete, changesFail, deleteFailAfter } = fake.next;
      fake.next = {};
      beforeDelete?.();
      // 1 枚ごとの呼び出しは、消す枚数の分だけ先に呼ぶ（投げれば何も消さない）
      for (let k = 0; k < named.length; k++) await beforeEach?.();
      fake.deleteCalls.push({ id, sops: named.map(i => i.SOPInstanceUID) });
      fake.events.push(`delete:${id}`);
      const names = new Set(named.map(triple));
      const candidates = fake.instances
        .filter(i => idOf(i) === id && names.has(triple(i)) && source.files[triple(i)] === fileOf(i))
        .map(instanceIdOf);
      duringDelete?.();
      if (changesFail) {
        throw new BackendUnknownError();
      }
      const doomed = new Set(candidates.filter(c => !arrivals.slice(source.since).includes(c)).slice(0, deleteFailAfter));
      fake.instances = fake.instances.filter(i => idOf(i) !== id || (!wholeStudyDelete && !doomed.has(instanceIdOf(i))));
      for (let k = arrivals.length - 1; k >= 0; k--) {
        if (doomed.has(arrivals[k]!)) arrivals[k] = "（消した画像の記録）";
      }
      if (deleteFailAfter !== undefined) {
        throw new BackendUnknownError();
      }
    },
    async jobStatus(jobId: string) {
      const state = jobs.get(jobId);
      return state ? {
        id: jobId,
        state,
        progress: 100,
        errorCode: 0,
        errorDescription: "",
        creationTime: "",
        completionTime: null
      } : null;
    }
  };
  fake.backend = backend as unknown as Backend;
  return fake;
}
