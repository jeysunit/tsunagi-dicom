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
  // 文書（Encapsulated PDF など）。Modality の定義語で文書は DOC（Document）。OT は「Other」で、文書とは限らないので
  // どの群にも入れない（PS3.3 C.7.3.1.1.1。2026d で確かめた）
  DOC: ["DOC"],
  SR: ["SR"],
};

export function isModalityGroup(value: unknown): value is ModalityGroup {
  return typeof value === "string" && (MODALITY_GROUPS as readonly string[]).includes(value);
}

/** 群の並びを、見出しの順（MODALITY_GROUPS）にそろえ、重複を除く */
export function orderGroups(groups: readonly ModalityGroup[]): ModalityGroup[] {
  return MODALITY_GROUPS.filter((g) => groups.includes(g));
}

/** 選んだ群に、群を足す（もう入っていれば外す）。見出しの順にそろえる。空になれば undefined（絞らない） */
export function toggleGroup(selected: readonly ModalityGroup[] | undefined, group: ModalityGroup): ModalityGroup[] | undefined {
  const current = selected ?? [];
  const next = orderGroups(current.includes(group) ? current.filter((g) => g !== group) : [...current, group]);
  return next.length > 0 ? next : undefined;
}

/** コンマで区切った群の名前（`CT,MR`）を読む。群でない名前は捨てる。見出しの順にそろえる */
export function parseGroups(value: string | undefined): ModalityGroup[] {
  return orderGroups((value ?? "").split(",").filter(isModalityGroup));
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
