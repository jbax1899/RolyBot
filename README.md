# RolyBot – A Discord Chatbot Very Good At Imitating Me

**RolyBot** is a context-aware Discord chatbot designed to emulate its creator in both writing and interaction style. It leverages OpenAI's GPT models and an in-memory context/memory system to provide highly relevant, dynamic responses.

---

## 🚀 Features

- **Conversational AI:** Emulates my style using GPT-4o-mini and fine-tuned GPT-4.
- **Interactive Chess:** Play chess in Discord threads, with AI (Stockfish) and natural move input.
- **Memory:** Fast, RAM-only, in-memory context; no persistent storage.
- **Smart Context:** Prioritized, deduplicated, and token-aware context for responses.
- **Spam Control:** Rate limits and AFK mode to prevent flooding.
- **Web Search:** Automatically performs web searches for extra context as needed.

![image](https://github.com/user-attachments/assets/7542c526-710e-4673-92c1-d378f7ebd3bd)

---

## ♟️ Chess

- Start a game: `!rb chess start`
- Move: `!rb chess move e4` (or just chat in plain English)
- Show board: `!rb chess show`
- Resign: `!rb chess resign`
- Each game runs automatically in a personal thread.
- Bot has context about the game state and can chat about it.
- AI uses Stockfish with adjustable difficulty.

![Image showcasing back and forth chess play with the bot, and the bot commenting on the state of the game](https://github.com/user-attachments/assets/869f58ca-cf5d-4345-8723-c1884d90326f)

---

## 🛠️ Technical Stack

- **Node.js** with **Discord.js** for bot framework and event handling.
- **OpenAI API** for language model completions and status generation.
- **RAM-only memory system** for fast, ephemeral, and ToS-compliant context management (no persistent storage, all in-memory).
- **Multi-algorithm similarity search** (cosine, Jaccard, Levenshtein) and dynamic summarization for memory/context retrieval.
- **Token-aware and deduplicated context management** for efficient prompt construction.

---

## ⚙️ Design Principles

- **Contextual Awareness:** Always responds with the most relevant, recent, and non-redundant information, using prioritized and deduplicated context.
- **Strict Discord ToS Compliance:** All memory and context storage is in-memory only; no persistent storage of user data.
- **Robust Error Handling & Diagnostics:** Extensive error handling, logging, and diagnostics for all major subsystems, including memory and context.
- **Fallback & Resilience:** Prioritized channel loading with comprehensive fallback mechanisms to ensure reliable memory initialization.
- **Extensibility:** Modular command and context system for easy addition of new features.

---

## 💡 Example Use Cases

- Emulates me in conversation, providing a personal touch.
- Recalls past relevant discussions with advanced similarity search and dynamic summarization.
- Plays chess interactively with users in dedicated threads, with AI-powered moves and natural language input.
- Handles high-load situations gracefully with AFK and rate limiting.

---
