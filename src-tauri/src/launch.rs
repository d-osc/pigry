//! Folder supplied by Explorer or the command line.
use std::ffi::OsString;
use std::path::PathBuf;

pub struct LaunchFolder(pub Result<Option<PathBuf>, String>);

pub fn parse_folder(args: impl IntoIterator<Item = OsString>) -> Result<Option<PathBuf>, String> {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Ok(None);
    };
    let path = if first == "--open-folder" || first == "--" {
        args.next()
    } else if first.to_string_lossy().starts_with('-') {
        return Ok(None);
    } else {
        Some(first)
    }
    .filter(|path| !path.is_empty())
    .ok_or("Usage: pigry <folder>")?;
    if args.next().is_some() {
        return Err("Expected one folder. Quote paths containing spaces.".into());
    }
    Ok(Some(PathBuf::from(path)))
}

#[tauri::command]
pub fn install_launch_command() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::{ErrorKind, Write};
        use std::os::unix::fs::OpenOptionsExt;

        let home = std::env::home_dir().ok_or("Could not locate your home directory.")?;
        let directory = home.join(".local/bin");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join("pigry");
        let launcher = include_bytes!("macos_launcher.sh");
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(launcher) {
                    let _ = std::fs::remove_file(&path);
                    return Err(error.to_string());
                }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if std::fs::read(&path).ok().as_deref() != Some(launcher) {
                    return Err(format!(
                        "An existing command is already present at {}.",
                        path.display()
                    ));
                }
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    Err("The Windows user installer registers the pigry command automatically.".into())
}

#[tauri::command]
pub fn get_launch_folder(folder: tauri::State<'_, LaunchFolder>) -> Result<Option<String>, String> {
    // Do not consume this value: React StrictMode can mount the provider twice.
    folder
        .0
        .clone()
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
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
        for path in [
            r"C:\My Projects\งานทดสอบ\.",
            r"C:\\.",
            r"\\server\shared folder\.",
        ] {
            assert_eq!(
                parse(&["--open-folder", path]).unwrap(),
                Some(PathBuf::from(path))
            );
        }
    }

    #[test]
    fn rejects_missing_empty_and_extra_folder_arguments() {
        assert!(parse(&["--open-folder"]).is_err());
        assert!(parse(&["--open-folder", ""]).is_err());
        assert!(parse(&["--open-folder", "first", "second"]).is_err());
    }

    #[test]
    fn accepts_shell_folder_paths_and_an_option_separator() {
        for path in [".", "./folder with spaces", "../งานทดสอบ", "C:/My Projects"] {
            assert_eq!(parse(&[path]).unwrap(), Some(PathBuf::from(path)));
        }
        assert_eq!(
            parse(&["--", "-project"]).unwrap(),
            Some(PathBuf::from("-project"))
        );
        assert!(parse(&["first", "second"]).is_err());
    }
}
