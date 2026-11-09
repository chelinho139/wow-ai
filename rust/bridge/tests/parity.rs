#[path = "parity/mod.rs"]
mod parity;

use parity::{ContractExpectation, ContractResult, Verdict, classify, load_inventory};

#[test]
fn classifier_enforces_the_strict_expected_failure_truth_table() {
    let active = ContractExpectation::Active;
    let expected = ContractExpectation::ExpectedFailure {
        reason_code: "unsupported_folder".into(),
    };
    let satisfied = ContractResult::Satisfied;
    let gap = ContractResult::KnownGap {
        contract_id: "folder_selection".into(),
        reason_code: "unsupported_folder".into(),
        evidence: "exact error".into(),
    };
    let wrong_id = ContractResult::KnownGap {
        contract_id: "other".into(),
        reason_code: "unsupported_folder".into(),
        evidence: "exact error".into(),
    };
    let wrong_reason = ContractResult::KnownGap {
        contract_id: "folder_selection".into(),
        reason_code: "provider_error".into(),
        evidence: "some error".into(),
    };
    let unexpected = ContractResult::UnexpectedFailure {
        diagnostics: "setup failed".into(),
    };
    let missing = ContractResult::MissingResult;
    let empty_evidence = ContractResult::KnownGap {
        contract_id: "folder_selection".into(),
        reason_code: "unsupported_folder".into(),
        evidence: " ".into(),
    };

    assert_eq!(
        classify("folder_selection", &active, &satisfied),
        Verdict::Pass
    );
    assert!(matches!(
        classify("folder_selection", &active, &gap),
        Verdict::Fail(_)
    ));
    assert_eq!(
        classify("folder_selection", &expected, &gap),
        Verdict::Xfail
    );
    assert!(matches!(
        classify("folder_selection", &expected, &satisfied),
        Verdict::Xpass(_)
    ));
    for result in [
        &wrong_id,
        &wrong_reason,
        &unexpected,
        &missing,
        &empty_evidence,
    ] {
        assert!(matches!(
            classify("folder_selection", &expected, result),
            Verdict::Fail(_)
        ));
        assert!(matches!(
            classify("folder_selection", &active, result),
            Verdict::Fail(_)
        ));
    }
}

#[test]
fn inventory_is_valid_and_report_is_deterministic() {
    let inventory = load_inventory().expect("parity inventory must validate");
    let report = parity::render_report(&inventory);
    println!("{report}");
    assert_eq!(report, parity::render_report(&inventory));
    let mut reversed = inventory.clone();
    reversed.cases.reverse();
    assert_eq!(report, parity::render_report(&reversed));
    assert!(report.contains("folder_selection\t"));
}

#[test]
fn inventory_rejects_invalid_and_orphaned_contracts() {
    let original = load_inventory().unwrap();
    let invalid = |mutate: fn(&mut parity::Inventory)| {
        let mut inventory = original.clone();
        mutate(&mut inventory);
        assert!(parity::validate_inventory(&inventory).is_err());
    };
    invalid(|i| i.cases.clear());
    invalid(|i| i.cases[0].reason_code = Some("stray".into()));
    invalid(|i| i.cases.push(i.cases[0].clone()));
    invalid(|i| i.cases[0].id.clear());
    invalid(|i| i.cases[0].node_reference = "missing-reference".into());
    invalid(|i| i.cases[0].status = "Typo".into());
    invalid(|i| i.cases[0].intended_behavior.clear());
    invalid(|i| i.cases[0].rationale.clear());
    invalid(|i| i.cases[0].rust_probe = None);
    invalid(|i| i.cases[0].rust_probe = Some("missing.rs::missing".into()));
    invalid(|i| {
        i.cases.remove(0);
    });
    invalid(|i| {
        let case = i
            .cases
            .iter_mut()
            .find(|c| c.id == "folder_selection")
            .unwrap();
        case.reason_code = None;
    });
    invalid(|i| {
        i.cases[0].status = "ExpectedFailure".into();
        i.cases[0].reason_code = Some("unhandled_expectation".into());
    });
}

#[test]
fn manifest_controls_the_pending_to_active_transition() {
    let mut inventory = load_inventory().unwrap();
    let expected = parity::expectation_for(&inventory, "folder_selection").unwrap();
    assert!(matches!(
        classify("folder_selection", &expected, &ContractResult::Satisfied),
        Verdict::Xpass(_)
    ));
    let case = inventory
        .cases
        .iter_mut()
        .find(|c| c.id == "folder_selection")
        .unwrap();
    case.status = "Active".into();
    case.reason_code = None;
    parity::validate_inventory(&inventory).unwrap();
    let active = parity::expectation_for(&inventory, "folder_selection").unwrap();
    assert_eq!(
        classify("folder_selection", &active, &ContractResult::Satisfied),
        Verdict::Pass
    );
    assert!(parity::expectation_for(&inventory, "missing").is_err());
    assert!(parity::expectation_for(&inventory, "reload_outbox").is_err());
}

#[test]
fn assertion_boundary_does_not_swallow_failures() {
    const CHILD: &str = "WOW_PARITY_NEGATIVE_CASE";
    if let Ok(mode) = std::env::var(CHILD) {
        let expectation = ContractExpectation::ExpectedFailure {
            reason_code: "unsupported_folder".into(),
        };
        match mode.as_str() {
            "xpass" => parity::assert_contract(
                "folder_selection",
                &expectation,
                &ContractResult::Satisfied,
            ),
            "unexpected" => parity::assert_contract(
                "folder_selection",
                &expectation,
                &ContractResult::UnexpectedFailure {
                    diagnostics: "publication failed".into(),
                },
            ),
            "panic" => panic!("simulated probe panic"),
            _ => panic!("unknown negative case"),
        }
        panic!("failure was swallowed");
    }
    for (mode, expected_text) in [
        ("xpass", "XPASS"),
        ("unexpected", "publication failed"),
        ("panic", "simulated probe panic"),
    ] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "assertion_boundary_does_not_swallow_failures",
                "--nocapture",
            ])
            .env(CHILD, mode)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(text.contains(expected_text), "{text}");
        assert!(!text.contains("failure was swallowed"), "{text}");
    }
}

#[test]
fn probe_links_require_real_unignored_test_declarations() {
    let source = "// fn bogus() {}\n/* #[test]\nfn comment() {}\n*/\n#[test]\n#[ignore]\nfn ignored() {}\nfn ordinary() {}\n#[test]\nfn actual() {}\n";
    assert_eq!(parity::test_names(source), vec!["actual"]);
}
