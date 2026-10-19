import type { ViewerInfo } from "@/lib/viewers";

/** 一覧の画面に、サーバーの側から渡す情報（ブラウザに渡してよいものだけ） */
export interface ScreenInfo {
  /** AUTH_MODE=local の CSRF の token（検証モードには無い） */
  csrfToken?: string;
  /** 設定されたビューア（URL は渡さない。開く時に BFF が作る） */
  viewers: ViewerInfo[];
  /** いまの役割でできること（src/lib/auth/roles.ts） */
  can: {
    rememberViewer: boolean;
    allValues: boolean;
    /** ほかの機器へ送る（段 4）。検証モードで書き込みを止めているときは false */
    send: boolean;
    /** 書き出し（ZIP。段 5）。検証モードで書き込みを止めているときは false */
    export: boolean;
    /** 削除（段 5。管理者だけ）。検証モードで書き込みを止めているときは false */
    delete: boolean;
  };
  /** 大事な操作の前の再認証（AUTH_MODE=local のときだけ）。needsTotp は確認の番号も求めるか */
  reauth?: { needsTotp: boolean };
}
