use crate::native_command_guard::guard;
use serde::Serialize;
use std::io::Cursor;
use tauri::{ipc::InvokeBody, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DesktopClipboardError {
    pub code: String,
    pub message: String,
}

impl DesktopClipboardError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn invalid_png() -> DesktopClipboardError {
    DesktopClipboardError::new("invalid_png", "Image payload is not a valid PNG")
}

pub fn decode_validated_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), DesktopClipboardError> {
    if bytes.is_empty() {
        return Err(DesktopClipboardError::new(
            "invalid_png",
            "Image payload is empty",
        ));
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err(DesktopClipboardError::new(
            "image_too_large",
            "Image exceeds the desktop limit",
        ));
    }
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
    decoder.set_transformations(
        png::Transformations::EXPAND | png::Transformations::STRIP_16 | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info().map_err(|_| invalid_png())?;
    let output_size = reader.output_buffer_size().ok_or_else(invalid_png)?;
    if output_size > MAX_OUTPUT_BYTES {
        return Err(invalid_png());
    }
    let mut output = vec![0; output_size];
    let frame = reader.next_frame(&mut output).map_err(|_| invalid_png())?;
    reader.finish().map_err(|_| invalid_png())?;
    output.truncate(frame.buffer_size());

    let expected_rgba = (frame.width as usize)
        .checked_mul(frame.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|size| *size <= MAX_OUTPUT_BYTES)
        .ok_or_else(invalid_png)?;

    let rgba = match frame.color_type {
        png::ColorType::Rgba => {
            if output.len() != expected_rgba {
                return Err(invalid_png());
            }
            output
        }
        png::ColorType::GrayscaleAlpha => {
            if output.len() != expected_rgba / 2 {
                return Err(invalid_png());
            }
            let mut expanded = Vec::with_capacity(expected_rgba);
            for pixel in output.chunks_exact(2) {
                expanded.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
            expanded
        }
        _ => return Err(invalid_png()),
    };

    Ok((rgba, frame.width, frame.height))
}

#[tauri::command]
pub async fn desktop_clipboard_write_image(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), DesktopClipboardError> {
    guard(&window).map_err(|code| DesktopClipboardError::new(code, "Caller is not trusted"))?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(DesktopClipboardError::new(
                "invalid_png",
                "Image payload must use binary IPC",
            ));
        }
    };
    if bytes.is_empty() {
        return Err(DesktopClipboardError::new(
            "invalid_png",
            "Image payload is empty",
        ));
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err(DesktopClipboardError::new(
            "image_too_large",
            "Image exceeds the desktop limit",
        ));
    }

    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (rgba, width, height) = decode_validated_png(&bytes)?;
        let image = tauri::image::Image::new_owned(rgba, width, height);
        app.clipboard().write_image(&image).map_err(|_| {
            DesktopClipboardError::new("write_failed", "Could not write image to clipboard")
        })
    })
    .await
    .map_err(|_| DesktopClipboardError::new("write_failed", "Clipboard task failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_png(
        width: u32,
        height: u32,
        color: png::ColorType,
        depth: png::BitDepth,
        data: &[u8],
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(color);
            encoder.set_depth(depth);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(data).unwrap();
        }
        bytes
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

    #[test]
    fn decodes_rgba_rgb_and_grayscale_pngs_into_rgba8_and_accepts_size_limit() {
        let rgba_png = encode_png(
            1,
            1,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &[10, 20, 30, 40],
        );
        assert_eq!(
            decode_validated_png(&rgba_png).unwrap(),
            (vec![10, 20, 30, 40], 1, 1)
        );

        let rgb_png = encode_png(1, 1, png::ColorType::Rgb, png::BitDepth::Eight, &[1, 2, 3]);
        assert_eq!(
            decode_validated_png(&rgb_png).unwrap(),
            (vec![1, 2, 3, 255], 1, 1)
        );

        let gray_png = encode_png(1, 1, png::ColorType::Grayscale, png::BitDepth::Eight, &[77]);
        assert_eq!(
            decode_validated_png(&gray_png).unwrap(),
            (vec![77, 77, 77, 255], 1, 1)
        );

        let filler = MAX_PNG_BYTES - rgba_png.len() - 12;
        let exact = insert_chunk(rgba_png, b"ruSt", &vec![0; filler]);
        assert_eq!(exact.len(), MAX_PNG_BYTES);
        assert!(decode_validated_png(&exact).is_ok());
    }

    #[test]
    fn rejects_empty_oversize_non_png_animated_trailing_and_dimension_bombs() {
        assert_eq!(decode_validated_png(&[]).unwrap_err().code, "invalid_png");
        assert_eq!(
            decode_validated_png(&vec![0; MAX_PNG_BYTES + 1])
                .unwrap_err()
                .code,
            "image_too_large"
        );
        assert_eq!(
            decode_validated_png(b"not-a-png").unwrap_err().code,
            "invalid_png"
        );

        let valid = encode_png(
            1,
            1,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &[0, 0, 0, 255],
        );
        let bad_crc = {
            let mut bytes = valid.clone();
            bytes[29] ^= 1;
            bytes
        };
        let animated = insert_chunk(valid.clone(), b"acTL", &[0; 8]);
        let extreme_width = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[..4].copy_from_slice(&16_385u32.to_be_bytes());
        });
        let excessive_pixels = rewrite_ihdr(valid.clone(), |ihdr| {
            ihdr[..4].copy_from_slice(&4_097u32.to_be_bytes());
            ihdr[4..8].copy_from_slice(&4_097u32.to_be_bytes());
        });
        let mut trailing = valid;
        trailing.push(0);

        for candidate in [bad_crc, animated, extreme_width, excessive_pixels, trailing] {
            assert_eq!(
                decode_validated_png(&candidate).unwrap_err().code,
                "invalid_png"
            );
        }
    }
}
