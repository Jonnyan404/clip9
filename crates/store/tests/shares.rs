//! 分享记录的存储行为测试。
//!
//! 这部分**没有**逐条对应的 Go 测试可抄（Go 把它放在 `share-log.json` 里），
//! 所以断言写的是**我们希望的行为**，尤其是我方比 Go 多出来的那一条：
//! 「限次分享的用量要跟记录一起落盘」—— Go 存在内存里，重启就归零。

use clip9_store::{ShareRecord, ShareUse, Store};

const NOW: i64 = 1_700_000_000;

fn record(jti: &str, room: &str, created_at: i64) -> ShareRecord {
    ShareRecord {
        jti: jti.to_owned(),
        share_type: "content".to_owned(),
        id: "7".to_owned(),
        room: room.to_owned(),
        kind: "text".to_owned(),
        name: "第一行".to_owned(),
        size: 0,
        created_at,
        exp: NOW + 900,
        max_uses: 0,
        password: false,
        visits: 0,
        scans: 0,
        used: 0,
    }
}

fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    (store, dir)
}

#[test]
fn share_records_round_trip_and_survive_reopen() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("clip9.redb");

    let mut expected = record("jti-1", "work", NOW);
    expected.visits = 2;
    expected.scans = 1;
    expected.used = 3;
    expected.max_uses = 5;
    expected.password = true;
    expected.size = 4096;

    {
        let store = Store::open(&path).expect("打开 store");
        store.put_share(&expected, NOW).expect("写入");
        assert_eq!(store.get_share("jti-1").unwrap().unwrap(), expected);
        assert!(store.get_share("不存在").unwrap().is_none());
    }

    // ★ 重开之后用量还在 —— Go 那边（内存 map）这一步会归零，
    // 于是「最多 3 次」的链接重启后又能用 3 次。
    let reopened = Store::open(&path).expect("重开 store");
    assert_eq!(reopened.get_share("jti-1").unwrap().unwrap(), expected);
}

#[test]
fn shares_are_listed_per_room_newest_first_with_a_total() {
    let (store, _dir) = store();
    store
        .put_share(&record("a", "work", NOW - 30), NOW)
        .unwrap();
    store
        .put_share(&record("b", "work", NOW - 10), NOW)
        .unwrap();
    store
        .put_share(&record("c", "work", NOW - 20), NOW)
        .unwrap();
    store.put_share(&record("d", "default", NOW), NOW).unwrap();

    let (records, total) = store.shares_for_room("work", 10).unwrap();
    assert_eq!(
        records.iter().map(|r| r.jti.as_str()).collect::<Vec<_>>(),
        ["b", "c", "a"],
        "新→旧"
    );
    assert_eq!(total, 3, "total 是该房间的总数，不是 limit 之后的条数");

    // ⚠️ limit 只截断返回的列表，**不改 total** —— 响应里两个数字都得是调用方能对上的。
    let (records, total) = store.shares_for_room("work", 2).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(total, 3);

    // 空房间名 = default 房间（归一化在 store 里做，调用方不用先转一道）。
    let (records, total) = store.shares_for_room("", 10).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(total, 1);
    assert_eq!(records[0].jti, "d");
}

/// 同一秒内创建的两条要**稳定**排序，否则每刷新一次列表顺序都可能变。
#[test]
fn same_second_records_have_a_stable_order() {
    let (store, _dir) = store();
    store.put_share(&record("b", "work", NOW), NOW).unwrap();
    store.put_share(&record("a", "work", NOW), NOW).unwrap();

    let first = store.shares_for_room("work", 10).unwrap().0;
    let second = store.shares_for_room("work", 10).unwrap().0;
    assert_eq!(
        first.iter().map(|r| r.jti.as_str()).collect::<Vec<_>>(),
        second.iter().map(|r| r.jti.as_str()).collect::<Vec<_>>()
    );
}

#[test]
fn share_open_counts_visits_and_scans() {
    let (store, _dir) = store();
    store.put_share(&record("jti-1", "work", NOW), NOW).unwrap();

    assert_eq!(
        store.record_share_open("jti-1", false).unwrap(),
        Some((1, 0))
    );
    assert_eq!(
        store.record_share_open("jti-1", true).unwrap(),
        Some((2, 1))
    );
    assert_eq!(
        store.record_share_open("jti-1", false).unwrap(),
        Some((3, 1))
    );

    // 没有这条记录 → None（调用方据此答 `tracked: false`）。
    assert_eq!(store.record_share_open("不存在", true).unwrap(), None);

    let stored = store.get_share("jti-1").unwrap().unwrap();
    assert_eq!((stored.visits, stored.scans), (3, 1));
}

#[test]
fn consume_share_use_stops_at_the_limit() {
    let (store, _dir) = store();
    let mut limited = record("jti-1", "work", NOW);
    limited.max_uses = 2;
    store.put_share(&limited, NOW).unwrap();

    assert_eq!(
        store.consume_share_use("jti-1", NOW).unwrap(),
        ShareUse::Consumed { used: 1 }
    );
    assert_eq!(
        store.consume_share_use("jti-1", NOW).unwrap(),
        ShareUse::Consumed { used: 2 }
    );
    assert_eq!(
        store.consume_share_use("jti-1", NOW).unwrap(),
        ShareUse::Exhausted {
            used: 2,
            max_uses: 2
        }
    );
    assert_eq!(
        store.get_share("jti-1").unwrap().unwrap().used,
        2,
        "用尽之后不能再涨"
    );
}

/// ⚠️ 过期与「查不到」要能区分：一个是「这条链接到期了」，另一个是「记录被裁掉了」。
#[test]
fn consume_share_use_distinguishes_expired_from_unknown() {
    let (store, _dir) = store();
    store.put_share(&record("jti-1", "work", NOW), NOW).unwrap();
    store
        .put_share(
            &ShareRecord {
                exp: NOW - 1,
                ..record("jti-2", "work", NOW)
            },
            NOW,
        )
        .unwrap();

    assert_eq!(
        store.consume_share_use("jti-2", NOW).unwrap(),
        ShareUse::Expired
    );
    assert_eq!(
        store.consume_share_use("不存在", NOW).unwrap(),
        ShareUse::Unknown
    );
}

/// ⚠️★ 裁剪要**先丢已经失效的**，而不是无脑按时间丢：
/// 否则「别人分享了 500 条」会把一条还在有效期内、还差一次就用完的分享挤掉，
/// 它的用量计数跟着消失 —— 那次限量就静默失效了。
#[test]
fn trimming_drops_expired_records_before_live_ones() {
    let (store, _dir) = store();

    // 先塞满上限：全部是**已过期**的记录，创建时间很新。
    for i in 0..500 {
        let expired = ShareRecord {
            exp: NOW - 1,
            ..record(&format!("dead-{i:03}"), "work", NOW - i)
        };
        store.put_share(&expired, NOW).unwrap();
    }
    assert_eq!(store.share_count().unwrap(), 500);

    // 再写一条**还活着**的（创建时间很旧）：它必须活得下来。
    let live = record("alive", "work", NOW - 10_000);
    let trimmed = store.put_share(&live, NOW).unwrap();

    assert_eq!(trimmed, 1, "超出一条就该丢掉恰好一条");
    assert_eq!(store.share_count().unwrap(), 500);
    assert!(
        store.get_share("alive").unwrap().is_some(),
        "活的记录不能被已过期的记录挤掉"
    );
    assert!(
        store.get_share("dead-499").unwrap().is_none(),
        "该丢的是最旧的已过期记录"
    );
}

/// 同一条 jti 覆盖写（重新签发不该产生第二条记录）。
#[test]
fn putting_the_same_jti_overwrites_instead_of_duplicating() {
    let (store, _dir) = store();
    store.put_share(&record("jti-1", "work", NOW), NOW).unwrap();
    let mut updated = record("jti-1", "work", NOW);
    updated.visits = 9;
    store.put_share(&updated, NOW).unwrap();

    assert_eq!(store.share_count().unwrap(), 1);
    assert_eq!(store.get_share("jti-1").unwrap().unwrap().visits, 9);
}

/// 没有可选字段的记录能正常往返（`kind` / `name` / `size` 都缺省）。
#[test]
fn minimal_record_round_trips() {
    let (store, _dir) = store();
    let minimal = ShareRecord {
        jti: "jti-min".to_owned(),
        share_type: "file".to_owned(),
        id: "uuid-1".to_owned(),
        room: "work".to_owned(),
        kind: String::new(),
        name: String::new(),
        size: 0,
        created_at: NOW,
        exp: NOW + 60,
        max_uses: 0,
        password: false,
        visits: 0,
        scans: 0,
        used: 0,
    };
    store.put_share(&minimal, NOW).unwrap();
    assert_eq!(store.get_share("jti-min").unwrap().unwrap(), minimal);
}
