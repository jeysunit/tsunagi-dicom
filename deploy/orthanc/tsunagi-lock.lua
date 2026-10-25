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
-- /tools/lookup の答えの Type
local TYPES = { Patient = true, Study = true, Series = true, Instance = true }

-- JSON の文字列を読む。最初の字が opening（'[' か '{'）でなければ（配列と物は Lua では同じ table になり、空なら見分けられない）、
-- 読めなければ nil
local function parse(raw, opening)
  if type(raw) ~= 'string' or string.match(raw, '^%s*(.)') ~= opening then
    return nil
  end
  local ok, value = pcall(ParseJson, raw)
  if not ok or type(value) ~= 'table' then
    return nil
  end
  return value
end

-- 1 から続く番号だけを鍵に持つ table（JSON の配列）か
local function isList(t)
  local n = 0
  for _ in pairs(t) do
    n = n + 1
  end
  return n == #t
end

-- 断るなら理由（文字列）を、受けるなら nil を返す
local function refusal(studyUid)
  if studyUid == nil or studyUid == '' then
    return nil
  end
  local ok, found = pcall(RestApiPost, '/tools/lookup', studyUid, true)
  if not ok or found == nil then
    return 'lookup failed'
  end
  -- 引き当ての答えは、{ Type, ID, Path } の配列
  local list = parse(found, '[')
  -- 配列の null の要素は Lua では無いのと同じになり、数えられない（正しい答えの要素はどれも物）
  if list == nil or not isList(list) or string.find(found, '[%[,]%s*null') then
    return 'lookup unreadable'
  end
  local now = os.time()
  for _, r in ipairs(list) do
    -- 知らない Type（綴りの違いなど）を、検査でないとして飛ばさない
    if type(r) ~= 'table' or not TYPES[r['Type']] then
      return 'lookup unreadable'
    end
    if r['Type'] == 'Study' then
      if type(r['ID']) ~= 'string' or r['ID'] == '' then
        return 'lookup unreadable'
      end
      -- 検査のメタデータの全部（名前から値への物。印が無くても読める。読めなければ確かめられない）
      local ok2, raw = pcall(RestApiGet, '/studies/' .. r['ID'] .. '/metadata?expand', true)
      if not ok2 or raw == nil then
        return 'metadata unreadable'
      end
      local meta = parse(raw, '{')
      if meta == nil then
        return 'metadata unreadable'
      end
      local value = meta[LOCK]
      if value == nil then
        value = meta[LOCK_NUMBER]
      end
      -- 名前はあるのに値が読めない（JSON の null は Lua では無いのと同じになる）
      if value == nil and (string.find(raw, '"' .. LOCK .. '"', 1, true) or string.find(raw, '"' .. LOCK_NUMBER .. '"', 1, true)) then
        return 'lock value unreadable'
      end
      if value ~= nil then
        -- 値は期限の UNIX 秒の文字列（false・物・配列などは読めない値）
        local untilSeconds = (type(value) == 'string' or type(value) == 'number') and tonumber(value) or nil
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
