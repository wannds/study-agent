// Diagnostic for QR generation only: never polls, saves, or prints a login ticket.
fn main() {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(12)))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent();
    match agent.get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate").header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36").header("Referer", "https://passport.bilibili.com/").header("Cookie", "").call() {
        Ok(r) => eprintln!("Native TLS generation endpoint HTTP {}", r.status()),
        Err(e) => eprintln!("Native TLS generation endpoint error: {e:?}"),
    }
    match c2m_source::auth::QrSession::generate() {
        Ok(session) => println!(
            "QR generated: {} modules; ticket deliberately not displayed",
            session.modules().len()
        ),
        Err(error) => {
            // Generation endpoint has no account credentials. Scrub URLs before reporting errors.
            for cause in error.chain() {
                let text = cause.to_string();
                let safe: Vec<_> = text
                    .split_whitespace()
                    .map(|word| if word.contains("://") { "[url]" } else { word })
                    .collect();
                eprintln!("{}", safe.join(" ").chars().take(350).collect::<String>());
            }
            std::process::exit(1);
        }
    }
}
