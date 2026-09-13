use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub trait JournalIo {
    fn remove(&self, path: &Path) -> io::Result<()>;
    fn write_record(&self, file: &mut File, bytes: &[u8]) -> io::Result<()>;
}
pub struct Disk;
impl JournalIo for Disk {
    fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
    fn write_record(&self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()
    }
}
fn remove_if_present(io: &impl JournalIo, path: &Path) -> Result<(), String> {
    match io.remove(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Save cleanup failed".into()),
    }
}
fn record(root: &Path) -> PathBuf {
    root.join("desktop-export.json")
}
fn pending(root: &Path) -> PathBuf {
    root.join("desktop-export.json.pending")
}

pub fn repair(root: &Path, io: &impl JournalIo) -> Result<(), String> {
    let journal = record(root);
    match fs::read(&journal) {
        Ok(bytes) => {
            let partial: PathBuf =
                serde_json::from_slice(&bytes).map_err(|_| "Save cleanup failed")?;
            let name = partial
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Save cleanup failed")?;
            if !partial.is_absolute()
                || !name.starts_with(".alook-")
                || !name.ends_with(".partial")
                || name.len() != 51
            {
                return Err("Save cleanup failed".into());
            }
            remove_if_present(io, &partial)?;
            remove_if_present(io, &journal)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("Save cleanup failed".into()),
    }
    remove_if_present(io, &pending(root))
}

pub fn prepare(root: &Path, partial: &Path, io: &impl JournalIo) -> Result<(), String> {
    let journal = record(root);
    if journal
        .try_exists()
        .map_err(|_| "Save journal unavailable")?
    {
        return Err("Save cleanup required".into());
    }
    let pending = pending(root);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&pending)
        .map_err(|_| "Save journal unavailable")?;
    let result = (|| {
        let bytes = serde_json::to_vec(partial).map_err(|_| "Save journal failed")?;
        io.write_record(&mut file, &bytes)
            .map_err(|_| "Save journal failed")?;
        fs::hard_link(&pending, &journal).map_err(|_| "Save journal publish failed")?;
        Ok(())
    })();
    drop(file);
    let _ = remove_if_present(io, &pending);
    result
}

pub fn finish(
    root: &Path,
    partial: &Path,
    created: bool,
    io: &impl JournalIo,
) -> Result<(), String> {
    if created {
        remove_if_present(io, partial)?;
    }
    remove_if_present(io, &record(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Faults {
        blocked: Mutex<Option<PathBuf>>,
        fail_write: bool,
    }
    impl JournalIo for Faults {
        fn remove(&self, path: &Path) -> io::Result<()> {
            if self.blocked.lock().unwrap().as_deref() == Some(path) {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
            } else {
                fs::remove_file(path)
            }
        }
        fn write_record(&self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
            if self.fail_write {
                file.write_all(b"{")?;
                Err(io::Error::other("injected sync failure"))
            } else {
                Disk.write_record(file, bytes)
            }
        }
    }
    fn root() -> PathBuf {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).unwrap();
        let p = std::env::temp_dir().join(format!("alook-journal-{:x?}", bytes));
        fs::create_dir_all(&p).unwrap();
        p
    }
    const A: &str = ".alook-00000000-0000-4000-8000-000000000001.partial";
    const B: &str = ".alook-00000000-0000-4000-8000-000000000002.partial";
    #[test]
    fn failed_cleanup_blocks_overwrite_then_restart_recovers() {
        let root = root();
        let a = root.join(A);
        let b = root.join(B);
        let target = root.join("complete-b");
        fs::write(&a, b"partial-a").unwrap();
        fs::write(&target, b"old").unwrap();
        prepare(&root, &a, &Disk).unwrap();
        let original = fs::read(record(&root)).unwrap();
        let fault = Faults {
            blocked: Mutex::new(Some(a.clone())),
            fail_write: false,
        };
        assert!(finish(&root, &a, true, &fault).is_err());
        assert!(repair(&root, &fault).is_err());
        assert!(prepare(&root, &b, &Disk).is_err());
        assert_eq!(fs::read(record(&root)).unwrap(), original);
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert!(!b.exists());
        repair(&root, &Disk).unwrap();
        assert!(!a.exists());
        prepare(&root, &b, &Disk).unwrap();
        fs::write(&b, b"complete-b").unwrap();
        fs::rename(&b, &target).unwrap();
        finish(&root, &b, true, &Disk).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"complete-b");
        assert!(!record(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incomplete_record_never_becomes_a_cleanup_obligation() {
        let root = root();
        let partial = root.join(A);
        let fault = Faults {
            blocked: Mutex::new(None),
            fail_write: true,
        };
        assert!(prepare(&root, &partial, &fault).is_err());
        assert!(!partial.exists());
        assert!(!record(&root).exists());
        repair(&root, &Disk).unwrap();
        prepare(&root, &partial, &Disk).unwrap();
        repair(&root, &Disk).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn record_removal_failure_after_publish_never_removes_target() {
        let root = root();
        let partial = root.join(A);
        let target = root.join("saved");
        prepare(&root, &partial, &Disk).unwrap();
        fs::write(&partial, b"exact").unwrap();
        fs::rename(&partial, &target).unwrap();
        let fault = Faults {
            blocked: Mutex::new(Some(record(&root))),
            fail_write: false,
        };
        assert!(finish(&root, &partial, true, &fault).is_err());
        assert!(repair(&root, &fault).is_err());
        repair(&root, &Disk).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"exact");
        fs::remove_dir_all(root).unwrap();
    }
}
