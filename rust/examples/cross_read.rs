//! Read a live brain-db corpus through the Rust SDK and print a digest.
//!
//! The same corpus is read through the Python and TypeScript SDKs. Three
//! independent codecs reporting the same counts over one server's bytes is
//! the evidence that the wire types agree in practice; a field-list
//! comparator reads declarations, not bytes, and cannot give it.
//!
//!   KEYFILE=/path/to/token PORT=18080 cargo run --example cross_read

use brain_db_sdk::wire::types::{
    EntityListRequest, ExtractorListRequest, MemoryListDirWire, MemoryListRequest,
    MemoryListSortWire, MemoryListTimeAxisWire, RecallRequest, RecallScopeWire, SchemaGetRequest,
    SpaceListRequest,
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

fn list_req(text_contains: &str) -> MemoryListRequest {
    MemoryListRequest {
        sort: MemoryListSortWire::Created,
        dir: MemoryListDirWire::Asc,
        limit: 100,
        cursor: Vec::new(),
        kinds: Vec::new(),
        include_tombstoned: false,
        time_axis: MemoryListTimeAxisWire::Created,
        from_unix_nanos: 0,
        to_unix_nanos: 0,
        salience_min: 0.0,
        salience_max: 1.0,
        text_contains: text_contains.to_string(),
        act_as: None,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = std::fs::read_to_string(std::env::var("KEYFILE")?)?
        .trim()
        .to_string();
    let port = std::env::var("PORT").unwrap_or_else(|_| "18080".into());
    let c = BrainClient::connect(
        format!("127.0.0.1:{port}").parse()?,
        Auth::Token(key.into_bytes()),
    )
    .await?;
    println!("namespace            {}", c.connection().namespace);

    let rows = c.memory_list(&list_req("")).await?;
    println!("memory_list_count    {}", rows.len());
    for r in rows.iter().take(3) {
        println!("  memory_id          {}", r.memory_id);
    }

    let hits = c
        .recall(&RecallRequest {
            cue_text: "what does Priya prefer?".into(),
            subject_name: String::new(),
            max_results: 5,
            confidence_threshold: 0.0,
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
            scope: RecallScopeWire::default(),
        })
        .await?;
    println!("recall_count         {}", hits.memories.len());

    let ents = c
        .list_entities(&EntityListRequest {
            entity_type_id: 1,
            name_prefix: String::new(),
            mention_count_min: 0,
            include_tombstoned: false,
            include_merged: false,
            limit: 20,
            cursor: Vec::new(),
            act_as: None,
        })
        .await?;
    println!("entity_list_count    {}", ents.len());

    let ext = c.extractor_list(&ExtractorListRequest::default()).await?;
    let mut qnames: Vec<String> = ext
        .items
        .iter()
        .map(|i| format!("{}:{}", i.namespace, i.name))
        .collect();
    qnames.sort();
    println!("extractors           {qnames:?}");

    let spaces = c
        .list_spaces(&SpaceListRequest {
            limit: 10,
            act_as: None,
        })
        .await?;
    println!("space_count          {}", spaces.spaces.len());

    let schema = c
        .get_schema(&SchemaGetRequest {
            namespace: "acme".into(),
            version: 0,
            act_as: None,
        })
        .await?;
    println!("schema_version       {}", schema.schema_version);

    // The v1.0 narrowing must look the same from here as from the other SDKs.
    match c.memory_list(&list_req("metformin")).await {
        Ok(_) => println!("text_filter          ACCEPTED"),
        Err(e) => println!(
            "text_filter          {}",
            &format!("{e}")[..60.min(format!("{e}").len())]
        ),
    }
    Ok(())
}
