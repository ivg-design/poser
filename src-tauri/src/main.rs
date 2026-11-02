// Poser — deterministic Rive MCP client. No AI, no agent: the frontend
// builds JSON-RPC tools/call payloads and this command POSTs them to the
// Rive editor's MCP server. Rig manifests (what each bind created) are JSON
// files in the app data folder, shared with tools/poser-cli.mjs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const MCP_URL: &str = "http://127.0.0.1:9791/mcp";

fn post(payload: &str) -> Result<String, String> {
    let resp = ureq::post(MCP_URL)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send_string(payload)
        .map_err(|e| format!("MCP request failed: {e}"))?;
    resp.into_string()
        .map_err(|e| format!("MCP response read failed: {e}"))
}

// The Rive MCP server requires the initialize handshake after every editor
// restart; until then tools/call returns 400 "Server not initialized".
fn handshake() -> Result<(), String> {
    post(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"poser","version":"3.0.0"}}}"#)?;
    // Notification: server replies 202 with an empty body; errors are fine to ignore.
    let _ = post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    Ok(())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn mcp_call(payload: String) -> Result<String, String> {
    match post(&payload) {
        Ok(body) => Ok(body),
        Err(_) => {
            // Editor may have restarted since our last call — re-handshake
            // and retry the original request once.
            handshake()?;
            post(&payload)
        }
    }
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
        .invoke_handler(tauri::generate_handler![mcp_call, app_version, rig_list, rig_save, rig_remove])
        .run(tauri::generate_context!())
        .expect("error while running poser");
}
