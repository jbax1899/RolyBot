# RolyBot – A Discord Chatbot Very Good At Imitating Me

**RolyBot** is a context-aware Discord chatbot designed to emulate its creator in both writing and interaction style. It leverages OpenAI's GPT models and an in-memory context/memory system to provide highly relevant, dynamic responses.

---

## 🚀 Features

### Conversational AI
- Uses OpenAI's GPT-4o-mini and fine-tuned GPT-4 models for contextually rich, human-like replies.

### Dynamic Memory & Context Management
- Maintains a rolling in-memory store of recent and relevant messages.
- Advanced similarity search (cosine, Jaccard, Levenshtein) to retrieve and summarize relevant past conversations.
- Injects system prompts, recent context, and function-based context into each reply.
- Deduplicates and prioritizes context to fit within model token limits.

### Command System
- Modular command loader (`!rb <command>`) with commands such as:
  - `help`: Lists all available commands with descriptions.
  - `status`: Generates and sets a new bot status using AI.
  - `debug`: Shows bot diagnostics (uptime, memory usage, etc.).
  - `chess`: Play chess with the bot (start/resign/move).
  - `memory`: Summarizes and displays bot's memory state.

### Message Classification & Filtering
- Classifies incoming messages to decide whether to respond or react with emotes.
- Responds only to relevant messages, reducing spam.
- Can react with Unicode or custom Discord emojis.

### AFK & Rate Limiting
- Detects and prevents prompt flooding by going AFK after too many requests.
- Responds with a friendly AFK message and blocks further requests temporarily.

### Self-Reflection & Diagnostics
- Provides debug info on demand (uptime, memory usage, OpenAI stats).
- Logs detailed context management, memory retrieval, and error states.

### Extensible Context Sources
- Can pull static context from a JSON file ([context.json](cci:7://file:///c:/Users/Jordan/My%20Drive/Jordan/Programming/RolyBot/utils/context.json:0:0-0:0)) for facts about itself, its creator, or other reference data.
- Designed to easily integrate additional context functions or plugins.

---

## 🛠️ Technical Stack

- **Node.js** with **Discord.js** for bot framework and event handling.
- **OpenAI API** for language model completions and status generation.
- **In-memory RAM-based memory system** for fast, ephemeral context management (no persistent storage).
- **Natural language processing** (via `natural` package) for similarity and filtering.
- **Comprehensive logging** using `winston`.

---

## ⚙️ Design Principles

- **Contextual Awareness:** Always responds with the most relevant, recent, and non-redundant information.
- **Compliance:** All memory and context storage is in-memory only, complying with Discord TOS.
- **Robust Error Handling:** Extensive error handling and logging for all major subsystems.
- **Extensibility:** Modular command and context system for easy addition of new features.

---

## 💡 Example Use Cases

- Emulates its creator in conversation, providing a personal touch.
- Summarizes and recalls past relevant discussions.
- Plays chess interactively with users.
- Provides up-to-date status and diagnostics for maintainers.
- Handles high-load situations gracefully with AFK and rate limiting.

---
