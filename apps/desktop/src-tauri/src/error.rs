use std::fmt;

#[derive(Debug, Clone)]
pub struct PlatformError {
    pub message: String,
    // 代码保留给 IPC 结构化错误；当前前端只消费 message
    #[allow(dead_code)]
    pub code: u16,
}

impl PlatformError {
    pub fn new(message: impl Into<String>, code: u16) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }

    pub fn msg(message: impl Into<String>) -> Self {
        Self::new(message, 500)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(message, 400)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(message, 403)
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PlatformError {}

impl From<rusqlite::Error> for PlatformError {
    fn from(value: rusqlite::Error) -> Self {
        Self::msg(format!("SQLite: {value}"))
    }
}

impl From<std::io::Error> for PlatformError {
    fn from(value: std::io::Error) -> Self {
        Self::msg(format!("IO: {value}"))
    }
}

pub type PResult<T> = Result<T, PlatformError>;
