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
}
