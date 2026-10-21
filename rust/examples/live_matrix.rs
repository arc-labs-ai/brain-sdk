//! Exercise brain-db through the Rust SDK: sizes, context recall, relations,
//! and the failure paths. Run against a live server:
//!   KEYFILE=... cargo run --example live_matrix
use brain_db_sdk::wire::types::{
    EdgeKindWire, EncodeRequest, LinkRequest, MemoryInspectRequest, RecallRequest, RecallScopeWire,
    UnlinkRequest,
};
use brain_db_sdk::{Auth, BrainClient};

fn rid() -> [u8; 16] {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut b = [0u8; 16];
    b.copy_from_slice(&n.to_be_bytes());
    b
}

fn enc_req(text: String) -> EncodeRequest {
    EncodeRequest {
        text,
        session_id: 1,
        request_id: rid(),
        txn_id: None,
        occurred_at_unix_nanos: None,
        act_as: None,
        wait: brain_db_sdk::wire::types::WaitMode::Ack,
        allow_duplicates: false,
    }
}

fn recall_req(cue: &str, threshold: f32) -> RecallRequest {
    RecallRequest {
        cue_text: cue.to_string(),
        subject_name: String::new(),
        max_results: 5,
        confidence_threshold: threshold,
        session_filter: None,
        age_bound_unix_nanos: None,
        as_of_record_time_unix_nanos: None,
        kind_filter: None,
        salience_floor: 0.0,
        include_edges: false,
        include_graph: false,
        include_text: true,
        request_id: Some(rid()),
        txn_id: None,
        trace: false,
        act_as: None,
        scope: RecallScopeWire::Space,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = std::fs::read_to_string(std::env::var("KEYFILE")?)?
        .trim()
        .to_string();
    let c = BrainClient::connect("127.0.0.1:18092".parse()?, Auth::Token(key.into_bytes())).await?;
    println!("connected: namespace={}", c.connection().namespace);
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();

    // ---- sizes ----------------------------------------------------------
    let mut ids = vec![];
    for (label, text) in [
        ("small 24B", format!("Rust tiny {n}")),
        ("medium 4KB", format!("Rust medium {n}. ").repeat(230)),
        ("large 200KB", format!("Rust large {n}. ").repeat(13000)),
    ] {
        match c.encode(&enc_req(text)).await {
            Ok(r) => {
                println!(
                    "{:<22} ok        id={} dedup={}",
                    label, r.memory_id, r.was_deduplicated
                );
                ids.push(r.memory_id);
            }
            Err(e) => println!("{label:<22} ERR       {e}"),
        }
    }
    for (label, text) in [("empty", String::new()), ("2MB", "x".repeat(2_000_000))] {
        match c.encode(&enc_req(text)).await {
            Ok(_) => println!("{label:<22} UNEXPECTED ok"),
            Err(e) => println!(
                "{:<22} rejected  {}",
                label,
                e.to_string().chars().take(78).collect::<String>()
            ),
        }
    }

    // ---- context recall across thresholds --------------------------------
    c.encode(&enc_req(format!(
        "Rafael brews kombucha in a Porto garage. {n}"
    )))
    .await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    for cue in ["What does Rafael brew?", "How deep is the Mariana Trench?"] {
        for thr in [0.0f32, 0.7] {
            let a = c.recall(&recall_req(cue, thr)).await?;
            println!(
                "recall thr={thr:<4} {:<34} {:?} n={}",
                &cue[..cue.len().min(34)],
                a.answer_kind,
                a.memories.len()
            );
        }
    }

    // ---- relations -------------------------------------------------------
    if ids.len() >= 2 {
        let (a, b) = (ids[0], ids[1]);
        for kind in [EdgeKindWire::Caused, EdgeKindWire::DerivedFrom] {
            let r = c
                .link(&LinkRequest {
                    source: a,
                    target: b,
                    kind,
                    weight: 1.0,
                    request_id: rid(),
                    txn_id: None,
                    act_as: None,
                })
                .await?;
            println!(
                "link {:<17?} ok        already_existed={}",
                kind, r.already_existed
            );
        }
        let insp = c
            .memory_inspect(&MemoryInspectRequest {
                memory_id: a.to_be_bytes(),
                act_as: None,
            })
            .await?;
        println!(
            "edges read back        n={} kinds={:?}",
            insp.edges.len(),
            insp.edges.iter().map(|e| e.kind).collect::<Vec<_>>()
        );
        let peer_ok = insp.edges.iter().any(|e| e.peer == b);
        println!("peer matches target    {peer_ok}");

        c.unlink(&UnlinkRequest {
            source: a,
            target: b,
            kind: EdgeKindWire::Caused,
            request_id: rid(),
            txn_id: None,
            act_as: None,
        })
        .await?;
        let after = c
            .memory_inspect(&MemoryInspectRequest {
                memory_id: a.to_be_bytes(),
                act_as: None,
            })
            .await?;
        let gone = !after
            .edges
            .iter()
            .any(|e| e.kind == EdgeKindWire::Caused && e.peer == b);
        println!(
            "after unlink           caused_gone={gone} n={}",
            after.edges.len()
        );

        match c
            .link(&LinkRequest {
                source: a,
                target: 99_999_999_999,
                kind: EdgeKindWire::Caused,
                weight: 1.0,
                request_id: rid(),
                txn_id: None,
                act_as: None,
            })
            .await
        {
            Ok(_) => println!("link unknown target    UNEXPECTED ok"),
            Err(e) => println!(
                "link unknown target    rejected  {}",
                e.to_string().chars().take(70).collect::<String>()
            ),
        }
    }
    let miss = c
        .memory_inspect(&MemoryInspectRequest {
            memory_id: 12345u128.to_be_bytes(),
            act_as: None,
        })
        .await?;
    println!("inspect unknown id     found={}", miss.found);
    Ok(())
}
