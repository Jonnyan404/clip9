//! store 的行为测试。
//!
//! 这里的东西**全都是 Go 那边已经确定的行为**（`msg.go` 的 `appendLocked` / `trimRoomHistoryLocked`、
//! `history.go` 的裁剪、`handler.go` 的 `/content/latest`）。移植时的验收标准就是它们，
//! 所以断言要写得比实现还具体 —— 「跑通了」不算，得钉住顺序、边界和副作用。

use clip9_protocol::{FileReceive, ReceiveBase, ReceiveHolder, TextReceive};
use clip9_store::{Limits, Store};

// ── 夹具 ──────────────────────────────────────────────────────────────

fn text(room: &str, ts: i64, content: &str) -> ReceiveHolder {
    ReceiveHolder::Text(TextReceive {
        base: ReceiveBase {
            kind: "text".to_owned(),
            room: room.to_owned(),
            timestamp: ts,
            ..ReceiveBase::default()
        },
        content: content.to_owned(),
        ..TextReceive::default()
    })
}

fn file(room: &str, ts: i64, name: &str) -> ReceiveHolder {
    ReceiveHolder::File(FileReceive {
        base: ReceiveBase {
            kind: "file".to_owned(),
            room: room.to_owned(),
            timestamp: ts,
            ..ReceiveBase::default()
        },
        name: name.to_owned(),
        cache: format!("uuid-{name}"),
        ..FileReceive::default()
    })
}

/// 临时库 + 不限额。**用完要 `keep` 住 TempDir**，否则文件在断言前就被删了。
fn store_with(limits: Limits) -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open_with(dir.path().join("clip9.redb"), limits).expect("打开 store");
    (store, dir)
}

fn ids(entries: &[ReceiveHolder]) -> Vec<i32> {
    entries.iter().map(ReceiveHolder::id).collect()
}

fn contents(entries: &[ReceiveHolder]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            ReceiveHolder::Text(t) => t.content.clone(),
            ReceiveHolder::File(f) => format!("<file {}>", f.name),
        })
        .collect()
}

// ── id 分配 ───────────────────────────────────────────────────────────

#[test]
fn insert_assigns_increasing_ids_from_one() {
    let (s, _d) = store_with(Limits::unlimited());
    let a = s.insert(text("default", 100, "a")).unwrap();
    let b = s.insert(text("default", 101, "b")).unwrap();
    assert_eq!((a.id(), b.id()), (1, 2));
    // 返回的条目要**带上分配好的 id** —— 调用方拿它去广播。
    assert_eq!(a.room(), "default");
}

/// ⚠️ 迁移工具会带着**已有 id** 灌数据。计数器必须能跳过去，
/// 否则迁移之后新插入的消息会撞上迁移进来的 id（表现为「新消息覆盖了老消息」）。
#[test]
fn explicit_ids_advance_the_counter() {
    let (s, _d) = store_with(Limits::unlimited());
    let mut e = text("default", 100, "from go");
    e.set_id(100);
    let inserted = s.insert(e).unwrap();
    assert_eq!(inserted.id(), 100);

    let next = s.insert(text("default", 101, "new")).unwrap();
    assert_eq!(next.id(), 101, "新 id 必须跳过迁移进来的 100");
}

#[test]
fn next_ephemeral_id_does_not_store_anything() {
    let (s, _d) = store_with(Limits::unlimited());
    let eph = s.next_ephemeral_id().unwrap();
    assert_eq!(eph, 1);
    assert_eq!(s.stats().unwrap().total_entries, 0, "临时 id 不该落库");
    // 但它占用了计数器 —— 后面插入的普通消息不会撞上它。
    let real = s.insert(text("default", 100, "real")).unwrap();
    assert_eq!(real.id(), 2);
}

// ── 顺序 ──────────────────────────────────────────────────────────────

#[test]
fn recent_desc_is_newest_first_asc_is_oldest_first() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..5 {
        s.insert(text("default", 1000 + i, &format!("m{i}")))
            .unwrap();
    }

    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["m4", "m3", "m2", "m1", "m0"]
    );
    assert_eq!(
        contents(&s.recent_asc("default", 10).unwrap()),
        ["m0", "m1", "m2", "m3", "m4"],
        "WS 回放要旧的在前 —— 客户端是一条条 append 的"
    );
}

/// ⚠️ 时间戳是**秒级**，同一秒里插多条是常态（脚本、自动化）。
/// 这时候顺序只能靠 id —— 这正是 key 里带 `id_desc` 的原因。
#[test]
fn same_timestamp_falls_back_to_id_order() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..3 {
        s.insert(text("default", 1000, &format!("same-second-{i}")))
            .unwrap();
    }
    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["same-second-2", "same-second-1", "same-second-0"]
    );
    // latest 也要取到最后插入的那条（对应 Go 的 `ORDER BY timestamp DESC, id DESC`）。
    assert_eq!(
        contents(&s.latest("default").unwrap().into_iter().collect::<Vec<_>>()),
        ["same-second-2"]
    );
}

#[test]
fn latest_is_none_for_an_empty_room() {
    let (s, _d) = store_with(Limits::unlimited());
    assert!(s.latest("nobody-here").unwrap().is_none());
    assert!(s.recent_desc("nobody-here", 10).unwrap().is_empty());
}

// ── 房间隔离 ──────────────────────────────────────────────────────────

/// ⚠️ 这条是防 key 前缀比较写错：「work」和「works」在字典序上相邻，
/// 一个不小心就会把隔壁房间的消息扫进来（表现为「房间里出现了别人的剪贴板」）。
#[test]
fn rooms_are_strictly_isolated() {
    let (s, _d) = store_with(Limits::unlimited());
    s.insert(text("work", 100, "in-work")).unwrap();
    s.insert(text("works", 100, "in-works")).unwrap();
    s.insert(text("wor", 100, "in-wor")).unwrap();

    assert_eq!(contents(&s.recent_desc("work", 10).unwrap()), ["in-work"]);
    assert_eq!(contents(&s.recent_desc("works", 10).unwrap()), ["in-works"]);
    assert_eq!(contents(&s.recent_desc("wor", 10).unwrap()), ["in-wor"]);
}

/// ⚠️ 空房间名 = `default` 房间（契约里就这么定的）。写入时必须归一，
/// 否则「不传 room」和「传空 room」会变成两个房间。
#[test]
fn empty_room_normalizes_to_default() {
    let (s, _d) = store_with(Limits::unlimited());
    let a = s.insert(text("", 100, "no-room")).unwrap();
    assert_eq!(a.room(), "default");
    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["no-room"]
    );
    // 两种写法都要能查到同一条。
    assert_eq!(contents(&s.recent_desc("", 10).unwrap()), ["no-room"]);
    assert_eq!(
        contents(&s.recent_desc("  default  ", 10).unwrap()),
        ["no-room"]
    );
}

// ── 单条取用 / 修改 / 删除 ────────────────────────────────────────────

#[test]
fn get_returns_the_entry_and_none_for_missing() {
    let (s, _d) = store_with(Limits::unlimited());
    let e = s.insert(text("default", 100, "hello")).unwrap();
    assert_eq!(
        contents(&s.get(e.id()).unwrap().into_iter().collect::<Vec<_>>()),
        ["hello"]
    );
    assert!(s.get(9999).unwrap().is_none());
}

#[test]
fn remove_deletes_and_reports_whether_it_existed() {
    let (s, _d) = store_with(Limits::unlimited());
    let e = s.insert(text("default", 100, "bye")).unwrap();
    assert!(s.remove(e.id()).unwrap(), "删存在的应该返回 true");
    assert!(!s.remove(e.id()).unwrap(), "删两次第二次返回 false");
    assert!(s.get(e.id()).unwrap().is_none());
    assert_eq!(s.stats().unwrap().total_entries, 0);
    // ⚠️ 房间计数要跟着减，否则 /rooms 会虚报。
    let rooms = s.rooms().unwrap();
    let default_room = rooms.iter().find(|r| r.name == "default");
    assert_eq!(default_room.map(|r| r.message_count), Some(0));
}

/// ⚠️ 看板挪列**不该动 timestamp** —— 挪位置不该让卡片跳到最新去。
/// 这条测试盯的就是那个「顺手改一下」的诱惑。
#[test]
fn replace_keeps_position_when_only_the_column_changes() {
    let (s, _d) = store_with(Limits::unlimited());
    let a = s.insert(text("default", 100, "old")).unwrap();
    let b = s.insert(text("default", 200, "new")).unwrap();

    let mut moved = a.clone();
    moved.set_column("done");
    assert!(s.replace(&moved).unwrap());

    let back = s.get(a.id()).unwrap().expect("还在");
    assert_eq!(back.column(), "done");
    assert_eq!(back.timestamp(), 100, "挪列不能动 timestamp");
    assert_eq!(back.content_of(), "old");
    // 顺序也不该变：b 仍然在 a 前面。
    assert_eq!(
        ids(&s.recent_desc("default", 10).unwrap()),
        [b.id(), a.id()]
    );
}

#[test]
fn replace_returns_false_for_a_missing_id() {
    let (s, _d) = store_with(Limits::unlimited());
    let mut ghost = text("default", 100, "ghost");
    ghost.set_id(4242);
    assert!(!s.replace(&ghost).unwrap());
}

#[test]
fn replace_moves_the_key_when_the_timestamp_changes() {
    let (s, _d) = store_with(Limits::unlimited());
    let a = s.insert(text("default", 100, "a")).unwrap();
    s.insert(text("default", 200, "b")).unwrap();

    let mut moved = a.clone();
    moved.base_mut().timestamp = 300;
    assert!(s.replace(&moved).unwrap());

    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["a", "b"],
        "时间戳改了就该跳到最新 —— key 变了，不是就地覆盖"
    );
    assert_eq!(s.stats().unwrap().total_entries, 2, "不该多出一条");
}

#[test]
fn replace_across_rooms_fixes_both_counters() {
    let (s, _d) = store_with(Limits::unlimited());
    let a = s.insert(text("from", 100, "a")).unwrap();
    let mut moved = a.clone();
    moved.base_mut().room = "to".to_owned();
    assert!(s.replace(&moved).unwrap());

    let rooms = s.rooms().unwrap();
    let count = |name: &str| {
        rooms
            .iter()
            .find(|r| r.name == name)
            .map_or(0, |r| r.message_count)
    };
    assert_eq!(count("from"), 0);
    assert_eq!(count("to"), 1);
    assert_eq!(contents(&s.recent_desc("to", 10).unwrap()), ["a"]);
    assert!(s.recent_desc("from", 10).unwrap().is_empty());
}

// ── 分页（ARCHITECTURE §6.2） ─────────────────────────────────────────

#[test]
fn page_before_walks_backwards_without_gaps_or_duplicates() {
    let (s, _d) = store_with(Limits::unlimited());
    let mut all = Vec::new();
    for i in 0..10 {
        all.push(
            s.insert(text("default", 1000 + i, &format!("m{i}")))
                .unwrap(),
        );
    }

    // 最新的一页：m9 m8 m7
    let first = s.recent_desc("default", 3).unwrap();
    assert_eq!(contents(&first), ["m9", "m8", "m7"]);

    // 翻下一页：比 m7（id=8）更早的 3 条
    let second = s
        .page_before("default", first.last().unwrap().id(), 3)
        .unwrap();
    assert_eq!(contents(&second), ["m6", "m5", "m4"]);

    let third = s
        .page_before("default", second.last().unwrap().id(), 3)
        .unwrap();
    assert_eq!(contents(&third), ["m3", "m2", "m1"]);

    // ⚠️ 拼接起来必须是**不重不漏**的完整序列 —— 这是游标用 id 而不是时间戳的全部理由。
    let mut seen: Vec<String> = Vec::new();
    seen.extend(contents(&first));
    seen.extend(contents(&second));
    seen.extend(contents(&third));
    assert_eq!(seen, ["m9", "m8", "m7", "m6", "m5", "m4", "m3", "m2", "m1"]);
}

/// ⚠️ 游标失效（那条被删了）不该报错 —— 删一条旧消息不该让整页翻不动。
#[test]
fn page_before_with_a_stale_cursor_falls_back_to_the_newest_page() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..5 {
        s.insert(text("default", 1000 + i, &format!("m{i}")))
            .unwrap();
    }
    let page = s.page_before("default", 9999, 3).unwrap();
    assert_eq!(contents(&page), ["m4", "m3", "m2"]);
}

#[test]
fn page_before_stops_at_the_room_boundary() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..4 {
        s.insert(text("work", 1000 + i, &format!("w{i}"))).unwrap();
        s.insert(text("works", 1000 + i, &format!("s{i}"))).unwrap();
    }
    // 从 work 最旧那条再往前翻 —— 应该空，而不是翻进 works。
    let oldest = s.recent_desc("work", 10).unwrap().pop().unwrap();
    let page = s.page_before("work", oldest.id(), 5).unwrap();
    assert!(page.is_empty(), "不该翻到隔壁房间: {:?}", contents(&page));
}

// ── 房间列表 ──────────────────────────────────────────────────────────

#[test]
fn rooms_reports_counts_and_last_active() {
    let (s, _d) = store_with(Limits::unlimited());
    s.insert(text("alpha", 100, "1")).unwrap();
    s.insert(text("alpha", 300, "2")).unwrap();
    s.insert(text("beta", 200, "3")).unwrap();

    let rooms = s.rooms().unwrap();
    assert_eq!(rooms.len(), 2, "按 last_active 排序，alpha 在前");
    assert_eq!(rooms[0].name, "alpha");
    assert_eq!(rooms[0].message_count, 2);
    assert_eq!(rooms[0].last_active, 300);
    assert_eq!(rooms[1].name, "beta");
    assert_eq!(rooms[1].last_active, 200);
}

/// ⚠️ 高水位只增不减 —— 这是**刻意的**，不是 bug。写成断言免得有人来「修」它。
#[test]
fn last_active_is_a_high_water_mark() {
    let (s, _d) = store_with(Limits::unlimited());
    s.insert(text("alpha", 100, "1")).unwrap();
    let newest = s.insert(text("alpha", 300, "2")).unwrap();
    s.remove(newest.id()).unwrap();

    let rooms = s.rooms().unwrap();
    assert_eq!(
        rooms[0].last_active, 300,
        "删掉最新一条之后 last_active 不该回落"
    );
    assert_eq!(rooms[0].message_count, 1, "但计数要减");
}

#[test]
fn rebuild_room_stats_repairs_the_counters() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..3 {
        s.insert(text("alpha", 100 + i, "x")).unwrap();
    }
    let rooms = s.rooms().unwrap();
    assert_eq!(rooms[0].message_count, 3);

    // 重算应该给出同样的结果（幂等）。
    assert_eq!(s.rebuild_room_stats().unwrap(), 1);
    let rooms = s.rooms().unwrap();
    assert_eq!(rooms[0].message_count, 3);
    assert_eq!(rooms[0].last_active, 102);
}

// ── 裁剪 ──────────────────────────────────────────────────────────────

#[test]
fn per_room_limit_evicts_the_oldest_on_write() {
    let (s, _d) = store_with(Limits::unlimited().with_per_room(3));
    for i in 0..6 {
        s.insert(text("default", 1000 + i, &format!("m{i}")))
            .unwrap();
    }
    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["m5", "m4", "m3"],
        "只留最新 3 条"
    );
    // ⚠️ 被淘汰的条目要从 by_id 里**也**清掉，否则 /content/<id> 会取到「已经不存在的」消息 ——
    // 表现是用户点开一条早该消失的旧消息，还能看到内容。
    assert_eq!(s.stats().unwrap().total_entries, 3);
    for evicted in 1..=3 {
        assert!(
            s.get(evicted).unwrap().is_none(),
            "id={evicted} 被裁掉了，但 by_id 里还在"
        );
    }
    // 留下来的三条必须还能按 id 取到。
    for kept in 4..=6 {
        assert!(s.get(kept).unwrap().is_some(), "id={kept} 应该还在");
    }
    // 字节计数也要跟着减，否则 max_bytes 会误判超限。
    let one = s.stats().unwrap().total_bytes;
    assert!(one > 0);
}

/// ⚠️ 每房间裁剪**不能**碰别的房间 —— 否则一个吵闹的房间会把安静的房间挤空。
#[test]
fn per_room_limit_does_not_touch_other_rooms() {
    let (s, _d) = store_with(Limits::unlimited().with_per_room(2));
    for i in 0..5 {
        s.insert(text("noisy", 1000 + i, &format!("n{i}"))).unwrap();
    }
    s.insert(text("quiet", 500, "keep-me")).unwrap();

    assert_eq!(contents(&s.recent_desc("noisy", 10).unwrap()), ["n4", "n3"]);
    assert_eq!(
        contents(&s.recent_desc("quiet", 10).unwrap()),
        ["keep-me"],
        "安静的房间不该被挤掉"
    );
}

#[test]
fn total_limit_evicts_the_globally_oldest() {
    let (s, _d) = store_with(Limits::unlimited().with_total(4));
    for i in 0..6 {
        s.insert(text("default", 1000 + i, &format!("m{i}")))
            .unwrap();
    }
    assert_eq!(s.stats().unwrap().total_entries, 6, "写入路径不裁全库维度");

    // 全库整理要**循环调用**直到返回 0（一次最多 TRIM_BATCH 条）。
    let mut rounds = 0;
    loop {
        let removed = s.trim_global().unwrap();
        if removed == 0 {
            break;
        }
        rounds += 1;
        assert!(rounds < 10, "不该需要这么多轮");
    }
    assert_eq!(s.stats().unwrap().total_entries, 4);
    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["m5", "m4", "m3", "m2"]
    );
}

#[test]
fn max_bytes_limit_trims_until_it_fits() {
    // 先量一条有多大，再据此设上限，避免把测试写死在某个体积上。
    let (probe, _pd) = store_with(Limits::unlimited());
    probe.insert(text("default", 1000, "0123456789")).unwrap();
    let one = probe.stats().unwrap().total_bytes;
    assert!(one > 0, "至少要算出正字节数");

    let (s, _d) = store_with(Limits::unlimited().with_max_bytes(one * 2 + one / 2));
    for i in 0..6 {
        s.insert(text("default", 1000 + i, "0123456789")).unwrap();
    }
    let mut rounds = 0;
    loop {
        if s.trim_global().unwrap() == 0 {
            break;
        }
        rounds += 1;
        assert!(rounds < 20);
    }
    let after = s.stats().unwrap();
    assert!(
        after.total_bytes <= one * 2 + one / 2,
        "裁完还是超限: {} 字节",
        after.total_bytes
    );
    assert!(after.total_entries >= 2, "不该裁到只剩一两条");
}

#[test]
fn trim_global_is_a_noop_when_unlimited() {
    let (s, _d) = store_with(Limits::unlimited());
    for i in 0..5 {
        s.insert(text("default", 1000 + i, "x")).unwrap();
    }
    assert_eq!(s.trim_global().unwrap(), 0);
    assert_eq!(s.stats().unwrap().total_entries, 5);
}

// ── 持久化 ────────────────────────────────────────────────────────────

#[test]
fn reopening_the_same_file_keeps_everything() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("clip9.redb");
    let a_id;
    {
        let s = Store::open_with(&path, Limits::unlimited()).unwrap();
        a_id = s.insert(text("default", 100, "persisted")).unwrap().id();
        s.insert(text("default", 200, "second")).unwrap();
    } // 关库（Drop）

    let s = Store::open_with(&path, Limits::unlimited()).unwrap();
    assert_eq!(
        contents(&s.recent_desc("default", 10).unwrap()),
        ["second", "persisted"]
    );
    assert_eq!(
        contents(&s.get(a_id).unwrap().into_iter().collect::<Vec<_>>()),
        ["persisted"]
    );
    // 计数器也要持久 —— 否则重开之后新消息会撞上老 id。
    let next = s.insert(text("default", 300, "third")).unwrap();
    assert_eq!(next.id(), 3);
}

#[test]
fn opening_a_newer_schema_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("clip9.redb");
    {
        let s = Store::open_with(&path, Limits::unlimited()).unwrap();
        s.insert(text("default", 100, "x")).unwrap();
    }
    // 直接把 schema_version 改成一个不认识的版本，模拟「用旧程序打开新库」。
    let db = redb::Database::create(&path).unwrap();
    {
        use redb::TableDefinition;
        let txn = db.begin_write().unwrap();
        {
            let mut meta = txn
                .open_table(TableDefinition::<&str, u64>::new("meta"))
                .unwrap();
            meta.insert("schema_version", 999u64).unwrap();
        }
        txn.commit().unwrap();
    }
    drop(db);

    let err = Store::open_with(&path, Limits::unlimited()).expect_err("应该拒绝");
    assert!(
        matches!(
            err,
            clip9_store::StoreError::SchemaMismatch { found: 999, .. }
        ),
        "报错类型不对: {err}"
    );
}

// ── 文件条目 ──────────────────────────────────────────────────────────

/// ⚠️ 文件条目**没有正文** —— 只有元数据。存进去再取出来必须还是那个形状，
/// 别在哪一层给它补上一个空的 `content`。
#[test]
fn file_entries_keep_their_metadata_only_shape() {
    let (s, _d) = store_with(Limits::unlimited());
    let mut f = file("default", 100, "shot.png");
    if let ReceiveHolder::File(fr) = &mut f {
        fr.size = 20480;
        fr.expire = 1758703601;
        fr.thumbnail = "data:image/png;base64,AAAA".to_owned();
        fr.url = "/file/uuid-shot.png/shot.png".to_owned();
    }
    let stored = s.insert(f).unwrap();
    let back = s.get(stored.id()).unwrap().unwrap();

    match back {
        ReceiveHolder::File(fr) => {
            assert_eq!(fr.name, "shot.png");
            assert_eq!(fr.cache, "uuid-shot.png");
            assert_eq!(fr.size, 20480);
            assert_eq!(fr.expire, 1758703601);
            assert_eq!(fr.url, "/file/uuid-shot.png/shot.png");
        }
        ReceiveHolder::Text(_) => panic!("文件条目变成了文本条目 —— 判别字段丢了"),
    }
}

/// 顺带钉住：`ReceiveHolder` 存进去再取出来必须**逐字段相等**。
/// 这是 store 最重要的一条 —— 任何字段（包括 `senderDevice` 的 null/{}）被吞掉，
/// 表现都是「前端某个角落莫名不对」，而不会报错。
#[test]
fn entries_round_trip_field_for_field() {
    let (s, _d) = store_with(Limits::unlimited());

    let mut rich = text("work", 1_758_700_000, "hello\nworld");
    if let ReceiveHolder::Text(t) = &mut rich {
        t.base.sender_ip = "192.168.1.20".to_owned();
        t.base.sender_client_id = "client-abc".to_owned();
        t.base.sender_device = Some(
            [("os".to_owned(), "macOS 14".to_owned())]
                .into_iter()
                .collect(),
        );
        t.base.column = "doing".to_owned();
        t.base.source = "automation".to_owned();
        t.base.scheduled_at = 1_758_700_000;
        t.base.late = true;
    }
    let stored = s.insert(rich.clone()).unwrap();

    // 除了 id（插入时分配的），其余字段必须完全一致。
    let mut expected = rich;
    expected.set_id(stored.id());
    let back = s.get(stored.id()).unwrap().unwrap();
    assert_eq!(back, expected, "往返之后有字段丢了或变了");
}

/// 让 `contents()` 也能显示文本正文（上面几处断言用得到）。
trait ContentOf {
    fn content_of(&self) -> String;
}
impl ContentOf for ReceiveHolder {
    fn content_of(&self) -> String {
        match self {
            ReceiveHolder::Text(t) => t.content.clone(),
            ReceiveHolder::File(f) => f.name.clone(),
        }
    }
}

// ── 文件登记：过期判定与按文件收条目 ──────────────────────────────────

fn put(s: &Store, uuid: &str, expire_time: i64) {
    s.put_file(&clip9_protocol::File {
        name: format!("{uuid}.bin"),
        uuid: uuid.to_owned(),
        size: 1,
        upload_time: 0,
        expire_time,
        room: "default".to_owned(),
    })
    .expect("登记文件");
}

/// ★ `expire_time == 0` 是**永不过期**，不是「立刻过期」。
///
/// ⚠️ 这条以前**只在注释里写着、没有任何测试钉住**。而它写错的表现是：
/// 所有设了 `fileExpire: 0` 的房间，文件会在下一次后台清理时被**全部清光** ——
/// 也就是「永不过期」这个功能整个失效，而且不报任何错。
#[test]
fn expired_files_excludes_never_expiring_ones() {
    let (s, _dir) = store_with(Limits::unlimited());
    put(&s, "u-never", 0); // 永不过期
    put(&s, "u-past", 100); // 早就过了
    put(&s, "u-future", 10_000); // 还没到

    let expired: Vec<String> = s
        .expired_files(1_000)
        .expect("查过期")
        .into_iter()
        .map(|f| f.uuid)
        .collect();
    assert_eq!(
        expired,
        vec!["u-past".to_owned()],
        "只有真过期的那条：0（永不过期）与未来都不算"
    );
}

/// ★ `remove_entries_for_files` 只收**引用那个文件**的条目，别的不碰。
///
/// ⚠️ 写错的表现是「用户的历史被莫名清掉」，而清理任务不报错。
#[test]
fn remove_entries_for_files_touches_only_that_file() {
    let (s, _dir) = store_with(Limits::unlimited());

    let doomed = s.insert(file("default", 1, "a")).expect("写 a");
    let kept = s.insert(file("default", 2, "b")).expect("写 b");
    let text_entry = s.insert(text("default", 3, "正文")).expect("写文本");

    // `file("default", 1, "a")` 的 cache 是 `uuid-a`
    let removed = s
        .remove_entries_for_files(&["uuid-a".to_owned()])
        .expect("收条目");

    assert_eq!(removed.len(), 1, "只该收掉引用 uuid-a 的那一条");
    assert_eq!(removed[0].0, doomed.id(), "返回的 id 要能拿去广播 revoke");
    assert_eq!(removed[0].1, "default", "房间也要带回来");

    let left: Vec<i32> = s.recent_desc("default", 10).expect("读").iter().map(|e| e.id()).collect();
    assert!(left.contains(&kept.id()), "别的文件条目要留着");
    assert!(left.contains(&text_entry.id()), "文本条目要留着");
    assert!(!left.contains(&doomed.id()), "被引用那条要没了");

    // ⚠️ 房间计数与总字节要跟着维护 —— 漏掉就是「数字慢慢漂掉」而不报错
    assert_eq!(s.stats().expect("统计").total_entries, 2, "总条数要减 1");
    let room = s.rooms().expect("读房间").into_iter().find(|r| r.name == "default").expect("default 在");
    assert_eq!(room.message_count, 2, "房间计数要减 1");
}
