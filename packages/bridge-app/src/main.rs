use axum::{
    extract::{Query, Request, State},
    http::{StatusCode, Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    key: String,
    root_dir: std::path::PathBuf,
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Serialize)]
struct IsDirResponse {
    is_dir: bool,
}

async fn auth(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get("X-Bridge-Key")
        .and_then(|header| header.to_str().ok());

    if let Some(auth_header) = auth_header {
        if auth_header == state.key {
            return Ok(next.run(req).await);
        }
    }

    Err(StatusCode::UNAUTHORIZED)
}

async fn list_directory(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PathParams>
) -> impl IntoResponse {
    let path = state.root_dir.join(&params.path);
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "Path not found").into_response();
    }
    
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut result = Vec::new();
            for entry in entries {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if entry.path().is_dir() {
                        result.push(format!("{}/", name));
                    } else {
                        result.push(name);
                    }
                }
            }
            Json(result).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read directory: {}", e)).into_response(),
    }
}

async fn read_file(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PathParams>
) -> impl IntoResponse {
    let path = state.root_dir.join(&params.path);
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    }
    if path.is_dir() {
        return (StatusCode::BAD_REQUEST, "Path is a directory").into_response();
    }

    match fs::read_to_string(path) {
        Ok(content) => content.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read file: {}", e)).into_response(),
    }
}

async fn write_file(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PathParams>,
    body: String
) -> impl IntoResponse {
    let path = state.root_dir.join(&params.path);
    
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if let Err(e) = fs::create_dir_all(parent) {
                return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create parent directories: {}", e)).into_response();
            }
        }
    }

    match fs::write(path, body) {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write file: {}", e)).into_response(),
    }
}

async fn is_directory(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PathParams>
) -> impl IntoResponse {
    let path = state.root_dir.join(&params.path);
    Json(IsDirResponse {
        is_dir: path.is_dir(),
    })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .init();

    let key = Uuid::new_v4().to_string();
    let root_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    
    let state = Arc::new(AppState { 
        key: key.clone(),
        root_dir: root_dir.clone(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, "X-Bridge-Key".parse().unwrap()])
        .allow_private_network(true);

    let app = Router::new()
        .route("/ls", get(list_directory))
        .route("/cat", get(read_file))
        .route("/write", post(write_file))
        .route("/is_dir", get(is_directory))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
        .layer(cors);

    let port = 8080;
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    
    println!("\n====================================================");
    println!("Bridge server running on http://{}", addr);
    println!("Root Directory: {}", root_dir.display());
    println!("Bridge Security Key: {}", key);
    println!("\nTo connect from Web-Vim, use command:");
    println!(":ed bridge {} {}", port, key);
    println!("====================================================\n");
    
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
