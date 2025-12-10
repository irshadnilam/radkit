//! Search knowledge tool for querying documents and external sources.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::runtime::context::AuthContext;
use crate::runtime::memory::{MemoryService, SearchOptions};
use crate::tools::{BaseTool, FunctionDeclaration, ToolContext, ToolResult};

/// Tool for agents to search documents and external knowledge.
///
/// This tool allows agents to find answers from uploaded documents,
/// manuals, or reference material.
///
/// # Auth Context
///
/// Uses auth context in this order of priority:
/// 1. Auth context captured at construction (via `with_auth`)
/// 2. Auth context from execution state (`"auth_context"` key)
pub struct SearchKnowledgeTool {
    memory_service: Arc<dyn MemoryService>,
    auth_context: Option<AuthContext>,
}

impl SearchKnowledgeTool {
    /// Creates a new search knowledge tool.
    pub fn new(memory_service: Arc<dyn MemoryService>) -> Self {
        Self {
            memory_service,
            auth_context: None,
        }
    }

    /// Creates a new search knowledge tool with a captured auth context.
    pub fn with_auth(memory_service: Arc<dyn MemoryService>, auth_context: AuthContext) -> Self {
        Self {
            memory_service,
            auth_context: Some(auth_context),
        }
    }
}

#[cfg_attr(
    all(target_os = "wasi", target_env = "p1"),
    async_trait::async_trait(?Send)
)]
#[cfg_attr(
    not(all(target_os = "wasi", target_env = "p1")),
    async_trait::async_trait
)]
impl BaseTool for SearchKnowledgeTool {
    fn name(&self) -> &str {
        "search_knowledge"
    }

    fn description(&self) -> &str {
        "Search documents and knowledge base for relevant information. \
         Use this to find answers from uploaded documents, manuals, or reference material."
    }

    fn declaration(&self) -> FunctionDeclaration {
        FunctionDeclaration::new(
            self.name(),
            self.description(),
            json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query describing what you're looking for"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 5, max: 10)",
                        "default": 5
                    }
                },
                "required": ["query"]
            }),
        )
    }

    async fn run_async(
        &self,
        args: HashMap<String, Value>,
        context: &ToolContext<'_>,
    ) -> ToolResult {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error("Missing required argument: query"),
        };

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(10) as usize)
            .unwrap_or(5);

        // Prefer captured auth context, fall back to execution state
        let auth_ctx: AuthContext = if let Some(ref auth) = self.auth_context {
            auth.clone()
        } else {
            match context.state().get_state("auth_context") {
                Some(v) => match serde_json::from_value(v) {
                    Ok(auth) => auth,
                    Err(e) => return ToolResult::error(format!("Invalid auth context: {e}")),
                },
                None => return ToolResult::error("No auth context available"),
            }
        };

        let options = SearchOptions::knowledge_only().with_limit(limit);

        let entries = match self.memory_service.search(&auth_ctx, query, options).await {
            Ok(e) => e,
            Err(e) => return ToolResult::error(format!("Knowledge search failed: {e}")),
        };

        if entries.is_empty() {
            return ToolResult::success(json!({
                "found": false,
                "message": "No relevant documents found."
            }));
        }

        let results: Vec<_> = entries
            .iter()
            .map(|e| {
                json!({
                    "text": e.text,
                    "source": e.source,
                    "relevance": e.score,
                })
            })
            .collect();

        ToolResult::success(json!({
            "found": true,
            "count": results.len(),
            "results": results
        }))
    }
}
