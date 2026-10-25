-- tsunagi-dicom：患者 ID の付け替えの最中の検査へ届く C-STORE を断る（openspec/changes/add-pir-case6-procedure-update/design.md §15.4）。
--
-- tsunagi-dicom は付け替えの前に、元の検査へ利用者のメタデータ TsunagiLock（期限の UNIX 秒）を付け、終わったら外す。
-- 届いた画像の StudyInstanceUID の検査のどれかに、期限の切れていない印があれば、C-STORE を 0xA700 で断る。
-- 送り手には「Refused: Out of Resources」が返り、黙って失われない（PS3.4 B.2.3）。印を外した後の送り直しは保存する。
--
-- 要る設定：UserMetadata に "TsunagiLock"（1024 以上の番号）、LuaScripts にこのファイル。
-- ReceivedInstanceFilter は使わない（C-STORE で断ると送り手に Success が返り、REST で断ると付け替えの写しの保存も止まる）。
-- REST・STOW-RS で入る画像は止めない（tsunagi-dicom が消す前に ModifiedFrom で確かめる）。
-- 印を読めないとき（引き当ての失敗）は受ける。止めると、Orthanc の不具合ひとつで全部の C-STORE が断られるため。

local LOCK = 'TsunagiLock'
-- Refused: Out of Resources（PS3.4 B.2.3。C-STORE の Failure）
local REFUSED = 0xA700

local function lockedStudy(studyUid)
  if studyUid == nil or studyUid == '' then
    return false
  end
  local ok, found = pcall(RestApiPost, '/tools/lookup', studyUid, true)
  if not ok or found == nil then
    print('tsunagi-lock: lookup failed, accepting the instance')
    return false
  end
  local now = os.time()
  for _, r in ipairs(ParseJson(found)) do
    if r['Type'] == 'Study' then
      -- 印の無い検査では誤りになる（pcall で受ける）
      local ok2, value = pcall(RestApiGet, '/studies/' .. r['ID'] .. '/metadata/' .. LOCK, true)
      if ok2 and value ~= nil then
        local untilSeconds = tonumber(value)
        if untilSeconds ~= nil and untilSeconds > now then
          return true
        end
      end
    end
  end
  return false
end

function ReceivedCStoreInstanceFilter(dicom, origin, info)
  if lockedStudy(dicom.StudyInstanceUID) then
    print('tsunagi-lock: refused a C-STORE to a study being updated, from ' .. tostring(origin['RemoteAet']))
    return REFUSED
  end
  return 0
end
