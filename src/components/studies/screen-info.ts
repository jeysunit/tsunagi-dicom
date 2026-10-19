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
    /** 結果の分からない送信を、送り先で確かめた結果として記録に足す（管理者） */
    reconcile: boolean;
  };
}
