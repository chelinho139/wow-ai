use std::{env, process::ExitCode};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [arg] if arg == "--version" || arg == "-V" => {
            println!("wow-ai-reforged {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        [arg] if arg == "--help" || arg == "-h" => {
            println!(
                "WoW AI Reforged — Rust backend (in development)\n\nUsage: wow-ai-reforged [--help | --version]\n\nThe game bridge is not implemented yet. Use npm start for the legacy backend."
            );
            ExitCode::SUCCESS
        }
        [] => {
            eprintln!(
                "The Rust backend is not implemented yet. Use npm start for the legacy backend."
            );
            ExitCode::FAILURE
        }
        _ => {
            eprintln!("Unknown arguments. Use --help for usage.");
            ExitCode::FAILURE
        }
    }
}
