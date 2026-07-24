//! Live smoke test for the HTTP client. Reads `BRAIN_API_URL` + `BRAIN_API_KEY`
//! from the environment.
//!
//!   BRAIN_API_URL=http://127.0.0.1:8080 BRAIN_API_KEY=brain_… \
//!       cargo run --example http_smoke

use brain_db_sdk::http::{BrainHttpClient, EncodeInput, Endpoint, ReasonInput, RecallInput};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("BRAIN_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let key = std::env::var("BRAIN_API_KEY").expect("set BRAIN_API_KEY");
    let brain = BrainHttpClient::new(url.clone(), key);

    let who = brain.whoami().await?;
    println!("whoami       {} {}", who.namespace, who.space_id);

    let caps = brain.capabilities().await?;
    println!("capabilities vector_dim={} llm={}", caps.vector_dim, caps.llm_extractor);

    let enc = brain
        .encode(&EncodeInput {
            text: "Rust SDK test: the kettle whistled.".into(),
            ..Default::default()
        })
        .await?;
    println!("encode       {} dedup={}", enc.memory_id, enc.was_deduplicated);

    let rec = brain
        .recall(&RecallInput {
            query: "what whistled?".into(),
            max_results: Some(3),
            ..Default::default()
        })
        .await?;
    println!(
        "recall       {} -> {}",
        rec.answer_kind,
        rec.memories.first().map_or("-", |m| m.text.as_str())
    );

    let rea = brain
        .reason(&ReasonInput {
            observation: Endpoint::text("the kettle whistled"),
            ..Default::default()
        })
        .await?;
    println!("reason       {} inference(s)", rea.inferences.len());

    match BrainHttpClient::new(url, "brain_bogus").whoami().await {
        Err(e) => println!("bad key      status={} code={}", e.status, e.code),
        Ok(_) => println!("bad key      unexpectedly ok"),
    }
    Ok(())
}
