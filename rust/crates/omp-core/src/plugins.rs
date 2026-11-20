use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::{CoreError, Result};
use crate::models::CliContext;
use crate::projects;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_definition: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWarning {
    pub scope: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub skills: Vec<SkillRecord>,
    pub warnings: Vec<PluginWarning>,
}

fn parse_frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Some(rest) = text.strip_prefix("---") else {
        return fields;
    };
    let Some((header, _)) = rest.split_once("\n---") else {
        return fields;
    };
    for line in header.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        fields.insert(
            key.trim().to_string(),
            value.trim().trim_matches('"').to_string(),
        );
    }
    fields
}

fn first_heading(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| {
            line.strip_prefix("# ")
                .map(|heading| heading.trim().to_string())
        })
        .filter(|heading| !heading.is_empty())
}

fn discover_skills(root: &Path, location: &str, skills: &mut Vec<SkillRecord>) {
    let directories = [
        root.join(".omp").join("skills"),
        root.join(".agents").join("skills"),
    ];
    for directory in directories {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_file = path.join("SKILL.md");
                if let Ok(text) = std::fs::read_to_string(&skill_file) {
                    let fields = parse_frontmatter(&text);
                    let name = fields
                        .get("name")
                        .cloned()
                        .or_else(|| {
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .map(str::to_string)
                        })
                        .unwrap_or_else(|| "Skill".to_string());
                    skills.push(SkillRecord {
                        id: format!("skill:{location}:{name}"),
                        name,
                        description: fields.get("description").cloned().unwrap_or_default(),
                        kind: "skill".to_string(),
                        location: location.to_string(),
                        path: Some(skill_file.display().to_string()),
                        enabled: true,
                        source: None,
                        definition_key: None,
                        mcp_definition: None,
                    });
                }
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let name = first_heading(&text)
                    .or_else(|| {
                        path.file_stem()
                            .and_then(|name| name.to_str())
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "Skill".to_string());
                skills.push(SkillRecord {
                    id: format!("skill:{location}:{name}"),
                    name,
                    description: String::new(),
                    kind: "skill".to_string(),
                    location: location.to_string(),
                    path: Some(path.display().to_string()),
                    enabled: true,
                    source: None,
                    definition_key: None,
                    mcp_definition: None,
                });
            }
        }
    }
}

fn plugins_lock_file(plugins_root: &Path) -> PathBuf {
    plugins_root.join("omp-plugins.lock.json")
}

fn discover_packages(plugins_root: &Path, location: &str, skills: &mut Vec<SkillRecord>) {
    let modules = plugins_root.join("node_modules");
    let Ok(entries) = std::fs::read_dir(&modules) else {
        return;
    };
    // The CLI records install/enable state in `omp-plugins.lock.json`; a
    // missing or unreadable file leaves every discovered package enabled.
    let lock = read_json_file(&plugins_lock_file(plugins_root), "plugin settings")
        .unwrap_or_else(|_| json!({}));
    let runtime = lock.get("plugins").and_then(Value::as_object);
    for entry in entries.flatten() {
        let path = entry.path();
        let package_file = path.join("package.json");
        let Ok(text) = std::fs::read_to_string(&package_file) else {
            continue;
        };
        let Ok(Value::Object(package)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(name) = package
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let description = package
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let directory = path.file_name().and_then(|name| name.to_str());
        let state = runtime.and_then(|plugins| {
            plugins
                .get(name)
                .or_else(|| directory.and_then(|directory| plugins.get(directory)))
        });
        let enabled = state
            .and_then(|state| state.get("enabled"))
            .and_then(Value::as_bool)
            != Some(false);
        skills.push(SkillRecord {
            id: format!("package:{location}:{name}"),
            name: name.to_string(),
            description: description.to_string(),
            kind: "package".to_string(),
            location: location.to_string(),
            path: Some(package_file.display().to_string()),
            enabled,
            source: Some("npm".to_string()),
            definition_key: Some(name.to_string()),
            mcp_definition: None,
        });
    }
}

fn read_json_file(path: &Path, label: &str) -> Result<Value> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => {
            return Err(CoreError::io(&format!("Could not inspect {label}"), error));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::invalid(format!(
            "{label} must be a regular file, not a symlink"
        )));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| CoreError::io(&format!("Could not read {label}"), error))?;
    serde_json::from_str::<Value>(&text)
        .map_err(|error| CoreError::invalid(format!("{label} are not valid JSON: {error}")))
}

fn mcp_servers(file: &Value) -> Map<String, Value> {
    file.get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn discover_mcp(file: &Value, location: &str, skills: &mut Vec<SkillRecord>) {
    let servers = mcp_servers(file);
    let disabled: Vec<&str> = file
        .get("disabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let enabled_list: Vec<&str> = file
        .get("enabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for (name, definition) in servers {
        let definition = definition.as_object().cloned().unwrap_or_default();
        let enabled = !disabled.contains(&name.as_str())
            && (enabled_list.is_empty()
                || enabled_list.contains(&name.as_str())
                || definition.get("enabled").and_then(Value::as_bool) == Some(true));
        let transport = if definition.contains_key("url") {
            definition
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("http")
                .to_string()
        } else {
            "stdio".to_string()
        };
        let mut summary = Map::new();
        summary.insert("transport".to_string(), Value::String(transport));
        if let Some(command) = definition.get("command").and_then(Value::as_str) {
            summary.insert("command".to_string(), Value::String(command.to_string()));
        }
        if let Some(args) = definition.get("args").and_then(Value::as_array) {
            summary.insert("args".to_string(), Value::Array(args.clone()));
        }
        if let Some(url) = definition.get("url").and_then(Value::as_str) {
            summary.insert("url".to_string(), Value::String(url.to_string()));
        }
        if let Some(headers) = definition.get("headers").and_then(Value::as_object) {
            summary.insert(
                "headerNames".to_string(),
                Value::Array(
                    headers
                        .keys()
                        .map(|key| Value::String(key.clone()))
                        .collect(),
                ),
            );
        }
        skills.push(SkillRecord {
            id: format!("mcp:{location}:{name}"),
            name: name.clone(),
            description: "MCP server".to_string(),
            kind: "mcp".to_string(),
            location: location.to_string(),
            path: None,
            enabled,
            source: None,
            definition_key: Some(name),
            mcp_definition: Some(Value::Object(summary)),
        });
    }
}

pub fn discover(agent_dir: &Path, project_path: Option<&Path>) -> PluginCatalog {
    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    if let Some(project) = project_path {
        discover_skills(project, "project", &mut skills);
        discover_packages(
            &plugins_root(agent_dir, Some(project)),
            "project",
            &mut skills,
        );
        let project_mcp = project.join(".omp").join("mcp.json");
        if project_mcp.exists() {
            match read_json_file(&project_mcp, "MCP settings") {
                Ok(value) => discover_mcp(&value, "project", &mut skills),
                Err(error) => warnings.push(PluginWarning {
                    scope: "project".to_string(),
                    path: project_mcp.display().to_string(),
                    message: error.message,
                }),
            }
        }
    }
    discover_skills(agent_dir, "user", &mut skills);
    discover_packages(&plugins_root(agent_dir, None), "user", &mut skills);
    let user_mcp = agent_dir.join("mcp.json");
    if user_mcp.exists() {
        match read_json_file(&user_mcp, "MCP settings") {
            Ok(value) => discover_mcp(&value, "user", &mut skills),
            Err(error) => warnings.push(PluginWarning {
                scope: "user".to_string(),
                path: user_mcp.display().to_string(),
                message: error.message,
            }),
        }
    }
    if let Ok(entries) = std::fs::read_dir(agent_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("mcp.json.") {
                continue;
            }
            let path = entry.path();
            let valid = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .is_some();
            if !valid {
                warnings.push(PluginWarning {
                    scope: "user".to_string(),
                    path: path.display().to_string(),
                    message: "invalid MCP config: the file is not valid JSON".to_string(),
                });
            }
        }
    }
    PluginCatalog { skills, warnings }
}

fn mcp_file(agent_dir: &Path, project: Option<&Path>, scope: &str) -> Result<PathBuf> {
    match scope {
        "user" => Ok(agent_dir.join("mcp.json")),
        "project" => {
            let project = project
                .ok_or_else(|| CoreError::invalid("MCP project scope requires projectPath"))?;
            Ok(project.join(".omp").join("mcp.json"))
        }
        _ => Err(CoreError::invalid("MCP scope must be user or project")),
    }
}

fn plugins_root(agent_dir: &Path, project: Option<&Path>) -> PathBuf {
    match project {
        Some(project) => project.join(".omp").join("plugins"),
        None => agent_dir
            .parent()
            .map(|root| root.join("plugins"))
            .unwrap_or_else(|| agent_dir.join("plugins")),
    }
}

fn write_json(path: &Path, value: &Value, label: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        if let Ok(metadata) = std::fs::symlink_metadata(parent)
            && metadata.file_type().is_symlink()
        {
            return Err(CoreError::invalid(format!(
                "{label} directory must not be a symlink"
            )));
        }
        std::fs::create_dir_all(parent).map_err(|error| {
            CoreError::io(&format!("Could not create the {label} directory"), error)
        })?;
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(CoreError::invalid(format!("{label} must not be a symlink")));
    }
    let serialized = format!("{}\n", serde_json::to_string_pretty(value)?);
    let temp = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings.json"),
        std::process::id()
    ));
    std::fs::write(&temp, serialized)
        .map_err(|error| CoreError::io(&format!("Could not write {label}"), error))?;
    std::fs::rename(&temp, path)
        .map_err(|error| CoreError::io(&format!("Could not publish {label}"), error))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

pub fn connect_mcp(
    agent_dir: &Path,
    store: &crate::state::StateStore,
    platform: crate::state::Platform,
    input: &Value,
) -> Result<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::invalid("MCP connection must be an object"))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("MCP server name is required"))?;
    if !valid_name(name) {
        return Err(CoreError::invalid(
            "MCP server name contains unsupported characters",
        ));
    }
    let scope = object
        .get("scope")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("MCP scope must be user or project"))?;
    let project = match scope {
        "project" => {
            let path = object
                .get("projectPath")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::invalid("MCP project scope requires projectPath"))?;
            Some(projects::authorize_path(store, Path::new(path), platform)?)
        }
        "user" => None,
        _ => return Err(CoreError::invalid("MCP scope must be user or project")),
    };
    let path = mcp_file(agent_dir, project.as_deref(), scope)?;
    let mut file = read_json_file(&path, "MCP settings")?;
    if !file.is_object() {
        file = json!({});
    }
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("create");
    let existing = file
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(name))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if mode != "replace" && !existing.is_empty() {
        return Err(CoreError::invalid(
            "MCP server already exists; use replace mode to edit it",
        ));
    }
    let mut definition = Map::new();
    match object.get("type").and_then(Value::as_str) {
        Some("stdio") => {
            if object.contains_key("url") {
                return Err(CoreError::invalid(
                    "MCP stdio definitions cannot include a URL",
                ));
            }
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .filter(|command| !command.is_empty() && !command.starts_with('-'))
                .ok_or_else(|| CoreError::invalid("MCP command is invalid"))?;
            definition.insert("command".to_string(), Value::String(command.to_string()));
            if let Some(args) = object.get("args").and_then(Value::as_array) {
                definition.insert("args".to_string(), Value::Array(args.clone()));
            }
        }
        Some("http") | Some("sse") => {
            if object.contains_key("command") {
                return Err(CoreError::invalid(
                    "MCP network definitions cannot include a command",
                ));
            }
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| CoreError::invalid("MCP endpoint URL is invalid"))?;
            let parsed = crate::url_policy::parse_http_url(url, "MCP endpoint URL")?;
            let loopback =
                crate::url_policy::is_loopback_or_private(parsed.host_str().unwrap_or_default());
            if parsed.scheme() == "http" {
                if !loopback {
                    return Err(CoreError::invalid(
                        "Public MCP endpoints must use https; plain http is only allowed for loopback or private-network addresses",
                    ));
                }
                if object.get("allowInsecureHttp").and_then(Value::as_bool) != Some(true) {
                    return Err(CoreError::invalid(
                        "Plain http requires the explicit insecure-http acknowledgement",
                    ));
                }
            }
            definition.insert(
                "type".to_string(),
                Value::String(
                    object
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("http")
                        .to_string(),
                ),
            );
            definition.insert("url".to_string(), Value::String(url.to_string()));
            if let Some(headers) = object.get("headers").and_then(Value::as_object) {
                definition.insert("headers".to_string(), Value::Object(headers.clone()));
            }
        }
        _ => {
            return Err(CoreError::invalid(
                "MCP transport must be stdio, http, or sse",
            ));
        }
    }
    if mode == "replace" {
        for key in ["auth", "oauth"] {
            if let Some(value) = existing.get(key) {
                definition.insert(key.to_string(), value.clone());
            }
        }
        if !definition.contains_key("headers")
            && let Some(headers) = existing.get("headers")
        {
            definition.insert("headers".to_string(), headers.clone());
        }
    }
    let root = file.as_object_mut().expect("object");
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers
        .as_object_mut()
        .expect("servers object")
        .insert(name.to_string(), Value::Object(definition));
    write_json(&path, &file, "MCP settings")?;
    Ok(json!({ "ok": true }))
}

pub fn set_mcp_enabled(
    agent_dir: &Path,
    store: &crate::state::StateStore,
    platform: crate::state::Platform,
    input: &Value,
) -> Result<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::invalid("MCP state must be an object"))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("MCP server name is required"))?;
    let scope = object
        .get("scope")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("MCP scope must be user or project"))?;
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| CoreError::invalid("MCP enabled state must be a boolean"))?;
    let project = match scope {
        "project" => {
            let path = object
                .get("projectPath")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::invalid("MCP project scope requires projectPath"))?;
            Some(projects::authorize_path(store, Path::new(path), platform)?)
        }
        "user" => None,
        _ => return Err(CoreError::invalid("MCP scope must be user or project")),
    };
    let path = mcp_file(agent_dir, project.as_deref(), scope)?;
    let mut file = read_json_file(&path, "MCP settings")?;
    let root = file
        .as_object_mut()
        .ok_or_else(|| CoreError::invalid("MCP settings are not an object"))?;
    let mut disabled: Vec<String> = root
        .get("disabledServers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut enabled_servers: Vec<String> = root
        .get("enabledServers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    disabled.retain(|item| item != name);
    enabled_servers.retain(|item| item != name);
    if enabled {
        enabled_servers.push(name.to_string());
    } else {
        disabled.push(name.to_string());
    }
    root.insert(
        "disabledServers".to_string(),
        Value::Array(disabled.into_iter().map(Value::String).collect()),
    );
    root.insert(
        "enabledServers".to_string(),
        Value::Array(enabled_servers.into_iter().map(Value::String).collect()),
    );
    write_json(&path, &file, "MCP settings")?;
    Ok(json!({ "ok": true }))
}

pub fn mutate_capability(
    agent_dir: &Path,
    store: &crate::state::StateStore,
    platform: crate::state::Platform,
    input: &Value,
) -> Result<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::invalid("Capability mutation must be an object"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind != "mcp" && kind != "package" {
        return Err(CoreError::invalid("Capability kind is invalid"));
    }
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("Capability name is required"))?;
    let scope = object
        .get("scope")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("Capability scope must be user or project"))?;
    let project = match scope {
        "project" => {
            let path = object
                .get("projectPath")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::invalid("Capability project scope requires projectPath")
                })?;
            Some(projects::authorize_path(store, Path::new(path), platform)?)
        }
        "user" => None,
        _ => {
            return Err(CoreError::invalid(
                "Capability scope must be user or project",
            ));
        }
    };
    if kind == "mcp" && action == "remove" {
        let path = mcp_file(agent_dir, project.as_deref(), scope)?;
        let mut file = read_json_file(&path, "MCP settings")?;
        if let Some(servers) = file.get_mut("mcpServers").and_then(Value::as_object_mut) {
            servers.remove(name);
        }
        write_json(&path, &file, "MCP settings")?;
        return Ok(json!({ "ok": true }));
    }
    if kind == "package" {
        // `omp plugin enable|disable` records the switch in the plugin
        // runtime lock next to the installed packages; discovery reads the
        // same file so the row reflects what the CLI would load.
        let enabled = match action {
            "enable" => true,
            "disable" => false,
            _ => return Err(CoreError::invalid("Capability action is invalid")),
        };
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(CoreError::invalid("Capability name is invalid"));
        }
        let root = plugins_root(agent_dir, project.as_deref());
        let path = plugins_lock_file(&root);
        let mut file = read_json_file(&path, "plugin settings")?;
        if !file.is_object() {
            file = json!({});
        }
        let installed = root
            .join("node_modules")
            .join(name)
            .join("package.json")
            .is_file();
        let known = file
            .get("plugins")
            .and_then(Value::as_object)
            .is_some_and(|plugins| plugins.contains_key(name));
        if !installed && !known {
            return Err(CoreError::invalid(format!(
                "Package {name} is not installed"
            )));
        }
        let root_object = file.as_object_mut().expect("object");
        let plugins = root_object.entry("plugins").or_insert_with(|| json!({}));
        if !plugins.is_object() {
            *plugins = json!({});
        }
        let entry = plugins
            .as_object_mut()
            .expect("plugins object")
            .entry(name.to_string())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        entry
            .as_object_mut()
            .expect("package state")
            .insert("enabled".to_string(), Value::Bool(enabled));
        write_json(&path, &file, "plugin settings")?;
        return Ok(json!({ "ok": true }));
    }
    Ok(json!({ "ok": true }))
}

pub fn install(context: &CliContext, source: &str) -> Result<Value> {
    if !source.starts_with("npm:") {
        return Err(CoreError::invalid("Only npm package sources are supported"));
    }
    let target = source
        .strip_prefix("npm:")
        .or_else(|| source.strip_prefix("git:"))
        .unwrap_or(source);
    let mut command = Command::new(&context.executable);
    command.args(["plugin", "install", target, "--json"]);
    command.env("HOME", &context.home_dir);
    command.env("USERPROFILE", &context.home_dir);
    command.env("OMP_FIXTURE_HOME", &context.home_dir);
    command.env(
        "OMP_FIXTURE_STATE_DIR",
        context.root_dir.join("fixture-state"),
    );
    for (key, value) in &context.extra_env {
        command.env(key, value);
    }
    let output = command
        .output()
        .map_err(|error| CoreError::io("Could not run omp plugin install", error))?;
    Ok(json!({ "ok": output.status.success() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, crate::state::StateStore) {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let home = temp.path().join("home");
        let agent_dir = home.join(".omp").join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let package = home
            .join(".omp")
            .join("plugins")
            .join("node_modules")
            .join("demo-package");
        std::fs::create_dir_all(&package).expect("package dir");
        std::fs::write(
            package.join("package.json"),
            json!({ "name": "demo-package", "description": "Demo package" }).to_string(),
        )
        .expect("package manifest");
        let store = crate::state::StateStore::open(
            temp.path().join("user-data").join("state.json"),
            None,
            crate::state::Platform::Linux,
        )
        .expect("store");
        (temp, agent_dir, store)
    }

    fn package_row(agent_dir: &Path, name: &str) -> SkillRecord {
        discover(agent_dir, None)
            .skills
            .into_iter()
            .find(|skill| skill.kind == "package" && skill.name == name)
            .unwrap_or_else(|| panic!("{name} package row"))
    }

    fn toggle(action: &str, name: &str) -> Value {
        json!({ "kind": "package", "action": action, "name": name, "scope": "user" })
    }

    #[test]
    fn package_toggles_persist_to_the_plugin_lock_and_discovery_follows() {
        let (_temp, agent_dir, store) = fixture();
        let lock_path = plugins_lock_file(&plugins_root(&agent_dir, None));
        assert!(package_row(&agent_dir, "demo-package").enabled);

        // Keep a CLI-shaped entry so the mutation can prove it preserves the
        // fields `omp plugin` writes alongside `enabled`.
        std::fs::create_dir_all(lock_path.parent().expect("plugins root")).expect("plugins root");
        std::fs::write(
            &lock_path,
            json!({
                "plugins": {
                    "demo-package": { "enabled": true, "enabledFeatures": ["skills"], "version": "1.0.0" }
                },
                "settings": {}
            })
            .to_string(),
        )
        .expect("lock");

        mutate_capability(
            &agent_dir,
            &store,
            crate::state::Platform::Linux,
            &toggle("disable", "demo-package"),
        )
        .expect("disable");
        let lock: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).expect("read lock"))
                .expect("lock json");
        assert_eq!(lock["plugins"]["demo-package"]["enabled"], json!(false));
        assert_eq!(lock["plugins"]["demo-package"]["version"], json!("1.0.0"));
        assert_eq!(
            lock["plugins"]["demo-package"]["enabledFeatures"],
            json!(["skills"])
        );
        assert_eq!(lock["settings"], json!({}));
        assert!(!package_row(&agent_dir, "demo-package").enabled);

        mutate_capability(
            &agent_dir,
            &store,
            crate::state::Platform::Linux,
            &toggle("enable", "demo-package"),
        )
        .expect("enable");
        let lock: Value =
            serde_json::from_str(&std::fs::read_to_string(&lock_path).expect("read lock"))
                .expect("lock json");
        assert_eq!(lock["plugins"]["demo-package"]["enabled"], json!(true));
        assert!(package_row(&agent_dir, "demo-package").enabled);
    }

    #[test]
    fn package_mutations_reject_unknown_names_and_actions() {
        let (_temp, agent_dir, store) = fixture();
        let lock_path = plugins_lock_file(&plugins_root(&agent_dir, None));

        let error = mutate_capability(
            &agent_dir,
            &store,
            crate::state::Platform::Linux,
            &toggle("disable", "missing-package"),
        )
        .expect_err("unknown package");
        assert!(error.message.contains("not installed"), "{}", error.message);

        let error = mutate_capability(
            &agent_dir,
            &store,
            crate::state::Platform::Linux,
            &toggle("remove", "demo-package"),
        )
        .expect_err("unknown action");
        assert!(
            error.message.contains("action is invalid"),
            "{}",
            error.message
        );

        assert!(!lock_path.exists());
    }
}
