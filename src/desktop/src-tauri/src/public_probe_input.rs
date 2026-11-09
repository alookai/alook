use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub(crate) const SHA256: &str = "0978980b77a02f90345dcebbb4b62a72dcf267f3b4d00a3dcc9b9a3e519888a9";
pub(crate) const FILE: &str = "qa61-public-shell.html";
const BYTES: u64 = 56_237;

pub(crate) fn read(path: &Path) -> Result<Vec<u8>, &'static str> {
    read_verified(path, SHA256, BYTES)
}

fn read_verified(
    path: &Path,
    expected_hash: &str,
    expected_bytes: u64,
) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "missing_public_fixture")?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != expected_bytes
    {
        return Err("invalid_public_fixture_size_or_type");
    }
    let body = fs::read(path).map_err(|_| "public_fixture_read")?;
    if body.len() as u64 != expected_bytes
        || format!("{:x}", Sha256::digest(&body)) != expected_hash
    {
        return Err("public_fixture_hash");
    }
    let text = std::str::from_utf8(&body).map_err(|_| "public_fixture_encoding")?;
    if !text.contains("data-community-shell=\"public\"") {
        return Err("public_fixture_marker");
    }
    Ok(body)
}
