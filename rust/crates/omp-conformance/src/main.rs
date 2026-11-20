use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use omp_core::agent::AgentManager;
use omp_core::broker::{BrokerHandle, start as start_broker};
use omp_core::collaboration;
use omp_core::error::{CoreError, Result};
use omp_core::git;
use omp_core::models;
use omp_core::plugins;
use omp_core::projects;
use omp_core::schedules;
use omp_core::sessions;
use omp_core::state::{Platform, StateStore, migrate_legacy_user_data};
use serde_json::{Value, json};

#[derive(Clone)]
struct Sandbox {
    root_dir: PathBuf,
    home_dir: PathBuf,
    user_data_dir: PathBuf,
    app_data_dir: PathBuf,
    omp_executable: PathBuf,
    platform: Platform,
    auto_open: bool,
    extra_env: Vec<(String, String)>,
}

struct Runtime {
    sandbox: Sandbox,
    store: Arc<Mutex<StateStore>>,
    catalog_revision: u64,
    last_catalog: Vec<sessions::SessionRecord>,
    agents: AgentManager,
    schedule_broker: Option<BrokerHandle>,
    collaboration_broker: Option<BrokerHandle>,
}

impl Runtime {
    fn open(sandbox: Sandbox) -> Result<Self> {
        let store = StateStore::open(
            sandbox
                .user_data_dir
                .join(omp_core::state::CURRENT_DESKTOP_STATE_FILENAME),
            Some(
                sandbox
                    .user_data_dir
                    .join(omp_core::state::LEGACY_DESKTOP_STATE_FILENAME),
            ),
            sandbox.platform,
        )?;
        Ok(Self {
            sandbox,
            store: Arc::new(Mutex::new(store)),
            catalog_revision: 1,
            last_catalog: Vec::new(),
            agents: AgentManager::default(),
            schedule_broker: None,
            collaboration_broker: None,
        })
    }

    fn shutdown(&mut self) {
        self.agents.stop_all();
        if let Some(mut broker) = self.schedule_broker.take() {
            broker.shutdown();
        }
        if let Some(mut broker) = self.collaboration_broker.take() {
            broker.shutdown();
        }
    }

    fn cli_context(&self) -> models::CliContext {
        models::CliContext {
            executable: self.sandbox.omp_executable.clone(),
            home_dir: self.sandbox.home_dir.clone(),
            root_dir: self.sandbox.root_dir.clone(),
            extra_env: self.sandbox.extra_env.clone(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StateStore> {
        self.store.lock().expect("state lock")
    }
}

struct Workspace {
    sandbox: Option<Sandbox>,
    runtime: Option<Runtime>,
}

impl Workspace {
    fn new() -> Self {
        Self {
            sandbox: None,
            runtime: None,
        }
    }

    fn close(&mut self) {
        if let Some(runtime) = self.runtime.as_mut() {
            runtime.shutdown();
        }
        self.runtime = None;
    }

    fn reset(&mut self, params: &Value) -> Result<Value> {
        self.close();
        let object = params
            .as_object()
            .ok_or_else(|| CoreError::invalid("workspace.reset params must be an object"))?;
        let required = |key: &str| -> Result<PathBuf> {
            object
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| CoreError::invalid(format!("workspace.reset is missing {key}")))
        };
        let platform =
            Platform::from_override(object.get("platformOverride").and_then(Value::as_str));
        let extra_env = object
            .get("extraEnv")
            .and_then(Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let sandbox = Sandbox {
            root_dir: required("rootDir")?,
            home_dir: required("homeDir")?,
            user_data_dir: required("userDataDir")?,
            app_data_dir: required("appDataDir")?,
            omp_executable: required("ompExecutable")?,
            platform,
            auto_open: object
                .get("autoOpen")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            extra_env,
        };
        let auto_open = sandbox.auto_open;
        self.sandbox = Some(sandbox);
        if auto_open {
            self.open_store()?;
        }
        Ok(json!({ "ok": true }))
    }

    fn open_store(&mut self) -> Result<()> {
        let sandbox = self.sandbox.clone().ok_or_else(|| {
            CoreError::invalid("workspace.reset must be called before state.open")
        })?;
        match Runtime::open(sandbox) {
            Ok(runtime) => {
                self.runtime = Some(runtime);
                Ok(())
            }
            Err(error) => {
                self.runtime = None;
                Err(error)
            }
        }
    }

    fn require_runtime(&self) -> Result<&Runtime> {
        self.runtime.as_ref().ok_or_else(|| {
            CoreError::invalid("State is not open; call workspace.reset or state.open first")
        })
    }

    fn require_runtime_mut(&mut self) -> Result<&mut Runtime> {
        self.runtime.as_mut().ok_or_else(|| {
            CoreError::invalid("State is not open; call workspace.reset or state.open first")
        })
    }

    fn require_sandbox(&self) -> Result<&Sandbox> {
        self.sandbox.as_ref().ok_or_else(|| {
            CoreError::invalid("Sandbox is not initialized; call workspace.reset first")
        })
    }

    fn handle(&mut self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "adapter.info" => Ok(json!({
                "protocolVersion": 1,
                "implementation": "rust-omp-core",
                "platform": Platform::current().as_str(),
                "capabilities": ["state", "projects", "sessions", "models", "agent", "git", "checkouts", "plugins", "schedules", "collaboration"],
            })),
            "workspace.reset" => self.reset(params),
            "workspace.shutdown" => {
                self.close();
                self.sandbox = None;
                Ok(json!({ "ok": true }))
            }
            "state.migrateUserData" => {
                let sandbox = self.require_sandbox()?;
                let report =
                    migrate_legacy_user_data(&sandbox.app_data_dir, &sandbox.user_data_dir);
                Ok(serde_json::to_value(report)?)
            }
            "state.open" => {
                self.open_store()?;
                Ok(json!({ "ok": true }))
            }
            "state.getSnapshot" => {
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(runtime.lock().snapshot())?)
            }
            "state.getSettings" => {
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(runtime.lock().settings())?)
            }
            "state.updateSettings" => {
                let patch = params
                    .get("patch")
                    .ok_or_else(|| CoreError::invalid("state.updateSettings requires patch"))?;
                let runtime = self.require_runtime()?;
                let settings = runtime.lock().update_settings(patch)?;
                Ok(serde_json::to_value(settings)?)
            }
            "state.close" => {
                self.close();
                Ok(json!({ "ok": true }))
            }
            "projects.grant" => {
                let path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("projects.grant requires path"))?
                    .to_string();
                let runtime = self.require_runtime()?;
                let mut store = runtime.lock();
                let record = projects::grant_project(
                    &mut store,
                    &runtime.sandbox.home_dir,
                    runtime.sandbox.platform,
                    &path,
                )?;
                Ok(serde_json::to_value(record)?)
            }
            "projects.list" => {
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(projects::list_projects(
                    &runtime.lock(),
                ))?)
            }
            "projects.listFiles" => {
                let root = params
                    .get("root")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("projects.listFiles requires root"))?;
                let runtime = self.require_runtime()?;
                let listing =
                    projects::list_files(&runtime.lock(), runtime.sandbox.platform, root)?;
                Ok(serde_json::to_value(listing)?)
            }
            "projects.remove" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("projects.remove requires id"))?;
                let runtime = self.require_runtime_mut()?;
                runtime.agents.stop_all();
                if let Some(mut broker) = runtime.schedule_broker.take() {
                    broker.shutdown();
                }
                if let Some(mut broker) = runtime.collaboration_broker.take() {
                    broker.shutdown();
                }
                let mut store = runtime.lock();
                Ok(json!(projects::remove_project(&mut store, id)?))
            }
            "sessions.list" => {
                let include_archived = params
                    .get("includeArchived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let project = params.get("projectPath").and_then(Value::as_str);
                let runtime = self.require_runtime()?;
                let store = runtime.lock();
                let records = sessions::list_sessions(
                    &store,
                    &runtime.sandbox.home_dir,
                    include_archived,
                    project,
                );
                Ok(serde_json::to_value(records)?)
            }
            "sessions.sync" => {
                let runtime = self.require_runtime_mut()?;
                match params.get("revision").and_then(Value::as_u64) {
                    Some(revision) => {
                        let store = runtime.lock();
                        let delta = sessions::sync_delta(
                            &store,
                            &runtime.sandbox.home_dir,
                            revision,
                            &runtime.last_catalog,
                        );
                        drop(store);
                        runtime.last_catalog = {
                            let store = runtime.lock();
                            sessions::list_sessions(&store, &runtime.sandbox.home_dir, true, None)
                        };
                        runtime.catalog_revision = delta.revision;
                        Ok(serde_json::to_value(delta)?)
                    }
                    None => {
                        let snapshot = {
                            let store = runtime.lock();
                            sessions::sync_snapshot(&store, &runtime.sandbox.home_dir)
                        };
                        runtime.last_catalog = snapshot.records.clone();
                        runtime.catalog_revision = snapshot.revision;
                        Ok(serde_json::to_value(snapshot)?)
                    }
                }
            }
            "sessions.read" => {
                let file_path = params
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("sessions.read requires filePath"))?;
                let runtime = self.require_runtime()?;
                let root = sessions::session_root(&runtime.sandbox.home_dir);
                let transcript = sessions::read_transcript(&root, file_path)?;
                Ok(serde_json::to_value(transcript)?)
            }
            "sessions.setPinned" => {
                let file_path = params
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("sessions.setPinned requires filePath"))?;
                let pinned = params
                    .get("pinned")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let runtime = self.require_runtime()?;
                let root = sessions::session_root(&runtime.sandbox.home_dir);
                sessions::set_pinned(&mut runtime.lock(), &root, file_path, pinned)?;
                Ok(json!({ "ok": true }))
            }
            "sessions.archive" => {
                let file_path = params
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("sessions.archive requires filePath"))?;
                let archived = params
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let runtime = self.require_runtime()?;
                let root = sessions::session_root(&runtime.sandbox.home_dir);
                Ok(json!(sessions::set_archived(
                    &mut runtime.lock(),
                    &root,
                    file_path,
                    archived
                )?))
            }
            "sessions.delete" => {
                let file_path = params
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("sessions.delete requires filePath"))?;
                let runtime = self.require_runtime()?;
                let root = sessions::session_root(&runtime.sandbox.home_dir);
                Ok(json!(sessions::delete_session(
                    &mut runtime.lock(),
                    &root,
                    file_path
                )?))
            }
            "git.status" => {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git.status requires cwd"))?;
                let runtime = self.require_runtime()?;
                let status = git::status(&runtime.lock(), runtime.sandbox.platform, cwd);
                Ok(serde_json::to_value(status)?)
            }
            "git.diff" => {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git.diff requires cwd"))?;
                let path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git.diff requires path"))?;
                let staged = params
                    .get("staged")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(git::diff(
                    &runtime.lock(),
                    runtime.sandbox.platform,
                    cwd,
                    path,
                    staged,
                )?)?)
            }
            "git.stage" | "git.unstage" | "git.restore" => {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git operation requires cwd"))?;
                let paths: Vec<String> = params
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let runtime = self.require_runtime()?;
                let store = runtime.lock();
                let outcome = match method {
                    "git.stage" => git::stage(&store, runtime.sandbox.platform, cwd, &paths)?,
                    "git.unstage" => git::unstage(&store, runtime.sandbox.platform, cwd, &paths)?,
                    _ => git::restore(&store, runtime.sandbox.platform, cwd, &paths)?,
                };
                Ok(json!(outcome))
            }
            "git.commit" => {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git.commit requires cwd"))?;
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("git.commit requires message"))?;
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(git::commit(
                    &runtime.lock(),
                    runtime.sandbox.platform,
                    cwd,
                    message,
                )?)?)
            }
            "checkouts.list" => {
                let project_id = params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("checkouts.list requires projectId"))?;
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(git::checkout_catalog(
                    &runtime.lock(),
                    project_id,
                )?)?)
            }
            "checkouts.execute" => {
                let project_id = params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("checkouts.execute requires projectId"))?;
                let action = params
                    .get("action")
                    .ok_or_else(|| CoreError::invalid("checkouts.execute requires action"))?;
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(git::execute_checkout(
                    &runtime.lock(),
                    project_id,
                    action,
                )?)?)
            }
            "models.catalog" => {
                let runtime = self.require_runtime()?;
                Ok(serde_json::to_value(models::load_catalog(
                    &runtime.cli_context(),
                ))?)
            }
            "models.presets" => {
                let runtime = self.require_runtime()?;
                let config = runtime
                    .sandbox
                    .home_dir
                    .join(".omp")
                    .join("agent")
                    .join("config.yml");
                Ok(Value::Array(models::presets_json(&config)))
            }
            "plugins.list" => {
                let project = params.get("projectPath").and_then(Value::as_str);
                let runtime = self.require_runtime()?;
                let agent_dir = runtime.sandbox.home_dir.join(".omp").join("agent");
                let project_path = match project {
                    Some(path) => Some(projects::authorize_path(
                        &runtime.lock(),
                        Path::new(path),
                        runtime.sandbox.platform,
                    )?),
                    None => None,
                };
                Ok(serde_json::to_value(plugins::discover(
                    &agent_dir,
                    project_path.as_deref(),
                ))?)
            }
            "plugins.connectMcp" => {
                let input = params
                    .get("input")
                    .ok_or_else(|| CoreError::invalid("plugins.connectMcp requires input"))?;
                let runtime = self.require_runtime()?;
                let agent_dir = runtime.sandbox.home_dir.join(".omp").join("agent");
                plugins::connect_mcp(&agent_dir, &runtime.lock(), runtime.sandbox.platform, input)
            }
            "plugins.setMcpEnabled" => {
                let input = params
                    .get("input")
                    .ok_or_else(|| CoreError::invalid("plugins.setMcpEnabled requires input"))?;
                let runtime = self.require_runtime()?;
                let agent_dir = runtime.sandbox.home_dir.join(".omp").join("agent");
                plugins::set_mcp_enabled(
                    &agent_dir,
                    &runtime.lock(),
                    runtime.sandbox.platform,
                    input,
                )
            }
            "plugins.mutateCapability" => {
                let input = params
                    .get("input")
                    .ok_or_else(|| CoreError::invalid("plugins.mutateCapability requires input"))?;
                let runtime = self.require_runtime()?;
                let agent_dir = runtime.sandbox.home_dir.join(".omp").join("agent");
                plugins::mutate_capability(
                    &agent_dir,
                    &runtime.lock(),
                    runtime.sandbox.platform,
                    input,
                )
            }
            "plugins.install" => {
                let source = params
                    .get("source")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("plugins.install requires source"))?;
                let runtime = self.require_runtime()?;
                plugins::install(&runtime.cli_context(), source)
            }
            "agent.start" => {
                let runtime = self.require_runtime_mut()?;
                let context = runtime.cli_context();
                let platform = runtime.sandbox.platform;
                let store = runtime.store.clone();
                let store = store.lock().expect("state lock");
                let info = runtime.agents.start(&store, platform, &context, params)?;
                Ok(info)
            }
            "agent.command" => {
                let runtime_id = params
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("agent.command requires runtimeId"))?;
                let command = params
                    .get("command")
                    .ok_or_else(|| CoreError::invalid("agent.command requires command"))?;
                let runtime = self.require_runtime_mut()?;
                runtime.agents.command(runtime_id, command)
            }
            "agent.drainEvents" => {
                let filter = params.get("runtimeId").and_then(Value::as_str);
                let runtime = self.require_runtime_mut()?;
                Ok(Value::Array(runtime.agents.drain_events(filter)))
            }
            "agent.list" => {
                let runtime = self.require_runtime()?;
                Ok(Value::Array(runtime.agents.list()))
            }
            "agent.stop" => {
                let runtime_id = params
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("agent.stop requires runtimeId"))?;
                let runtime = self.require_runtime_mut()?;
                Ok(json!(runtime.agents.stop(runtime_id)))
            }
            "schedules.preview" => {
                let timing = params
                    .get("timing")
                    .ok_or_else(|| CoreError::invalid("schedules.preview requires timing"))?;
                let count = params.get("count").and_then(Value::as_u64).unwrap_or(5) as usize;
                let occurrences = schedules::preview(timing, count)?;
                Ok(json!({ "occurrences": occurrences }))
            }
            "schedules.create" => {
                let input = params
                    .get("input")
                    .ok_or_else(|| CoreError::invalid("schedules.create requires input"))?;
                let created_by = params
                    .get("createdBy")
                    .and_then(Value::as_str)
                    .unwrap_or("user");
                let runtime = self.require_runtime()?;
                let mut store = runtime.lock();
                schedules::create(&mut store, input, created_by)
            }
            "schedules.list" => {
                let runtime = self.require_runtime()?;
                Ok(Value::Array(schedules::list(&runtime.lock())))
            }
            "schedules.update" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("schedules.update requires id"))?;
                let patch = params
                    .get("patch")
                    .ok_or_else(|| CoreError::invalid("schedules.update requires patch"))?;
                let runtime = self.require_runtime()?;
                let mut store = runtime.lock();
                schedules::update(&mut store, id, patch)
            }
            "schedules.pause" | "schedules.resume" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("schedule operation requires id"))?;
                let status = if method == "schedules.pause" {
                    "paused"
                } else {
                    "active"
                };
                let runtime = self.require_runtime()?;
                let mut store = runtime.lock();
                schedules::set_status(&mut store, id, status)
            }
            "schedules.delete" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::invalid("schedules.delete requires id"))?;
                let runtime = self.require_runtime()?;
                let mut store = runtime.lock();
                Ok(json!(schedules::delete(&mut store, id)?))
            }
            "schedules.brokerInfo" => self.schedule_broker_info(params),
            "collaboration.encodeEnvelope" => {
                let from_session_id = params
                    .get("fromSessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        CoreError::invalid("collaboration.encodeEnvelope requires fromSessionId")
                    })?;
                let text = params.get("text").and_then(Value::as_str).ok_or_else(|| {
                    CoreError::invalid("collaboration.encodeEnvelope requires text")
                })?;
                let runtime = self.require_runtime()?;
                let key = collaboration::load_or_create_key(&collaboration::key_path(
                    &runtime.sandbox.user_data_dir,
                ))?;
                Ok(json!({ "envelope": collaboration::encode(&key, from_session_id, text)? }))
            }
            "collaboration.verifyEnvelope" => {
                let value = params.get("value").and_then(Value::as_str).ok_or_else(|| {
                    CoreError::invalid("collaboration.verifyEnvelope requires value")
                })?;
                let runtime = self.require_runtime()?;
                let key = collaboration::load_or_create_key(&collaboration::key_path(
                    &runtime.sandbox.user_data_dir,
                ))?;
                Ok(json!({ "parsed": collaboration::verify(&key, value) }))
            }
            "collaboration.brokerInfo" => self.collaboration_broker_info(params),
            other => Err(CoreError::new(
                "Error",
                format!("Unknown conformance method: {other}"),
            )),
        }
    }

    fn schedule_broker_info(&mut self, params: &Value) -> Result<Value> {
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::invalid("schedules.brokerInfo requires cwd"))?;
        let runtime = self.require_runtime_mut()?;
        let store = runtime.store.clone();
        let project_id = {
            let state = runtime.lock();
            let canonical =
                projects::authorize_path(&state, Path::new(cwd), runtime.sandbox.platform)?;
            state
                .state()
                .projects
                .iter()
                .find(|project| {
                    project.folders.iter().any(|folder| {
                        omp_core::paths::canonicalize(folder)
                            .map(|root| projects::path_within(&root, &canonical))
                            .unwrap_or(false)
                    })
                })
                .map(|project| project.id.clone())
                .ok_or_else(|| CoreError::invalid("The cwd is not inside a granted project"))?
        };
        let handler_store = store.clone();
        let handler_project = project_id.clone();
        let broker = start_broker(move |method, params| {
            let mut state = handler_store.lock().expect("state lock");
            match method {
                "list" => Ok(schedules::broker_list(&state, &handler_project)),
                "create" => {
                    let input = params
                        .get("input")
                        .ok_or_else(|| CoreError::invalid("Broker create requires input"))?;
                    schedules::broker_create(&mut state, &handler_project, input)
                }
                "delete" => {
                    let id = params
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| CoreError::invalid("Broker delete requires id"))?;
                    schedules::broker_delete(&mut state, &handler_project, id)
                }
                other => Err(CoreError::invalid(format!(
                    "Unknown schedule broker method: {other}"
                ))),
            }
        })?;
        let info = json!({ "url": broker.url, "token": broker.token });
        runtime.schedule_broker = Some(broker);
        Ok(info)
    }

    fn collaboration_broker_info(&mut self, params: &Value) -> Result<Value> {
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::invalid("collaboration.brokerInfo requires cwd"))?;
        let session_path = params
            .get("sessionPath")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let runtime = self.require_runtime_mut()?;
        let store = runtime.store.clone();
        let home = runtime.sandbox.home_dir.clone();
        let canonical_cwd = {
            let state = runtime.lock();
            projects::authorize_path(&state, Path::new(cwd), runtime.sandbox.platform)?
        };
        let source = session_path.clone();
        let handler_store = store.clone();
        let handler_home = home.clone();
        let handler_cwd = canonical_cwd.clone();
        let broker = start_broker(move |method, params| {
            let state = handler_store.lock().expect("state lock");
            match method {
                "list" => {
                    let peers = collaboration::peer_sessions(
                        &state,
                        &handler_home,
                        &handler_cwd,
                        source.as_deref(),
                    );
                    Ok(Value::Array(
                        peers
                            .into_iter()
                            .map(|peer| json!({ "id": peer.id, "title": peer.title }))
                            .collect(),
                    ))
                }
                "read" => {
                    let target = params
                        .get("target_session_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            CoreError::invalid("Broker read requires target_session_id")
                        })?;
                    let peers = collaboration::peer_sessions(
                        &state,
                        &handler_home,
                        &handler_cwd,
                        source.as_deref(),
                    );
                    let record = peers
                        .into_iter()
                        .find(|peer| peer.id == target)
                        .ok_or_else(|| {
                            CoreError::invalid("Target session is not a same-cwd peer")
                        })?;
                    collaboration::peer_messages(&handler_home, &record)
                }
                other => Err(CoreError::invalid(format!(
                    "Unknown collaboration broker method: {other}"
                ))),
            }
        })?;
        let info = json!({ "url": broker.url, "token": broker.token });
        runtime.collaboration_broker = Some(broker);
        Ok(info)
    }
}

fn main() {
    let stdin = io::stdin();
    let mut workspace = Workspace::new();
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(id) = request.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match workspace.handle(&method, &params) {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => {
                json!({ "id": id, "ok": false, "error": { "code": error.code, "message": error.message } })
            }
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
    workspace.close();
}
