"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ModalityMark } from "@/components/ui/modality-mark";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import { CellMain, CellSub, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parsePatientName } from "@/lib/format/patient-name";
import { checkHead, formatCount, formatSize, HEAD_BYTES, UNREADABLE_REASON } from "@/lib/import/dicom-preview";
import {
  abortBody,
  addedMessage,
  addFiles,
  badgeOf,
  cancelWaiting,
  countItems,
  formbarText,
  isSelected,
  resultNotice,
  seriesImageText,
  skippedNote,
  sortForList,
  type PickInput,
  type PickItem,
  type PickPhase,
} from "@/lib/import/picker-model";
import { cn } from "@/lib/utils";

// ファイルを選ぶ部品（docs/design-system/parts.md の「ファイルを選ぶ部品」。ui-kit 1.2.6 の `.picker`）。
// 選ぶ→件数・大きさ・患者と検査を確かめる→除外（戻せる）か中止で外す→インポート、の順を変えない。
// 送る中身（1 件ずつの要求）は呼ぶ側の importFile が持つ。この部品は、選んだものの数え方・並び・状態・焦点・読み上げを持つ。
// ファイル名とタグの値は外から来る値なので、React の文字として出す（HTML として入れない）。

/**
 * 1 件の結果。成功は ok（note は札の下の 1 句。例：もう保管にあった）、失敗は ok: false と理由の 1 句。
 * 受け手の答えが分からないときは unknown: true（札「結果不明」。成功とも失敗とも数えない）
 */
export type ImportOutcome = { ok: true; note?: string } | { ok: false; reason: string; unknown?: boolean };

/** 結果を行の状態に写す */
const stateOf = (o: ImportOutcome): Pick<PickItem, "state" | "reason"> =>
  o.ok ? { state: "ok", reason: o.note ?? "" } : { state: o.unknown ? "uk" : "ng", reason: o.reason };

/** 隠した読み上げの領域に書く間（一度空にしてから書く） */
const SAY_DELAY_MS = 30;
/** 中止の確認の窓を開いている間、進みを止めて待つ間隔 */
const DIALOG_POLL_MS = 100;
/** 頭の確かめを同時に読む数（大きなフォルダで、一度に全部のファイルを読まない） */
const READ_WORKERS = 8;
/** 確かめの結果を一覧にまとめて書く間隔 */
const FLUSH_MS = 50;

/** DADS のプログレスインジケーターの静的インジケーター（砂時計、24px）。部品集の catalog と同じ絵 */
function Hourglass() {
  return (
    <svg
      className="pk-hg shrink-0 text-primary-active forced-colors:text-[CanvasText] [[data-theme=dark]_&]:text-link"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path fill="currentcolor" d="M9 6c0 1.8 1.1 5 3.5 5S16 7.4 16 6H9ZM8 21h9c0-1-.5-2.2-.5-2.2l-4-1.8-4 1.8S8 20 8 21Z" />
      <path fill="none" stroke="currentcolor" d="M4 1.5h17m-17 21h17M6 1.5C6 5.1 7.6 12 12.5 12S18.9 5 19 1.5M19 22.5c.3-3.7-2.2-10.5-6.5-10.5S5.7 18.8 6 22.5" />
      <circle cx="12.5" cy="13.5" r=".5" fill="currentcolor" />
      <circle cx="12.5" cy="15.5" r=".5" fill="currentcolor" />
    </svg>
  );
}

const none = <span className="label font-sans text-sm text-label">—</span>;

/** 札の字の色：送らない行（対象外・除外）は warning、失敗・結果不明・中止は danger（囲み線と同じ色。行の字は通常の色のまま） */
const BADGE_TEXT: Partial<Record<string, string>> = { skip: "text-warning", ng: "text-danger", unknown: "text-danger", stop: "text-danger" };

type FileWithPath = File & { tsunagiPath?: string };

/** ドロップしたフォルダを辿って、中のファイルを集める（webkitGetAsEntry。ファイルでないものは無視する） */
async function readEntry(entry: FileSystemEntry, out: FileWithPath[]): Promise<void> {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      (entry as FileSystemFileEntry).file(
        (f) => {
          const file = f as FileWithPath;
          file.tsunagiPath = entry.fullPath.replace(/^\/+/, "");
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
    });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // readEntries は一度に全部を返さないので、空が返るまで読む
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) break;
      all.push(...batch);
    }
    for (const child of all) await readEntry(child, out);
  }
}

const inputOf = (f: FileWithPath): PickInput => ({
  file: f,
  path: f.tsunagiPath || f.webkitRelativePath || f.name,
  size: f.size,
  lastModified: f.lastModified,
});

export function FilePicker({
  limitBytes,
  importFile,
  title = "インポート",
  testId = "file-picker",
  unknownHelp,
}: {
  /** 1 件の大きさの上限（バイト）。超えたものは対象外にする（受け手も確かめる） */
  limitBytes: number;
  /** 1 件を送る。index は選択の中の番目（0 から）、total は選択の件数。失敗は理由の 1 句（製品の言葉）で返す */
  importFile: (file: File, at: { index: number; total: number }) => Promise<ImportOutcome>;
  title?: string;
  testId?: string;
  /** 結果不明の知らせの最後の 1 文（確かめを頼む先）。初期値は「管理者に確かめを頼んでください。」。管理者には空を渡す */
  unknownHelp?: string;
}) {
  const titleId = useId();
  const progressId = useId();
  const [items, setItemsState] = useState<PickItem[]>([]);
  const itemsRef = useRef<PickItem[]>([]);
  const [phase, setPhaseState] = useState<PickPhase>("idle");
  const phaseRef = useRef<PickPhase>("idle");
  const [over, setOver] = useState(false);
  const [message, setMessage] = useState("");
  const [abortOpen, setAbortOpen] = useState(false);
  const abortOpenRef = useRef(false);
  const [abortText, setAbortText] = useState("");
  const abortedRef = useRef(false);
  const nextId = useRef(1);
  // 選択を解除したら上がる。解除の前に始めた確かめの結果を、解除の後の一覧に書かない
  const generation = useRef(0);
  const rootRef = useRef<HTMLElement>(null);
  const filesButton = useRef<HTMLButtonElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortButton = useRef<HTMLButtonElement>(null);
  const againButton = useRef<HTMLButtonElement>(null);
  const [focusTarget, setFocusTarget] = useState<{ to: "files" | "abort" | "again" | "list" | "keep"; seq: number } | null>(null);
  const sayTimer = useRef<number | undefined>(undefined);
  // 最後に焦点のあった行のボタン（行が対象外になってボタンが消えると、焦点はどこにも無くなる。そのときの戻し先を決めるため）
  const lastRowFocus = useRef<string | undefined>(undefined);

  const setItems = useCallback((next: PickItem[] | ((prev: PickItem[]) => PickItem[])) => {
    const value = typeof next === "function" ? next(itemsRef.current) : next;
    itemsRef.current = value;
    setItemsState(value);
  }, []);
  const setPhase = (p: PickPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const say = useCallback((text: string) => {
    if (!text) return;
    setMessage("");
    window.clearTimeout(sayTimer.current);
    sayTimer.current = window.setTimeout(() => setMessage(text), SAY_DELAY_MS);
  }, []);
  const focusSoon = (to: "files" | "abort" | "again" | "list" | "keep") => setFocusTarget((f) => ({ to, seq: (f?.seq ?? 0) + 1 }));

  // フォルダを選ぶ input は webkitdirectory（React の属性に無いので、描いた後に付ける）
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  // 頁を離れたら（部品が外れたら）、待っている行を送らない。実行中の 1 件は終わるのを待つだけで、結果は描かない。
  // 中止の窓の待ちも解く（待ち続けない）
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortedRef.current = true;
      abortOpenRef.current = false;
      window.clearTimeout(sayTimer.current);
    };
  }, []);

  // 焦点：押したボタンが組み直されても落とさない（描いた後に移す）
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.to === "keep") {
      const id = lastRowFocus.current;
      const button = id ? rootRef.current?.querySelector<HTMLElement>(`[data-pick-id="${CSS.escape(id)}"]`) : null;
      if (button && document.activeElement !== button) button.focus();
      return;
    }
    const target = { files: filesButton, abort: abortButton, again: againButton, list: listRef }[focusTarget.to];
    target.current?.focus();
  }, [focusTarget]);

  const add = useCallback(
    (files: FileWithPath[]) => {
      if (phaseRef.current !== "idle") return;
      const { items: next, fresh, duplicates } = addFiles(itemsRef.current, files.map(inputOf), nextId.current);
      nextId.current += fresh.length;
      setItems(next);
      // 足した後は「ファイルを選択」へ焦点を戻す。部品の外にある焦点は奪わない（ドロップの間に、ほかの所で入力していることがある）
      const active = document.activeElement;
      if (!active || active === document.body || rootRef.current?.contains(active)) focusSoon("files");
      if (fresh.length === 0) {
        say(addedMessage([], duplicates, next));
        return;
      }
      const gen = generation.current;
      // 確かめは READ_WORKERS 件ずつ並べて読み（大きなフォルダで一度に全部を読まない）、結果はまとめて一覧に書く
      const patches = new Map<number, Partial<PickItem>>();
      let flushTimer: number | undefined;
      const flush = () => {
        flushTimer = undefined;
        if (gen !== generation.current || patches.size === 0) return;
        const ready = new Map(patches);
        patches.clear();
        setItems((prev) => prev.map((i) => (i.state === "check" && ready.has(i.id) ? { ...i, ...ready.get(i.id) } : i)));
      };
      const queue = [...fresh];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          if (gen !== generation.current) return;
          let patch: Partial<PickItem>;
          try {
            const head = new Uint8Array(await item.file.slice(0, Math.min(item.size, HEAD_BYTES)).arrayBuffer());
            const r = checkHead(head, item.size, limitBytes);
            // 対象外になった行は、確かめの間に除外していても対象外にする（対象外の行は除外も戻すも持たない）
            patch = r.kind === "dicom" ? { state: "wait", tags: r.tags } : { state: "ex", reason: r.reason, off: false };
          } catch {
            patch = { state: "ex", reason: UNREADABLE_REASON, off: false };
          }
          patches.set(item.id, patch);
          flushTimer ??= window.setTimeout(flush, FLUSH_MS);
        }
      };
      void Promise.all(Array.from({ length: Math.min(READ_WORKERS, fresh.length) }, worker)).then(() => {
        window.clearTimeout(flushTimer);
        flush();
        if (gen !== generation.current || !mounted.current) return;
        // 焦点：確かめの間に行の「除外」「戻す」へ移していたら、そのボタンに保つ。そのボタンが消えた（対象外になった）ら一覧の領域へ。
        // 部品の外へ移していたら動かさない。部品の中のほかの所・どこにも無い（押したボタンが組み直された）ときは「ファイルを選択」へ
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && !!rootRef.current?.contains(active);
        const lost = !active || active === document.body;
        const rowId = inside ? (active as HTMLElement).dataset.pickId : lost ? lastRowFocus.current : undefined;
        if (rowId) {
          const still = itemsRef.current.find((i) => String(i.id) === rowId);
          focusSoon(still && still.state !== "ex" ? "keep" : "list");
        } else if (inside || lost) {
          focusSoon("files");
        }
        const ids = new Set(fresh.map((f) => f.id));
        say(addedMessage(itemsRef.current.filter((i) => ids.has(i.id)), duplicates, itemsRef.current));
      });
    },
    [limitBytes, say, setItems],
  );

  const toggle = (id: number) => {
    const target = itemsRef.current.find((i) => i.id === id);
    if (!target || phaseRef.current !== "idle") return;
    const next = itemsRef.current.map((i) => (i.id === id ? { ...i, off: !i.off } : i));
    setItems(next);
    const selected = formatCount(countItems(next).selected);
    say(target.off ? `${target.name} を戻しました。選択 ${selected} 件。` : `${target.name} を除外しました。選択 ${selected} 件。`);
  };

  const clear = () => {
    generation.current++;
    setItems([]);
    say("選択を解除しました。");
    focusSoon("files");
  };

  const waitWhileDialog = () =>
    new Promise<void>((resolve) => {
      const check = () => (abortOpenRef.current ? window.setTimeout(check, DIALOG_POLL_MS) : resolve());
      check();
    });

  const start = async () => {
    const c = countItems(itemsRef.current);
    if (phaseRef.current !== "idle" || c.selected === 0 || c.checking > 0) return;
    abortedRef.current = false;
    setPhase("busy");
    focusSoon("abort");
    const queue = itemsRef.current.filter((i) => isSelected(i) && i.state === "wait").sort((a, b) => a.id - b.id);
    for (let index = 0; index < queue.length; index++) {
      await waitWhileDialog();
      if (abortedRef.current) break;
      const item = queue[index]!;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, state: "run" } : i)));
      let outcome: ImportOutcome;
      try {
        outcome = await importFile(item.file, { index, total: queue.length });
      } catch {
        outcome = { ok: false, reason: "インポートできませんでした" };
      }
      // 中止の窓を開いている間は、実行中の 1 件の終わりも数に入れない（窓の本文の数を動かさない）
      await waitWhileDialog();
      if (!mounted.current) return;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...stateOf(outcome) } : i)));
    }
    if (!mounted.current) return;
    const { items: finished, cancelled } = cancelWaiting(itemsRef.current);
    setItems(finished);
    setPhase("done");
    focusSoon("again");
    say(cancelled ? `インポートを中止しました。${formatCount(cancelled)} 件はインポートしていません。` : "インポートが終わりました。");
  };

  const openAbort = () => {
    setAbortText(abortBody(itemsRef.current));
    abortOpenRef.current = true;
    setAbortOpen(true);
  };
  const closeAbort = (confirmed: boolean) => {
    if (confirmed) abortedRef.current = true;
    abortOpenRef.current = false;
    setAbortOpen(false);
    focusSoon("abort");
  };

  const again = () => {
    generation.current++;
    setItems([]);
    setPhase("idle");
    focusSoon("files");
  };

  const idle = phase === "idle";
  const busy = phase === "busy";
  const c = countItems(items);
  const done = c.ok + c.ng + c.unknown;
  const notice = phase === "done" ? resultNotice(c, unknownHelp) : null;
  const showDrop = items.length === 0 || idle;

  return (
    <>
      <section
        ref={rootRef}
        data-testid={testId}
        className="picker sec rounded-md border border-border bg-background"
        aria-labelledby={titleId}
        data-over={over ? "true" : "false"}
        data-busy={busy ? "true" : "false"}
        onDragOver={(e) => {
          // ブラウザがファイルを開いて画面を消さないよう、受けないときも止める
          e.preventDefault();
          if (!idle) {
            e.dataTransfer.dropEffect = "none";
            return;
          }
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!idle) return;
          const entries = Array.from(e.dataTransfer.items ?? [])
            .map((it) => it.webkitGetAsEntry?.() ?? null)
            .filter((en): en is FileSystemEntry => en !== null);
          if (entries.length === 0) {
            add(Array.from(e.dataTransfer.files));
            return;
          }
          const out: FileWithPath[] = [];
          // フォルダを辿っている間に「選択を解除」「続けて選択」を押したら、辿った結果を足さない
          const gen = generation.current;
          void Promise.all(entries.map((en) => readEntry(en, out))).then(() => {
            if (gen === generation.current && mounted.current) add(out);
          });
        }}
      >
        <h2 id={titleId} className="m-0 rounded-t-md border-b border-border bg-surface px-3 py-2 text-sm leading-5 font-bold text-value">
          {title}
        </h2>
        <div className="in flex flex-col gap-3 px-4 py-3">
          {notice && (
            <Notice kind={notice.kind} alert={notice.alert} data-testid={`${testId}-result`}>
              {notice.text}
            </Notice>
          )}
          {showDrop && (
            <div
              data-testid={`${testId}-drop`}
              className={cn(
                "pk-drop flex items-center gap-2 rounded-md border-2 border-dashed border-border-input bg-surface text-center text-label",
                items.length ? "compact flex-row flex-wrap justify-between px-3 py-2" : "flex-col px-4 py-6",
                over && "border-solid border-primary bg-selected",
              )}
            >
              <span className="t font-bold text-value">{over ? "ドロップして追加" : "ここにファイルまたはフォルダをドロップ"}</span>
              <span className="acts flex gap-2">
                <Button ref={filesButton} type="button" variant="outline" data-pk="files" onClick={() => filesInput.current?.click()}>
                  ファイルを選択
                </Button>
                <Button type="button" variant="outline" data-pk="folder" onClick={() => folderInput.current?.click()}>
                  フォルダを選択
                </Button>
              </span>
            </div>
          )}
          {items.length > 0 && (
            <>
              <div className="listhead pk-sum flex flex-wrap items-center justify-between gap-3" data-testid={`${testId}-sum`}>
                <span className="cnt">
                  <b className="text-base">{formatCount(c.total)}</b> 件{skippedNote(c)}
                  {"　"}選択 <b className="text-base">{formatCount(c.selected)}</b> 件・{formatSize(c.selectedBytes)}
                </span>
                {idle && (
                  <span className="acts flex items-center gap-2">
                    <Button type="button" variant="ghost" size="sm" data-pk="clear" onClick={clear}>
                      選択を解除
                    </Button>
                  </span>
                )}
              </div>
              {busy && (
                <div
                  className="pk-prog flex items-center gap-3"
                  role="progressbar"
                  aria-labelledby={progressId}
                  aria-valuemin={0}
                  aria-valuemax={c.selected}
                  aria-valuenow={done}
                  aria-valuetext={`${done} ／ ${c.selected} 件`}
                  data-testid={`${testId}-progress`}
                >
                  <Hourglass />
                  <span id={progressId} className="n whitespace-nowrap tabular-nums">
                    インポート中{"　"}
                    {formatCount(done)} ／ {formatCount(c.selected)} 件
                  </span>
                </div>
              )}
              <Table label="選んだファイル" wrapperRef={listRef} wrapperClassName="pk-list max-h-80" className="tall" wrapperTestId={`${testId}-list`}>
                <TableHeader>
                  <tr>
                    <TableHead>名前</TableHead>
                    <TableHead>患者ID</TableHead>
                    <TableHead>氏名</TableHead>
                    <TableHead>検査日</TableHead>
                    <TableHead>モダリティ</TableHead>
                    <TableHead>シリーズ／画像</TableHead>
                    <TableHead num>大きさ</TableHead>
                    <TableHead>状態</TableHead>
                    <TableHead>
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {sortForList(items).map((item) => {
                    const badge = badgeOf(item);
                    const t = item.tags;
                    const name = t ? parsePatientName(t.patientName).name : "";
                    const si = seriesImageText(t);
                    return (
                      <TableRow key={item.id} tall data-state={item.state} data-off={item.off ? "true" : undefined} data-testid={`${testId}-row`}>
                        <TableCell className="nm min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                          <CellMain>{item.name}</CellMain>
                          {item.dir && <CellSub>{item.dir}</CellSub>}
                        </TableCell>
                        <TableCell className="pid w-24 font-mono text-[13px] whitespace-normal [overflow-wrap:anywhere]">{t?.patientId || none}</TableCell>
                        <TableCell className="pn w-32 whitespace-normal [overflow-wrap:anywhere]">{name || none}</TableCell>
                        <TableCell className="dt w-[88px] whitespace-nowrap tabular-nums">{t?.studyDate || none}</TableCell>
                        <TableCell className="md w-[72px] whitespace-normal [overflow-wrap:anywhere]">
                          {t?.modality ? <ModalityMark modality={t.modality} className="max-w-full whitespace-normal [overflow-wrap:anywhere]" /> : none}
                        </TableCell>
                        <TableCell className="si w-20 font-mono text-[13px] whitespace-normal [overflow-wrap:anywhere]">{si || none}</TableCell>
                        <TableCell num className="sz w-24 whitespace-nowrap">
                          {formatSize(item.size)}
                        </TableCell>
                        <TableCell className="stt w-[200px] whitespace-normal [overflow-wrap:anywhere]">
                          <StatusBadge kind={badge.kind} className={BADGE_TEXT[badge.kind]}>
                            {badge.label}
                          </StatusBadge>
                          {item.reason && !item.off && <CellSub className="[word-break:auto-phrase]">{item.reason}</CellSub>}
                        </TableCell>
                        <TableCell className="op w-[72px] text-right">
                          {idle && item.state !== "ex" && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-pick-id={item.id}
                              aria-label={item.off ? `${item.name} を選択に戻す` : `${item.name} を選択から除外`}
                              onClick={() => toggle(item.id)}
                              onFocus={() => {
                                lastRowFocus.current = String(item.id);
                              }}
                              onBlur={(e) => {
                                // 消えて焦点を失ったとき（移った先が無い）は覚えておく。ほかへ移ったら忘れる
                                if (e.relatedTarget) lastRowFocus.current = undefined;
                              }}
                            >
                              {item.off ? "戻す" : "除外"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </>
          )}
        </div>
        <div className="formbar flex justify-end gap-2 rounded-b-md border-t border-border bg-surface px-4 py-3">
          <span className="l mr-auto self-center text-label" data-testid={`${testId}-formbar`}>
            {formbarText(phase, c)}
          </span>
          {busy && (
            <>
              <Button ref={abortButton} type="button" variant="danger-outline" data-pk="abort" onClick={openAbort}>
                中止
              </Button>
              <Button type="button" disabled aria-busy="true" tabIndex={-1}>
                インポート
              </Button>
            </>
          )}
          {phase === "done" && (
            <Button ref={againButton} type="button" variant="outline" data-pk="again" onClick={again}>
              続けて選択
            </Button>
          )}
          {idle && (
            <Button type="button" data-pk="go" disabled={c.selected === 0 || c.checking > 0} onClick={() => void start()}>
              インポート
            </Button>
          )}
        </div>
      </section>
      <input
        ref={filesInput}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        data-testid={`${testId}-files`}
        onChange={(e) => {
          add(Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        tabIndex={-1}
        data-testid={`${testId}-folder`}
        onChange={(e) => {
          add(Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      <p className="sr-only" role="status" data-testid={`${testId}-live`}>
        {message}
      </p>
      <ConfirmDialog
        open={abortOpen}
        title="インポートを中止しますか？"
        body={abortText}
        confirmLabel="中止する"
        danger
        onConfirm={() => closeAbort(true)}
        onCancel={() => closeAbort(false)}
        testId={`${testId}-abort`}
      />
    </>
  );
}
