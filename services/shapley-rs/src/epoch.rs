//! Epoch identity and the boxed-future alias the store traits return.
//!
//! What survives of the old `snapshot.rs` after the extractor moved to the
//! Next.js cron. Nothing here reaches the network, and nothing depends on
//! `AppState`.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

/// Boxed, sendable future returned by the trait methods in this crate.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A DoubleZero epoch number. Newtype so an epoch is never confused with a
/// byte count or a depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(pub u32);

impl fmt::Display for Epoch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Earliest published snapshot.
pub const MIN_DZ_EPOCH: Epoch = Epoch(48);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_displays_as_a_bare_number() {
        assert_eq!(Epoch(211).to_string(), "211");
    }

    #[test]
    fn epoch_serializes_transparently() {
        let json = serde_json::to_string(&Epoch(204)).expect("Epoch serializes");
        assert_eq!(json, "204");
        let back: Epoch = serde_json::from_str("204").expect("Epoch deserializes");
        assert_eq!(back, Epoch(204));
    }
}
