use std::path::PathBuf;

pub fn home_dir() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn is_absolute_path(value: &str) -> bool {
    std::path::Path::new(value).is_absolute()
}
