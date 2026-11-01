//! 低频快照：主窗口推增量，平台侧合并成完整快照。
//!
//! 桌面歌词与任务栏面板都是「主窗口的显示器」：它们不持有播放逻辑，
//! 挂载时补读一次完整快照，之后只吃增量。合并规则因此只写一份。

use std::sync::Mutex;

use serde_json::Value;

pub struct Snapshot {
    /// 初始值：锁被毒化时用它兜底，也省掉一次 clone 常量
    initial: Value,
    value: Mutex<Value>,
}

impl Snapshot {
    pub fn new(initial: Value) -> Self {
        Self {
            value: Mutex::new(initial.clone()),
            initial,
        }
    }

    pub fn get(&self) -> Value {
        self.value
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| self.initial.clone())
    }

    /// 合并增量。`null` 是合法值（例如清空当前曲目），所以只按「键是否出现」判断。
    pub fn merge(&self, patch: &Value) -> Value {
        let Some(patch) = patch.as_object() else {
            return self.get();
        };
        match self.value.lock() {
            Ok(mut guard) => {
                if let Some(target) = guard.as_object_mut() {
                    for (key, value) in patch {
                        target.insert(key.clone(), value.clone());
                    }
                }
                guard.clone()
            }
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}
