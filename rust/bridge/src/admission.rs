//! Durable exact request admission tracking.
//!
//! IDs are retained as compressed inclusive intervals per addon session. The
//! ledger deliberately has no high-water shortcut: requests can arrive out of
//! order, so an unobserved gap must remain admissible.

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io};

const MAX_SAFE_ID: u64 = (1_u64 << 53) - 1;
const MAX_SESSIONS: usize = 256;
const MAX_INTERVALS: usize = 8192;
const MAX_SESSION_BYTES: usize = 256;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionLedger {
    #[serde(default)]
    sessions: BTreeMap<String, Vec<(u64, u64)>>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn valid_identity(session: &str, id: u64) -> io::Result<()> {
    if session.len() > MAX_SESSION_BYTES {
        return Err(invalid("addon session token exceeds 256 bytes"));
    }
    if id == 0 || id > MAX_SAFE_ID {
        return Err(invalid("request id is outside the JavaScript-safe range"));
    }
    Ok(())
}

impl AdmissionLedger {
    /// Check exact membership. Invalid identities are never considered admitted.
    pub fn contains(&self, session: &str, id: u64) -> bool {
        if valid_identity(session, id).is_err() {
            return false;
        }
        self.sessions.get(session).is_some_and(|intervals| {
            intervals
                .iter()
                .any(|&(start, end)| start <= id && id <= end)
        })
    }

    /// Record one admitted request, merging overlapping or adjacent intervals.
    ///
    /// The update is transactional in memory: invalid existing data or a bound
    /// violation returns an error without modifying the ledger.
    pub fn insert(&mut self, session: &str, id: u64) -> io::Result<()> {
        valid_identity(session, id)?;
        self.validate()?;
        if self.contains(session, id) {
            return Ok(());
        }

        let mut updated = self.clone();
        if !updated.sessions.contains_key(session) && updated.sessions.len() >= MAX_SESSIONS {
            return Err(invalid("admission ledger session limit reached"));
        }
        let intervals = updated.sessions.entry(session.to_owned()).or_default();
        intervals.push((id, id));
        intervals.sort_unstable_by_key(|&(start, _)| start);

        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(intervals.len());
        for &(start, end) in intervals.iter() {
            if let Some((_, previous_end)) = merged.last_mut()
                && start <= previous_end.saturating_add(1)
            {
                *previous_end = (*previous_end).max(end);
            } else {
                merged.push((start, end));
            }
        }
        *intervals = merged;
        updated.validate()?;
        *self = updated;
        Ok(())
    }

    /// Validate persisted data before it can influence request admission.
    pub fn validate(&self) -> io::Result<()> {
        if self.sessions.len() > MAX_SESSIONS {
            return Err(invalid("admission ledger contains too many sessions"));
        }
        let mut interval_count = 0usize;
        for (session, intervals) in &self.sessions {
            if session.len() > MAX_SESSION_BYTES {
                return Err(invalid("admission ledger session token exceeds 256 bytes"));
            }
            if intervals.is_empty() {
                return Err(invalid("admission ledger session has no intervals"));
            }
            interval_count = interval_count
                .checked_add(intervals.len())
                .ok_or_else(|| invalid("admission ledger interval count overflow"))?;
            if interval_count > MAX_INTERVALS {
                return Err(invalid("admission ledger contains too many intervals"));
            }
            let mut previous_end: Option<u64> = None;
            for &(start, end) in intervals {
                valid_identity(session, start)?;
                valid_identity(session, end)?;
                if start > end {
                    return Err(invalid("admission ledger interval is reversed"));
                }
                if previous_end.is_some_and(|previous| start <= previous.saturating_add(1)) {
                    return Err(invalid(
                        "admission ledger intervals must be sorted and compressed",
                    ));
                }
                previous_end = Some(end);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(json: &str) -> AdmissionLedger {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn out_of_order_ids_keep_gaps_exact_and_merge_when_filled() {
        let mut value = AdmissionLedger::default();
        value.insert("session", 5).unwrap();
        value.insert("session", 1).unwrap();
        value.insert("session", 3).unwrap();
        assert!(value.contains("session", 1));
        assert!(value.contains("session", 3));
        assert!(value.contains("session", 5));
        assert!(!value.contains("session", 2));
        assert!(!value.contains("session", 4));

        value.insert("session", 2).unwrap();
        value.insert("session", 4).unwrap();
        assert_eq!(value.sessions["session"], [(1, 5)]);
        value.validate().unwrap();
    }

    #[test]
    fn admitted_ids_are_never_pruned_or_replaced_by_a_high_water_mark() {
        let mut value = AdmissionLedger::default();
        for id in [MAX_SAFE_ID, 1, 100, 50, 75] {
            value.insert("session", id).unwrap();
        }
        for id in [MAX_SAFE_ID, 1, 100, 50, 75] {
            assert!(value.contains("session", id));
        }
        assert!(!value.contains("session", 2));
        assert!(!value.contains("session", MAX_SAFE_ID - 1));
    }

    #[test]
    fn validation_rejects_malformed_persisted_intervals_and_identities() {
        for json in [
            r#"{"sessions":{"s":[[2,1]]}}"#,
            r#"{"sessions":{"s":[[1,2],[2,3]]}}"#,
            r#"{"sessions":{"s":[[2,2],[1,1]]}}"#,
            r#"{"sessions":{"s":[[0,1]]}}"#,
            r#"{"sessions":{"s":[[1,9007199254740992]]}}"#,
            r#"{"sessions":{"s":[]}}"#,
        ] {
            assert!(ledger(json).validate().is_err(), "accepted {json}");
        }
        let long = "x".repeat(MAX_SESSION_BYTES + 1);
        let value = AdmissionLedger {
            sessions: BTreeMap::from([(long, vec![(1, 1)])]),
        };
        assert!(value.validate().is_err());
    }

    #[test]
    fn capacity_failure_leaves_the_ledger_unchanged() {
        let sessions = (0..MAX_SESSIONS)
            .map(|index| (format!("s{index}"), vec![(1, 1)]))
            .collect();
        let mut value = AdmissionLedger { sessions };
        let before = serde_json::to_vec(&value).unwrap();
        assert!(value.insert("overflow", 1).is_err());
        assert_eq!(serde_json::to_vec(&value).unwrap(), before);

        let intervals = (0..MAX_INTERVALS)
            .map(|index| {
                let id = 1 + (index as u64) * 2;
                (id, id)
            })
            .collect();
        let mut value = AdmissionLedger {
            sessions: BTreeMap::from([("s".into(), intervals)]),
        };
        let before = serde_json::to_vec(&value).unwrap();
        assert!(value.insert("s", MAX_SAFE_ID).is_err());
        assert_eq!(serde_json::to_vec(&value).unwrap(), before);
    }

    #[test]
    fn duplicate_insert_is_idempotent_at_capacity() {
        let intervals = (0..MAX_INTERVALS)
            .map(|index| {
                let id = 1 + (index as u64) * 2;
                (id, id)
            })
            .collect();
        let mut value = AdmissionLedger {
            sessions: BTreeMap::from([("s".into(), intervals)]),
        };
        value.insert("s", 1).unwrap();
        assert!(value.contains("s", 1));
    }
}
