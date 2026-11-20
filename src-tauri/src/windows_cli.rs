//! Register the installed GUI command in the current user's terminal PATH.
use std::{io, path::Path};

use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
};
use winreg::{
    RegKey,
    enums::*,
    types::{FromRegValue, ToRegValue},
};

const MARKER: &str = "Software\\Pigry\\CLI";

fn same_directory(entry: &str, directory: &str) -> bool {
    entry
        .trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .eq_ignore_ascii_case(directory.trim_end_matches(['\\', '/']))
}

pub fn register(directory: &Path, install: bool) -> io::Result<()> {
    let directory = directory
        .to_str()
        .filter(|entry| !entry.is_empty() && !entry.contains(';'))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid installation path"))?;
    if register_in(&RegKey::predef(HKEY_CURRENT_USER), directory, install)? {
        let setting: Vec<u16> = "Environment\0".encode_utf16().collect();
        // The setting name remains valid while Windows broadcasts the change.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                setting.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                500,
                std::ptr::null_mut(),
            );
        }
    }
    Ok(())
}

fn register_in(user: &RegKey, directory: &str, install: bool) -> io::Result<bool> {
    let (environment, _) = user.create_subkey("Environment")?;
    let (registration, _) = user.create_subkey(MARKER)?;
    let original = environment.get_raw_value("Path");
    let (path, kind) = match original {
        Ok(value) => (String::from_reg_value(&value)?, value.vtype),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (String::new(), REG_EXPAND_SZ),
        Err(error) => return Err(error),
    };
    let mut entries: Vec<_> = if path.is_empty() {
        Vec::new()
    } else {
        path.split(';').collect()
    };
    if install {
        if entries.iter().any(|entry| same_directory(entry, directory)) {
            return Ok(false);
        }
        entries.push(directory);
        registration.set_value("PathAdded", &directory)?;
    } else {
        let owned: Option<String> = registration.get_value("PathAdded").ok();
        if !owned
            .as_deref()
            .is_some_and(|entry| same_directory(entry, directory))
        {
            return Ok(false);
        }
        if let Some(index) = entries
            .iter()
            .position(|entry| same_directory(entry, directory))
        {
            entries.remove(index);
        }
    }

    let joined = entries.join(";");
    let mut value = joined.to_reg_value();
    value.vtype = kind;
    environment.set_raw_value("Path", &value)?;
    if !install {
        registration.delete_value("PathAdded")?;
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_registry_entries_with_windows_path_conventions() {
        assert!(same_directory(
            r#" "c:/Users/Test/Pigry/" "#,
            r"C:\Users\Test\Pigry"
        ));
        assert!(!same_directory(
            r"C:\Users\Test\Pigry2",
            r"C:\Users\Test\Pigry"
        ));
    }

    #[test]
    fn install_and_uninstall_preserve_the_existing_user_path() -> io::Result<()> {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let fixture = format!("Software\\PigryCliTest-{}", std::process::id());
        let (user, _) = root.create_subkey(&fixture)?;
        let (environment, _) = user.create_subkey("Environment")?;
        let run = || {
            let start = r"%USERPROFILE%\bin;C:\tools";
            let pigry = r"C:\Users\Test User\Pigry";
            let mut value = start.to_reg_value();
            value.vtype = REG_EXPAND_SZ;
            environment.set_raw_value("Path", &value)?;
            assert!(register_in(&user, pigry, true)?);
            assert!(!register_in(&user, pigry, true)?);
            let updated = environment.get_raw_value("Path")?;
            assert_eq!(updated.vtype, REG_EXPAND_SZ);
            assert_eq!(
                String::from_reg_value(&updated)?,
                format!("{start};{pigry}")
            );
            assert!(register_in(&user, pigry, false)?);
            assert_eq!(
                String::from_reg_value(&environment.get_raw_value("Path")?)?,
                start
            );
            assert!(!register_in(&user, r"C:\tools", true)?);
            assert!(!register_in(&user, r"C:\tools", false)?);
            assert_eq!(
                String::from_reg_value(&environment.get_raw_value("Path")?)?,
                start
            );
            Ok(())
        };
        let result = run();
        drop(environment);
        drop(user);
        root.delete_subkey_all(fixture)?;
        result
    }
}
