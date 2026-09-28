module("luci.controller.clip9", package.seeall)

function index()
    if not nixio.fs.access("/etc/config/clip9") then
        return
    end

    -- 注册主菜单和多个子页面
    entry({"admin", "services", "clip9"}, firstchild(), _("Clip9"), 90).dependent = true

    -- 总览页面
    entry({"admin", "services", "clip9", "overview"}, template("clip9/overview"), _("总览"), 10).leaf = true

    -- 基本设置页面
    entry({"admin", "services", "clip9", "settings"}, template("clip9/basic"), _("基本设置"), 20).leaf = true

    -- 高级设置页面
    entry({"admin", "services", "clip9", "advanced"}, template("clip9/advanced"), _("高级设置"), 30).leaf = true

    -- 日志页面
    entry({"admin", "services", "clip9", "log"}, template("clip9/log"), _("日志"), 50).leaf = true

    -- API接口
    entry({"admin", "services", "clip9", "status"}, call("act_status")).leaf = true
    entry({"admin", "services", "clip9", "version"}, call("act_version")).leaf = true
    entry({"admin", "services", "clip9", "action"}, call("act_action")).leaf = true
    entry({"admin", "services", "clip9", "getconfig"}, call("act_getconfig")).leaf = true
    entry({"admin", "services", "clip9", "saveconfig"}, call("act_saveconfig")).leaf = true
    entry({"admin", "services", "clip9", "getbasic"}, call("act_getbasic")).leaf = true
    entry({"admin", "services", "clip9", "savebasic"}, call("act_savebasic")).leaf = true
    entry({"admin", "services", "clip9", "getlog"}, call("get_log")).leaf = true
    entry({"admin", "services", "clip9", "clearlog"}, call("clear_log")).leaf = true
end

local CONFIG_DIR = "/etc/clip9"
local DEFAULT_DATA = CONFIG_DIR .. "/data"
-- ⚠️ 这两个名字**必须与 `clip9-core` 的 `ServerConfig::default()` 一致**
-- （`dbPath = "clip9.redb"`、`storageDir = "uploads"`）—— 配置里写的是**相对路径**时
-- 服务端按「相对数据目录」解析（`resolve_against`），这里要按同一套算，否则
-- 「界面上显示的文件」和「服务端实际用的文件」是两个。Go 那边是绝对路径写死，
-- 所以那边没这个问题；这边是 redb + 数据目录，必须自己解析。
local DEFAULT_DB = "clip9.redb"
local DEFAULT_UPLOADS = "uploads"

local function data_dir()
    local uci = luci.model.uci.cursor()
    return uci:get("clip9", "main", "data") or DEFAULT_DATA
end

local function conf_path()
    local uci = luci.model.uci.cursor()
    return uci:get("clip9", "main", "config") or CONFIG_DIR .. "/config.json"
end

-- 解析 JSON（兼容 luci.jsonc / luci.json）
local function parse_json(text)
    local json = nil
    local ok1, j1 = pcall(require, "luci.jsonc")
    if ok1 and j1 then json = j1 else
        local ok2, j2 = pcall(require, "luci.json")
        if ok2 and j2 then json = j2 end
    end
    if not json then return nil end
    local ok, obj = pcall(function()
        if json.parse then return json.parse(text) end
        if json.decode then return json.decode(text) end
    end)
    if not ok then return nil end
    return obj
end

local function default_config()
    local dir = data_dir()
    return {
        server = {
            dbPath = dir .. "/" .. DEFAULT_DB,
            storageDir = dir .. "/" .. DEFAULT_UPLOADS
        },
        text = {},
        file = {}
    }
end

local function read_config()
    local p = conf_path()
    if not nixio.fs.access(p) then return default_config() end
    local ok, text = pcall(nixio.fs.readfile, p)
    if not ok or not text or text == "" then return default_config() end
    local obj = parse_json(text)
    if not obj then return default_config() end
    return obj
end

-- 配置里那个 `dbPath` 解析成**实际路径**（规则与服务端一致：绝对路径原样，相对路径相对数据目录）
local function resolve_db_path()
    local srv = read_config().server
    local p = srv and srv.dbPath
    if type(p) ~= "string" or p == "" then p = DEFAULT_DB end
    if p:sub(1, 1) == "/" then return p end
    return data_dir() .. "/" .. p
end

-- 目录占用的 KB（du -sk）
local function du_kb(path)
    if not nixio.fs.access(path) then return 0 end
    local out = luci.sys.exec("du -sk '" .. path .. "' 2>/dev/null")
    local kb = out:match("(%d+)[%s]+")
    return tonumber(kb) or 0
end

-- 单个文件的 KB（`du -sk` 对文件也有效）。历史库不再是一个可枚举的目录，用这个量它。
local function file_kb(path)
    if not nixio.fs.access(path) then return 0 end
    local out = luci.sys.exec("du -sk '" .. path .. "' 2>/dev/null")
    local kb = out:match("(%d+)[%s]+")
    return tonumber(kb) or 0
end

local function get_pid()
    local out = luci.sys.exec("pgrep -f '^/usr/bin/clip9-server' | head -n1")
    local pid = out:match("%d+")
    return pid and tonumber(pid) or nil
end

local function is_running()
    return luci.sys.call("pgrep -f '^/usr/bin/clip9-server' >/dev/null") == 0
end

local function get_installed_version()
    -- ⚠️★ 这条正则是**改名之后才需要改的**：二进制现在叫 `clip9-server`，名字里带一个 `9`，
    -- 而原来的形状 `[%d%.]+[%w%._%-]*` 会从那个 `9` 开始吃 → 返回 **"9-server"**。
    -- Go 的 `cloud-clipboard` 不含数字，所以那边一直是好的 —— 这就是「换个名字，
    -- 某处一个不起眼的正则默默变了意思」。现在要求 `数字.数字`，只会匹配到 `0.1.0`。
    local out = luci.sys.exec("/usr/bin/clip9-server -v 2>/dev/null")
    local ver = out:match("(%d+%.%d+[%w%._%-]*)")
    if ver then
        return "v" .. ver
    end
    local uci = luci.model.uci.cursor()
    local uv = uci:get("clip9", "main", "version") or ""
    if uv ~= "" then return "v" .. uv end
    return ""
end

local function get_update_repo()
    local uci = luci.model.uci.cursor()
    return uci:get("clip9", "main", "update_repo") or "Jonnyan404/clip9"
end

-- 从 GitHub Releases 获取最新版本（带本地缓存，10 分钟过期）
local function fetch_latest(repo, force)
    local cache = "/tmp/clip9/version.json"
    local json = nil
    local ok1, j1 = pcall(require, "luci.jsonc")
    if ok1 and j1 then json = j1 else
        local ok2, j2 = pcall(require, "luci.json")
        if ok2 and j2 then json = j2 end
    end

    local function read_cache()
        if not nixio.fs.access(cache) then return nil end
        local st = nixio.fs.stat(cache)
        if st and st.mtime and os.time() - st.mtime > 600 then return nil end
        local ok, text = pcall(nixio.fs.readfile, cache)
        if not ok or not text then return nil end
        local obj = json and parse_json(text) or nil
        return obj
    end

    local cached = read_cache()
    if cached and cached.tag_name then
        return cached.tag_name, cached.html_url, false
    end

    if not force then
        -- 有旧缓存但已过期：继续用旧缓存作为兜底，避免离线时失败
        if nixio.fs.access(cache) then
            local ok, text = pcall(nixio.fs.readfile, cache)
            if ok and text then
                local obj = json and parse_json(text) or nil
                if obj and obj.tag_name then
                    return obj.tag_name, obj.html_url, true
                end
            end
        end
    end

    local api_url = string.format("https://api.github.com/repos/%s/releases/latest", repo)
    local data = ""
    data = luci.sys.exec(string.format("curl -fsSL --max-time 8 '%s' 2>/dev/null", api_url))
    if not data or data == "" then
        data = luci.sys.exec(string.format("wget -qO- --timeout=8 '%s' 2>/dev/null", api_url))
    end
    data = data or ""

    if data ~= "" and json and json.parse then
        local obj = json.parse(data)
        if obj and obj.tag_name then
            nixio.fs.mkdir("/tmp/clip9")
            local cache_json = data:gsub("^%s+", "")
            pcall(nixio.fs.writefile, cache, cache_json)
            return obj.tag_name, obj.html_url, false
        end
    end
    return nil, nil, "无法从 GitHub 获取最新版本"
end

-- 服务状态检查
function act_status()
    local running = is_running()
    local uci = luci.model.uci.cursor()
    local conf = read_config()
    local srv = conf.server or {}
    local txt = conf.text or {}
    local fl = conf.file or {}

    local host = uci:get("clip9", "main", "host") or ""
    local port = uci:get("clip9", "main", "port") or ""
    local auth = uci:get("clip9", "main", "auth") or ""
    if host == "" then
        host = (srv.host ~= "" and tostring(srv.host)) or "0.0.0.0"
    end
    local cport = tonumber(srv.port) or 0
    if port == "" or tonumber(port) == nil then port = tostring(cport) end

    local summary = {
        roomList = srv.roomList == true,
        -- ⚠️ 兜底值与 `ServerConfig::default()` 一致（50，不是 Go 那边的 100）
        history = tonumber(srv.history) or 50,
        textLimit = tonumber(txt.limit) or 4096,
        fileLimit = tonumber(fl.limit) or 268435456
    }

    local dir = data_dir()
    local db = resolve_db_path()
    local e = {
        running = running,
        pid = get_pid(),
        host = host,
        port = port,
        auth = (auth ~= "" or srv.auth == true),
        version = get_installed_version(),
        -- Go 那边三项都在 `/etc/cloud-clipboard` 下面按目录量。这边历史是**一个库文件**，
        -- 所以「历史」量的是那个文件本身（而不是把上传目录重复算一遍）。
        usage = {
            total = du_kb(dir) * 1024,
            upload = du_kb(dir .. "/" .. DEFAULT_UPLOADS) * 1024,
            history = file_kb(db) * 1024
        },
        summary = summary
    }
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end

-- 版本检查
function act_version()
    local force = (luci.http.formvalue("force") == "1")
    local installed = get_installed_version()
    local repo = get_update_repo()
    local latest, release_url, err = fetch_latest(repo, force)

    local e = {
        installed = installed,
        latest = latest or "",
        release_url = release_url or "",
        update = (latest ~= nil and latest ~= "" and latest ~= installed),
        repo = repo,
        error = err
    }
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end

-- 服务动作: start / stop / restart / reload / clearhistory
function act_action()
    local a = luci.http.formvalue("act") or ""
    if a ~= "" then
        a = a:match("^%w+$") or ""
    end
    local ok = false
    if a == "start" then
        ok = (luci.sys.call("/etc/init.d/clip9 start >/dev/null 2>&1") == 0)
    elseif a == "stop" then
        ok = (luci.sys.call("/etc/init.d/clip9 stop >/dev/null 2>&1") == 0)
    elseif a == "restart" then
        ok = (luci.sys.call("/etc/init.d/clip9 restart >/dev/null 2>&1") == 0)
    elseif a == "reload" then
        ok = (luci.sys.call("/etc/init.d/clip9 reload >/dev/null 2>&1") == 0)
    elseif a == "clearhistory" then
        -- ⚠️★ 这一步**不能**照 Go 的写法做。Go 那边历史是一个 JSON 文件，
        -- 「清空」= 往里写 `[]`。本实现的历史存在 **redb** 里，往里写 `[]`
        -- 就是把它写成一个「不是 redb 的文件」—— 下一次启动 `Database::create`
        -- 会直接报错，**服务起不来**，而 procd 的 respawn 会把它反复重启，
        -- 日志里只有一句 redb 的错（这是最难查的一档：明明只点了一下「清空历史」）。
        --
        -- 所以：**停服务 → 删库文件 → 再起**。库文件没了会被重新建成空的
        -- （`open_with` 里 `Database::create` 是「建或打开」）。
        local db = resolve_db_path()
        local was_running = is_running()
        if was_running then
            luci.sys.call("/etc/init.d/clip9 stop >/dev/null 2>&1")
        end
        -- 用 `os.remove` 而不是 `luci.sys.call("rm ...")`：后者的路径要能对上 rpcd 的
        -- exec ACL（那里面列的是 `/bin/busybox`，而实际执行的是 `/bin/rm` 这个 applet 链接），
        -- 是个不必去踩的坑。
        local removed = os.remove(db)
        ok = (removed == true) or (not nixio.fs.access(db))
        if was_running then
            luci.sys.call("/etc/init.d/clip9 start >/dev/null 2>&1")
        end
    end
    luci.http.prepare_content("application/json")
    luci.http.write_json({ ok = ok, act = a })
end

-- 读取当前配置（供高级设置页使用）
function act_getconfig()
    local e = {
        path = conf_path(),
        config = read_config()
    }
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end

-- 保存完整配置 JSON
function act_saveconfig()
    local p = conf_path()
    local dir = p:match("(.+)/[^/]+")
    if dir and not nixio.fs.access(dir) then
        nixio.fs.mkdir(dir)
    end

    local body = luci.http.content() or ""
    if body == "" then body = luci.http.formvalue("json") or "" end

    local obj = parse_json(body)
    if not obj or type(obj) ~= "table" then
        luci.http.prepare_content("application/json")
        luci.http.write_json({ ok = false, error = "无效的 JSON 格式" })
        return
    end

    local j = nil
    local ok1, j1 = pcall(require, "luci.jsonc")
    if ok1 and j1 then j = j1 else
        local ok2, j2 = pcall(require, "luci.json")
        if ok2 and j2 then j = j2 end
    end
    local text = body
    if j and j.stringify then
        text = j.stringify(obj, true)
    end

    local wok, werr = pcall(nixio.fs.writefile, p, text)
    if not wok then
        luci.http.prepare_content("application/json")
        luci.http.write_json({ ok = false, error = "写入失败: " .. tostring(werr) })
        return
    end
    luci.http.prepare_content("application/json")
    luci.http.write_json({ ok = true, path = p })
end

-- 读取基本设置（UCI）
function act_getbasic()
    local uci = luci.model.uci.cursor()
    local e = {
        enabled = (uci:get("clip9", "main", "enabled") or "1"),
        host = uci:get("clip9", "main", "host") or "0.0.0.0",
        port = uci:get("clip9", "main", "port") or "9501",
        auth = uci:get("clip9", "main", "auth") or "",
        data = uci:get("clip9", "main", "data") or DEFAULT_DATA,
        config = uci:get("clip9", "main", "config") or (CONFIG_DIR .. "/config.json")
    }
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end

-- 保存基本设置（UCI）并启停服务
function act_savebasic()
    local body = luci.http.content() or ""
    if body == "" then body = luci.http.formvalue("json") or "" end
    local obj = parse_json(body)
    if not obj or type(obj) ~= "table" then
        luci.http.prepare_content("application/json")
        luci.http.write_json({ ok = false, error = "无效的 JSON 格式" })
        return
    end

    local enabled = tostring(obj.enabled)
    if enabled ~= "0" and enabled ~= "1" then enabled = "1" end
    local host = tostring(obj.host or "0.0.0.0")
    if host == "" then host = "0.0.0.0" end
    local port = tostring(tonumber(obj.port) or 9501)
    local auth = tostring(obj.auth or "")
    local data = tostring(obj.data or DEFAULT_DATA)
    if data == "" then data = DEFAULT_DATA end
    local config = tostring(obj.config or (CONFIG_DIR .. "/config.json"))
    if config == "" then config = CONFIG_DIR .. "/config.json" end

    local uci = luci.model.uci.cursor()
    uci:set("clip9", "main", "enabled", enabled)
    uci:set("clip9", "main", "host", host)
    uci:set("clip9", "main", "port", port)
    uci:set("clip9", "main", "auth", auth)
    uci:set("clip9", "main", "data", data)
    uci:set("clip9", "main", "config", config)
    local committed = uci:commit("clip9")

    if enabled == "1" then
        luci.sys.call("/etc/init.d/clip9 enable >/dev/null 2>&1; /etc/init.d/clip9 restart >/dev/null 2>&1")
    else
        luci.sys.call("/etc/init.d/clip9 stop >/dev/null 2>&1; /etc/init.d/clip9 disable >/dev/null 2>&1")
    end

    luci.http.prepare_content("application/json")
    luci.http.write_json({ ok = (committed == true), enabled = (enabled == "1"), host = host, port = port, data = data })
end

-- 日志读取函数
function get_log()
    local uci = luci.model.uci.cursor()
    local uselog = uci:get("clip9", "main", "use_logread")
    local logtext = ""
    if uselog ~= "0" then
        logtext = luci.sys.exec("logread | grep 'clip9'")
    else
        logtext = luci.sys.exec("cat /var/log/clip9.log 2>/dev/null")
    end

    if logtext == "" then
        logtext = _("No related logs found")
    end

    luci.http.prepare_content("text/plain")
    luci.http.write(logtext)
end

-- 日志清除函数
function clear_log()
    luci.sys.call("> /var/log/clip9.log")
    luci.http.prepare_content("application/json")
    luci.http.write('{"result":"success"}')
end
