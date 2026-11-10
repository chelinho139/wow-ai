#![allow(dead_code)] // The shared test helper is compiled into two integration-test crates.

use serde::Deserialize;
use std::{collections::HashSet, fs, path::Path};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub cases: Vec<Case>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub id: String,
    pub intended_behavior: String,
    pub node_reference: String,
    pub rust_probe: Option<String>,
    pub status: String,
    pub reason_code: Option<String>,
    pub rationale: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ContractExpectation {
    Active,
    ExpectedFailure { reason_code: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ContractResult {
    Satisfied,
    KnownGap {
        contract_id: String,
        reason_code: String,
        evidence: String,
    },
    UnexpectedFailure {
        diagnostics: String,
    },
    MissingResult,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Xfail,
    Xpass(String),
    Fail(String),
}

pub fn classify(id: &str, expectation: &ContractExpectation, result: &ContractResult) -> Verdict {
    match (expectation, result) {
        (ContractExpectation::Active, ContractResult::Satisfied) => Verdict::Pass,
        (ContractExpectation::ExpectedFailure { .. }, ContractResult::Satisfied) => Verdict::Xpass(
            format!("{id}: now satisfied; remove the expected-failure marker"),
        ),
        (
            ContractExpectation::ExpectedFailure {
                reason_code: expected,
            },
            ContractResult::KnownGap {
                contract_id,
                reason_code,
                evidence,
            },
        ) if id == contract_id && expected == reason_code && !evidence.trim().is_empty() => {
            Verdict::Xfail
        }
        (
            _,
            ContractResult::KnownGap {
                contract_id,
                reason_code,
                ..
            },
        ) => Verdict::Fail(format!(
            "{id}: unmatched known gap {contract_id}/{reason_code}"
        )),
        (_, ContractResult::UnexpectedFailure { diagnostics }) => {
            Verdict::Fail(format!("{id}: unexpected failure: {diagnostics}"))
        }
        (_, ContractResult::MissingResult) => Verdict::Fail(format!("{id}: missing probe result")),
    }
}

pub fn load_inventory() -> Result<Inventory, String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/manifest.json");
    let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let inventory: Inventory = serde_json::from_str(&source).map_err(|error| error.to_string())?;
    validate_inventory(&inventory)?;
    Ok(inventory)
}

pub fn validate_inventory(inventory: &Inventory) -> Result<(), String> {
    let mut ids = HashSet::new();
    let probes: HashSet<&str> = [
        "protocol_compat.rs::matches_legacy_node_protocol_fixtures",
        "reload_compat.rs::saved_variables_match_legacy_outbox_contract",
        "slots_compat.rs::matches_node_slot_schema_for_every_status_and_optional_fields",
        "frame_compat.rs::real_lua_encoded_frames_survive_threshold_noise_offsets_and_row_padding",
        "pipeline.rs::every_adapter_runs_to_private_lua_and_preserves_legacy_data",
        "live_transport.rs::completed_reply_recovers_after_restart_without_rerunning_the_agent",
        "live_transport.rs::per_chat_folder_selection_is_known_gap",
    ]
    .into_iter()
    .collect();
    if inventory.cases.is_empty() {
        return Err("inventory must not be empty".into());
    }
    for case in &inventory.cases {
        if case.id.trim().is_empty() || !ids.insert(case.id.as_str()) {
            return Err(format!("empty or duplicate case id: {}", case.id));
        }
        let reference = &case.node_reference;
        if !Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../")
            .join(reference)
            .is_file()
        {
            return Err(format!("{} references missing path {reference}", case.id));
        }
        if case.intended_behavior.trim().is_empty() || case.rationale.trim().is_empty() {
            return Err(format!("{} needs behavior and rationale", case.id));
        }
        match case.status.as_str() {
            "Active"
            | "ExpectedFailure"
            | "Planned"
            | "IntentionalDifference"
            | "NeedsDecision" => {}
            other => return Err(format!("{} has unknown status {other}", case.id)),
        }
        if case.status == "ExpectedFailure"
            && case.rust_probe.as_deref()
                != Some("live_transport.rs::per_chat_folder_selection_is_known_gap")
        {
            return Err(format!(
                "{} cannot mark a probe without expectation handling as ExpectedFailure",
                case.id
            ));
        }
        if matches!(case.status.as_str(), "Active" | "Planned" | "NeedsDecision")
            && case.reason_code.is_some()
        {
            return Err(format!("case {} must remove its gap reason", case.id));
        }
        if matches!(
            case.status.as_str(),
            "ExpectedFailure" | "IntentionalDifference"
        ) && case.reason_code.as_deref().unwrap_or("").trim().is_empty()
        {
            return Err(format!("{} needs a reason code", case.id));
        }
        if matches!(case.status.as_str(), "Active" | "ExpectedFailure") {
            let probe = case
                .rust_probe
                .as_deref()
                .ok_or_else(|| format!("{} has no probe", case.id))?;
            if !probes.contains(probe) {
                return Err(format!("{} references unknown probe {probe}", case.id));
            }
            let (test_file, test_name) = probe.split_once("::").expect("probe is file::test");
            let source = fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests")
                    .join(test_file),
            )
            .map_err(|error| format!("{} probe source unavailable: {error}", case.id))?;
            if !test_names(&source).contains(&test_name.to_owned()) {
                return Err(format!("{} references missing Rust test {probe}", case.id));
            }
        } else if case.rust_probe.is_some() {
            return Err(format!("non-executable case {} has a probe", case.id));
        }
    }
    let mut executable = HashSet::new();
    for case in &inventory.cases {
        if let Some(probe) = &case.rust_probe
            && !executable.insert(probe.as_str())
        {
            return Err(format!("probe {probe} has multiple inventory entries"));
        }
    }
    // A newly added pending probe cannot disappear from both registry and manifest.
    for entry in fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests"))
        .map_err(|e| e.to_string())?
    {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "rs") {
            let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            for name in test_names(&source)
                .into_iter()
                .filter(|n| n.ends_with("_is_known_gap"))
            {
                let probe = format!("{}::{name}", path.file_name().unwrap().to_string_lossy());
                if !executable.contains(probe.as_str()) {
                    return Err(format!("pending probe {probe} has no inventory entry"));
                }
            }
        }
    }
    for probe in probes {
        if !executable.contains(probe) {
            return Err(format!(
                "registered Rust parity probe {probe} has no inventory entry"
            ));
        }
    }
    Ok(())
}

// Require an actual unignored #[test] declaration, not a commented function name.
// Pending integration tests use the `_is_known_gap` naming convention.
pub fn test_names(source: &str) -> Vec<String> {
    let mut block_comment = false;
    let mut armed = false;
    let mut names = Vec::new();
    for line in source.lines() {
        let mut line = line.trim();
        if block_comment {
            if let Some((_, rest)) = line.split_once("*/") {
                line = rest.trim();
                block_comment = false;
            } else {
                continue;
            }
        }
        if line.starts_with("/*") {
            if let Some((_, rest)) = line.split_once("*/") {
                line = rest.trim();
            } else {
                block_comment = true;
                continue;
            }
        }
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line == "#[test]" {
            armed = true;
            continue;
        }
        if armed
            && let Some(name) = line
                .strip_prefix("fn ")
                .and_then(|s| s.split_once("()").map(|(name, _)| name))
        {
            names.push(name.to_owned());
        }
        armed = false;
    }
    names
}

/// Runtime probes consume the same expectation shown in the inventory report.
pub fn expectation_for(inventory: &Inventory, id: &str) -> Result<ContractExpectation, String> {
    let case = inventory
        .cases
        .iter()
        .find(|case| case.id == id)
        .ok_or_else(|| format!("unknown contract {id}"))?;
    match case.status.as_str() {
        "Active" => Ok(ContractExpectation::Active),
        "ExpectedFailure" => Ok(ContractExpectation::ExpectedFailure {
            reason_code: case
                .reason_code
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("{id} needs a reason code"))?,
        }),
        _ => Err(format!("{id} has no executable expectation")),
    }
}

/// No panic interception: setup and probe panics remain ordinary test failures.
pub fn assert_contract(id: &str, expectation: &ContractExpectation, result: &ContractResult) {
    match classify(id, expectation, result) {
        Verdict::Pass => println!("PASS {id}"),
        Verdict::Xfail => println!("XFAIL {id}: {result:?}"),
        Verdict::Xpass(message) => panic!("XPASS {message}"),
        Verdict::Fail(message) => panic!("FAIL {message}"),
    }
}

pub fn render_report(inventory: &Inventory) -> String {
    let mut rows = inventory.cases.iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    let mut counts = [0usize; 5];
    let mut out = String::new();
    for case in rows {
        let index = match case.status.as_str() {
            "Active" => 0,
            "ExpectedFailure" => 1,
            "Planned" => 2,
            "IntentionalDifference" => 3,
            "NeedsDecision" => 4,
            _ => unreachable!("inventory validation rejects unknown statuses"),
        };
        counts[index] += 1;
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\n",
            case.id,
            case.status,
            case.reason_code.as_deref().unwrap_or("-"),
            case.rationale,
            case.node_reference,
            case.rust_probe.as_deref().unwrap_or("-")
        ));
    }
    out.push_str(&format!(
        "totals\tactive={}\texpected_failure={}\tplanned={}\tintentional_difference={}\tneeds_decision={}\n",
        counts[0], counts[1], counts[2], counts[3], counts[4]
    ));
    out
}
