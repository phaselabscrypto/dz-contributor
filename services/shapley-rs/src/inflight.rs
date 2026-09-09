//! One in-flight cold baseline solve per input hash inside this process.
//!
//! The first request for a hash leads and runs the solve; every later request
//! for the same hash follows and awaits the leader's result over a `watch`
//! channel. The leader holds a [`LeaderGuard`] whose `Drop` releases the hash,
//! so a panicked or aborted solve can never wedge followers or the map.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

use crate::model::ShapleyResponse;

/// What followers observe: `None` while the leader is still solving, then the
/// leader's result. The error text is safe for clients.
pub type BaselineSlot = Option<Result<ShapleyResponse, String>>;

/// The leader vanished without finishing: its task panicked or was aborted.
#[derive(Debug, PartialEq, Eq)]
pub struct LeaderGone;

impl std::fmt::Display for LeaderGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("baseline solve did not complete")
    }
}

/// The per-process registry of in-flight baseline solves, keyed by input hash.
#[derive(Default)]
pub struct BaselineInflight {
    map: Mutex<HashMap<u64, watch::Receiver<BaselineSlot>>>,
}

/// The caller's role for one hash.
pub enum Flight {
    /// This caller runs the solve and must call [`LeaderGuard::finish`].
    Lead(LeaderGuard),
    /// Another caller is solving; await it with [`await_leader`].
    Follow(watch::Receiver<BaselineSlot>),
}

impl BaselineInflight {
    /// Join the flight for `input_hash`: lead when nobody is solving it, else
    /// follow the solve already in progress.
    pub fn join(self: &Arc<Self>, input_hash: u64) -> Flight {
        let mut map = self.lock();
        if let Some(receiver) = map.get(&input_hash) {
            return Flight::Follow(receiver.clone());
        }
        let (tx, rx) = watch::channel(None);
        map.insert(input_hash, rx);
        Flight::Lead(LeaderGuard {
            inflight: Arc::clone(self),
            input_hash,
            tx,
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u64, watch::Receiver<BaselineSlot>>> {
        // A poisoned lock only means a holder panicked between two plain map
        // operations; the map itself is still consistent.
        self.map.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// Held by the leading solve. Dropping it, with or without [`finish`], removes
/// the hash from the registry and wakes every follower.
///
/// [`finish`]: LeaderGuard::finish
pub struct LeaderGuard {
    inflight: Arc<BaselineInflight>,
    input_hash: u64,
    tx: watch::Sender<BaselineSlot>,
}

impl LeaderGuard {
    /// Publish the result to every follower, then release the hash.
    pub fn finish(self, result: Result<ShapleyResponse, String>) {
        // A send only fails when no follower is listening, which is fine: the
        // leader has its own copy of the result.
        let _ = self.tx.send(Some(result));
    }
}

impl Drop for LeaderGuard {
    fn drop(&mut self) {
        self.inflight.lock().remove(&self.input_hash);
    }
}

/// Await the leader's result. The outer `Err` means the leader disappeared
/// without finishing; the inner `Result` is the leader's own outcome.
pub async fn await_leader(
    mut receiver: watch::Receiver<BaselineSlot>,
) -> Result<Result<ShapleyResponse, String>, LeaderGone> {
    match receiver.wait_for(Option::is_some).await {
        Ok(slot) => slot.clone().ok_or(LeaderGone),
        Err(_) => Err(LeaderGone),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(method: &str) -> ShapleyResponse {
        ShapleyResponse {
            method: method.to_string(),
            operator_count: 0,
            values: Default::default(),
        }
    }

    #[test]
    fn second_join_follows_first() {
        let inflight = Arc::new(BaselineInflight::default());
        let first = inflight.join(7);
        assert!(matches!(first, Flight::Lead(_)));
        assert!(matches!(inflight.join(7), Flight::Follow(_)));
        assert_eq!(inflight.len(), 1);
    }

    #[tokio::test]
    async fn follower_receives_the_leaders_result() {
        let inflight = Arc::new(BaselineInflight::default());
        let Flight::Lead(guard) = inflight.join(1) else {
            panic!("first join must lead");
        };
        let Flight::Follow(rx) = inflight.join(1) else {
            panic!("second join must follow");
        };
        let follower = tokio::spawn(await_leader(rx));
        guard.finish(Ok(response("solved")));
        let result = follower
            .await
            .expect("follower task")
            .expect("leader stayed")
            .expect("leader result");
        assert_eq!(result.method, "solved");
        assert_eq!(inflight.len(), 0);
    }

    #[tokio::test]
    async fn dropped_leader_fails_followers() {
        let inflight = Arc::new(BaselineInflight::default());
        let Flight::Lead(guard) = inflight.join(2) else {
            panic!("first join must lead");
        };
        let Flight::Follow(rx) = inflight.join(2) else {
            panic!("second join must follow");
        };
        drop(guard);
        let result = await_leader(rx).await;
        assert_eq!(result.unwrap_err(), LeaderGone);
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn finished_hash_can_be_led_again() {
        let inflight = Arc::new(BaselineInflight::default());
        let Flight::Lead(guard) = inflight.join(3) else {
            panic!("first join must lead");
        };
        guard.finish(Err("rejected".to_string()));
        assert!(matches!(inflight.join(3), Flight::Lead(_)));
    }

    #[test]
    fn distinct_hashes_lead_independently() {
        let inflight = Arc::new(BaselineInflight::default());
        let _a = inflight.join(10);
        let b = inflight.join(11);
        assert!(matches!(b, Flight::Lead(_)));
        assert_eq!(inflight.len(), 2);
    }
}
