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
        assert_eq!(store.get_task("task-1").unwrap().unwrap(), expected);
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
