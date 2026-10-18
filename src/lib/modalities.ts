// モダリティの群（docs/spec.md の 3.1 の見出し：すべて・CT・MR・CR/DX・US・ES・MG・DOC・SR）。
// 一覧の絞り込み・色分け・モダリティごとの既定のビューア（3.2）で同じ群を使う。

export const MODALITY_GROUPS = ["CT", "MR", "CR/DX", "US", "ES", "MG", "DOC", "SR"] as const;
export type ModalityGroup = (typeof MODALITY_GROUPS)[number];

/** 群に入る DICOM の Modality の値 */
const MEMBERS: Record<ModalityGroup, readonly string[]> = {
  CT: ["CT"],
  MR: ["MR"],
  "CR/DX": ["CR", "DX"],
  US: ["US"],
  ES: ["ES"],
  MG: ["MG"],
  // 文書（Encapsulated PDF など）。Modality に DOC を使う装置と、OT を使う装置がある
  DOC: ["DOC", "OT"],
  SR: ["SR"],
};

export function isModalityGroup(value: unknown): value is ModalityGroup {
  return typeof value === "string" && (MODALITY_GROUPS as readonly string[]).includes(value);
}

/** DICOM の Modality の値が入る群。どれにも入らなければ null */
export function modalityGroupOf(modality: string): ModalityGroup | null {
  const m = modality.trim().toUpperCase();
  return MODALITY_GROUPS.find((g) => MEMBERS[g].includes(m)) ?? null;
}

/** 検査のモダリティ（ModalitiesInStudy）のどれかが、群に入るか */
export function studyInGroup(modalities: readonly string[], group: ModalityGroup): boolean {
  return modalities.some((m) => modalityGroupOf(m) === group);
}

/** 検査の主な群（モダリティの既定のビューアを選ぶのに使う）。SR・DOC より画像の群を先にする */
export function primaryGroup(modalities: readonly string[]): ModalityGroup | null {
  const groups = modalities.map(modalityGroupOf).filter((g): g is ModalityGroup => g !== null);
  return groups.find((g) => g !== "SR" && g !== "DOC") ?? groups[0] ?? null;
}
