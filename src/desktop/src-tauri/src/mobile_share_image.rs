use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use unicode_normalization::UnicodeNormalization;

pub const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileShareImagePayload {
    pub attempt_id: String,
    pub png_base64: String,
    pub filename: Option<String>,
}

#[derive(Debug)]
pub struct ValidatedMobileShareImage {
    pub attempt_id: String,
    pub png_base64: String,
    pub filename: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileShareImageResult {
    pub attempt_id: String,
    pub status: String,
    pub destination: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MobileShareImageError {
    pub code: String,
    pub message: String,
}

impl MobileShareImageError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Default)]
pub struct MobileShareImageState {
    busy: AtomicBool,
}

#[derive(Debug)]
pub struct MobileShareImageLease<'a>(&'a AtomicBool);

impl MobileShareImageState {
    pub fn acquire(&self) -> Result<MobileShareImageLease<'_>, MobileShareImageError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| MobileShareImageError::new("busy", "Another image action is active"))?;
        Ok(MobileShareImageLease(&self.busy))
    }
}

impl Drop for MobileShareImageLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub fn validate_payload(
    payload: MobileShareImagePayload,
) -> Result<ValidatedMobileShareImage, MobileShareImageError> {
    if !valid_attempt_id(&payload.attempt_id) {
        return Err(MobileShareImageError::new(
            "invalid_png",
            "Invalid attempt identifier",
        ));
    }
    let max_encoded = MAX_PNG_BYTES.div_ceil(3) * 4;
    if payload.png_base64.is_empty() || payload.png_base64.len() % 4 != 0 {
        return Err(MobileShareImageError::new(
            "invalid_png",
            "Image payload is not valid base64",
        ));
    }
    if payload.png_base64.len() > max_encoded {
        return Err(MobileShareImageError::new(
            "image_too_large",
            "Image exceeds the mobile limit",
        ));
    }
    let bytes = STANDARD
        .decode(payload.png_base64.as_bytes())
        .map_err(|_| {
            MobileShareImageError::new("invalid_png", "Image payload is not valid base64")
        })?;
    if bytes.is_empty() {
        return Err(MobileShareImageError::new(
            "invalid_png",
            "Image payload is empty",
        ));
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err(MobileShareImageError::new(
            "image_too_large",
            "Image exceeds the mobile limit",
        ));
    }
    validate_png(&bytes)?;
    Ok(ValidatedMobileShareImage {
        attempt_id: payload.attempt_id,
        png_base64: payload.png_base64,
        filename: sanitize_filename(payload.filename.as_deref().unwrap_or_default()),
    })
}

fn valid_attempt_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn validate_png(bytes: &[u8]) -> Result<(), MobileShareImageError> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.get(..8) != Some(SIGNATURE) {
        return Err(invalid_png());
    }
    let mut offset = 8usize;
    let mut ihdr = false;
    let mut idat = false;
    let mut iend = false;
    while offset < bytes.len() {
        let header_end = offset.checked_add(8).ok_or_else(invalid_png)?;
        let header = bytes.get(offset..header_end).ok_or_else(invalid_png)?;
        let length =
            u32::from_be_bytes(header[..4].try_into().map_err(|_| invalid_png())?) as usize;
        let chunk_type: [u8; 4] = header[4..8].try_into().map_err(|_| invalid_png())?;
        let data_end = header_end.checked_add(length).ok_or_else(invalid_png)?;
        let chunk_end = data_end.checked_add(4).ok_or_else(invalid_png)?;
        let data = bytes.get(header_end..data_end).ok_or_else(invalid_png)?;
        if chunk_end > bytes.len() || iend {
            return Err(invalid_png());
        }
        match &chunk_type {
            b"IHDR" => {
                if ihdr || offset != 8 || length != 13 {
                    return Err(invalid_png());
                }
                ihdr = true;
                let width = u32::from_be_bytes(data[..4].try_into().map_err(|_| invalid_png())?);
                let height = u32::from_be_bytes(data[4..8].try_into().map_err(|_| invalid_png())?);
                let pixels = u64::from(width)
                    .checked_mul(u64::from(height))
                    .ok_or_else(invalid_png)?;
                if width == 0
                    || height == 0
                    || width > MAX_DIMENSION
                    || height > MAX_DIMENSION
                    || pixels > MAX_PIXELS
                {
                    return Err(invalid_png());
                }
                let bit_depth = data[8];
                let color_type = data[9];
                let legal = matches!(
                    (color_type, bit_depth),
                    (0, 1 | 2 | 4 | 8 | 16)
                        | (2, 8 | 16)
                        | (3, 1 | 2 | 4 | 8)
                        | (4, 8 | 16)
                        | (6, 8 | 16)
                );
                if !legal || data[10] != 0 || data[11] != 0 || data[12] > 1 {
                    return Err(invalid_png());
                }
            }
            b"IDAT" => {
                if !ihdr || iend {
                    return Err(invalid_png());
                }
                idat = true;
            }
            b"IEND" => {
                if !ihdr || !idat || length != 0 {
                    return Err(invalid_png());
                }
                iend = true;
                if chunk_end != bytes.len() {
                    return Err(invalid_png());
                }
            }
            b"acTL" | b"fcTL" | b"fdAT" => return Err(invalid_png()),
            _ => {}
        }
        offset = chunk_end;
    }
    if !iend {
        return Err(invalid_png());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.ignore_checksums(false);
    decoder.set_limits(png::Limits {
        bytes: 80 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| invalid_png())?;
    let output_size = reader.output_buffer_size().ok_or_else(invalid_png)?;
    if output_size > MAX_OUTPUT_BYTES {
        return Err(invalid_png());
    }
    let mut output = vec![0; output_size];
    reader.next_frame(&mut output).map_err(|_| invalid_png())?;
    reader.finish().map_err(|_| invalid_png())?;
    Ok(())
}

fn invalid_png() -> MobileShareImageError {
    MobileShareImageError::new("invalid_png", "Image payload is not a valid PNG")
}

pub fn sanitize_filename(value: &str) -> String {
    let normalized: String = value.nfc().collect();
    let basename = normalized
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim_start_matches(|character: char| character == '.' || character.is_whitespace());
    let mut stem = basename
        .chars()
        .filter(|character| !character.is_control() && *character != '/' && *character != '\\')
        .collect::<String>();
    while stem.to_ascii_lowercase().ends_with(".png") {
        stem.truncate(stem.len() - 4);
    }
    stem = stem.trim().to_string();
    if stem.is_empty() {
        stem = "alook-message-share".to_string();
    }
    while format!("{stem}.png").len() > 180 {
        stem.pop();
    }
    if stem.is_empty() {
        "alook-message-share.png".to_string()
    } else {
        format!("{stem}.png")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTEMPT_ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    fn encode_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&vec![0; width as usize * height as usize * 4])
                .unwrap();
        }
        bytes
    }

    fn payload(bytes: Vec<u8>, filename: Option<&str>) -> MobileShareImagePayload {
        MobileShareImagePayload {
            attempt_id: ATTEMPT_ID.to_string(),
            png_base64: STANDARD.encode(bytes),
            filename: filename.map(str::to_string),
        }
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    0xedb8_8320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
        }
        crc ^ u32::MAX
    }

    fn rewrite_ihdr(mut bytes: Vec<u8>, change: impl FnOnce(&mut [u8])) -> Vec<u8> {
        change(&mut bytes[16..29]);
        let checksum = crc32(&bytes[12..29]).to_be_bytes();
        bytes[29..33].copy_from_slice(&checksum);
        bytes
    }

    fn insert_chunk(mut bytes: Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let iend = bytes.len() - 12;
        let mut chunk = Vec::with_capacity(data.len() + 12);
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(chunk_type);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&crc32(&chunk[4..]).to_be_bytes());
        bytes.splice(iend..iend, chunk);
        bytes
    }

    fn error_code(payload: MobileShareImagePayload) -> String {
        validate_payload(payload).unwrap_err().code
    }

    #[test]
    fn lease_is_app_wide_and_released() {
        let state = MobileShareImageState::default();
        let first = state.acquire().unwrap();
        assert_eq!(state.acquire().unwrap_err().code, "busy");
        drop(first);
        assert!(state.acquire().is_ok());
    }

    #[test]
    fn filename_is_normalized_and_bounded_by_utf8_bytes() {
        assert_eq!(
            sanitize_filename(" ../a/b/..re\u{301}sume\u{301}.PNG.png"),
            "résumé.png"
        );
        assert_eq!(sanitize_filename("bad\0/name.png"), "name.png");
        assert_eq!(sanitize_filename("..."), "alook-message-share.png");
        let value = format!("{}。png", "界".repeat(100));
        let filename = sanitize_filename(&value);
        assert!(filename.len() <= 180);
        assert!(filename.ends_with(".png"));
        assert_eq!(sanitize_filename(&"a".repeat(175)).len(), 179);
        assert_eq!(sanitize_filename(&"a".repeat(176)).len(), 180);
        assert_eq!(sanitize_filename(&"a".repeat(177)).len(), 180);
    }

    #[test]
    fn attempt_id_must_be_a_canonical_v4_uuid() {
        assert!(valid_attempt_id(ATTEMPT_ID));
        for value in [
            "123e4567-e89b-12d3-a456-426614174000",
            "123E4567-E89B-42D3-A456-426614174000",
            "123e4567-e89b-42d3-c456-426614174000",
            "bad\nlog",
        ] {
            assert!(!valid_attempt_id(value));
        }
    }

    #[test]
    fn accepts_a_complete_png_and_exact_transport_limit() {
        let valid = encode_png(1, 1);
        assert!(validate_payload(payload(valid.clone(), Some("card.png"))).is_ok());

        let filler = MAX_PNG_BYTES - valid.len() - 12;
        let exact = insert_chunk(valid, b"ruSt", &vec![0; filler]);
        assert_eq!(exact.len(), MAX_PNG_BYTES);
        assert!(validate_payload(payload(exact, None)).is_ok());
    }

    #[test]
    fn validated_payload_retains_every_native_dispatch_field() {
        let encoded = STANDARD.encode(encode_png(1, 1));
        let validated = validate_payload(MobileShareImagePayload {
            attempt_id: ATTEMPT_ID.to_string(),
            png_base64: encoded.clone(),
            filename: Some("card".to_string()),
        })
        .unwrap();

        assert_eq!(validated.attempt_id, ATTEMPT_ID);
        assert_eq!(validated.png_base64, encoded);
        assert_eq!(validated.filename, "card.png");
    }

    #[test]
    fn native_result_retains_every_response_field() {
        let result = MobileShareImageResult {
            attempt_id: ATTEMPT_ID.to_string(),
            status: "saved".to_string(),
            destination: "photos".to_string(),
        };

        assert_eq!(result.attempt_id, ATTEMPT_ID);
        assert_eq!(result.status, "saved");
        assert_eq!(result.destination, "photos");
    }

    #[test]
    fn rejects_oversize_invalid_and_noncanonical_base64_before_native_dispatch() {
        let oversized = STANDARD.encode(vec![0; MAX_PNG_BYTES + 1]);
        assert_eq!(
            error_code(MobileShareImagePayload {
                attempt_id: ATTEMPT_ID.to_string(),
                png_base64: oversized,
                filename: None,
            }),
            "image_too_large"
        );
        for invalid in ["", "AA", "A===", "****", "aGVsbG8="] {
            assert_eq!(
                error_code(MobileShareImagePayload {
                    attempt_id: ATTEMPT_ID.to_string(),
                    png_base64: invalid.to_string(),
                    filename: None,
                }),
                "invalid_png"
            );
        }
    }

    #[test]
    fn rejects_malformed_png_structure_and_bounds() {
        let valid = encode_png(1, 1);
        let invalid_header_length = {
            let mut bytes = valid.clone();
            bytes[11] = 12;
            bytes
        };
        let zero_width = rewrite_ihdr(valid.clone(), |ihdr| ihdr[..4].fill(0));
        let extreme_width = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[..4].copy_from_slice(&16_385u32.to_be_bytes())
        });
        let excessive_pixels = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[..4].copy_from_slice(&4_097u32.to_be_bytes());
            ihdr[4..8].copy_from_slice(&4_097u32.to_be_bytes());
        });
        let invalid_color_depth = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[8] = 1;
            ihdr[9] = 6;
        });
        let invalid_interlace = rewrite_ihdr(valid.clone(), |ihdr| ihdr[12] = 2);
        let oversized_output = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[..4].copy_from_slice(&4_096u32.to_be_bytes());
            ihdr[4..8].copy_from_slice(&4_096u32.to_be_bytes());
            ihdr[8] = 16;
            ihdr[9] = 6;
        });
        for bytes in [
            invalid_header_length,
            zero_width,
            extreme_width,
            excessive_pixels,
            invalid_color_depth,
            invalid_interlace,
            oversized_output,
        ] {
            assert_eq!(error_code(payload(bytes, None)), "invalid_png");
        }
    }

    #[test]
    fn rejects_corruption_animation_truncation_duplicate_end_and_trailing_data() {
        let valid = encode_png(1, 1);
        let mut bad_crc = valid.clone();
        bad_crc[29] ^= 1;

        let mut bad_adler = valid.clone();
        let idat = bad_adler
            .windows(4)
            .position(|window| window == b"IDAT")
            .unwrap();
        let idat_length =
            u32::from_be_bytes(bad_adler[idat - 4..idat].try_into().unwrap()) as usize;
        bad_adler[idat + 4 + idat_length - 1] ^= 1;
        let idat_crc = crc32(&bad_adler[idat..idat + 4 + idat_length]).to_be_bytes();
        bad_adler[idat + 4 + idat_length..idat + 8 + idat_length].copy_from_slice(&idat_crc);

        let animated = insert_chunk(valid.clone(), b"acTL", &[0; 8]);
        let truncated = valid[..valid.len() - 1].to_vec();
        let missing_end = valid[..valid.len() - 12].to_vec();
        let duplicate_end = insert_chunk(valid.clone(), b"IEND", &[]);
        let mut trailing = valid;
        trailing.push(0);
        for bytes in [
            bad_crc,
            bad_adler,
            animated,
            truncated,
            missing_end,
            duplicate_end,
            trailing,
        ] {
            assert_eq!(error_code(payload(bytes, None)), "invalid_png");
        }
    }
}
