// Poser — deterministic Rive MCP client. No AI, no agent: the frontend
// builds JSON-RPC tools/call payloads and this command POSTs them to the
// Rive editor's MCP server. Rig manifests (what each bind created) are JSON
// files in the app data folder, shared with tools/poser-cli.mjs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::Manager;

const MCP_URL: &str = "http://127.0.0.1:9791/mcp";

// The server hands out a session id on initialize and answers 400 to any
// later request that does not carry it.
static SESSION: Mutex<Option<String>> = Mutex::new(None);

fn post(payload: &str) -> Result<String, String> {
    let mut req = ureq::post(MCP_URL)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream");
    if let Some(sid) = SESSION.lock().unwrap().clone() {
        req = req.set("mcp-session-id", &sid);
    }
    let resp = req
        .send_string(payload)
        .map_err(|e| format!("MCP request failed: {e}"))?;
    if let Some(sid) = resp.header("mcp-session-id") {
        *SESSION.lock().unwrap() = Some(sid.to_string());
    }
    resp.into_string()
        .map_err(|e| format!("MCP response read failed: {e}"))
}

// The Rive MCP server requires the initialize handshake after every editor
// restart; until then tools/call returns 400 "Server not initialized".
fn handshake() -> Result<(), String> {
    *SESSION.lock().unwrap() = None;
    post(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"poser","version":"3.0.0"}}}"#)?;
    // Notification: server replies 202 with an empty body; errors are fine to ignore.
    let _ = post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    Ok(())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// Every MCP request goes into mcp.log in the app's log folder (~/Library/Logs/design.ivg.poser on
// macOS) before it is sent, and its answer after, so an editor crash can be traced to the request
// that came last. The log moves to mcp.old.log once it passes 5 MB.
fn clip(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect::<String>().replace('\n', " ");
    if s.chars().count() > n {
        out.push_str("...");
    }
    out
}

fn log_line(app: &tauri::AppHandle, line: String) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("mcp.log");
    if fs::metadata(&path).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("mcp.old.log"));
    }
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ms} {line}");
    }
}

// what the panel told the user, next to the requests that led to it
#[tauri::command]
fn log_note(app: tauri::AppHandle, line: String) {
    log_line(&app, format!("# {}", clip(&line, 1000)));
}

#[tauri::command]
fn mcp_call(app: tauri::AppHandle, payload: String) -> Result<String, String> {
    let started = Instant::now();
    log_line(&app, format!("> {}", clip(&payload, 700)));
    let result = match post(&payload) {
        Ok(body) => Ok(body),
        Err(_) => {
            // Editor may have restarted since our last call — re-handshake
            // and retry the original request once.
            log_line(&app, "~ retrying after a new handshake".into());
            handshake().and_then(|_| post(&payload))
        }
    };
    let took = started.elapsed().as_millis();
    match &result {
        Ok(body) => log_line(&app, format!("< {took} ms {} bytes {}", body.len(), clip(body, 240))),
        Err(e) => log_line(&app, format!("! {took} ms {}", clip(e, 300))),
    }
    result
}

fn rigs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("rigs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn rig_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    Ok(rigs_dir(app)?.join(format!("{safe}.json")))
}

#[tauri::command]
fn rig_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(rigs_dir(&app)?).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|x| x == "json") {
            out.push(fs::read_to_string(&path).map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

#[tauri::command]
fn rig_save(app: tauri::AppHandle, name: String, json: String) -> Result<(), String> {
    fs::write(rig_file(&app, &name)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn rig_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = rig_file(&app, &name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![mcp_call, log_note, app_version, rig_list, rig_save, rig_remove])
        .run(tauri::generate_context!())
        .expect("error while running poser");
}
