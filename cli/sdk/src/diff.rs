use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

pub struct ScreenshotDiff {
    pub total_pixels: u64,
    pub different_pixels: u64,
    pub mismatch_percentage: f64,
    pub matched: bool,
    pub diff_image: Option<Vec<u8>>,
    pub dimension_mismatch: Option<Value>,
}

pub fn snapshots(before: &str, after: &str) -> Value {
    if before == after {
        return json!({
            "diff": "",
            "additions": 0,
            "removals": 0,
            "unchanged": before.lines().count(),
            "changed": false,
        });
    }

    let text_diff = TextDiff::from_lines(before, after);
    let mut additions = 0_u64;
    let mut removals = 0_u64;
    let mut unchanged = 0_u64;
    for change in text_diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => removals += 1,
            ChangeTag::Equal => unchanged += 1,
        }
    }
    json!({
        "diff": text_diff.unified_diff().context_radius(3).header("before", "after").to_string(),
        "additions": additions,
        "removals": removals,
        "unchanged": unchanged,
        "changed": additions > 0 || removals > 0,
    })
}

pub fn screenshots(
    baseline: &[u8],
    current: &[u8],
    threshold: f64,
) -> Result<ScreenshotDiff, String> {
    let expected =
        image::load_from_memory(baseline).map_err(|e| format!("decode baseline image: {e}"))?;
    let actual =
        image::load_from_memory(current).map_err(|e| format!("decode current image: {e}"))?;
    let (expected_width, expected_height) = (expected.width(), expected.height());
    let (actual_width, actual_height) = (actual.width(), actual.height());
    if (expected_width, expected_height) != (actual_width, actual_height) {
        return Ok(ScreenshotDiff {
            total_pixels: u64::from(expected_width) * u64::from(expected_height),
            different_pixels: u64::from(expected_width) * u64::from(expected_height),
            mismatch_percentage: 100.0,
            matched: false,
            diff_image: None,
            dimension_mismatch: Some(json!({
                "expected": { "width": expected_width, "height": expected_height },
                "actual": { "width": actual_width, "height": actual_height },
            })),
        });
    }

    let expected = expected.to_rgba8();
    let actual = actual.to_rgba8();
    let total_pixels = u64::from(expected_width) * u64::from(expected_height);
    let maximum_distance = threshold * 255.0 * 3.0_f64.sqrt();
    let mut different_pixels = 0_u64;
    let mut diff_image = image::RgbaImage::new(expected_width, expected_height);
    for y in 0..expected_height {
        for x in 0..expected_width {
            let before = expected.get_pixel(x, y);
            let after = actual.get_pixel(x, y);
            let red = f64::from(before[0]) - f64::from(after[0]);
            let green = f64::from(before[1]) - f64::from(after[1]);
            let blue = f64::from(before[2]) - f64::from(after[2]);
            if (red * red + green * green + blue * blue).sqrt() > maximum_distance {
                different_pixels += 1;
                diff_image.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            } else {
                let gray = (u16::from(before[0]) + u16::from(before[1]) + u16::from(before[2])) / 3;
                let dimmed = (f64::from(gray) * 0.3) as u8;
                diff_image.put_pixel(x, y, image::Rgba([dimmed, dimmed, dimmed, 255]));
            }
        }
    }

    let mismatch_percentage = if total_pixels == 0 {
        0.0
    } else {
        different_pixels as f64 / total_pixels as f64 * 100.0
    };
    let encoded_diff = if different_pixels == 0 {
        None
    } else {
        let mut buffer = std::io::Cursor::new(Vec::new());
        diff_image
            .write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|e| format!("encode diff image: {e}"))?;
        Some(buffer.into_inner())
    };
    Ok(ScreenshotDiff {
        total_pixels,
        different_pixels,
        mismatch_percentage,
        matched: different_pixels == 0,
        diff_image: encoded_diff,
        dimension_mismatch: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(color: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(2, 1, image::Rgba(color));
        let mut buffer = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut buffer, image::ImageFormat::Png)
            .unwrap();
        buffer.into_inner()
    }

    #[test]
    fn snapshot_diff_reports_real_line_changes() {
        let result = snapshots("one\ntwo\n", "one\nthree\n");
        assert_eq!(result["changed"], true);
        assert_eq!(result["additions"], 1);
        assert_eq!(result["removals"], 1);
        assert!(result["diff"].as_str().unwrap().contains("three"));
    }

    #[test]
    fn screenshot_diff_compares_decoded_pixels() {
        let result = screenshots(&png([0, 0, 0, 255]), &png([255, 0, 0, 255]), 0.1).unwrap();
        assert_eq!(result.total_pixels, 2);
        assert_eq!(result.different_pixels, 2);
        assert!(!result.matched);
        assert!(result.diff_image.is_some());
    }
}
