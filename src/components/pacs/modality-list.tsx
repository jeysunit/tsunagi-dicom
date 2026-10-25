"use client";

import { useRef, useState } from "react";
import { ActionButton } from "@/components/ui/pending";
import { StatusBadge } from "@/components/ui/status-badge";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView } from "@/lib/fields";
import { formatDateTimeIn } from "@/lib/format/japanese-date";
import { cn } from "@/lib/utils";

// 接続先の表と接続確認（docs/spec.md の 3.3。段 4）。1 件 1 行。「接続確認」で Orthanc から C-ECHO を送る。
// 「最後の接続確認」の列は、未確認「—」・確認中（札。その行のボタンは押せない）・成功（札と時刻）・失敗（札と時刻と理由の 1 句）。
// 画面の言葉は docs/spec.md の 2.2、文の型は docs/design-system/writing.md。

interface EchoResult {
  ok: boolean;
  /** 確かめた時刻（`10:32:05`） */
  at: string;
  /** 失敗の理由の 1 句（なぜか＋次にすること）。成功のときは無い */
  reason?: string;
  /** 失敗のうち、C-ECHO が通らなかったと BFF が正常に答えたもの。false は、確認そのものを終えられなかった（断られた要求・通信の失敗など） */
  unreachable?: boolean;
}

type Row = EchoResult | "busy";

interface Notice {
  kind: "info" | "ok" | "err";
  text: string;
}

/**
 * BFF の応答から言えるのは「つながった」「つながらなかった」と、BFF が返した誤りの文だけ。
 * 断られた・AE タイトルが合わない・ホスト名を引けない、の見分けは応答に無いので、原因は分からないと書く
 */
function unreachableReason(canSeeAddress: boolean): string {
  return canSeeAddress
    ? "原因は分かりません。ホスト名・ポート番号・AEタイトルを確認して、もう一度接続確認してください。"
    : "原因は分かりません。管理者に、登録の確認を頼んでください。";
}

export function ModalityList({ modalities, csrfToken, timeZone }: { modalities: ModalityView[]; csrfToken?: string; timeZone: string }) {
  const [results, setResults] = useState<Record<string, Row>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  // state は描画の後に変わるので、二重の押しはここで止める
  const running = useRef(new Set<string>());
  const noticeSeq = useRef(0);
  const showAddress = modalities.some((m) => m.host !== undefined);
  const ids = modalities.map((m) => m.id ?? "");
  const anyBusy = ids.some((id) => results[id] === "busy");
  const allBusy = ids.length > 0 && ids.every((id) => results[id] === "busy");

  async function echo(id: string): Promise<EchoResult | null> {
    if (running.current.has(id)) return null;
    running.current.add(id);
    setResults((r) => ({ ...r, [id]: "busy" }));
    try {
      const result = await postJson(`/api/modalities/${encodeURIComponent(id)}/echo`, {}, csrfToken);
      const at = formatDateTimeIn(new Date().toISOString(), timeZone, { seconds: true }).split(" ")[1] ?? "";
      const ok = result.ok && result.data.connected === true;
      const reason = ok ? undefined : result.ok ? unreachableReason(showAddress) : errorText(result);
      const done: EchoResult = { ok, at, reason, unreachable: !ok && result.ok };
      setResults((r) => ({ ...r, [id]: done }));
      return done;
    } finally {
      running.current.delete(id);
    }
  }

  async function echoOne(id: string) {
    if (running.current.has(id)) return;
    const seq = ++noticeSeq.current;
    setNotice({ kind: "info", text: `${id} の接続確認を受け付けました。結果は、下の表の「最後の接続確認」で分かります。` });
    const done = await echo(id);
    if (!done || seq !== noticeSeq.current) return;
    setNotice(
      done.ok
        ? { kind: "ok", text: `${id} に接続できました（${done.at}）。` }
        : {
            kind: "err",
            text: done.unreachable
              ? `${id} に接続できませんでした（${done.at}）。理由は、下の表の「最後の接続確認」に出ています。`
              : `${id} の接続確認を終えられませんでした（${done.at}）。接続先につながるかは分かりません。理由は、下の表の「最後の接続確認」に出ています。`,
          },
    );
  }

  // 失敗した接続先があっても、残りの確認は続ける。全部が終わってから件数を知らせる
  async function echoAll() {
    const targets = ids.filter((id) => !running.current.has(id));
    if (targets.length === 0) return;
    const seq = ++noticeSeq.current;
    setNotice({ kind: "info", text: `${targets.length} 件の接続確認を受け付けました。結果は、下の表の「最後の接続確認」で分かります。` });
    const done = (await Promise.all(targets.map((id) => echo(id)))).filter((d): d is EchoResult => d !== null);
    if (seq !== noticeSeq.current) return;
    const unreachable = done.filter((d) => d.unreachable).length;
    const unfinished = done.filter((d) => !d.ok && !d.unreachable).length;
    if (unreachable === 0 && unfinished === 0) {
      setNotice({ kind: "ok", text: `${done.length} 件すべてに接続できました。` });
      return;
    }
    const parts = [
      unreachable > 0 ? `${unreachable} 件に接続できませんでした` : "",
      unfinished > 0 ? `${unfinished} 件は確認を終えられず、接続できるかは分かりません` : "",
    ].filter(Boolean);
    setNotice({ kind: "err", text: `${done.length} 件のうち、${parts.join("。")}。理由は、下の表の「最後の接続確認」に出ています。` });
  }

  return (
    <section className="space-y-2" data-testid="modalities-page">
      <h1 className="text-lg font-bold text-value">接続先</h1>
      {notice && (
        <div
          role="status"
          className={cn(
            "rounded-md border border-border border-l-4 bg-surface px-3 py-1.5 text-sm text-foreground",
            notice.kind === "ok" ? "border-l-success" : notice.kind === "err" ? "border-l-danger" : "border-l-ring",
          )}
          data-testid="echo-notice"
          data-kind={notice.kind}
        >
          {notice.text}
        </div>
      )}
      <div className="rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <h2 className="text-sm font-bold text-value">接続先の一覧</h2>
          <ActionButton
            type="button"
            size="sm"
            variant="outline"
            pending={allBusy}
            disabled={modalities.length === 0 || anyBusy}
            onClick={() => void echoAll()}
            data-testid="echo-all"
          >
            すべて接続確認
          </ActionButton>
        </div>
        {modalities.length === 0 ? (
          <p className="px-3 pb-2 text-label">接続先が登録されていません</p>
        ) : (
          <div className="overflow-auto border-t border-border bg-background">
            <table className="w-full border-collapse" data-testid="modality-table">
              <thead className="bg-surface text-left text-xs text-label">
                <tr className="border-b border-border">
                  <th className="px-2 py-1 font-normal">名称</th>
                  <th className="px-2 py-1 font-normal">種類</th>
                  <th className="px-2 py-1 font-normal">AEタイトル</th>
                  {showAddress && <th className="px-2 py-1 font-normal">ホスト名:ポート番号</th>}
                  <th className="px-2 py-1 font-normal">最後の接続確認</th>
                  <th className="px-2 py-1 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {modalities.map((m) => {
                  const id = m.id ?? "";
                  const r = results[id];
                  return (
                    <tr key={id} className="border-b border-border last:border-0" data-testid="modality-row" data-modality={id}>
                      <td className="h-7 px-2 py-0 font-bold text-value">{id}</td>
                      {/* この画面の接続先は Orthanc に登録された DICOM だけ。HL7 の接続先は、この画面にまだ無い */}
                      <td className="h-7 px-2 py-0">DICOM</td>
                      <td className="h-7 px-2 py-0 font-mono">{m.aet}</td>
                      {showAddress && (
                        <td className="h-7 px-2 py-0 font-mono text-label">
                          {m.host}
                          {m.port != null ? `:${m.port}` : ""}
                        </td>
                      )}
                      <td className="h-7 px-2 py-0" data-testid="echo-cell">
                        {r === undefined && <span className="text-label">—</span>}
                        {r === "busy" && (
                          <span role="status" data-testid="echo-result" data-state="check">
                            <StatusBadge kind="sending">確認中</StatusBadge>
                          </span>
                        )}
                        {r && r !== "busy" && (
                          <span
                            className="flex flex-wrap items-center gap-x-2"
                            role={r.ok ? "status" : "alert"}
                            data-testid="echo-result"
                            data-state={r.ok ? "ok" : "ng"}
                          >
                            <StatusBadge kind={r.ok ? "confirmed" : "failed"}>{r.ok ? "成功" : "失敗"}</StatusBadge>
                            <span className="text-xs text-label">{r.at}</span>
                            {!r.ok && r.reason && (
                              <span className="text-xs text-foreground" data-testid="echo-why">
                                {r.reason}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="h-7 px-2 py-0">
                        <ActionButton type="button" size="xs" variant="outline" pending={r === "busy"} onClick={() => void echoOne(id)} data-testid="echo">
                          接続確認
                        </ActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
