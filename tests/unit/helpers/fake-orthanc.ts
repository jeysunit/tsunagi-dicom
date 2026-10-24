import { createHash, randomUUID } from "node:crypto";
import type { Backend, JobState, PatientInstance } from "@/lib/backend/types";

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
   * （画像の削除を誤る Orthanc）
   */
  next: { state?: JobState; partial?: boolean; beforeModify?: () => void; wholeStudyDelete?: boolean };
  add(instance: Partial<PatientInstance> & Pick<PatientInstance, "PatientID" | "StudyInstanceUID">): PatientInstance;
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
  const fake: FakeOrthanc = {
    instances: [],
    unstable: new Set(),
    next: {},
    modifyCalls: [],
    jobs,
    deleteCalls: [],
    studyId,
    add(instance) {
      const full: PatientInstance = {
        PatientName: "",
        PatientBirthDate: "",
        PatientSex: "",
        AccessionNumber: "",
        SeriesInstanceUID: `${instance.StudyInstanceUID}.1`,
        SOPInstanceUID: `${instance.StudyInstanceUID}.1.${fake.instances.length + 1}`,
        SpecificCharacterSet: "ISO_IR 192",
        ...instance
      };
      fake.instances.push(full);
      return full;
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
      return fake.instances.filter(i => idOf(i) === id).map(i => ({ ...i }));
    },
    async studyIsStable(id: string) {
      return !fake.unstable.has(id);
    },
    async lookupStudyIds(uid: string) {
      return [...new Set(fake.instances.filter(i => i.StudyInstanceUID === uid).map(idOf))];
    },
    async modifyStudyKeepingUids(id: string, replace: Record<string, string>) {
      fake.modifyCalls.push({ id, replace: { ...replace } });
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
      }
      fake.next = { wholeStudyDelete: fake.next.wholeStudyDelete };
      const jobId = randomUUID();
      jobs.set(jobId, state);
      return { jobId };
    },
    async deleteStudyInstances(id: string, named: PatientInstance[]) {
      fake.deleteCalls.push({ id, sops: named.map(i => i.SOPInstanceUID) });
      const names = new Set(named.map(triple));
      const whole = fake.next.wholeStudyDelete;
      fake.next = {};
      fake.instances = fake.instances.filter(i => idOf(i) !== id || (!whole && !names.has(triple(i))));
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
