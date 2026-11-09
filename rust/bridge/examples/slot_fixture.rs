#[path = "../tests/support/mod.rs"]
mod support;
fn main() {
    print!(
        "{}",
        wow_ai_reforged::slots::serialize(
            wow_ai_reforged::slots::Target::Slot,
            &support::snapshot()
        )
        .unwrap()
    );
}
