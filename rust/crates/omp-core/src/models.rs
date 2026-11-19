use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};
use crate::settings::PRIME_THINKING_LEVELS;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub key: String,
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub context_window: u64,
    pub max_tokens: u64,
    pub available_thinking_levels: Vec<String>,
    pub fast_mode_supported: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub auth_method: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreset {
    pub name: String,
    pub model_roles: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub prime_version: String,
    pub refreshed_at: String,
    pub models: Vec<ModelDescriptor>,
    pub providers: Vec<ProviderDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_delegation: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<ModelPreset>,
}

pub struct CliContext {
    pub executable: PathBuf,
    pub home_dir: PathBuf,
    pub root_dir: PathBuf,
    pub extra_env: Vec<(String, String)>,
}

fn command(context: &CliContext, args: &[&str]) -> Command {
    let mut command = Command::new(&context.executable);
    command.args(args);
    command.env("HOME", &context.home_dir);
    command.env("USERPROFILE", &context.home_dir);
    command.env("OMP_BINARY", &context.executable);
    command.env("OMP_FIXTURE_HOME", &context.home_dir);
    command.env(
        "OMP_FIXTURE_STATE_DIR",
        context.root_dir.join("fixture-state"),
    );
    command.env("NO_COLOR", "1");
    for (key, value) in &context.extra_env {
        command.env(key, value);
    }
    command
}

fn run(mut command: Command) -> Result<String> {
    let output = command
        .output()
        .map_err(|error| CoreError::io("Could not run the omp CLI", error))?;
    if !output.status.success() {
        return Err(CoreError::new(
            "Error",
            format!(
                "omp exited with status {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn safe_provider(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || value.len() > 128 {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn safe_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '+' | '-'))
}

fn thinking_levels(reasoning: bool, thinking: Option<&Value>) -> Vec<String> {
    if !reasoning {
        return vec!["off".to_string()];
    }
    let reported: Vec<&str> = thinking
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    PRIME_THINKING_LEVELS
        .iter()
        .filter(|level| **level == "off" || reported.contains(level))
        .map(|level| level.to_string())
        .collect()
}

fn fast_mode_supported(provider: &str, id: &str) -> bool {
    provider == "openai-codex"
        && (id == "gpt-5.4" || id == "gpt-5.5" || id == "gpt-5.6" || id.starts_with("gpt-5.6-"))
}

fn bounded_integer(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn parse_model(value: &Value) -> Option<ModelDescriptor> {
    let record = value.as_object()?;
    let provider = record.get("provider").and_then(Value::as_str)?;
    let id = record.get("id").and_then(Value::as_str)?;
    if !safe_provider(provider) || !safe_model(id) {
        return None;
    }
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())?;
    if let Some(reasoning) = record.get("reasoning")
        && !reasoning.is_boolean()
    {
        return None;
    }
    let reasoning = record
        .get("reasoning")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let input = record
        .get("input")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| *item == "text" || *item == "image")
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(ModelDescriptor {
        key: format!("{provider}/{id}"),
        provider: provider.to_string(),
        id: id.to_string(),
        name: name.chars().take(500).collect(),
        reasoning,
        input,
        context_window: bounded_integer(record.get("contextWindow")),
        max_tokens: bounded_integer(record.get("maxTokens")),
        available_thinking_levels: thinking_levels(reasoning, record.get("thinking")),
        fast_mode_supported: fast_mode_supported(provider, id),
        available: true,
    })
}

pub fn read_presets(config_file: &Path) -> Vec<ModelPreset> {
    let Ok(text) = std::fs::read_to_string(config_file) else {
        return Vec::new();
    };
    let Ok(Value::Object(root)) = serde_yaml_ng::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(Value::Object(table)) = root.get("modelPresets") else {
        return Vec::new();
    };
    let mut presets = Vec::new();
    for (name, entry) in table {
        if presets.len() >= 128 || name.trim().is_empty() || name.len() > 64 {
            continue;
        }
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let mut roles = BTreeMap::new();
        if let Some(Value::Object(role_table)) = entry.get("modelRoles") {
            for (role, value) in role_table.iter().take(64) {
                if role.len() > 64 {
                    continue;
                }
                if let Some(value) = value
                    .as_str()
                    .filter(|value| !value.trim().is_empty() && value.len() <= 256)
                {
                    roles.insert(role.clone(), value.to_string());
                }
            }
        }
        let thinking = entry
            .get("defaultThinkingLevel")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 32)
            .map(str::to_string);
        presets.push(ModelPreset {
            name: name.clone(),
            model_roles: roles,
            default_thinking_level: thinking,
        });
    }
    presets
}

pub fn load_catalog(context: &CliContext) -> ModelCatalog {
    let version = run(command(context, &["--version"]))
        .ok()
        .and_then(|stdout| {
            let text = stdout.trim();
            text.strip_prefix("omp/")
                .map(|version| version.chars().take(64).collect::<String>())
        })
        .unwrap_or_default();
    let mut warning = None;
    let models = match run(command(context, &["models", "--json"])) {
        Ok(stdout) => match serde_json::from_str::<Value>(&stdout) {
            Ok(Value::Object(root)) => root
                .get("models")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(parse_model).collect())
                .unwrap_or_default(),
            _ => {
                warning = Some("OMP returned malformed model catalog JSON".to_string());
                Vec::new()
            }
        },
        Err(error) => {
            warning = Some(error.message);
            Vec::new()
        }
    };
    let mut providers: BTreeMap<String, ProviderDescriptor> = BTreeMap::new();
    for model in &models {
        providers
            .entry(model.provider.clone())
            .or_insert_with(|| ProviderDescriptor {
                id: model.provider.clone(),
                name: model.provider.clone(),
                auth_method: "cli".to_string(),
                configured: true,
            });
    }
    let vision_delegation = run(command(context, &["config", "get", "modelRoles"]))
        .ok()
        .and_then(|stdout| serde_json::from_str::<Value>(stdout.trim()).ok())
        .and_then(|value| {
            value.as_object().and_then(|roles| {
                roles
                    .get("vision")
                    .and_then(Value::as_str)
                    .map(|vision| !vision.trim().is_empty())
            })
        })
        .filter(|enabled| *enabled);
    let presets = read_presets(
        &context
            .home_dir
            .join(".omp")
            .join("agent")
            .join("config.yml"),
    );
    ModelCatalog {
        prime_version: version,
        refreshed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        models,
        providers: providers.into_values().collect(),
        warning,
        vision_delegation,
        presets,
    }
}

pub fn presets_json(config_file: &Path) -> Vec<Value> {
    read_presets(config_file)
        .into_iter()
        .map(|preset| {
            let mut object = Map::new();
            object.insert("name".to_string(), Value::String(preset.name));
            object.insert(
                "modelRoles".to_string(),
                Value::Object(
                    preset
                        .model_roles
                        .into_iter()
                        .map(|(key, value)| (key, Value::String(value)))
                        .collect(),
                ),
            );
            if let Some(thinking) = preset.default_thinking_level {
                object.insert("defaultThinkingLevel".to_string(), Value::String(thinking));
            }
            Value::Object(object)
        })
        .collect()
}
