#![forbid(unsafe_code)]

use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BitReadError {
    RangeOverflow,
    RangeOutsideInput,
    InvalidBitCount,
    UnexpectedEnd,
    NonZeroAlignmentBit,
}

impl fmt::Display for BitReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RangeOverflow => "bit range overflows",
            Self::RangeOutsideInput => "bit range is outside input",
            Self::InvalidBitCount => "bit count must be between 0 and 53",
            Self::UnexpectedEnd => "unexpected end of bit range",
            Self::NonZeroAlignmentBit => "byte alignment bit is not zero",
        })
    }
}

impl std::error::Error for BitReadError {}

#[derive(Clone, Debug)]
pub struct BitReader<'a> {
    input: &'a [u8],
    start_bit: usize,
    end_bit: usize,
    position: usize,
}

impl<'a> BitReader<'a> {
    /// Creates a reader over a checked byte subrange.
    ///
    /// # Errors
    ///
    /// Returns an error when the requested range overflows or escapes `input`.
    pub fn new(
        input: &'a [u8],
        start_byte: usize,
        length_bytes: usize,
    ) -> Result<Self, BitReadError> {
        let end_byte = start_byte
            .checked_add(length_bytes)
            .ok_or(BitReadError::RangeOverflow)?;
        if end_byte > input.len() {
            return Err(BitReadError::RangeOutsideInput);
        }
        let start_bit = start_byte
            .checked_mul(8)
            .ok_or(BitReadError::RangeOverflow)?;
        let end_bit = end_byte
            .checked_mul(8)
            .ok_or(BitReadError::RangeOverflow)?;
        Ok(Self {
            input,
            start_bit,
            end_bit,
            position: start_bit,
        })
    }

    #[must_use]
    pub const fn position(&self) -> usize {
        self.position - self.start_bit
    }

    #[must_use]
    pub const fn remaining(&self) -> usize {
        self.end_bit - self.position
    }

    /// Reads one bit in most-significant-bit-first order.
    ///
    /// # Errors
    ///
    /// Returns [`BitReadError::UnexpectedEnd`] at the configured boundary.
    pub fn read_bit(&mut self) -> Result<u8, BitReadError> {
        if self.position >= self.end_bit {
            return Err(BitReadError::UnexpectedEnd);
        }
        let byte = self.input[self.position / 8];
        let shift = 7 - (self.position % 8);
        self.position += 1;
        Ok((byte >> shift) & 1)
    }

    /// Reads at most 53 bits into an exactly representable integer.
    ///
    /// # Errors
    ///
    /// Returns an error for a larger count or when the range ends first.
    pub fn read_bits(&mut self, count: usize) -> Result<u64, BitReadError> {
        if count > 53 {
            return Err(BitReadError::InvalidBitCount);
        }
        if count > self.remaining() {
            return Err(BitReadError::UnexpectedEnd);
        }
        let mut value = 0_u64;
        for _ in 0..count {
            value = (value << 1) | u64::from(self.read_bit()?);
        }
        Ok(value)
    }

    /// Advances without reading data.
    ///
    /// # Errors
    ///
    /// Returns [`BitReadError::UnexpectedEnd`] if the skip crosses the boundary.
    pub fn skip_bits(&mut self, count: usize) -> Result<(), BitReadError> {
        self.position = self
            .position
            .checked_add(count)
            .filter(|position| *position <= self.end_bit)
            .ok_or(BitReadError::UnexpectedEnd)?;
        Ok(())
    }

    /// Consumes zero bits up to the next byte boundary.
    ///
    /// # Errors
    ///
    /// Returns an error at end-of-range or when any alignment bit is one.
    pub fn byte_align_zero(&mut self) -> Result<usize, BitReadError> {
        let mut consumed = 0;
        while self.position % 8 != 0 {
            if self.read_bit()? != 0 {
                return Err(BitReadError::NonZeroAlignmentBit);
            }
            consumed += 1;
        }
        Ok(consumed)
    }
}

#[cfg(test)]
mod tests {
    use super::{BitReadError, BitReader};

    #[test]
    fn reads_most_significant_bit_first() {
        let input = [0b1011_0001, 0b0110_0000];
        let mut reader = BitReader::new(&input, 0, input.len()).unwrap();
        assert_eq!(reader.read_bits(4).unwrap(), 0b1011);
        assert_eq!(reader.read_bits(6).unwrap(), 0b000101);
        assert_eq!(reader.position(), 10);
        assert_eq!(reader.remaining(), 6);
    }

    #[test]
    fn rejects_out_of_range_reads_and_alignment_ones() {
        let input = [0b1000_0000];
        let mut reader = BitReader::new(&input, 0, 1).unwrap();
        reader.read_bit().unwrap();
        assert_eq!(reader.byte_align_zero().unwrap(), 7);
        assert_eq!(reader.read_bit(), Err(BitReadError::UnexpectedEnd));

        let mut non_zero = BitReader::new(&[0b0100_0000], 0, 1).unwrap();
        non_zero.read_bit().unwrap();
        assert_eq!(
            non_zero.byte_align_zero(),
            Err(BitReadError::NonZeroAlignmentBit)
        );
    }
}
