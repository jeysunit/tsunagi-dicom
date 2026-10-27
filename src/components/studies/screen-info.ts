import type { ViewerInfo } from "@/lib/viewers";

/** 一覧の画面に、サーバーの側から渡す情報（ブラウザに渡してよいものだけ） */
export interface ScreenInfo {
  /** AUTH_MODE=local の CSRF の token（検証モードには無い） */
  csrfToken?: string;
  /** 設定されたビューア（URL は渡さない。開く時に BFF が作る） */
  viewers: ViewerInfo[];
  /** サーバーの時間帯（TZ）。画面の時刻（送信の時刻など）は、この時間帯で出す（docs/spec.md の 2.2） */
  timeZone: string;
  /** 検査の一覧の自動更新の間隔（秒。無い・0 なら止める。STUDY_LIST_REFRESH_SECONDS。docs/spec.md の 3.1） */
  refreshSeconds?: number;
  /** いまの役割でできること（src/lib/auth/roles.ts） */
  can: {
    rememberViewer: boolean;
    allValues: boolean;
    /** ほかの機器へ送る（段 4）。検証モードで書き込みを止めているときは false */
    send: boolean;
    /** 結果の分からない送信を、送り先で確かめた結果として記録に足す（管理者） */
    reconcile: boolean;
    /** 書き出し（ZIP。段 5）。検証モードで書き込みを止めているときは false */
    export: boolean;
    /** 削除（段 5。管理者だけ）。検証モードで書き込みを止めているときは false */
    delete: boolean;
    /** 患者情報修正・検査情報修正（段 6。一般と管理者）。検証モードで書き込みを止めているときは false */
    modify?: boolean;
  };
  /** 大事な操作の前の再認証がある（AUTH_MODE=local のときだけ）。再認証はパスワードだけ（docs/spec.md の 3.6） */
  reauth?: boolean;
}
