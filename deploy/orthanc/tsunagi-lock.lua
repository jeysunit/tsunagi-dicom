-- tsunagi-dicom：患者 ID の付け替えの最中の検査へ届く C-STORE を断る（openspec/changes/add-pir-case6-procedure-update/design.md §15.4）。
--
-- tsunagi-dicom は付け替えの前に、元の検査へ利用者のメタデータ TsunagiLock（期限の UNIX 秒）を付け、終わったら外す。
-- 届いた画像の StudyInstanceUID の検査のどれかに、期限の切れていない印があれば、C-STORE を 0xA700 で断る。
-- 送り手には「Refused: Out of Resources」が返り、黙って失われない（PS3.4 B.2.3）。印を外した後の送り直しは保存する。
--
-- 要る設定：UserMetadata に "TsunagiLock"（1024 以上の番号）、LuaScripts にこのファイル。
-- ReceivedInstanceFilter は使わない（C-STORE で断ると送り手に Success が返り、REST で断ると付け替えの写しの保存も止まる）。
-- REST・STOW-RS で入る画像は止めない（tsunagi-dicom が消す前と後に ModifiedFrom で確かめる）。
-- 印を確かめられないとき（引き当て・メタデータの読み取りの失敗、読めない値）は断る側に倒す。付け替えの最中に
-- 確かめられずに受けると、別の中身が黙って失われうるため。断られた装置は、後で送り直す。

local LOCK = 'TsunagiLock'
local LOCK_NUMBER = '1024'
-- Refused: Out of Resources（PS3.4 B.2.3。C-STORE の Failure）
local REFUSED = 0xA700

-- 断るなら理由（文字列）を、受けるなら nil を返す
local function refusal(studyUid)
  if studyUid == nil or studyUid == '' then
    return nil
  end
  local ok, found = pcall(RestApiPost, '/tools/lookup', studyUid, true)
  if not ok or found == nil then
    return 'lookup failed'
  end
  local okParse, list = pcall(ParseJson, found)
  if not okParse or type(list) ~= 'table' then
    return 'lookup unreadable'
  end
  local now = os.time()
  for _, r in ipairs(list) do
    if r['Type'] == 'Study' then
      -- 検査のメタデータの全部（印が無くても読める。読めなければ確かめられない）
      local ok2, raw = pcall(RestApiGet, '/studies/' .. r['ID'] .. '/metadata?expand', true)
      if not ok2 or raw == nil then
        return 'metadata unreadable'
      end
      local ok3, meta = pcall(ParseJson, raw)
      if not ok3 or type(meta) ~= 'table' then
        return 'metadata unreadable'
      end
      local value = meta[LOCK] or meta[LOCK_NUMBER]
      if value ~= nil then
        local untilSeconds = tonumber(value)
        if untilSeconds == nil then
          return 'lock value unreadable'
        end
        if untilSeconds > now then
          return 'locked'
        end
      end
    end
  end
  return nil
end

function ReceivedCStoreInstanceFilter(dicom, origin, info)
  local reason = refusal(dicom.StudyInstanceUID)
  if reason ~= nil then
    print('tsunagi-lock: refused a C-STORE (' .. reason .. '), from ' .. tostring(origin['RemoteAet']))
    return REFUSED
  end
  return 0
end
