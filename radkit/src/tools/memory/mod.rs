//! Memory tools for agent access to long-term memory.
//!
//! This module provides tools that agents can use to interact with the
//! [`MemoryService`](crate::runtime::memory::MemoryService):
//!
//! - [`LoadMemoryTool`]: Search past conversations and user facts
//! - [`SaveMemoryTool`]: Store important user information
//! - [`SearchKnowledgeTool`]: Search documents and knowledge base
//! - [`MemoryToolset`]: Convenience toolset containing all memory tools
//!
//! # Usage
//!
//! ```ignore
//! use radkit::tools::memory::MemoryToolset;
//! use radkit::runtime::memory::InMemoryMemoryService;
//! use radkit::runtime::context::AuthContext;
//! use std::sync::Arc;
//!
//! let memory_service = Arc::new(InMemoryMemoryService::new());
//! let auth = AuthContext::new("my-app", "user123");
//!
//! // Recommended: Create toolset with captured auth context
//! let toolset = MemoryToolset::with_auth(memory_service, auth);
//!
//! // Add toolset to agent...
//! ```
//!
//! # Auth Context
//!
//! These tools use auth context in this order of priority:
//! 1. Auth context captured at construction (via `with_auth`) - **recommended**
//! 2. Auth context from execution state (`"auth_context"` key)
//!
//! Using `with_auth` is the recommended pattern as it ensures the tools work
//! out-of-the-box without requiring manual wiring of execution state.

mod load_memory;
mod save_memory;
mod search_knowledge;

pub use load_memory::LoadMemoryTool;
pub use save_memory::SaveMemoryTool;
pub use search_knowledge::SearchKnowledgeTool;

use crate::runtime::context::AuthContext;
use crate::runtime::memory::MemoryService;
use crate::tools::{BaseTool, BaseToolset};
use std::sync::Arc;

/// Toolset providing memory and knowledge access to agents.
///
/// Contains all three memory tools:
/// - `load_memory`: Search past conversations and user facts
/// - `save_memory`: Store user facts and preferences
/// - `search_knowledge`: Search documents and external sources
///
/// # Auth Context
///
/// Prefer using [`with_auth`](Self::with_auth) to create toolsets with a captured
/// auth context. This ensures tools work without manual execution state wiring.
pub struct MemoryToolset {
    load_memory: LoadMemoryTool,
    save_memory: SaveMemoryTool,
    search_knowledge: SearchKnowledgeTool,
}

impl MemoryToolset {
    /// Creates a new memory toolset with the given memory service.
    ///
    /// Tools created this way will look for `"auth_context"` in execution state.
    /// Consider using [`with_auth`](Self::with_auth) instead.
    pub fn new(memory_service: Arc<dyn MemoryService>) -> Self {
        Self {
            load_memory: LoadMemoryTool::new(Arc::clone(&memory_service)),
            save_memory: SaveMemoryTool::new(Arc::clone(&memory_service)),
            search_knowledge: SearchKnowledgeTool::new(memory_service),
        }
    }

    /// Creates a new memory toolset with a captured auth context.
    ///
    /// This is the recommended constructor. The auth context is captured at
    /// construction time and used for all tool invocations, ensuring the
    /// tools work out-of-the-box without manual execution state wiring.
    pub fn with_auth(memory_service: Arc<dyn MemoryService>, auth_context: AuthContext) -> Self {
        Self {
            load_memory: LoadMemoryTool::with_auth(
                Arc::clone(&memory_service),
                auth_context.clone(),
            ),
            save_memory: SaveMemoryTool::with_auth(
                Arc::clone(&memory_service),
                auth_context.clone(),
            ),
            search_knowledge: SearchKnowledgeTool::with_auth(memory_service, auth_context),
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
impl BaseToolset for MemoryToolset {
    async fn get_tools(&self) -> Vec<&dyn BaseTool> {
        vec![&self.load_memory, &self.save_memory, &self.search_knowledge]
    }

    async fn close(&self) {
        // No cleanup needed
    }
}
