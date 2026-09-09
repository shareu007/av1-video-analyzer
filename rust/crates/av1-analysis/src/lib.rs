#![forbid(unsafe_code)]

use av1_ivf::{IvfContainer, IvfFrame, ParseError as IvfParseError, parse_ivf};
use av1_model::{Diagnostic, ObuRecord, Severity};
use av1_structural::{
    ParseError as ObuParseError, ParseOptions as ObuParseOptions,
    parse_obu_sequence,
};
use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputFormat {
    Ivf,
    LowOverheadObu,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnalysisOptions {
    pub maximum_frames: usize,
    pub maximum_obus: usize,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            maximum_frames: 250_000,
            maximum_obus: 250_000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyzedFrame {
    pub frame: IvfFrame,
    pub obu_ids: Vec<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuralAnalysis {
    pub format: InputFormat,
    pub container: Option<IvfContainer>,
    pub frames: Vec<AnalyzedFrame>,
    pub obus: Vec<ObuRecord>,
    pub diagnostics: Vec<Diagnostic>,
    pub frame_limit_reached: bool,
    pub obu_limit_reached: bool,
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnalysisError {
    InvalidBudget,
    OffsetOutsideInput,
    Ivf(IvfParseError),
    Obu(ObuParseError),
}

impl fmt::Display for AnalysisError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBudget => formatter.write_str("analysis budgets must be positive"),
            Self::OffsetOutsideInput => formatter.write_str("indexed range is outside input"),
            Self::Ivf(error) => write!(formatter, "IVF analysis failed: {error}"),
            Self::Obu(error) => write!(formatter, "OBU analysis failed: {error}"),
        }
    }
}

impl std::error::Error for AnalysisError {}

impl From<IvfParseError> for AnalysisError {
    fn from(error: IvfParseError) -> Self {
        Self::Ivf(error)
    }
}

impl From<ObuParseError> for AnalysisError {
    fn from(error: ObuParseError) -> Self {
        Self::Obu(error)
    }
}

fn is_error(diagnostic: &Diagnostic) -> bool {
    matches!(diagnostic.severity, Severity::Error | Severity::Fatal)
}

#[allow(clippy::too_many_arguments)]
fn finish(
    format: InputFormat,
    container: Option<IvfContainer>,
    frames: Vec<AnalyzedFrame>,
    obus: Vec<ObuRecord>,
    diagnostics: Vec<Diagnostic>,
    frame_limit_reached: bool,
    obu_limit_reached: bool,
) -> StructuralAnalysis {
    let complete = !frame_limit_reached
        && !obu_limit_reached
        && !diagnostics.iter().any(is_error)
        && frames.iter().all(|record| record.frame.complete)
        && obus.iter().all(|record| record.complete);
    StructuralAnalysis {
        format,
        container,
        frames,
        obus,
        diagnostics,
        frame_limit_reached,
        obu_limit_reached,
        complete,
    }
}

/// Builds the bounded raw/IVF structural index used before deep syntax parsing.
///
/// # Errors
///
/// Returns an error for zero budgets, impossible persisted ranges, or arithmetic
/// failures reported by the IVF/OBU parsers. Malformed media remains diagnostics.
pub fn analyze_structural(
    input: &[u8],
    options: AnalysisOptions,
) -> Result<StructuralAnalysis, AnalysisError> {
    if options.maximum_frames == 0 || options.maximum_obus == 0 {
        return Err(AnalysisError::InvalidBudget);
    }
    if !input.starts_with(b"DKIF") {
        let mut obu_options = ObuParseOptions::for_input(input.len());
        obu_options.maximum_obus = options.maximum_obus;
        let parsed = parse_obu_sequence(input, obu_options)?;
        return Ok(finish(
            InputFormat::LowOverheadObu,
            None,
            Vec::new(),
            parsed.obus,
            parsed.diagnostics,
            false,
            parsed.limit_reached,
        ));
    }

    let ivf = parse_ivf(input, options.maximum_frames)?;
    let mut diagnostics = ivf.diagnostics;
    let mut obus = Vec::new();
    let mut frames = Vec::with_capacity(ivf.frames.len());
    let mut next_obu_id = 0_u64;
    let mut obu_limit_reached = false;
    for frame in ivf.frames {
        let start = usize::try_from(frame.payload_range.start)
            .map_err(|_| AnalysisError::OffsetOutsideInput)?;
        let length = usize::try_from(frame.payload_range.length)
            .map_err(|_| AnalysisError::OffsetOutsideInput)?;
        let end = start
            .checked_add(length)
            .filter(|value| *value <= input.len())
            .ok_or(AnalysisError::OffsetOutsideInput)?;
        let mut obu_options = ObuParseOptions::for_input(input.len());
        obu_options.start = start;
        obu_options.end = end;
        obu_options.frame_id = Some(frame.frame_id);
        obu_options.allow_unsized_final_obu = true;
        obu_options.next_obu_id = next_obu_id;
        obu_options.maximum_obus = options.maximum_obus.saturating_sub(obus.len());
        let parsed = parse_obu_sequence(input, obu_options)?;
        let obu_ids = parsed.obus.iter().map(|record| record.obu_id).collect();
        next_obu_id = parsed.next_obu_id;
        obu_limit_reached |= parsed.limit_reached;
        obus.extend(parsed.obus);
        diagnostics.extend(parsed.diagnostics);
        frames.push(AnalyzedFrame { frame, obu_ids });
        if obu_limit_reached {
            break;
        }
    }

    Ok(finish(
        InputFormat::Ivf,
        ivf.container,
        frames,
        obus,
        diagnostics,
        ivf.limit_reached,
        obu_limit_reached,
    ))
}

#[cfg(test)]
mod tests {
    use super::{AnalysisError, AnalysisOptions, InputFormat, analyze_structural};

    fn append_ivf_frame(output: &mut Vec<u8>, payload: &[u8], timestamp: u64) {
        output.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        output.extend_from_slice(&timestamp.to_le_bytes());
        output.extend_from_slice(payload);
    }

    fn two_frame_ivf() -> Vec<u8> {
        let mut input = vec![0_u8; 32];
        input[0..4].copy_from_slice(b"DKIF");
        input[6..8].copy_from_slice(&32_u16.to_le_bytes());
        input[8..12].copy_from_slice(b"AV01");
        input[12..14].copy_from_slice(&16_u16.to_le_bytes());
        input[14..16].copy_from_slice(&16_u16.to_le_bytes());
        input[16..20].copy_from_slice(&30_u32.to_le_bytes());
        input[20..24].copy_from_slice(&1_u32.to_le_bytes());
        input[24..28].copy_from_slice(&2_u32.to_le_bytes());
        append_ivf_frame(&mut input, &[0x12, 0x00], 7);
        append_ivf_frame(&mut input, &[0x12, 0x00], 9);
        input
    }

    #[test]
    fn raw_obus_are_indexed_without_frames() {
        let parsed = analyze_structural(&[0x12, 0x00], AnalysisOptions::default()).unwrap();
        assert_eq!(parsed.format, InputFormat::LowOverheadObu);
        assert!(parsed.frames.is_empty());
        assert_eq!(parsed.obus.len(), 1);
        assert!(parsed.complete);
    }

    #[test]
    fn ivf_frames_bind_absolute_obu_ranges_and_ids() {
        let parsed = analyze_structural(&two_frame_ivf(), AnalysisOptions::default()).unwrap();
        assert_eq!(parsed.format, InputFormat::Ivf);
        assert_eq!(parsed.frames.len(), 2);
        assert_eq!(parsed.obus.len(), 2);
        assert_eq!(parsed.frames[0].obu_ids, vec![0_u64]);
        assert_eq!(parsed.frames[1].obu_ids, vec![1_u64]);
        assert_eq!(parsed.obus[0].byte_range.start, 44);
        assert_eq!(parsed.obus[1].byte_range.start, 58);
        assert_eq!(parsed.obus[0].frame_id, Some(0));
        assert_eq!(parsed.obus[1].frame_id, Some(1));
        assert!(parsed.complete);
    }

    #[test]
    fn obu_budget_retains_a_stable_frame_prefix() {
        let parsed = analyze_structural(
            &two_frame_ivf(),
            AnalysisOptions {
                maximum_frames: 2,
                maximum_obus: 1,
            },
        )
        .unwrap();
        assert_eq!(parsed.frames.len(), 2);
        assert_eq!(parsed.obus.len(), 1);
        assert!(parsed.obu_limit_reached);
        assert!(!parsed.complete);
        assert_eq!(
            parsed.diagnostics.last().unwrap().code,
            "OBU_RECORD_LIMIT_REACHED"
        );
    }

    #[test]
    fn zero_budgets_are_rejected() {
        assert_eq!(
            analyze_structural(
                &[],
                AnalysisOptions {
                    maximum_frames: 0,
                    maximum_obus: 1,
                }
            ),
            Err(AnalysisError::InvalidBudget)
        );
    }
}
