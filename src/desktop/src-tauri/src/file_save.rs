use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use unicode_normalization::UnicodeNormalization;

pub const CHUNK_BYTES: usize = 65_536;
const MAX_BYTES: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Begin {
    pub attempt_id: String,
    pub name: String,
    pub mime: String,
    pub size: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    pub attempt_id: String,
    pub sequence: u64,
    pub offset: u64,
    pub data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub attempt_id: String,
    pub bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub attempt_id: String,
    pub bytes: u64,
    pub sequence: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub attempt_id: String,
    pub status: &'static str,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub destination: String,
}

pub fn safe_name(value: &str) -> String {
    let base = value.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .nfc()
        .filter(|c| !c.is_control())
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    name = name
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_owned();
    if name.is_empty() {
        name = "download".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    while name.len() > 180 {
        name.pop();
    }
    name.trim_end_matches(|c: char| c == '.' || c.is_whitespace())
        .to_owned()
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn valid_mime(mime: &str) -> bool {
    mime.len() <= 127
        && mime.split('/').count() == 2
        && mime.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
        })
}

pub struct Transfer {
    pub metadata: Begin,
    pub path: PathBuf,
    file: Option<File>,
    pub bytes: u64,
    sequence: u64,
    hash: Sha256,
    pub cancelled: Arc<AtomicBool>,
    pub publish_guard: Arc<Mutex<()>>,
    sealed: bool,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}
impl Transfer {
    pub fn begin(root: &Path, metadata: Begin) -> Result<Self, String> {
        if !valid_id(&metadata.attempt_id)
            || safe_name(&metadata.name) != metadata.name
            || !valid_mime(&metadata.mime)
            || metadata.size.is_some_and(|n| n > MAX_BYTES)
        {
            return Err("Invalid file metadata".into());
        }
        fs::create_dir_all(root).map_err(|_| "Save storage unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Save storage unavailable")?;
        }
        let path = root.join(format!("{}.partial", metadata.attempt_id));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|_| "Save storage unavailable")?;
        Ok(Self {
            metadata,
            path,
            file: Some(file),
            bytes: 0,
            sequence: 0,
            hash: Sha256::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            publish_guard: Arc::new(Mutex::new(())),
            sealed: false,
        })
    }
    pub fn ack(&self) -> Ack {
        Ack {
            attempt_id: self.metadata.attempt_id.clone(),
            bytes: self.bytes,
            sequence: self.sequence,
        }
    }
    pub fn write(&mut self, chunk: Chunk) -> Result<Ack, String> {
        if self.cancelled.load(Ordering::Acquire)
            || self.sealed
            || chunk.attempt_id != self.metadata.attempt_id
            || chunk.sequence != self.sequence
            || chunk.offset != self.bytes
            || chunk.data.len() > CHUNK_BYTES.div_ceil(3) * 4
        {
            return Err("Invalid save chunk".into());
        }
        let data = STANDARD
            .decode(chunk.data)
            .map_err(|_| "Invalid save chunk")?;
        if data.is_empty() || data.len() > CHUNK_BYTES {
            return Err("Invalid save chunk".into());
        }
        let next = self
            .bytes
            .checked_add(data.len() as u64)
            .filter(|n| *n <= MAX_BYTES)
            .ok_or("File too large")?;
        if self.metadata.size.is_some_and(|size| next > size) {
            return Err("File length mismatch".into());
        }
        self.file
            .as_mut()
            .ok_or("Save already closed")?
            .write_all(&data)
            .map_err(|_| "File write failed")?;
        self.hash.update(&data);
        self.bytes = next;
        self.sequence += 1;
        Ok(self.ack())
    }
    pub fn seal(&mut self, commit: Commit) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire)
            || self.sealed
            || commit.attempt_id != self.metadata.attempt_id
            || commit.bytes != self.bytes
            || self.metadata.size.is_some_and(|size| size != self.bytes)
        {
            return Err("File length mismatch".into());
        }
        self.file
            .take()
            .ok_or("Save already closed")?
            .sync_all()
            .map_err(|_| "File write failed")?;
        self.sealed = true;
        Ok(())
    }
    pub fn receipt(&self, destination: Option<String>) -> Receipt {
        Receipt {
            attempt_id: self.metadata.attempt_id.clone(),
            status: if destination.is_some() {
                "saved"
            } else {
                "cancelled"
            },
            name: self.metadata.name.clone(),
            mime: self.metadata.mime.clone(),
            bytes: self.bytes,
            sha256: format!("{:x}", self.hash.clone().finalize()),
            destination: destination.unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn transfer(size: Option<u64>) -> Transfer {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("alook-save-test-{:x?}", random));
        Transfer::begin(
            &root,
            Begin {
                attempt_id: "00000000-0000-0000-0000-000000000001".into(),
                name: "file.bin".into(),
                mime: "application/octet-stream".into(),
                size,
            },
        )
        .unwrap()
    }
    fn chunk(t: &Transfer, bytes: &[u8]) -> Chunk {
        Chunk {
            attempt_id: t.metadata.attempt_id.clone(),
            sequence: t.sequence,
            offset: t.bytes,
            data: STANDARD.encode(bytes),
        }
    }
    #[test]
    fn bounded_stream_has_exact_hash_and_cleanup() {
        let mut t = transfer(Some(3));
        let path = t.path.clone();
        let root = path.parent().unwrap().to_owned();
        let c = chunk(&t, b"abc");
        assert_eq!(t.write(c).unwrap().bytes, 3);
        t.seal(Commit {
            attempt_id: t.metadata.attempt_id.clone(),
            bytes: 3,
        })
        .unwrap();
        assert_eq!(
            t.receipt(Some("desktop".into())).sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(fs::read(&path).unwrap(), b"abc");
        drop(t);
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn rejects_replay_offset_oversize_and_incomplete_commit() {
        let mut t = transfer(Some(4));
        let mut c = chunk(&t, b"a");
        c.offset = 1;
        assert!(t.write(c).is_err());
        let c = chunk(&t, &vec![0; CHUNK_BYTES + 1]);
        assert!(t.write(c).is_err());
        let c = chunk(&t, b"a");
        t.write(c).unwrap();
        assert!(t
            .seal(Commit {
                attempt_id: t.metadata.attempt_id.clone(),
                bytes: 1
            })
            .is_err());
        let mut c = chunk(&t, b"a");
        c.sequence = 0;
        assert!(t.write(c).is_err());
        t.cancelled.store(true, Ordering::Release);
        let c = chunk(&t, b"a");
        assert!(t.write(c).is_err());
        let root = t.path.parent().unwrap().to_owned();
        drop(t);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn empty_file_and_names() {
        assert_eq!(safe_name("../CON.txt"), "_CON.txt");
        assert_eq!(safe_name("x\\a\0:b?.txt  "), "a_b_.txt");
        assert_eq!(safe_name("..."), "download");
        assert!(safe_name(&"中".repeat(100)).len() <= 180);
        let mut t = transfer(Some(0));
        t.seal(Commit {
            attempt_id: t.metadata.attempt_id.clone(),
            bytes: 0,
        })
        .unwrap();
        assert_eq!(t.receipt(None).status, "cancelled");
        let root = t.path.parent().unwrap().to_owned();
        drop(t);
        fs::remove_dir(root).unwrap();
    }
}
