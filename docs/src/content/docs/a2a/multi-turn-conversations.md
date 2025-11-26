---
title: Multi-turn Conversations
description: Implement agents that ask follow-up questions to gather information across multiple turns.
---



Not all tasks can be completed in a single step. Often, an agent needs to ask follow-up questions to gather all the necessary information. Radkit has first-class support for these multi-turn conversations.

The flow is as follows:
1.  The `on_request` handler determines that information is missing.
2.  It saves its partial work to the `State` and returns an `OnRequestResult::InputRequired` variant.
3.  Radkit sends a message to the user asking for the missing information.
4.  The user responds.
5.  Radkit calls the `on_input_received` handler on your skill with the user's new input.
6.  The `on_input_received` handler loads the partial state and continues the work.

## Requesting Input

If your `on_request` handler can't complete its work, it should return `OnRequestResult::InputRequired`.

This result contains a `message` field for the question to ask the user. You track *what* you're asking for using slots stored in your `State`.

### Using Slots

A "slot" is a piece of information you're trying to fill. You should define an `enum` for your skill that represents the different pieces of information you might need to ask for.

```rust
use serde::{Deserialize, Serialize};

// This enum defines the different states of our conversation.
// We can be waiting for an email, a phone number, or a department.
#[derive(Serialize, Deserialize)]
enum ProfileSlot {
    Email,
    PhoneNumber,
    Department,
}
```

### Returning `InputRequired`

Inside `on_request`, if you find that the email is missing, you save the work you've done so far, set the slot to track what you're asking for, and return `InputRequired`.

```rust
// In SkillHandler::on_request...

// ... after extracting a partial profile ...

if profile.email.is_empty() {
    // 1. Save the partial data to the task-scoped state.
    state.task().save("partial_profile", &profile)?;

    // 2. Set the slot to track what we're asking for.
    state.set_slot(ProfileSlot::Email)?;

    // 3. Return 'InputRequired' to ask the user for the email.
    return Ok(OnRequestResult::InputRequired {
        message: Content::from_text("I have the name and role, but I'm missing the email. What is it?"),
    });
}
```

## Handling User Input

When the user responds to your question, Radkit will call the `on_input_received` method on your `SkillHandler`. You must override the default implementation of this method to handle the input.

### The `on_input_received` Handler

This handler's job is to continue the work. It receives the user's new input and has access to the same `State` where you saved your partial data.

```rust
// In the `impl SkillHandler for ProfileExtractorSkill` block...

async fn on_input_received(
    &self,
    state: &mut State,
    progress: &ProgressSender,
    runtime: &dyn Runtime,
    content: Content, // This is the user's answer
) -> Result<OnInputResult> {
    // 1. Find out what we were waiting for by loading the slot.
    let slot: ProfileSlot = state.slot()?
        .ok_or_else(|| anyhow!("Input received without a slot"))?;

    // 2. Load the saved state from task-scoped storage.
    let mut profile: UserProfile = state.task()
        .load("partial_profile")?
        .ok_or_else(|| anyhow!("No partial profile found"))?;

    // 3. Handle the input based on the slot.
    match slot {
        ProfileSlot::Email => {
            profile.email = content.first_text().unwrap_or_default().to_string();

            // Now that we have the email, maybe we need the phone number?
            // You can chain input requests!
            if profile.phone_number.is_empty() {
                state.task().save("partial_profile", &profile)?;
                state.set_slot(ProfileSlot::PhoneNumber)?;
                return Ok(OnInputResult::InputRequired {
                    message: Content::from_text("Thanks! What's the phone number?"),
                });
            }
        }
        ProfileSlot::PhoneNumber => {
            profile.phone_number = content.first_text().unwrap_or_default().to_string();
            // ... and so on
        }
        ProfileSlot::Department => { /* ... */ }
    }

    // 4. Once all information is gathered, clear the slot and complete the task.
    state.clear_slot();
    let artifact = Artifact::from_json("user_profile.json", &profile)?;
    Ok(OnInputResult::Completed {
        message: Some(Content::from_text("Profile complete!")),
        artifacts: vec![artifact],
    })
}
```

The `on_input_received` handler can also return `InputRequired`, allowing you to chain questions until you have all the information needed to complete the task. This state machine, managed via slots in `State`, is the key to building robust, multi-turn conversational agents.