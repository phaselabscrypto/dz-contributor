//! Failure modes of the per-epoch diff shape store.
//!
//! Replaces the old `SnapshotError`, which described reads against the public
//! snapshot bucket. The service no longer reads that bucket: shapes arrive by
//! `PUT /diff/shape/:epoch` from the Next.js cron, so the only things that can
//! go wrong are a missing record, an unreachable object store, a duplicate
//! write, or a body that fails validation.
//!
//! `Display` and `Error` are written by hand. The crate depends on `anyhow`
//! and not on `thiserror`, and both `SnapshotError` and `ScanFailure` were
//! hand-written before it, so this keeps one pattern in the crate.

use std::fmt;

use crate::epoch::Epoch;

/// Text of [`DiffStoreError::NotFound`]. Frozen: `/changelog` renders the
/// service's 404 body verbatim for an epoch that has not landed, and
/// `lib/utils/snapshot-diff.ts` matched it with `^epoch \d+: snapshot HTTP \d+$`
/// before it was deleted. Changing this changes what a user reads.
const NOT_FOUND_TEMPLATE: &str = "snapshot HTTP 404";

/// Why a shape read or write did not succeed.
#[non_exhaustive]
#[derive(Debug)]
pub enum DiffStoreError {
    /// No record persisted for this epoch.
    NotFound {
        /// Requested epoch.
        epoch: Epoch,
    },
    /// The object store failed a read, write or list, or a read deadline
    /// elapsed. `detail` is for logs only and never reaches a client.
    Persistence {
        /// Requested epoch.
        epoch: Epoch,
        /// Underlying error text, for logs.
        detail: String,
    },
    /// A record already exists for this epoch under the current version
    /// prefix, and it deserializes and names this epoch.
    Conflict {
        /// Requested epoch.
        epoch: Epoch,
    },
    /// The submitted record failed validation.
    Malformed {
        /// Requested epoch.
        epoch: Epoch,
        /// What was wrong, safe to return to the caller.
        reason: String,
    },
}

impl DiffStoreError {
    /// Shorthand for a persistence failure carrying an error to log.
    pub fn persistence(epoch: Epoch, detail: impl fmt::Display) -> Self {
        Self::Persistence {
            epoch,
            detail: detail.to_string(),
        }
    }

    /// Shorthand for a rejected body.
    pub fn malformed(epoch: Epoch, reason: impl Into<String>) -> Self {
        Self::Malformed {
            epoch,
            reason: reason.into(),
        }
    }

    /// The epoch every variant carries.
    pub fn epoch(&self) -> Epoch {
        match self {
            Self::NotFound { epoch }
            | Self::Persistence { epoch, .. }
            | Self::Conflict { epoch }
            | Self::Malformed { epoch, .. } => *epoch,
        }
    }
}

impl fmt::Display for DiffStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { epoch } => write!(f, "epoch {epoch}: {NOT_FOUND_TEMPLATE}"),
            Self::Persistence { epoch, .. } => write!(f, "epoch {epoch}: shape store unavailable"),
            Self::Conflict { epoch } => write!(f, "epoch {epoch}: shape already persisted"),
            Self::Malformed { epoch, reason } => write!(f, "epoch {epoch}: {reason}"),
        }
    }
}

impl std::error::Error for DiffStoreError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/changelog` shows this string to a user when an epoch has not landed.
    /// If this test fails, the UI copy changed with it.
    #[test]
    fn not_found_text_is_the_frozen_public_contract() {
        let error = DiffStoreError::NotFound { epoch: Epoch(190) };
        assert_eq!(error.to_string(), "epoch 190: snapshot HTTP 404");
    }

    #[test]
    fn persistence_detail_stays_out_of_display() {
        let error = DiffStoreError::persistence(Epoch(211), "connect timed out to gateway-7");
        assert_eq!(error.to_string(), "epoch 211: shape store unavailable");
        assert!(
            format!("{error:?}").contains("gateway-7"),
            "Debug keeps the detail"
        );
    }

    #[test]
    fn conflict_and_malformed_read_clearly() {
        assert_eq!(
            DiffStoreError::Conflict { epoch: Epoch(204) }.to_string(),
            "epoch 204: shape already persisted"
        );
        assert_eq!(
            DiffStoreError::malformed(Epoch(204), "links must not be empty").to_string(),
            "epoch 204: links must not be empty"
        );
    }

    #[test]
    fn every_variant_reports_its_epoch() {
        let cases = [
            DiffStoreError::NotFound { epoch: Epoch(1) },
            DiffStoreError::persistence(Epoch(2), "x"),
            DiffStoreError::Conflict { epoch: Epoch(3) },
            DiffStoreError::malformed(Epoch(4), "y"),
        ];
        let epochs: Vec<u32> = cases.iter().map(|e| e.epoch().0).collect();
        assert_eq!(epochs, vec![1, 2, 3, 4]);
    }
}
