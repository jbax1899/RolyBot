const natural = require('natural');
const { 
    cosineSimilarity, 
    preprocessInput, 
    normalizeScore, 
    padEmbedding,
    jaccardSimilarity,
    levenshteinDistance 
} = require('./vectorUtils');
const logger = require('./logger');

/**
 * Memory Relevance Weighting Constants
 * 
 * These constants control the scoring and importance of different memory attributes.
 * Adjust these values to fine-tune memory retrieval behavior.
 */

const RELEVANCE_WEIGHTS = {
    // Similarity Metric Weights (should sum to 1)
    COSINE_SIMILARITY_WEIGHT: 0.5,   // Semantic meaning similarity
    JACCARD_SIMILARITY_WEIGHT: 0.2,  // Structural token matching
    LEVENSHTEIN_SIMILARITY_WEIGHT: 0.3,  // Fine-grained textual similarity

    // Contextual Matching Weights
    CHANNEL_MATCH_WEIGHT: 0.3,  // Bonus for same channel context
    GUILD_MATCH_WEIGHT: 0.3,    // Bonus for same guild context

    // Temporal Relevance Weights
    RECENT_MESSAGE_HALF_LIFE_HOURS: 12  // Half-life for temporal decay
};

// Similarity Thresholds
// Controls how strict the memory matching process is
const COSINE_SIMILARITY_THRESHOLD = 0.3;
const JACCARD_SIMILARITY_THRESHOLD = 0.15;
const LEVENSHTEIN_MAX_DISTANCE = 10;

/**
 * RolyBot Memory Retrieval System
 * 
 * A smart, context-aware memory management solution for conversational AI.
 * 
 * Features:
 * - In-memory, ephemeral storage
 * - Dynamic context tracking
 * - Advanced similarity matching
 * - Privacy-first design
 * - Multi-dimensional relevance scoring
 * - Real-time contextual analysis
 * - Configurable semantic metrics
 * - Low-latency retrieval
 * - Zero persistent storage
 * - Adaptive memory management
 */
class MemoryRetriever {
    // Static default priority channel
    static DEFAULT_PRIORITY_CHANNEL_ID = '1362185428584890469';

    // Similarity and matching thresholds
    static COSINE_SIMILARITY_THRESHOLD = COSINE_SIMILARITY_THRESHOLD;
    static JACCARD_SIMILARITY_THRESHOLD = JACCARD_SIMILARITY_THRESHOLD;
    static LEVENSHTEIN_MAX_DISTANCE = LEVENSHTEIN_MAX_DISTANCE;

    constructor(config = {}) {
        // Destructure configuration with sensible defaults
        const {
            maxMemorySize = 500,
            memoryRateLimit = 120,
            memoryRateLimitWindow = 60000, // 1 minute
            priorityChannelIds = [MemoryRetriever.DEFAULT_PRIORITY_CHANNEL_ID],
            preprocessingConfig = {},
            similarityConfig = {},
            relevanceWeights = RELEVANCE_WEIGHTS
        } = config;

        // Preprocessing configuration
        const {
            tokenLimit = 500,
            embeddingDimension = 768,
            similarityThreshold = 0.7
        } = preprocessingConfig;

        // Similarity configuration
        const {
            cosineSimilarityThreshold = MemoryRetriever.COSINE_SIMILARITY_THRESHOLD,
            jaccardSimilarityThreshold = MemoryRetriever.JACCARD_SIMILARITY_THRESHOLD,
            levenshteinMaxDistance = MemoryRetriever.LEVENSHTEIN_MAX_DISTANCE
        } = similarityConfig;

        // Initialize memory management properties
        this.memoryStore = [];
        this.embeddingCache = new Map();
        this.maxMemorySize = maxMemorySize;
        this.memoryRateLimit = memoryRateLimit;
        this.memoryRateLimitWindow = memoryRateLimitWindow;
        this.memoryAdditionTimes = [];
        this.priorityChannelIds = priorityChannelIds;

        // Preprocessing configuration
        this.tokenLimit = tokenLimit;
        this.embeddingDimension = embeddingDimension;
        this.similarityThreshold = similarityThreshold;

        // Similarity threshold configurations
        this.cosineSimilarityThreshold = cosineSimilarityThreshold;
        this.jaccardSimilarityThreshold = jaccardSimilarityThreshold;
        this.levenshteinMaxDistance = levenshteinMaxDistance;

        // Relevance weights
        this.relevanceWeights = relevanceWeights;
    }

    // Calculate multi-dimensional memory relevance
    // Wrapper method for preprocessing to maintain backwards compatibility
    preprocessInput(input) {
        return preprocessInput(input);
    }

    calculateMemoryRelevance(memory, query, queryEmbedding, context = {}) {
        // Context parameters for additional weighting
        const {
            currentChannelId = null,
            currentGuildId = null,
            currentTimestamp = Date.now()
        } = context;

        // Validate input parameters
        if (!memory || !query || !queryEmbedding) {
            logger.warn('[MemoryRetriever] Missing required parameters for relevance calculation');
            return 0;
        }

        try {
            // Validate memory structure
            const requiredMemoryProps = ['embedding', 'tokens', 'text'];
            const missingProps = requiredMemoryProps.filter(prop => !memory[prop]);
            if (missingProps.length > 0) {
                logger.warn(`[MemoryRetriever] Memory missing critical properties: ${missingProps.join(', ')}`);
                return 0;
            }

            // Defensive embedding and token processing
            const safeQueryTokens = preprocessInput(query).tokens.filter(token => token.length > 0);
            const safeMemoryTokens = memory.tokens.filter(token => token.length > 0);

            // Cosine Similarity (Semantic Meaning)
            // Ensure embeddings are of equal length by padding or truncating
            const maxLength = Math.max(queryEmbedding.length, memory.embedding.length);
            const paddedQueryEmbedding = padEmbedding(queryEmbedding, maxLength);
            const paddedMemoryEmbedding = padEmbedding(memory.embedding, maxLength);
            const cosineSim = cosineSimilarity(paddedQueryEmbedding, paddedMemoryEmbedding);
            const normalizedCosineSim = normalizeScore(cosineSim, -1, 1);

            // Jaccard Similarity (Structural Token Matching)
            const jaccardSim = jaccardSimilarity(safeQueryTokens, safeMemoryTokens);
            const normalizedJaccardSim = normalizeScore(jaccardSim, 0, 1);

            // Levenshtein Distance (Fine-grained Textual Similarity)
            const levenshteinDist = levenshteinDistance(query, memory.text);
            const maxPossibleDistance = Math.max(query.length, memory.text.length);
            const levenshteinSim = 1 - (levenshteinDist / maxPossibleDistance);
            const normalizedLevenshteinSim = normalizeScore(levenshteinSim, 0, 1);

            // Log detailed similarity metrics
            /*
            logger.info(`[MemoryRetriever] Similarity Metrics for Memory: ${memory.text.substring(0, 50)}...`);
            logger.info(JSON.stringify({
                query: query.substring(0, 50),
                memoryText: memory.text.substring(0, 50),
                cosineSimilarity: {
                    raw: cosineSim,
                    normalized: normalizedCosineSim,
                    threshold: this.cosineSimilarityThreshold
                },
                jaccardSimilarity: {
                    raw: jaccardSim,
                    normalized: normalizedJaccardSim,
                    threshold: this.jaccardSimilarityThreshold,
                    queryTokens: safeQueryTokens,
                    memoryTokens: safeMemoryTokens
                },
                levenshteinSimilarity: {
                    distance: levenshteinDist,
                    maxPossibleDistance: maxPossibleDistance,
                    raw: levenshteinSim,
                    normalized: normalizedLevenshteinSim,
                    threshold: this.levenshteinMaxDistance
                }
            }));
            */

            // Temporal Relevance Calculation
            let temporalWeight = 1;
            try {
                // Try parsing different timestamp formats
                let memoryTimestamp = null;

                // Check memory timestamp
                if (memory.timestamp !== undefined && memory.timestamp !== null) {
                    if (typeof memory.timestamp === 'number') {
                        memoryTimestamp = memory.timestamp;
                    } else if (typeof memory.timestamp === 'string') {
                        const parsedDate = new Date(memory.timestamp);
                        if (!isNaN(parsedDate.getTime())) {
                            memoryTimestamp = parsedDate.getTime();
                        }
                    }
                }

                // Fallback to context timestamp
                if (!memoryTimestamp && memory.context && memory.context.timestamp) {
                    if (typeof memory.context.timestamp === 'number') {
                        memoryTimestamp = memory.context.timestamp;
                    } else if (typeof memory.context.timestamp === 'string') {
                        const parsedContextDate = new Date(memory.context.timestamp);
                        if (!isNaN(parsedContextDate.getTime())) {
                            memoryTimestamp = parsedContextDate.getTime();
                        }
                    }
                }

                // Calculate temporal weight
                if (memoryTimestamp) {
                    const timeDiffHours = (currentTimestamp - memoryTimestamp) / (1000 * 60 * 60);
                    temporalWeight = Math.pow(0.5, timeDiffHours / this.relevanceWeights.RECENT_MESSAGE_HALF_LIFE_HOURS);
                } else {
                    logger.warn('[MemoryRetriever] Could not parse any valid timestamp');
                }
            } catch (error) {
                logger.error(`[MemoryRetriever] Comprehensive timestamp error: ${error.stack}`);
                temporalWeight = 1; // Default to no temporal penalty
            }

            // Contextual Matching Weights
            let contextualWeight = 1;
            if (memory.context) {
                // Channel Matching
                if (currentChannelId && memory.context.channelId === currentChannelId) {
                    contextualWeight += CHANNEL_MATCH_WEIGHT;
                }

                // Guild Matching
                if (currentGuildId && memory.context.guildId === currentGuildId) {
                    contextualWeight += GUILD_MATCH_WEIGHT;
                }
            }

            // Adaptive Weighting with Temporal and Contextual Factors
            const relevanceScore = (
                (this.relevanceWeights.COSINE_SIMILARITY_WEIGHT * normalizedCosineSim + 
                this.relevanceWeights.JACCARD_SIMILARITY_WEIGHT * normalizedJaccardSim + 
                this.relevanceWeights.LEVENSHTEIN_SIMILARITY_WEIGHT * normalizedLevenshteinSim) *
                temporalWeight *
                contextualWeight
            );

            return relevanceScore;
        } catch (error) {
            logger.error(`[MemoryRetriever] Comprehensive error in memory relevance calculation: ${error.stack}`);
            return 0;
        }
    }
    // Pad or truncate embedding to a specific length
    padEmbedding(embedding, targetLength) {
        if (embedding.length === targetLength) {
            return embedding;
        }

        if (embedding.length < targetLength) {
            // Pad with zeros
            const paddedEmbedding = [...embedding];
            while (paddedEmbedding.length < targetLength) {
                paddedEmbedding.push(0);
            }
            return paddedEmbedding;
        } else {
            // Truncate
            return embedding.slice(0, targetLength);
        }
    }

    // Cosine similarity filter
    cosineSimilarityFilter(queryEmbedding, threshold = this.cosineSimilarityThreshold) {
        // Ensure using the passed threshold
        const effectiveThreshold = threshold !== undefined ? threshold : this.cosineSimilarityThreshold;
        logger.info(`[MemoryRetriever] Cosine Similarity Filtering: Threshold: ${effectiveThreshold}, Query Embedding Length: ${queryEmbedding ? queryEmbedding.length : 'N/A'}`);

        try {
            // Ensure query embedding exists and is not empty
            if (!queryEmbedding || queryEmbedding.length === 0) {
                logger.warn('[MemoryRetriever] Empty query embedding');
                return [];
            }

            return this.memoryStore.filter(memory => {
                // Validate memory embedding
                if (!memory.embedding || memory.embedding.length === 0) {
                    return false;
                }

                // Ensure embeddings are of equal length, truncate to shorter length
                const minLength = Math.min(queryEmbedding.length, memory.embedding.length);
                const truncatedQueryEmbedding = queryEmbedding.slice(0, minLength);
                const truncatedMemoryEmbedding = memory.embedding.slice(0, minLength);

                const similarity = cosineSimilarity(truncatedQueryEmbedding, truncatedMemoryEmbedding);
                if (similarity >= effectiveThreshold) {
                    return true;
                }
                return false;
            });
        } catch (error) {
            logger.error('[MemoryRetriever] Error in cosine similarity filtering:', error);
            return [];
        }
    }

    // Jaccard similarity for structural comparison
    jaccardSimilarityFilter(queryTokens, candidates, threshold = this.jaccardSimilarityThreshold) {
        // Ensure using the passed threshold
        const effectiveThreshold = threshold !== undefined ? threshold : this.jaccardSimilarityThreshold;
        logger.info(`[MemoryRetriever] Jaccard Similarity Filtering: Threshold: ${effectiveThreshold}, Query Tokens: ${queryTokens.join(', ')}, Candidate Memories: ${candidates.length}`);

        try {
            // Validate input
            if (!queryTokens || queryTokens.length === 0) {
                logger.warn('[MemoryRetriever] Empty query tokens');
                return [];
            }

            // Normalize tokens
            const normalizeTokens = (tokens) => {
                return tokens.map(token => 
                    token.toString().toLowerCase().replace(/[^a-z0-9]/g, '')
                ).filter(token => token.length > 0);
            };

            const normalizedQueryTokens = normalizeTokens(queryTokens);

            // Log initial query tokens
            logger.info(`[MemoryRetriever] Normalized Query Tokens: ${normalizedQueryTokens.join(', ')}`);

            // Track filtering stages
            let initialCandidatesCount = candidates.length;
            logger.info(`[MemoryRetriever] Initial candidates: ${initialCandidatesCount}`);

            const filteredMemories = candidates.filter(memory => {
                // Validate memory tokens
                if (!memory.tokens || memory.tokens.length === 0) {
                    return false;
                }

                // Normalize memory tokens
                const normalizedMemoryTokens = normalizeTokens(memory.tokens);

                // Calculate Jaccard similarity
                const intersection = normalizedQueryTokens.filter(token => 
                    normalizedMemoryTokens.includes(token)
                );
                const union = [...new Set([...normalizedQueryTokens, ...normalizedMemoryTokens])];
                const jaccardScore = intersection.length / union.length;

                // Detailed logging for matched memories
                if (jaccardScore >= effectiveThreshold) {
                    logger.info(`[MemoryRetriever] Memory Matched:
                    Jaccard Score: ${jaccardScore}
                    Query Tokens: ${normalizedQueryTokens.join(', ')}
                    Memory Tokens: ${normalizedMemoryTokens.join(', ')}
                    Intersection: ${intersection.join(', ')}`);
                }
                
                return jaccardScore >= effectiveThreshold;
            });

            // Log filtering results
            logger.info(`[MemoryRetriever] Jaccard Filtering Results: Initial Candidates: ${initialCandidatesCount}, Filtered Memories: ${filteredMemories.length}, Threshold: ${threshold}`);

            return filteredMemories;
        } catch (error) {
            logger.error('[MemoryRetriever] Error in Jaccard similarity filtering:', error);
            return [];
        }
    }

    // Levenshtein distance for fine-grained matching
    levenshteinRefinement(query, candidates, maxDistance = this.levenshteinMaxDistance) {
        // Ensure using the passed max distance
        const effectiveMaxDistance = maxDistance !== undefined ? maxDistance : this.levenshteinMaxDistance;
        logger.info(`[MemoryRetriever] Levenshtein Refinement: Max Distance: ${effectiveMaxDistance}, Query: ${query}, Candidate Memories: ${candidates.length}`);

        try {
            // Validate input
            if (!query || query.trim() === '') {
                logger.warn('[MemoryRetriever] Empty query for Levenshtein refinement');
                return [];
            }

            return candidates.filter(memory => {
                // Validate memory text
                if (!memory.text || memory.text.trim() === '') {
                    return false;
                }

                const distance = natural.LevenshteinDistance(
                    query.toLowerCase(), 
                    memory.text.toLowerCase()
                );

                logger.info(`[MemoryRetriever] Levenshtein distance: ${distance}`);
                if (distance <= effectiveMaxDistance) {
                    return true;
                }
                return false;
            });
        } catch (error) {
            logger.error('[MemoryRetriever] Error in Levenshtein refinement:', error);
            return [];
        }
    }

    // Main retrieval method
    async retrieveRelevantMemories(input, tokenBudget = 500) {
        // Validate and preprocess input
        if (!input || input.trim() === '') {
            logger.warn('[MemoryRetriever] Empty input provided');
            return [];
        }

        const { tokens, embedding } = this.preprocessInput(input);

        // Log input preprocessing
        //logger.info(`[MemoryRetriever] Input tokens: ${tokens.join(', ')}`);
        //logger.info(`[MemoryRetriever] Input embedding length: ${embedding.length}`);

        // Ensure we have memories to search
        if (this.memoryStore.length === 0) {
            logger.warn('[MemoryRetriever] No memories available for retrieval');
            
            // Additional 
            /*
            logger.info(`[MemoryRetriever] Current instance: ${JSON.stringify({
                maxMemorySize: this.maxMemorySize,
                priorityChannelIds: this.priorityChannelIds,
                memoryRateLimit: this.memoryRateLimit
            })}`);
            */

            return [];
        }

        // Tiered filtering with more lenient thresholds
        let relevantMemories = this.cosineSimilarityFilter(embedding, 0.5); // Lower threshold
        //logger.info(`[MemoryRetriever] Memories after cosine similarity filter: ${relevantMemories.length}`);
        
        // Log details of cosine similarity filtering
        if (relevantMemories.length === 0) {
            logger.warn('[MemoryRetriever] No memories found with cosine similarity');
        }

        // If no memories found, fall back to broader matching
        if (relevantMemories.length === 0) {
            // Use a more inclusive Jaccard similarity
            relevantMemories = this.jaccardSimilarityFilter(tokens, this.memoryStore, 0.3);
            logger.info(`[MemoryRetriever] Memories after fallback Jaccard similarity filter: ${relevantMemories.length}`);
        } else {
            // Further filter already filtered memories
            relevantMemories = this.jaccardSimilarityFilter(tokens, relevantMemories, 0.3);
            logger.info(`[MemoryRetriever] Memories after Jaccard similarity filter: ${relevantMemories.length}`);
        }

        // Levenshtein refinement with more relaxed distance
        relevantMemories = this.levenshteinRefinement(input, relevantMemories, 5); // Increased max distance
        logger.info(`[MemoryRetriever] Memories after Levenshtein refinement: ${relevantMemories.length}`);

        // Retrieve memories with multi-dimensional relevance scoring
        const queryEmbedding = this.preprocessInput(input).embedding;
        const candidates = this.memoryStore;

        // Calculate relevance scores for all memories
        const scoredMemories = candidates.map(memory => ({
            memory,
            relevanceScore: this.calculateMemoryRelevance(memory, input, queryEmbedding)
        }));

        // Sort memories by relevance score in descending order
        const sortedMemories = scoredMemories.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Default to top 10 most relevant memories, or configurable via options
        const maxMemories = 10;
        const topMemories = sortedMemories
            .filter(item => item.relevanceScore > 0)
            .slice(0, maxMemories)
            .map(item => item.memory);

        // Log retrieval results
        logger.info(`[MemoryRetriever] Memory Retrieval Summary:
            Total Memories: ${candidates.length}
            Memories with Relevance: ${sortedMemories.filter(item => item.relevanceScore > 0).length}
            Top Memories Retrieved: ${topMemories.length}`);
        // Prepare final memories
        const finalMemories = topMemories.map(memory => memory);

        // Add current input as a memory if no relevant memories found
        if (finalMemories.length === 0) {
            const newMemoryContext = { source: 'direct_input', timestamp: Date.now() };
            const newMemory = {
                text: input,
                context: newMemoryContext,
                timestamp: Date.now()
            };
            this.addMemory(input, newMemoryContext);
            logger.warn('[MemoryRetriever] No relevant memories found, added current input as a new memory');
            finalMemories.push(newMemory);
        }

        return finalMemories;
    }

    // Check if content is filler
    isFillerContent(text) {
        const fillerWords = ['yeah', 'lol', 'ok', 'hmm', 'right'];
        return fillerWords.some(word => text.toLowerCase().includes(word));
    }

    // Trim memories to token budget
    trimToTokenBudget(memories, budget) {
        let currentTokens = 0;
        return memories.filter(memory => {
            const memoryTokens = encode(memory.text).length;
            if (currentTokens + memoryTokens <= budget) {
                currentTokens += memoryTokens;
                return true;
            }
            return false;
        });
    }

    // Add memory to store
    addMemory(text, context = {}) {
        // Ensure text is a non-empty string
        if (!text || typeof text !== 'string' || text.trim() === '') {
            //logger.warn('[MemoryRetriever] Attempted to add empty or invalid memory');
            return false;
        }

        // Validate and normalize context
        const currentTime = Date.now();
        const normalizedContext = {
            source: context.source || 'unknown',
            channelId: context.channelId || null,
            authorId: context.authorId || null,
            username: context.username || 'Anonymous',
            timestamp: context.timestamp || currentTime
        };

        // Preprocess input
        let preprocessedInput;
        try {
            preprocessedInput = this.preprocessInput(text);
        } catch (preprocessError) {
            logger.error(`[MemoryRetriever] Failed to preprocess memory: ${preprocessError.message}`);
            return false;
        }

        // Create memory object with all required properties
        const memory = {
            text: text,
            tokens: preprocessedInput.tokens,
            embedding: preprocessedInput.embedding,
            context: normalizedContext,
            timestamp: currentTime
        };

        // Rate limiting check
        this.memoryAdditionTimes = this.memoryAdditionTimes.filter(
            time => currentTime - time < this.memoryRateLimitWindow
        );

        if (this.memoryAdditionTimes.length >= this.memoryRateLimit) {
            //logger.warn('[MemoryRetriever] Memory addition rate limited');
            return false;
        }

        // Add memory to store
        this.memoryStore.push(memory);
        this.memoryAdditionTimes.push(currentTime);

        // Manage memory store size
        if (this.memoryStore.length > this.maxMemorySize) {
            // Remove oldest memories first
            this.memoryStore.splice(0, this.memoryStore.length - this.maxMemorySize);
        }

        // Detailed logging
        /*
        logger.info(`[MemoryRetriever] Memory added successfully: ${text.substring(0, 100)}...`, {
            timestamp: currentTime,
            tokens: preprocessedInput.tokens.length,
            context: normalizedContext
        });
        */

        return true;
    }

    // Initialize memories from channel history
    async initializeMemoriesFromHistory(client, customChannelIds = [], limit = 100) {
        // Validate input
        if (!client) {
            logger.error('[MemoryRetriever] No Discord client provided');
            return;
        }

        // Combine instance priority channels with any custom channels
        const channelIds = [...new Set([...this.priorityChannelIds, ...customChannelIds])];

        logger.info(`[MemoryRetriever] Attempting to initialize memories from channels: ${channelIds.join(', ')}`);
        logger.info(`[MemoryRetriever] Current instance priority channels: ${this.priorityChannelIds.join(', ')}`);
        logger.info(`[MemoryRetriever] Custom channel IDs: ${customChannelIds.join(', ')}`);

        let memoriesInitialized = 0;
        let totalProcessedMessages = 0;

        // Iterate through priority channels
        for (const channelId of channelIds) {
            logger.info(`[MemoryRetriever] Attempting to process channel: ${channelId}`);
            
            try {
                const channel = await client.channels.fetch(channelId);

                // Validate channel
                if (!channel || !channel.isTextBased()) {
                    logger.warn(`[MemoryRetriever] Channel ${channelId} is not a valid text channel`);
                    continue;
                }

                // Fetch messages, sorting from oldest to newest
                const messages = await channel.messages.fetch({ limit });
                const memoryEntries = Array.from(messages.values())
                    .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // Oldest first
                    .filter(message => {
                        // Filter out system messages, empty messages, or bot messages
                        const isValidMessage = message.content.trim().length > 0 && 
                            !message.author.bot && 
                            message.type === 0; // Default message type
                        return isValidMessage;
                    });

                logger.info(`[MemoryRetriever] Processing ${memoryEntries.length} valid messages from channel: ${channelId}`);

                let channelMemoriesInitialized = 0;
                for (const message of memoryEntries) {
                    try {
                        const addResult = this.addMemory(message.content, {
                            source: 'channel_history',
                            channelId: channel.id,
                            authorId: message.author.id,
                            username: message.author.username,
                            timestamp: message.createdTimestamp
                        });

                        if (addResult) {
                            memoriesInitialized++;
                            channelMemoriesInitialized++;
                        }

                        totalProcessedMessages++;

                        // Limit total memories to prevent overwhelming the store
                        if (memoriesInitialized >= this.maxMemorySize) {
                            logger.info(`[MemoryRetriever] Reached max memory size of ${this.maxMemorySize}`);
                            break;
                        }
                    } catch (memoryError) {
                        logger.error(`[MemoryRetriever] Error adding memory from message: ${memoryError.message}`);
                    }
                }

                logger.info(`[MemoryRetriever] Initialized ${channelMemoriesInitialized} memories from channel ${channelId}`);

                // Stop after successfully processing a channel
                if (channelMemoriesInitialized > 0) break;

            } catch (channelError) {
                logger.error(`[MemoryRetriever] Error accessing channel ${channelId}: ${channelError.message}`);
            }
        }

        // Fallback: if no memories initialized, log a warning
        if (memoriesInitialized === 0) {
            logger.warn('[MemoryRetriever] Could not initialize memories from any channel');
        } else {
            logger.info(`[MemoryRetriever] Successfully initialized ${memoriesInitialized} memories from ${totalProcessedMessages} processed messages`);
        }
    }

    isRateLimited() {
        const now = Date.now();
        
        // Remove timestamps outside the rate limit window
        this.memoryAdditionTimes = this.memoryAdditionTimes.filter(
            time => now - time < this.memoryRateLimitWindow
        );

        // Check if we've exceeded the rate limit
        return this.memoryAdditionTimes.length >= this.memoryRateLimit;
    }

    // Clear memory store
    clearMemory() {
        this.memoryStore = [];
        logger.info('[MemoryRetriever] Memory store cleared');
    }
}

module.exports = MemoryRetriever;
