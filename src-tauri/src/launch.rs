//! Folder supplied by Explorer (or `pigry --open-folder PATH`).
use std::ffi::OsString;
use std::path::PathBuf;

pub struct LaunchFolder(pub Result<Option<PathBuf>, String>);

pub fn parse_folder(args: impl IntoIterator<Item = OsString>) -> Result<Option<PathBuf>, String> {
    let mut args = args.into_iter();
    let Some(flag) = args.next() else { return Ok(None) };
    if flag != "--open-folder" {
        return Ok(None);
    }
    let path = args.next().filter(|path| !path.is_empty())
        .ok_or("Usage: pigry --open-folder PATH")?;
    if args.next().is_some() {
        return Err("Expected one folder after --open-folder".into());
    }
    Ok(Some(PathBuf::from(path)))
}

#[tauri::command]
pub fn get_launch_folder(folder: tauri::State<'_, LaunchFolder>) -> Result<Option<String>, String> {
    // Do not consume this value: React StrictMode can mount the provider twice.
    folder.0.clone().map(|path| path.map(|path| path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<PathBuf>, String> {
        parse_folder(args.iter().map(OsString::from))
    }

    #[test]
    fn normal_launch_keeps_repository_picker() {
        assert_eq!(parse(&[]).unwrap(), None);
        assert_eq!(parse(&["--unrelated-option"]).unwrap(), None);
    }

    #[test]
    fn preserves_spaces_unicode_and_explorer_folder_suffix() {
        for path in [r"C:\My Projects\งานทดสอบ\.", r"C:\\.", r"\\server\shared folder\."] {
            assert_eq!(parse(&["--open-folder", path]).unwrap(), Some(PathBuf::from(path)));
        }
    }

    #[test]
    fn rejects_missing_empty_and_extra_folder_arguments() {
        assert!(parse(&["--open-folder"]).is_err());
        assert!(parse(&["--open-folder", ""]).is_err());
        assert!(parse(&["--open-folder", "first", "second"]).is_err());
    }
}
