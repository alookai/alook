use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(crate) const BOOTSTRAP_FILE: &str = "bootstrap.html";
const MAX_BOOTSTRAP_BYTES: usize = 262_144;

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid startup asset directory",
    )
}

fn verify(directory: &Path, body: &[u8]) -> io::Result<()> {
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    let entries = fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    if entries.len() != 1 || entries[0].file_name() != BOOTSTRAP_FILE {
        return Err(invalid());
    }
    let path = entries[0].path();
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != body.len() as u64
        || fs::read(path)? != body
    {
        return Err(invalid());
    }
    Ok(())
}

fn remove_temporary(directory: &Path) {
    let file = directory.join(BOOTSTRAP_FILE);
    #[cfg(windows)]
    if let Ok(metadata) = fs::metadata(&file) {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&file, permissions);
    }
    let _ = fs::remove_file(file);
    let _ = fs::remove_dir(directory);
}

pub(crate) fn prepare(root: &Path, body: &[u8]) -> io::Result<PathBuf> {
    if body.is_empty() || body.len() > MAX_BOOTSTRAP_BYTES {
        return Err(invalid());
    }
    fs::create_dir_all(root)?;
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    let hash = format!("{:x}", Sha256::digest(body));
    let destination = root.join(&hash);
    if fs::symlink_metadata(&destination).is_ok() {
        verify(&destination, body)?;
        return Ok(destination);
    }
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = root.join(format!(".{hash}-{}-{nonce}", std::process::id()));
    fs::create_dir(&temporary)?;
    let result = (|| {
        let path = temporary.join(BOOTSTRAP_FILE);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(body)?;
        file.flush()?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(true);
        file.set_permissions(permissions)?;
        drop(file);
        verify(&temporary, body)?;
        match fs::rename(&temporary, &destination) {
            Ok(()) => Ok(destination.clone()),
            Err(_) if fs::symlink_metadata(&destination).is_ok() => {
                verify(&destination, body)?;
                Ok(destination.clone())
            }
            Err(error) => Err(error),
        }
    })();
    remove_temporary(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temporary(PathBuf);

    impl Temporary {
        fn new() -> Self {
            let mut nonce = [0u8; 12];
            getrandom::fill(&mut nonce).unwrap();
            let nonce = nonce
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let path = std::env::temp_dir().join(format!("alook-startup-assets-{nonce}"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temporary {
        fn drop(&mut self) {
            #[cfg(windows)]
            for item in fs::read_dir(&self.0).unwrap().flatten() {
                let path = item.path().join(BOOTSTRAP_FILE);
                if let Ok(metadata) = fs::metadata(&path) {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(path, permissions);
                }
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn publishes_only_complete_matching_readonly_bootstrap_bytes() {
        let temporary = Temporary::new();
        let body = b"<!doctype html><title>Alook startup</title>";
        let published = prepare(&temporary.0, body).unwrap();
        assert_eq!(fs::read(published.join(BOOTSTRAP_FILE)).unwrap(), body);
        assert!(fs::metadata(published.join(BOOTSTRAP_FILE))
            .unwrap()
            .permissions()
            .readonly());
        assert_eq!(prepare(&temporary.0, body).unwrap(), published);
        assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 1);
    }

    #[test]
    fn modified_or_extra_files_fail_without_deleting_existing_data() {
        for extra in [false, true] {
            let temporary = Temporary::new();
            let body = b"public bootstrap";
            let published = prepare(&temporary.0, body).unwrap();
            if extra {
                fs::write(published.join("unrelated"), b"retain").unwrap();
            } else {
                #[cfg(windows)]
                {
                    let path = published.join(BOOTSTRAP_FILE);
                    let mut permissions = fs::metadata(&path).unwrap().permissions();
                    permissions.set_readonly(false);
                    fs::set_permissions(path, permissions).unwrap();
                }
                fs::remove_file(published.join(BOOTSTRAP_FILE)).unwrap();
                fs::write(published.join(BOOTSTRAP_FILE), b"changed").unwrap();
            }
            assert!(prepare(&temporary.0, body).is_err());
            assert!(published.exists());
            if extra {
                assert_eq!(fs::read(published.join("unrelated")).unwrap(), b"retain");
            }
        }
    }

    #[test]
    fn concurrent_publishers_converge_without_a_partial_directory() {
        let temporary = Temporary::new();
        let root = temporary.0.clone();
        let thread_root = root.clone();
        let other =
            std::thread::spawn(move || prepare(&thread_root, b"same complete document").unwrap());
        let this = prepare(&root, b"same complete document").unwrap();
        assert_eq!(this, other.join().unwrap());
        verify(&this, b"same complete document").unwrap();
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_roots_and_payloads_are_not_mapped() {
        let temporary = Temporary::new();
        let real = temporary.0.join("real");
        fs::create_dir(&real).unwrap();
        let linked = temporary.0.join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        assert!(prepare(&linked, b"public").is_err());
        let published = prepare(&real, b"public").unwrap();
        let target = temporary.0.join("target");
        fs::write(&target, b"public").unwrap();
        fs::remove_file(published.join(BOOTSTRAP_FILE)).unwrap();
        std::os::unix::fs::symlink(&target, published.join(BOOTSTRAP_FILE)).unwrap();
        assert!(prepare(&real, b"public").is_err());
        assert_eq!(fs::read(target).unwrap(), b"public");
    }
}
