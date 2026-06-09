# Company Memory

This local OpenClaw plugin stores public and private memories in one LanceDB table.

- Public rows have `visibility = "public"` and no `owner_user_id`.
- Private rows have `visibility = "private"` and `owner_user_id` from OpenClaw's trusted runtime sender context.
- Direct chats search public rows plus the current sender's private rows.
- Group chats search public rows only.

Tools:

- `company_context_search`
- `private_memory_store`
- `public_memory_store`

Do not expose raw LanceDB queries to the model. Keep all owner filtering inside the plugin.
