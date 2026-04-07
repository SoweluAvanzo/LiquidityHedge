/// Integer square root using Newton's method for u128.
/// Returns floor(sqrt(n)).
pub fn integer_sqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

// ─── Concentrated Liquidity Math ─────────────────────────────────────

/// Q64 constant: 2^64
pub const Q64: u128 = 1u128 << 64;

/// Convert price_e6 (6-decimal USD price) to sqrtPriceX64.
/// For SOL/USDC (decimals 9 vs 6): sqrtPriceX64 = sqrt(price / 1000) * 2^64
/// We compute: sqrt(price_e6 * Q64^2 / 1_000_000_000) to keep integer precision.
pub fn price_e6_to_sqrt_price_x64(price_e6: u64) -> u128 {
    // price = price_e6 / 1_000_000 (in USD)
    // raw_price = price / 10^(9-6) = price / 1000
    // sqrt_price = sqrt(raw_price) = sqrt(price_e6 / 1_000_000_000)
    // sqrt_price_x64 = sqrt_price * 2^64
    //                 = sqrt(price_e6 / 1_000_000_000) * 2^64
    //                 = sqrt(price_e6 * 2^128 / 1_000_000_000)
    let numerator = (price_e6 as u128) * Q64 * Q64 / 1_000_000_000u128;
    integer_sqrt(numerator)
}

/// Estimate token amounts for a concentrated liquidity position at a given sqrtPrice.
/// Returns (amount_a_lamports, amount_b_micro_usdc).
/// This is the standard Uniswap V3 / Orca formula.
pub fn estimate_token_amounts(
    liquidity: u128,
    sqrt_price_current: u128,
    sqrt_price_lower: u128,
    sqrt_price_upper: u128,
) -> (u128, u128) {
    if liquidity == 0 {
        return (0, 0);
    }

    if sqrt_price_current <= sqrt_price_lower {
        // Price below range: all token A (SOL)
        let amount_a = liquidity
            .checked_mul(sqrt_price_upper - sqrt_price_lower)
            .unwrap_or(0)
            .checked_mul(Q64)
            .unwrap_or(0)
            / sqrt_price_lower
            / sqrt_price_upper;
        (amount_a, 0)
    } else if sqrt_price_current >= sqrt_price_upper {
        // Price above range: all token B (USDC)
        let amount_b = liquidity
            .checked_mul(sqrt_price_upper - sqrt_price_lower)
            .unwrap_or(0)
            / Q64;
        (0, amount_b)
    } else {
        // In range: both tokens
        let amount_a = liquidity
            .checked_mul(sqrt_price_upper - sqrt_price_current)
            .unwrap_or(0)
            .checked_mul(Q64)
            .unwrap_or(0)
            / sqrt_price_current
            / sqrt_price_upper;
        let amount_b = liquidity
            .checked_mul(sqrt_price_current - sqrt_price_lower)
            .unwrap_or(0)
            / Q64;
        (amount_a, amount_b)
    }
}

/// Compute the USD value of a CL position in e6 (micro-USDC).
/// amount_a = SOL lamports, amount_b = USDC micro-units, price_e6 = SOL price in e6.
/// value_e6 = amount_a * price_e6 / 1_000_000_000 + amount_b
pub fn cl_position_value_e6(amount_a: u128, amount_b: u128, price_e6: u64) -> u64 {
    // SOL value in micro-USDC: amount_a (lamports) * price_e6 / 10^9
    let sol_value = (amount_a as u128)
        .checked_mul(price_e6 as u128)
        .unwrap_or(0)
        / 1_000_000_000u128;
    let total = sol_value.checked_add(amount_b).unwrap_or(0);
    total.min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sqrt_zero() {
        assert_eq!(integer_sqrt(0), 0);
    }

    #[test]
    fn test_sqrt_one() {
        assert_eq!(integer_sqrt(1), 1);
    }

    #[test]
    fn test_sqrt_perfect() {
        assert_eq!(integer_sqrt(4), 2);
        assert_eq!(integer_sqrt(9), 3);
        assert_eq!(integer_sqrt(16), 4);
        assert_eq!(integer_sqrt(1_000_000), 1_000);
    }

    #[test]
    fn test_sqrt_floor() {
        assert_eq!(integer_sqrt(2), 1);
        assert_eq!(integer_sqrt(8), 2);
        assert_eq!(integer_sqrt(10), 3);
    }

    #[test]
    fn test_sqrt_large() {
        // 1_000_000 * 1_000_000 = 1_000_000_000_000
        assert_eq!(integer_sqrt(1_000_000_000_000u128), 1_000_000);
    }

    #[test]
    fn test_price_e6_to_sqrt_price_x64() {
        // SOL at $150 → price_e6 = 150_000_000
        let sqrt_px64 = price_e6_to_sqrt_price_x64(150_000_000);
        // sqrt(150 / 1000) * 2^64 ≈ 0.3873 * 2^64 ≈ 7_145_929_548_129_968_128
        // Allow 1% tolerance
        let expected = 7_145_929_548_129_968_128u128;
        let diff = if sqrt_px64 > expected {
            sqrt_px64 - expected
        } else {
            expected - sqrt_px64
        };
        assert!(
            diff < expected / 100,
            "sqrt_px64={} expected~={} diff={}",
            sqrt_px64,
            expected,
            diff
        );
    }

    #[test]
    fn test_cl_position_value_e6() {
        // 10_000_000 lamports (0.01 SOL) at $150 + 2_000_000 USDC (2 USDC)
        let val = cl_position_value_e6(10_000_000, 2_000_000, 150_000_000);
        // 0.01 * 150 = 1.5 USDC = 1_500_000 + 2_000_000 = 3_500_000
        assert_eq!(val, 3_500_000);
    }
}
