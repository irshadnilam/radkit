//! Facades for convenient memory access.
//!
//! This module provides [`History`] and [`Knowledge`] facades that wrap the
//! [`MemoryService`](super::MemoryService) trait with filtered access:
//!
//! - [`History`]: Access to past conversations and user facts (borrowed)
//! - [`Knowledge`]: Access to documents and external sources (borrowed)
//! - [`OwnedHistory`]: Arc-owning version for use with Runtime
//! - [`OwnedKnowledge`]: Arc-owning version for use with Runtime
//!
//! Both facades use the same underlying `MemoryService` but filter by source type.

use std::collections::HashMap;
use std::sync::Arc;

use crate::errors::AgentResult;
use crate::runtime::context::AuthContext;

use super::{ContentSource, MemoryContent, MemoryEntry, MemoryService, SearchOptions, SourceType};

/// History facade - access to past interactions.
///
/// Searches and stores `PastConversation` and `UserFact` sources.
/// Use this to recall what was discussed in previous sessions or
/// retrieve user preferences.
///
/// # Example
///
/// ```ignore
/// let history = History::new(&memory_service);
///
/// // Search past conversations
/// let memories = history.recall(&auth, "dark mode preferences", 5).await?;
///
/// // Save a user fact
/// history.save_fact(&auth, "User prefers dark mode".into(), Some("preferences".into())).await?;
/// ```
pub struct History<'a> {
    service: &'a dyn MemoryService,
}

impl<'a> History<'a> {
    /// Create a new History facade wrapping the given memory service.
    pub fn new(service: &'a dyn MemoryService) -> Self {
        Self { service }
    }

    /// Search past conversations and user facts.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `query` - Natural language query describing what you're looking for
    /// * `limit` - Maximum number of results to return
    pub async fn recall(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(auth, query, SearchOptions::history_only().with_limit(limit))
            .await
    }

    /// Save a user fact to long-term memory.
    ///
    /// Use this to remember user preferences, facts, or insights
    /// that should be recalled in future conversations.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `text` - The fact to remember (be specific and include context)
    /// * `category` - Optional category for organization (e.g., "preferences", "facts")
    pub async fn save_fact(
        &self,
        auth: &AuthContext,
        text: String,
        category: Option<String>,
    ) -> AgentResult<String> {
        self.service
            .add(
                auth,
                MemoryContent {
                    text,
                    source: ContentSource::UserFact { category },
                    metadata: HashMap::new(),
                },
            )
            .await
    }

    /// Access the underlying service for advanced operations.
    pub fn service(&self) -> &dyn MemoryService {
        self.service
    }
}

/// Knowledge facade - content-oriented access.
///
/// Searches `Document` and `External` sources.
/// Use this to find answers from uploaded documents, manuals, or reference material.
///
/// # Example
///
/// ```ignore
/// let knowledge = Knowledge::new(&memory_service);
///
/// // Search documents
/// let results = knowledge.search(&auth, "vacation policy", 5).await?;
/// ```
pub struct Knowledge<'a> {
    service: &'a dyn MemoryService,
}

impl<'a> Knowledge<'a> {
    /// Create a new Knowledge facade wrapping the given memory service.
    pub fn new(service: &'a dyn MemoryService) -> Self {
        Self { service }
    }

    /// Search documents and external sources.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `query` - Natural language query describing what you're looking for
    /// * `limit` - Maximum number of results to return
    pub async fn search(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(
                auth,
                query,
                SearchOptions::knowledge_only().with_limit(limit),
            )
            .await
    }

    /// Search only documents (excluding external sources).
    pub async fn search_documents(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(
                auth,
                query,
                SearchOptions::default()
                    .with_source_types(vec![SourceType::Document])
                    .with_limit(limit),
            )
            .await
    }

    /// Access the underlying service for advanced operations.
    pub fn service(&self) -> &dyn MemoryService {
        self.service
    }
}

// =============================================================================
// Owned Facades (for use with Runtime)
// =============================================================================

/// Owned History facade - Arc-owning version for use with Runtime.
///
/// This is the same as [`History`] but owns the memory service via Arc,
/// making it suitable for returning from `runtime.history()`.
///
/// # Example
///
/// ```ignore
/// // From runtime
/// let history = runtime.history();
/// let memories = history.recall(&auth, "dark mode preferences", 5).await?;
/// ```
pub struct OwnedHistory {
    service: Arc<dyn MemoryService>,
}

impl OwnedHistory {
    /// Create a new OwnedHistory facade wrapping the given memory service.
    pub fn new(service: Arc<dyn MemoryService>) -> Self {
        Self { service }
    }

    /// Search past conversations and user facts.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `query` - Natural language query describing what you're looking for
    /// * `limit` - Maximum number of results to return
    pub async fn recall(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(auth, query, SearchOptions::history_only().with_limit(limit))
            .await
    }

    /// Save a user fact to long-term memory.
    ///
    /// Use this to remember user preferences, facts, or insights
    /// that should be recalled in future conversations.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `text` - The fact to remember (be specific and include context)
    /// * `category` - Optional category for organization (e.g., "preferences", "facts")
    pub async fn save_fact(
        &self,
        auth: &AuthContext,
        text: String,
        category: Option<String>,
    ) -> AgentResult<String> {
        self.service
            .add(
                auth,
                MemoryContent {
                    text,
                    source: ContentSource::UserFact { category },
                    metadata: HashMap::new(),
                },
            )
            .await
    }

    /// Access the underlying service for advanced operations.
    pub fn service(&self) -> &dyn MemoryService {
        &*self.service
    }

    /// Get the Arc to the underlying service.
    pub fn into_service(self) -> Arc<dyn MemoryService> {
        self.service
    }
}

/// Owned Knowledge facade - Arc-owning version for use with Runtime.
///
/// This is the same as [`Knowledge`] but owns the memory service via Arc,
/// making it suitable for returning from `runtime.knowledge()`.
///
/// # Example
///
/// ```ignore
/// // From runtime
/// let knowledge = runtime.knowledge();
/// let results = knowledge.search(&auth, "vacation policy", 5).await?;
/// ```
pub struct OwnedKnowledge {
    service: Arc<dyn MemoryService>,
}

impl OwnedKnowledge {
    /// Create a new OwnedKnowledge facade wrapping the given memory service.
    pub fn new(service: Arc<dyn MemoryService>) -> Self {
        Self { service }
    }

    /// Search documents and external sources.
    ///
    /// # Arguments
    ///
    /// * `auth` - Authentication context for namespacing
    /// * `query` - Natural language query describing what you're looking for
    /// * `limit` - Maximum number of results to return
    pub async fn search(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(
                auth,
                query,
                SearchOptions::knowledge_only().with_limit(limit),
            )
            .await
    }

    /// Search only documents (excluding external sources).
    pub async fn search_documents(
        &self,
        auth: &AuthContext,
        query: &str,
        limit: usize,
    ) -> AgentResult<Vec<MemoryEntry>> {
        self.service
            .search(
                auth,
                query,
                SearchOptions::default()
                    .with_source_types(vec![SourceType::Document])
                    .with_limit(limit),
            )
            .await
    }

    /// Access the underlying service for advanced operations.
    pub fn service(&self) -> &dyn MemoryService {
        &*self.service
    }

    /// Get the Arc to the underlying service.
    pub fn into_service(self) -> Arc<dyn MemoryService> {
        self.service
    }
}
