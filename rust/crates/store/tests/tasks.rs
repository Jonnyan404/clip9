//! 定时任务的存储行为测试。
//!
//! 断言写的是「我们希望的行为」：任务进库、重开不丢、按 id 读写删。
//! 与 Go 的差异（Go 放 `tasks.json`）不影响这里的契约 —— 存储载体是内部实现，
//! 对外面暴露的是「任务能被可靠地读写删」。

use clip9_core::task::AutomationTask;
use clip9_store::Store;

fn task(id: &str, room: &str, template: &str) -> AutomationTask {
    AutomationTask {
        id: id.to_owned(),
        // ⚠️ `0` = 「还没分配序号」，`put_task` 会补上（见它自己的注释）。
        seq: 0,
        name: "值班提醒".to_owned(),
        enabled: true,
        freq: "daily".to_owned(),
        time: "09:30".to_owned(),
        cron: String::new(),
        by_weekday: Vec::new(),
        run_at: String::new(),
        tz: "Asia/Shanghai".to_owned(),
        room: room.to_owned(),
        template: template.to_owned(),
        chain: Vec::new(),
        keep_history: false,
        sender: "定时任务".to_owned(),
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
        last_run_key: String::new(),
        last_run_at: 0,
        last_status: String::new(),
        last_error: String::new(),
        last_output: String::new(),
        owner_hash: String::new(),
    }
}

#[test]
fn tasks_round_trip_and_survive_reopen() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("clip9.redb");

    let mut expected = task("task-1", "work", "今天是 {{date}}");
    expected.last_run_key = "2026-09-24T09:30".to_owned();
    expected.last_status = "ok".to_owned();

    {
        let store = Store::open(&path).expect("打开 store");
        store.put_task(&expected).expect("写入");
        let read = store.get_task("task-1").unwrap().unwrap();
        // ⚠️ `seq` 是 `put_task` 分配的（调用方传 0），所以不能整体相等 —— 先把它对齐再比。
        // 「分配了一个正数」这件事本身就是断言的一部分。
        assert!(read.seq > 0, "写入时应分配一个单调序号");
        expected.seq = read.seq;
        assert_eq!(read, expected);
        assert!(store.get_task("不存在").unwrap().is_none());
    }

    let reopened = Store::open(&path).expect("重开 store");
    assert_eq!(reopened.get_task("task-1").unwrap().unwrap(), expected);
}

#[test]
fn tasks_list_and_remove() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    store.put_task(&task("a", "home", "x")).unwrap();
    store.put_task(&task("b", "work", "y")).unwrap();
    store.put_task(&task("c", "home", "z")).unwrap();

    let all = store.list_tasks().unwrap();
    assert_eq!(all.len(), 3);

    assert!(store.remove_task("b").unwrap());
    assert!(!store.remove_task("b").unwrap(), "删第二次应返回 false");
    assert_eq!(store.list_tasks().unwrap().len(), 2);
    assert!(store.get_task("b").unwrap().is_none());
    assert_eq!(store.task_count().unwrap(), 2);
}

/// ⚠️★ 列表顺序 = **写入顺序**（`seq` 单调递增），**不是 redb 的 key 顺序**。
///
/// 这条防的是：表的主键是任务 uuid，按 key 遍历等于**按随机串排序** ——
/// 用户新建一条任务，它会出现在列表中间某个随机位置而不是末尾，而且每读一次可能又变。
///
/// ⚠️ 中途试过「按 `(createdAt, id)` 排」，**不够**：`createdAt` 是秒级的，
/// 同一秒内建的两条仍然只能靠 uuid 兜底，顺序还是随机的（就是这条测试当场抓到的）。
/// 根因是「拿**随机值**当排序兜底键」，所以修法是换掉兜底键 —— 用单调序列。
///
/// 断言刻意让 **uuid 顺序与写入顺序完全相反**，这样「碰巧对」不可能：
/// 按 key（uuid）排会得到 `aaa, mmm, zzz`，按 `seq` 排才是 `zzz, mmm, aaa`。
#[test]
fn list_tasks_follows_insertion_order_not_key_order() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    // ⚠️ 三条的 `createdAt` **故意写成同一个值** —— 这正是「同一秒内建的几条」那一档，
    // 也是「靠秒级时间戳排序」救不了的那一档。uuid 顺序与写入顺序也故意相反。
    let mut first = task("zzz", "home", "最先写入");
    first.created_at = 1_700_000_000;
    let mut second = task("mmm", "home", "第二个写入");
    second.created_at = 1_700_000_000;
    let mut third = task("aaa", "home", "最后写入");
    third.created_at = 1_700_000_000;

    store.put_task(&first).unwrap();
    store.put_task(&second).unwrap();
    store.put_task(&third).unwrap();

    let ids =
        |s: &Store| -> Vec<String> { s.list_tasks().unwrap().into_iter().map(|t| t.id).collect() };
    assert_eq!(
        ids(&store),
        vec!["zzz", "mmm", "aaa"],
        "应按写入顺序（seq 升序）—— 按 uuid 排会得到 aaa,mmm,zzz，正好相反"
    );

    // 更新一条**不该**改变它的位置（`seq` 由调用方带着进来，`put_task` 不会重发）。
    let mut touched = second.clone();
    touched.updated_at = 1_700_000_400;
    touched.enabled = false;
    store.put_task(&touched).unwrap();
    assert_eq!(
        ids(&store),
        vec!["zzz", "mmm", "aaa"],
        "更新不该把任务挪到列表末尾（Go 那边 upsert 也是就地替换）"
    );

    // 删掉中间那条之后，新建的必须排在**最后**（计数器要跳过已用的序号）。
    assert!(store.remove_task("mmm").unwrap());
    store.put_task(&task("bbb", "home", "后来新建的")).unwrap();
    assert_eq!(
        ids(&store),
        vec!["zzz", "aaa", "bbb"],
        "新任务应排在末尾，不能因为 uuid 更小就插到前面"
    );
}

#[test]
fn put_task_overwrites_in_place() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    store.put_task(&task("a", "home", "旧正文")).unwrap();

    let mut updated = task("a", "home", "新正文");
    updated.enabled = false;
    store.put_task(&updated).unwrap();

    let read = store.get_task("a").unwrap().unwrap();
    assert_eq!(read.template, "新正文");
    assert!(!read.enabled);
    assert_eq!(store.task_count().unwrap(), 1, "覆盖不该新增一条");
}
