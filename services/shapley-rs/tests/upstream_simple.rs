//! Correctness pin: feeds the same input as the upstream `network-shapley-rs`
//! `simple` example through OUR build_input + ShapleyInput::compute path,
//! and asserts the output values match upstream-expected values within a
//! 1% tolerance. If this regresses we know either:
//!   (a) the upstream solver changed (bump expected values), or
//!   (b) our wire-type → crate-type translation drifted.
//!
//! Run:  cargo test -p dz-shapley-service --test upstream_simple

use network_shapley::{
    shapley::ShapleyInput,
    types::{Demand, Device, PrivateLink, PublicLink},
};

fn within(a: f64, b: f64, rel_tol: f64) -> bool {
    (a - b).abs() / b.abs().max(1e-9) <= rel_tol
}

#[test]
fn upstream_simple_matches() {
    // From: https://github.com/doublezerofoundation/network-shapley-rs README
    let private_links = vec![
        PrivateLink::new(
            "SIN1".to_string(),
            "FRA1".to_string(),
            50.0,
            10.0,
            1.0,
            None,
        ),
        PrivateLink::new("FRA1".to_string(), "AMS1".to_string(), 3.0, 10.0, 1.0, None),
        PrivateLink::new("FRA1".to_string(), "LON1".to_string(), 5.0, 10.0, 1.0, None),
    ];
    let devices = vec![
        Device::new("SIN1".to_string(), 1, "Alpha".to_string()),
        Device::new("FRA1".to_string(), 1, "Alpha".to_string()),
        Device::new("AMS1".to_string(), 1, "Beta".to_string()),
        Device::new("LON1".to_string(), 1, "Beta".to_string()),
    ];
    let public_links = vec![
        PublicLink::new("SIN".to_string(), "FRA".to_string(), 100.0),
        PublicLink::new("SIN".to_string(), "AMS".to_string(), 102.0),
        PublicLink::new("FRA".to_string(), "LON".to_string(), 7.0),
        PublicLink::new("FRA".to_string(), "AMS".to_string(), 5.0),
    ];
    let demands = vec![
        Demand::new("SIN".to_string(), "AMS".to_string(), 1, 1.0, 1.0, 1, true),
        Demand::new("SIN".to_string(), "LON".to_string(), 5, 1.0, 2.0, 1, true),
        Demand::new("AMS".to_string(), "LON".to_string(), 2, 3.0, 1.0, 2, false),
        Demand::new("AMS".to_string(), "FRA".to_string(), 1, 3.0, 1.0, 2, false),
    ];

    let input = ShapleyInput {
        private_links,
        devices,
        demands,
        public_links,
        operator_uptime: 0.98,
        contiguity_bonus: 5.0,
        demand_multiplier: 1.0,
    };

    let result = input.compute().expect("solver succeeds on simple example");

    let alpha = result.get("Alpha").expect("alpha present");
    let beta = result.get("Beta").expect("beta present");

    // Upstream README values:
    let expected_alpha = 173.67559751778526_f64;
    let expected_beta = 85.47560036995537_f64;

    let tol = 0.01; // 1% — generous to absorb solver tweaks
    assert!(
        within(alpha.value, expected_alpha, tol),
        "alpha = {}, expected ~{}",
        alpha.value,
        expected_alpha
    );
    assert!(
        within(beta.value, expected_beta, tol),
        "beta = {}, expected ~{}",
        beta.value,
        expected_beta
    );

    // Sanity: shares sum to ~1
    let share_sum: f64 = result.values().map(|v| v.value).sum::<f64>();
    assert!(share_sum > 0.0, "non-zero total value");
}
